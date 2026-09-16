import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* ═══════════════════════════════════════════════════════════════════════
   generate-podcast-script  —  coached audio study, phase 1

   Turns one section of a study guide into a single-narrator lecture script
   with periodic recall checkpoints, and VERIFIES coverage TWICE, against two
   independently produced fact lists:

     1. model-extracted - facts this function pulls out of the section itself.
        Self-referential: the same model writes the script and grades it, so a
        fact extraction missed is a fact nothing would catch.
     2. quiz-derived    - fact_tested strings from quiz_questions, written in a
        separate earlier pass over the same source. These catch what extraction
        missed, which is the whole point of the second pass.

   The two numbers are reported SEPARATELY and never merged into one score.
   A fact is never silently dropped: a section that still has misses after
   MAX_RETRIES is stored with status='incomplete' and every miss listed.

   Admin only. Deployed with verify_jwt=true, so the gateway validates the
   caller's JWT; this function then confirms profiles.role = 'admin'.

   POST body:
     action           'generate' (default) | 'list-sections' | 'list-models'
                      | 'scope-audit' (scoping verdicts only, nothing written)
                      | 'generate-cards' (a two-voice CONVERSATION built from the
                        flashcards of one objective or lecture; see the
                        DIALOGUE block below — no markdown involved)
                      | 'checkpoints-cards' (rewrite the per-card checkpoints of
                        an existing conversation episode; episode_id)
     guide_slug       e.g. "nur144-u1-l1"          (generate, list-sections)
     section_heading  exact H2 text                 (generate)
     markdown         full guide markdown           (generate, list-sections)
     source_url       optional; fetched when markdown is omitted
     max_retries      default 3
     dry_run          true = don't write to the database
     cross_check      default true; second, independent coverage pass
     quiz_objective_prefix  e.g. "N144" (derived from guide_slug when omitted)
     quiz_objective_ids     explicit override, e.g. ["N144_L1","N144_SKILLS"]
     gen_model        optional model override for writing
     check_model      optional model override for extraction + verification
═══════════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const JSON_HDR = { ...CORS, 'Content-Type': 'application/json' };

const MAX_RETRIES_DEFAULT = 3;
/* Room to TEACH. At 1200-1600 words a section with 57 facts in it was spending
   one fact every 21 words — no space to build an idea, so it came out as a list
   of facts in sentence form: accurate, complete, and boring. Length is not the
   goal; it is the room the explanation needs. */
const WORDS_MIN = 2500;
const WORDS_MAX = 3500;

let modelCache: string[] | null = null;
/* each model's real output-token ceiling, straight from ListModels, so the
   budget is never a number we guessed */
const modelOutputLimit: Record<string, number> = {};

async function availableModels(apiKey: string): Promise<string[]> {
  if (modelCache) return modelCache;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`);
  if (!res.ok) throw new Error(`ListModels failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const usable = (data.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'));
  usable.forEach((m: any) => {
    const n = String(m.name || '').replace(/^models\//, '');
    const lim = Number(m.outputTokenLimit);
    if (n && Number.isFinite(lim) && lim > 0) modelOutputLimit[n] = lim;
  });
  const names: string[] = usable
    .map((m: any) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  modelCache = names;
  return names;
}

/* Model names change constantly, so nothing is hardcoded as "the" model: the
   live list is fetched and ranked. Newest version wins, because a model
   generation gap outweighs a tier gap; ties break toward the more capable tier.

   The exclusion list matters — a name-prefix match alone would happily hand
   text generation to gemini-2.5-flash-preview-tts the day gemini-2.5-flash is
   retired. */
const NOT_TEXT = /(tts|image|vision|embedding|robotics|computer-use|lyria|nano-banana|deep-research|transcribe|omni|antigravity|gemma)/i;

function modelVersion(name: string): number {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}
/* higher = more capable tier */
function modelTier(name: string): number {
  if (/flash-lite/i.test(name)) return 1;
  if (/flash/i.test(name)) return 2;
  if (/pro/i.test(name)) return 3;
  return 0;
}

function rankModels(available: string[]): string[] {
  const usable = available.filter((m) => /^gemini/i.test(m) && !NOT_TEXT.test(m));
  const stable = usable.filter((m) => !/preview|exp\b/i.test(m));
  let pool = stable.length ? stable : usable;
  /* prefer an explicitly versioned name over a *-latest alias so a run is
     reproducible and cannot silently change model mid-project */
  const versioned = pool.filter((m) => modelVersion(m) > 0);
  if (versioned.length) pool = versioned;
  /* a lite model is too weak to be the coverage judge or the writer */
  const full = pool.filter((m) => modelTier(m) >= 2);
  if (full.length) pool = full;
  return pool.slice().sort((a, b) => (modelVersion(b) - modelVersion(a)) || (modelTier(b) - modelTier(a)));
}

/* `avoid` lets the verifier be a different model from the writer, so the script
   is not graded solely by the model that wrote it. */
function pickModel(available: string[], avoid?: string): string {
  const ranked = rankModels(available);
  if (avoid) {
    const other = ranked.find((m) => m !== avoid);
    if (other) return other;
  }
  return ranked[0] || '';
}

/* ── what a run actually cost ──
   Every call already came back with a usageMetadata block and this function
   dropped it, so the first full lecture cost whatever it cost and there is no
   record of it anywhere. The ledger is passed in per request rather than kept
   at module scope, because one isolate serves several requests at once and a
   shared counter would bill them to each other. */
type UsageRow = {
  stage: string; model: string;
  prompt_tokens: number; thoughts_tokens: number; answer_tokens: number;
  total_tokens: number; ms: number;
};

class Ledger {
  rows: UsageRow[] = [];
  add(row: UsageRow) { this.rows.push(row); }
  summary() {
    const sum = (k: keyof UsageRow) =>
      this.rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const group = (key: 'stage' | 'model') => {
      const out: Record<string, { calls: number; total_tokens: number; ms: number }> = {};
      for (const r of this.rows) {
        const g = out[r[key]] || (out[r[key]] = { calls: 0, total_tokens: 0, ms: 0 });
        g.calls++; g.total_tokens += Number(r.total_tokens) || 0; g.ms += Number(r.ms) || 0;
      }
      return out;
    };
    return {
      calls: this.rows.length,
      prompt_tokens: sum('prompt_tokens'),
      thoughts_tokens: sum('thoughts_tokens'),
      answer_tokens: sum('answer_tokens'),
      total_tokens: sum('total_tokens'),
      ms: sum('ms'),
      by_stage: group('stage'),
      by_model: group('model'),
      calls_detail: this.rows,
    };
  }
}

async function gemini(apiKey: string, model: string, prompt: string, opts: {
  json?: boolean; temperature?: number; maxOutputTokens?: number;
  stage?: string; ledger?: Ledger;
} = {}): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const t0 = Date.now();
  /* Thinking models bill reasoning tokens against this same budget, so a cap
     sized only for the visible answer truncates the script mid-sentence. Use
     the model's declared ceiling. */
  const cap = opts.maxOutputTokens ?? modelOutputLimit[model] ?? 32768;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.6,
        maxOutputTokens: cap,
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    }),
  });
  const data = await res.json();
  /* recorded before any throw, so a run that fails still accounts for what it
     spent getting there */
  if (opts.ledger) {
    const u = data.usageMetadata || {};
    opts.ledger.add({
      stage: opts.stage || 'unknown', model,
      prompt_tokens: Number(u.promptTokenCount) || 0,
      thoughts_tokens: Number(u.thoughtsTokenCount) || 0,
      answer_tokens: Number(u.candidatesTokenCount) || 0,
      total_tokens: Number(u.totalTokenCount) || 0,
      ms: Date.now() - t0,
    });
  }
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${JSON.stringify(data).slice(0, 600)}`);
  const cand = data.candidates && data.candidates[0];
  if (!cand) throw new Error(`Gemini ${model} returned no candidate: ${JSON.stringify(data).slice(0, 400)}`);
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map((p: any) => p.text || '').join('').trim();
  /* MAX_TOKENS still returns partial content, so this must NOT require empty
     content — otherwise a truncated reply reaches parseJson and surfaces as an
     unterminated-string error that says nothing about the real cause. */
  if (cand.finishReason === 'MAX_TOKENS') {
    const u = data.usageMetadata || {};
    throw new Error(`Gemini ${model} hit the output cap (MAX_TOKENS) at ${cap} tokens `
      + `— prompt ${u.promptTokenCount ?? '?'}, thinking ${u.thoughtsTokenCount ?? 0}, `
      + `answer ${u.candidatesTokenCount ?? '?'}. Truncated after ${text.length} chars. `
      + `Retry with a smaller section, or pass gen_model/check_model.`);
  }
  if (cand.finishReason && cand.finishReason !== 'STOP' && !text)
    throw new Error(`Gemini ${model} stopped: ${cand.finishReason}`);
  return text;
}

function parseJson(raw: string): any {
  let t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const s = t.indexOf('['), o = t.indexOf('{');
  const start = (s === -1) ? o : (o === -1 ? s : Math.min(s, o));
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (start !== -1 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error('Model did not return parsable JSON: ' + raw.slice(0, 300));
}

/* ── markdown → sections (same rule the study guide page uses: the first H2,
      sitting directly under the H1, is the guide subtitle, not a section) ── */
function splitSections(md: string) {
  const lines = md.split(/\r?\n/);
  let fence = false, seenTitle = false, subtitleTaken = false;
  const intro: string[] = [];
  const secs: { heading: string; lines: string[] }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      if (!seenTitle && /^#\s+/.test(line)) { seenTitle = true; continue; }
      if (/^##\s+(?!#)/.test(line)) {
        const heading = line.replace(/^##\s+/, '').trim();
        if (seenTitle && !subtitleTaken && !secs.length && !intro.join('').trim()) {
          subtitleTaken = true; continue;
        }
        cur = { heading, lines: [] }; secs.push(cur); continue;
      }
    }
    if (cur) cur.lines.push(line); else intro.push(line);
  }
  return secs.map((s, i) => ({
    ordinal: i,
    heading: s.heading,
    body: s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  }));
}

const SOURCE_RULES = `
ABSOLUTE SOURCE RULES — these override everything else:
- The SECTION TEXT below is your ONLY source. Use no outside nursing knowledge,
  no clinical experience, no textbook recall, nothing you believe to be true.
- Do not add, infer, extrapolate, correct or "improve" any fact.
- If the section states something you believe is wrong or incomplete, narrate it
  exactly as written anyway.
- Where the source gives CONFLICTING values for the same thing (for example a
  head-of-bed elevation appearing as 30 degrees in one place, 6-8 inches in
  another, and 4-8 inches in a third), you must say plainly that the sources
  conflict and give every variant. Never silently choose one, average them, or
  present one as correct.
- The markers mean: ★ the professor flagged it as must-know, ⊕ added from the
  textbook because the slide listed the topic only, ⊙ a textbook detail the
  slide named without explaining, ⚠ a warning. Never speak the symbols aloud.
  Convey ★ emphasis in words, phrased differently every time it comes up —
  never the same stock sentence twice.`;

function extractFactsPrompt(heading: string, body: string) {
  return `You are indexing a nursing study guide section so that nothing in it can be lost.

${SOURCE_RULES}

Break the section into DISCRETE ATOMIC FACTS. Rules:
- One fact per entry. If a sentence carries three facts, emit three entries.
- Preserve every number, unit, range, dose, timeframe, anatomical term and
  proper name EXACTLY as written.
- Every row of every table becomes at least one fact.
- Every list item becomes at least one fact.
- Each conflicting value gets its OWN fact, plus one fact stating that the
  source conflicts on that point.
- Include definitions, causes, signs and symptoms, diagnostics, interventions,
  rationales and contraindications.
- Do not merge, summarise or rank. Do not skip anything as "obvious".
- Write each fact as a short standalone sentence readable on its own.

Return ONLY a JSON array of strings.

SECTION HEADING: ${heading}

SECTION TEXT:
"""
${body}
"""`;
}

function scriptPrompt(heading: string, body: string, facts: string[]) {
  return `You are writing a spoken lecture script for one nursing student. She listens to it
as the FIRST pass through this material, before flashcards and before quizzing.

${SOURCE_RULES}

VOICE AND FORM:
- ONE narrator speaking directly to her as "you". Warm, plain, direct — a person
  who finds this genuinely interesting talking to someone who wants to get it.
- USE CONTRACTIONS. "let's", "here's", "that's", "you'll", "it's", "doesn't".
  "Let us walk through" is stilted. This is speech, not prose read aloud.
- Plain flowing prose. NO stage directions, NO [pause] markers, NO speaker
  labels, NO headings, NO bullet points, NO markdown, NO numbered lists.
- Target ${WORDS_MIN}-${WORDS_MAX} words. That is deliberately generous: it is
  the room the explanations need, not a quota to pad toward.

TEACH THE MECHANISM, THEN NAME IT:
- Build the idea first, in plain words, then let the term land as the NAME for
  something she already understands. Never state a fact and then explain it —
  by then she has already heard a term that meant nothing and stopped listening.
- Wrong: "Pyrosis is heartburn caused by reflux of acid into the esophagus."
  Right: "Acid that belongs in the stomach washes back up into the esophagus,
  which has no protection against it. That burning behind the breastbone is what
  she means by pyrosis."
- Every mechanism the source explains gets built, not summarised. If the source
  says WHY, that why is the spine of the passage.

ANALOGY AND CONCRETE IMAGERY — this is what makes a mechanism stick:
- Reach for a physical image whenever it explains a mechanism the source states.
  Food acting as a buffer that gets used up, which is why the pain comes back a
  couple of hours after eating. The colon pulling water back out, which is why
  output gets more formed the further along it sits. Digestive enzymes landing
  on skin that was never built to meet them.
- HARD RULE: an analogy may only explain something ALREADY IN THE SECTION TEXT.
  It never introduces a clinical fact, a number, a mechanism or a consequence
  that the source does not state. If the source does not say why something
  happens, do not invent a reason and dress it as an image. An analogy is a way
  of seeing what is there; it is not a source.
- Keep them short and physical. One good image beats three laboured ones.

SOUND LIKE A PODCAST, NOT A TEXTBOOK BEING READ ALOUD:
- When something is genuinely surprising, say so and let it land. The stomach
  producing acid strong enough to digest tissue. Blood turning black as it
  travels. A stoma's output telling you where along the bowel it sits.
- STAKES: what actually happens to the patient if this is missed. Not
  melodrama — the real consequence, where the source gives one.
- BE OPINIONATED about the material: what is genuinely hard, what gets confused
  with what, what is obviously going to be tested. She wants a guide with a
  point of view, not a neutral reader.
- CALLBACKS. When something connects to a point made earlier, say so out loud —
  "this is that same barrier problem again". The mucosal barrier explains
  gastritis, ulcers, perforation and hemorrhage; when the thread reappears, make
  it visible.
- VARY THE RHYTHM. Read it back to yourself. If every sentence is a declarative
  of roughly the same length, it drones. Use a short sentence to land a point.
  Use a question to set one up. Let a long sentence carry a chain of reasoning
  and then stop hard.

HUMOUR — light and dry, or none:
- A wry aside is welcome: that the exam loves the perforation-versus-penetration
  distinction, or that nobody remembers "rectorrhagia" the first time.
- NEVER write a joke with a setup and a punchline. Forced humour in a study
  script is worse than no humour. If a line would not make a real person smile
  slightly in a real conversation, cut it.

DO NOT ANNOUNCE STRUCTURE:
- No "next, let's look at", no "now let's turn to", no "first... second...
  third", no "in this section we will cover". That is a table of contents read
  aloud and it wastes her attention.
- Move between topics THROUGH THE CONTENT. The last idea of one passage should
  hand over to the first idea of the next: what you just explained is the reason
  the next thing happens.

FLAGGING EXAM-CRITICAL MATERIAL:
- When the source marks something must-know, say so — but a DIFFERENT WAY EVERY
  TIME. "this one's on the exam"; "she circled this in lecture"; "if you keep
  one thing from this, keep this"; or simply put the weight in the sentence and
  use no tag at all.
- Never write the same flagging sentence twice.

SAY IT ALOUD-FRIENDLY (keep doing this):
- Spell symbols and abbreviations the way a person says them: "↓" becomes
  "decreased", "1500 mL" becomes "fifteen hundred milliliters", "B12" becomes
  "B twelve", "I&O" becomes "I and O", "H2 receptor antagonists" becomes
  "H two receptor antagonists", "GI" stays "G I".

SHE IS LISTENING, NOT READING — there is no document in front of her:
- NEVER refer to the source document, its formatting, or its structure. No
  "the source", "the guide", "the table", "this section", "the slide", "as
  shown", "side by side", "the first column", "bullet points". She cannot see
  any of it.
- Where the source puts two things side by side, TEACH THE CONTRAST — that is
  what the comparison is for. Only draw a contrast the source actually draws,
  and never assert the absence of a finding the source is simply silent about.

CHECKPOINTS:
- Pause roughly every 400-500 words to ask ONE open recall question, then keep
  teaching. Let the count follow the length rather than aiming at a number.
- Prefer MORE, SMALLER checkpoints over fewer big ones. Each should test 2-3
  specific things, not a whole topic sweep.
- Open recall only — never multiple choice, never yes/no.
- VARY THE STEM. Do not begin every question with the same words. Rotate:
  "What's the difference between…"; "Why does…"; "A patient comes in with…,
  what are you thinking?"; "Which one would you expect to see in…"; "How would
  you explain … to a patient?"; "What are you watching for after…"; "Walk me
  through…" (at most once).
- Ask only about material already taught ABOVE that point in the script.
- Write the question INLINE in the narration as its own sentence, exactly once,
  worded exactly as you report it in the checkpoints array. Do NOT insert any
  marker, tag, or bracketed token — the question sentence itself marks the spot.
- After the question, resume teaching naturally. Do not answer your own question
  immediately; continue as if she has just answered.

EVERY ONE of these facts must be taught somewhere in the script:
${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Return ONLY JSON of the form:
{"script":"<the full narration>",
 "checkpoints":[{"question":"<the question sentence, copied CHARACTER FOR CHARACTER from the script>",
                 "expected_points":["<specific fact a correct answer must contain>", "..."]}]}
The checkpoints array must be in the same order the questions appear in the
script, one entry per question. Each question string must match the script
exactly — the pause is located by finding that sentence in the narration, so a
paraphrase there breaks playback. Give 2-3 expected_points per checkpoint: the
concrete things she has to say for the answer to count, drawn only from the
section text.

SECTION HEADING: ${heading}

SECTION TEXT:
"""
${body}
"""`;
}

function repairPrompt(heading: string, body: string, facts: string[], script: string,
                      missing: string[], quizMissing: string[], unsourced: string[],
                      docRefs: string[]) {
  const blocks: string[] = [];
  if (missing.length) blocks.push(
`MISSING — a listener would not learn these from the current narration. Teach them:
${missing.map((f, i) => `${i + 1}. ${f}`).join('\n')}`);
  if (quizMissing.length) blocks.push(
`ALSO MISSING — these are stated in the SECTION TEXT. Find each one there and
teach it. If you genuinely cannot find it in the section text, leave it out —
do NOT supply it from outside knowledge:
${quizMissing.map((f, i) => `${i + 1}. ${f}`).join('\n')}`);
  if (docRefs.length) blocks.push(
`SHE CANNOT SEE A DOCUMENT — these phrases describe the source or its layout.
Rewrite each sentence so it teaches the material directly, with no mention of a
table, a section, a slide, a list, the guide, or how anything is arranged:
${docRefs.map((f, i) => `${i + 1}. "${f}"`).join('\n')}`);
  if (unsourced.length) blocks.push(
`UNSOURCED — these claims are in your narration but NOT in the section text.
Delete them, or rewrite them so they only say what the section actually says.
Do not replace them with a different unsourced claim:
${unsourced.map((f, i) => `${i + 1}. ${f}`).join('\n')}`);

  return `Revise the lecture script below.

${SOURCE_RULES}

${blocks.join('\n\n')}

HOW TO ADD THE MISSING MATERIAL — this matters as much as the content:
- INTEGRATE each one into the prose that is already there. Fold it into the
  sentence or paragraph where it belongs.
- NEVER append a standalone declarative sentence just to make a fact appear.
  Writing "Nonerosive acute gastritis is caused by H. pylori. Nonerosive acute
  gastritis can cause peptic ulcers." is exactly wrong. Write it as one flowing
  thought: "the nonerosive kind comes from H. pylori, and that's the one that
  can go on to cause peptic ulcers."
- Do NOT repeat the full noun phrase as the subject of consecutive sentences.
  Once the subject is established, use pronouns and connectives.
- Keep every fact already taught. Do not drop anything to make room.
- Keep the same narrator, voice and contractions. Keep the analogies and the
  concrete images: they are how the mechanisms stick, not decoration to trim.
- Do NOT shorten the script to make room. It is meant to be long enough to
  explain things; adding a fact means teaching it, not compressing everything
  else to fit.
- Keep the checkpoint questions in the narration and return the matching
  checkpoints array. Each question string you return must match the sentence in
  the script CHARACTER FOR CHARACTER — the pause is located by finding that
  sentence. Insert no markers or bracketed tokens of any kind.
- Vary how you flag exam-critical material; do not reuse one stock phrase.
- She is LISTENING. Never mention the source, a table, a section, a slide, a
  list, or how the material is laid out. Teach the content directly.
- Plain prose only. No headings, bullets, markdown or stage directions.
- Length may grow to about ${WORDS_MAX + 400} words.

Return ONLY the same JSON shape:
{"script":"...","checkpoints":[{"question":"...","expected_points":["..."]}]}

SECTION HEADING: ${heading}

SECTION TEXT (the only permitted source):
"""
${body}
"""

CURRENT SCRIPT:
"""
${script}
"""`;
}

/* Which quiz facts does THIS section's source text actually contain?

   Judged against the section markdown, never against the script — scoping
   against the script would let a fact the script omitted be ruled
   "out of scope", which is exactly the failure this pass exists to catch. */
function scopePrompt(heading: string, body: string, facts: string[]) {
  return `Decide which of these exam facts are contained in ONE section of a study guide.

For each fact, answer whether the SECTION TEXT below states it or directly
supports it:
- true  = the section text contains this fact (wording may differ, meaning must match)
- false = the section text does not contain it (it belongs to another section of
          the guide, or is not in this guide at all)

Judge ONLY against the section text printed below. Use no outside nursing
knowledge. Do not infer from the heading alone — the fact must actually be in
the text. If the section text does not state it, answer false.

For every fact, also give a SHORT reason (under 15 words) for the verdict. For
a true, name the part of the section text that carries it. For a false, say why
it was excluded — "belongs to the peptic ulcer section", "guide never gives a
dose", "about the esophagus, not the stomach", "no such statement anywhere in
this text".

Return ONLY a JSON array, one entry per fact, in the same order:
[{"i":0,"in_section":true,"reason":"<short>"}]

SECTION HEADING: ${heading}

SECTION TEXT:
"""
${body}
"""

FACTS:
${facts.map((f, i) => `${i}. ${f}`).join('\n')}`;
}

function coveragePrompt(facts: string[], script: string) {
  return `Decide whether a listener who heard ONLY this narration would come away
knowing each fact. You are testing LEARNING, not string containment.

COVERED — all of these count:
- the fact is paraphrased, or said in a different order, or in different words
- the fact is embedded inside an explanation, a mechanism, or a causal chain
- the fact is taught through a worked example or a contrast with something else
- the fact is carried by the narration around it rather than stated outright,
  as long as a listener would still know it
- numbers spelled out for speech ("one to three days" for "1-3 days",
  "B twelve" for "B12", "I and O" for "I&O", "H two receptor antagonists")

Do NOT require the fact to appear as its own sentence. Do NOT require the
subject to be named again if the narration has already established it. A fact
woven into a flowing paragraph is covered.

NOT COVERED:
- the listener would simply not know it
- only the topic is named, with the specific content missing
- a number, unit, range, direction, drug, or term is different from the fact
- the fact records a CONFLICT between sources and the narration gives only one
  variant, or resolves it

Return ONLY a JSON array, one entry per fact, in the same order:
[{"i":0,"covered":true,"evidence":"<short quote, or empty>"}]

FACTS:
${facts.map((f, i) => `${i}. ${f}`).join('\n')}

SCRIPT:
"""
${script}
"""`;
}

/* Unsourced-claim detection.

   Coverage answers "did the script teach everything the source says". It cannot
   answer the opposite question: "did the script say anything the source does
   not". The first real run produced "acute gastritis does not present with
   anemia" — true-sounding, never stated in the guide, arrived at by inverting a
   fact about chronic gastritis. That is the class of error this pass catches.

   Negations and contrasts are called out specifically because they are where
   inference hides: the source being SILENT about a finding is not the source
   saying the finding is absent. */
function unsourcedPrompt(heading: string, body: string, script: string) {
  return `Below is a section of a nursing study guide, and a narration written from it.

Find every DECLARATIVE CLINICAL CLAIM in the narration that is NOT traceable to
the section text. A claim is traceable if the section text states it, or states
something that directly entails it. Wording may differ; meaning must match.

FLAG (these are the failure modes):
- a NEGATIVE claim the source never makes: "X does not present with Y",
  "there is no Z", "Y is absent in X". The source being SILENT about a finding
  is NOT the source saying the finding is absent.
- a CONTRAST the source never draws: "unlike chronic, acute…". Flag it unless
  the source itself states the difference between the two.
- a number, dose, range, timeframe, lab value, or drug the source never gives.
- a mechanism, cause, or consequence the source never states.
- correct outside nursing knowledge that simply is not in this section text.
  Being TRUE is not the test. Being IN THE SECTION TEXT is the test.

ANALOGIES AND IMAGERY — read these carefully, they are the hard case:
The narration is SUPPOSED to explain mechanisms with physical images. An image
is not a claim. Judge what it ASSERTS, not whether the words appear in the text.
- DO NOT FLAG an analogy that only re-describes something the source states.
  If the source says pain returns two to three hours after eating, then "food is
  buffering the acid, and a couple of hours later that buffer is used up" is that
  same fact made visible. Fine.
- DO FLAG an analogy that SMUGGLES IN CONTENT. If the source never says why the
  pain returns, then inventing the buffer mechanism to explain it is an unsourced
  mechanism wearing an image as a disguise — exactly the thing to catch.
- The test is subtraction: strip the image away and ask what clinical assertion
  is left. If that assertion is in the section text, the image is fine. If the
  image is the only thing holding the assertion up, flag it.

DO NOT FLAG:
- teaching scaffolding with no clinical content: "let's start here", "here's why
  that matters", "picture a patient", transitions, second-person address.
- an opinion about the MATERIAL rather than about medicine: that something is
  hard, commonly confused, or likely to be examined. That is the narrator
  talking about her studying, not making a clinical claim.
- emphasis, surprise, or a callback to something said earlier in the narration.
- restatement, paraphrase, summary, or reordering of sourced material.
- a recall question posed to the listener.
- spelling a symbol or abbreviation out for speech ("B twelve", "I and O",
  "H two receptor antagonists", "fifteen hundred milliliters").
- a claim supported ANYWHERE in the section text, even under a different heading
  inside it.

Quote the offending sentence exactly as it appears in the narration.

Return ONLY a JSON array (empty if nothing is unsourced):
[{"claim":"<the sentence, verbatim from the narration>",
  "why":"<under 20 words: what the source actually says, or that it is silent>",
  "kind":"negation|contrast|number|mechanism|outside-knowledge"}]

SECTION HEADING: ${heading}

SECTION TEXT:
"""
${body}
"""

NARRATION:
"""
${script}
"""`;
}

async function findUnsourced(apiKey: string, model: string, heading: string, body: string, script: string,
                             ledger?: Ledger) {
  const out = parseJson(await gemini(apiKey, model, unsourcedPrompt(heading, body, script),
    { json: true, temperature: 0, stage: 'unsourced', ledger }));
  const rows = (Array.isArray(out) ? out : [])
    .map((r: any) => ({
      claim: String((r && r.claim) || '').trim(),
      why: String((r && r.why) || '').trim().slice(0, 200),
      kind: String((r && r.kind) || '').trim().slice(0, 40),
    }))
    .filter((r: any) => r.claim);
  /* A "claim" the verifier cannot actually locate in the narration is itself a
     hallucination; drop it rather than report a sentence that was never said. */
  const { norm } = normIndex(script);
  return rows.filter((r: any) => {
    const q = normIndex(r.claim).norm;
    return q.length > 12 && norm.indexOf(q) >= 0;
  });
}

/* Document-reference lint.

   "The source lays these two out side by side in a comparison table so you can
   appreciate their differences directly" — she is listening on headphones;
   there is no table. This is a narration defect, not a factual one, so neither
   coverage nor the unsourced pass sees it. It is also perfectly mechanical, so
   it gets a regex rather than another model call.

   Kept deliberately narrow: it matches the noun only when it is doing
   document-describing work. "The stomach lining is a barrier" must not trip a
   rule aimed at "as the table shows". */
const DOC_REF_PATTERNS: { re: RegExp; what: string }[] = [
  /* "table" only where it is doing document-describing work — "the patient
     eats at the table" is ordinary prose and must not trip this */
  { re: /\b(?:comparison|summary)\s+tables?\b/gi, what: 'table' },
  { re: /\btables?\s+(?:above|below|here|shows?|lists?|says?|gives?|has|breaks)\b/gi, what: 'table' },
  { re: /\b(?:in|from|on)\s+(?:the|this|that)\s+tables?\b/gi, what: 'table' },
  { re: /\b(?:the|this)\s+(?:study\s+)?(?:guide|source|document|text|handout|packet|material)\b/gi, what: 'the source' },
  { re: /\b(?:the|this|that)\s+(?:slides?|deck|powerpoint|lecture\s+slides?)\b/gi, what: 'slide' },
  { re: /\b(?:this|the|that)\s+(?:section|chapter|page|column|row|heading|appendix|addendum)\b/gi, what: 'section' },
  { re: /\bbullet(?:\s+points?|ed)?\b/gi, what: 'bullets' },
  { re: /\b(?:listed|grouped|organi[sz]ed|laid\s+out|set\s+out|written|printed|shown|presented|displayed)\s+(?:here|above|below|side\s+by\s+side|together|under|in|as|with|next\s+to)\b/gi, what: 'layout' },
  { re: /\b(?:as|like)\s+(?:you\s+can\s+)?(?:see|shown|listed|written)\b/gi, what: 'layout' },
  { re: /\b(?:above|below)\s+(?:in\s+)?(?:the\s+)?(?:list|table|text)\b/gi, what: 'layout' },
  { re: /\bside\s+by\s+side\b/gi, what: 'layout' },
  { re: /\bthe\s+(?:first|second|third|last|left|right)\s+column\b/gi, what: 'column' },
];

function findDocumentReferences(script: string) {
  const hits: { phrase: string; kind: string; context: string }[] = [];
  const seen = new Set<string>();
  for (const { re, what } of DOC_REF_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) {
      const key = what + '|' + m.index;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        phrase: m[0],
        kind: what,
        context: script.slice(Math.max(0, m.index - 70), m.index + m[0].length + 70).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return hits.slice(0, 25);
}

/* Checkpoint placement.

   The old version located each pause by finding a [[CHECKPOINT]] marker on a
   line of its own. The model emits the marker INLINE, and before the question
   rather than after it, so nothing matched, positions came back empty and every
   checkpoint silently fell back to script.length. Marker placement is not
   something the model does reliably, so it is no longer the anchor.

   The anchor is now the question text itself, which the model returns verbatim
   in the checkpoints array: the pause belongs immediately after the question is
   asked. Markers are stripped wherever they appear. Every checkpoint records
   HOW it was placed, so a run where anchoring failed is visible in the report
   instead of quietly wrong. */

/* Minimum characters between two pauses before the placement is called
   degenerate. ~500 chars is roughly 30 seconds of speech. */
const MIN_CHECKPOINT_GAP = 500;

function cleanScript(raw: string): string {
  return String(raw)
    .replace(/\[\[\s*CHECKPOINT\s*\]\]/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* whitespace/case-insensitive view of a string, with a map back to real offsets */
function normIndex(s: string) {
  const chars: string[] = [], map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      chars.push(' '); map.push(i); prevSpace = true;
    } else {
      chars.push(ch.toLowerCase()); map.push(i); prevSpace = false;
    }
  }
  return { norm: chars.join('').trim(), map };
}

function placeCheckpoints(rawScript: string, checkpoints: any[]) {
  const script = cleanScript(rawScript);
  const { norm, map } = normIndex(script);

  const placed = checkpoints.map((c: any) => {
    const question = String((c && c.question) || '').trim();
    let pos = -1, how = 'unplaced';
    if (question) {
      const qn = normIndex(question).norm;
      if (qn) {
        const at = norm.indexOf(qn);
        if (at >= 0) { pos = map[at + qn.length - 1] + 1; how = 'question'; }
      }
    }
    return { question, pos, how, expected_points: c && c.expected_points };
  });

  /* anything unanchored goes in proportionally, and says so */
  const n = placed.length;
  placed.forEach((p, i) => {
    if (p.pos < 0) { p.pos = Math.round((script.length * (i + 1)) / (n + 1)); p.how = 'proportional'; }
  });

  /* offsets must be strictly increasing; nudging one means it no longer sits
     right after its question, so relabel it rather than pretend */
  placed.sort((a, b) => a.pos - b.pos);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].pos <= placed[i - 1].pos) {
      placed[i].pos = Math.min(script.length, placed[i - 1].pos + 1);
      placed[i].how = 'adjusted';
    }
  }

  /* Two pauses seconds apart is a degraded episode even when the offsets are
     technically distinct. Flag it — do NOT move the pause, because moving it
     would detach it from the question it belongs to. */
  placed.forEach((p: any, i: number) => {
    p.gap_from_previous = i === 0 ? p.pos : p.pos - placed[i - 1].pos;
    p.crowded = p.gap_from_previous < MIN_CHECKPOINT_GAP;
  });
  return { script, placed };
}

const wordCount = (s: string) => (s.trim().match(/\S+/g) || []).length;

/* one coverage pass over an arbitrary fact list */
async function checkCoverage(apiKey: string, model: string, facts: string[], script: string,
                            ledger?: Ledger, stage = 'coverage') {
  if (!facts.length) return [] as any[];
  const rows: any[] = [];
  const CHUNK = 120;
  for (let s = 0; s < facts.length; s += CHUNK) {
    const slice = facts.slice(s, s + CHUNK);
    const out = parseJson(await gemini(apiKey, model, coveragePrompt(slice, script),
      { json: true, temperature: 0, stage, ledger }));
    const byIndex = new Map<number, any>();
    (Array.isArray(out) ? out : []).forEach((c: any, idx: number) => {
      const i = Number.isInteger(c && c.i) ? c.i : idx;
      byIndex.set(i, c);
    });
    slice.forEach((f, i) => {
      const c = byIndex.get(i) || {};
      rows.push({ fact: f, covered: c.covered === true, evidence: String(c.evidence || '').slice(0, 300) });
    });
  }
  return rows;
}

/* which quiz facts belong to this section, judged against the section source */
async function scopeToSection(apiKey: string, model: string, heading: string, body: string, facts: string[],
                              ledger?: Ledger) {
  const flags: boolean[] = new Array(facts.length).fill(false);
  const reasons: string[] = new Array(facts.length).fill('');
  const CHUNK = 120;
  for (let s = 0; s < facts.length; s += CHUNK) {
    const slice = facts.slice(s, s + CHUNK);
    const out = parseJson(await gemini(apiKey, model, scopePrompt(heading, body, slice),
      { json: true, temperature: 0, stage: 'scope', ledger }));
    (Array.isArray(out) ? out : []).forEach((r: any, idx: number) => {
      const i = Number.isInteger(r && r.i) ? r.i : idx;
      if (i >= 0 && i < slice.length) {
        flags[s + i] = (r.in_section === true);
        reasons[s + i] = String((r && r.reason) || '').slice(0, 160);
      }
    });
  }
  return { flags, reasons };
}

/* Lexical overlap between a fact and the section text, so the scoping dump can
   rank REJECTED facts by how close they came. A fact that shares many content
   words with the section but was still excluded is the interesting case; one
   that shares almost nothing is obviously another section's. */
const STOP = new Set(('a an and are as at be but by for from has have in is it its of on or that the'
  + ' to was were will with which who whom this these those not no can may').split(' '));
function contentWords(s: string): string[] {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}
function overlapScore(fact: string, bodyWords: Set<string>): number {
  const w = contentWords(fact);
  if (!w.length) return 0;
  let hit = 0;
  const seen = new Set<string>();
  for (const t of w) { if (seen.has(t)) continue; seen.add(t); if (bodyWords.has(t)) hit++; }
  return Math.round((hit / seen.size) * 100) / 100;
}

/* ═══════════════════════════════════════════════════════════════════════
   DIALOGUE — a conversation that prepares her for the deck

   The lecture format above is something she listens to passively. This one
   is built from the FLASHCARDS of one objective (or a whole lecture): for
   each card, in deck order, two voices work out WHY the thing happens (the
   explanation field, expanded into talk), the Teacher then asks the card's
   question out loud, frames the silence ("take a second"), a [[PAUSE]] line
   marks 4.5 seconds of real silence that the audio function splices in, and
   the Teacher answers, then the why. The Student voice is her: asks why,
   pushes back with intuition, restates the mechanism, connects to earlier
   cards.

   Verified two ways before it is saved: a local lint (one pause per card,
   every question asked verbatim, a frame before each pause, an "Okay —"
   after, only Teacher/Student lines, nothing that refers to the deck) and a
   model coverage pass over every card's answer. A part that still fails after
   the retries is saved as 'incomplete' with the misses listed.
   ═══════════════════════════════════════════════════════════════════════ */

const CARDS_PER_PART_DEFAULT = 12;     /* ~180 words + a stop each -> about 15 minutes */
const WORDS_PER_CARD = 180;
/* Asked for 180 a card, the model wrote 220-270: the first lecture came back at
   3,270 words for twelve cards, a 23-minute part. The ceiling goes in the
   prompt and the lint enforces it, so a long part is repaired, not shipped. */
const WORDS_CAP_PER_CARD = 210;
const WORDS_LINT_PER_CARD = 230;
const PAUSE_MARK = '[[PAUSE]]';

type Card = { id: number; question: string; answer: string; explanation: string | null };

function dialoguePrompt(objLabel: string, objDesc: string, lectureLabel: string, cards: Card[],
                        part: number, parts: number, priorQuestions: string[]) {
  const target = cards.length * WORDS_PER_CARD;
  return `You are writing a two-voice CONVERSATION for one nursing student to listen to
before she works through a set of flashcards. It is not a lecture and it is not
a quiz. It is two people working out WHY things happen, and then testing recall.

THE TWO VOICES
- Teacher: knows the material, explains mechanisms in plain words, answers
  objections honestly, never talks in lists.
- Student: is her. Curious, sharp, a little sceptical. The Student does NOT feed
  straight lines. She:
  * asks WHY something happens, not just what happens
    ("Dysphagia is worse with solids — but why are liquids different?")
  * raises the obvious objection a student would have, from her own intuition,
    and gets it answered ("It's a spasm, so wouldn't gravity still help the food
    down?" "We put an NG tube in a GI bleed — wouldn't the suction make it bleed
    more?" "Manometry measures pressure squeezing. How is that movement and not
    structural?")
  * restates the mechanism back in plainer words to check she has it ("So the
    acid inflames the peritoneum, that makes the capillaries leaky, and the
    fluid that leaks out is from the circulating blood?")
  * connects it to something already covered ("That's the same reason ascites
    happens, right?")
  About one in three of her turns should be a pushback or a restatement rather
  than a question. She is never a prompter.

FOR EACH CARD, IN THE ORDER GIVEN. This structure is not optional:
1. MECHANISM FIRST. Before any fact from the answer is stated, the two of them
   build WHY it happens, conversationally. The card's WHY text is the raw
   material: expand it into dialogue, never read it out. If it is thin, build the
   why from the answer and from cards already covered. Never jump to detail
   before the mechanism is on the table.
2. THE QUESTION. The Teacher poses the card's question OUT LOUD, worded EXACTLY
   as the card has it — copy it character for character, it is located by text.
3. THE FRAME. In the SAME Teacher turn, right after the question, one short
   sentence that tells her the coming silence is deliberate. Vary it every time:
   "Take a second." "Think it through." "Give it a moment before I say it."
   "See if you can get all of it." "Say it in your head first."
4. THE PAUSE. Then a line containing exactly ${PAUSE_MARK} and nothing else.
   One per card. Never two in a row.
5. THE ANSWER. The next line is a Teacher turn that begins with "Okay —" (or
   "Alright —" or "Right —"), gives the card's ANSWER in full, then the why in a
   sentence or two. The Student may react briefly, then the next card begins
   through the content, not with an announcement.

CONTENT RULES
- The cards are the ONLY source. No outside nursing knowledge. Every fact in the
  dialogue comes from a card's question, answer or why, or from a card already
  covered in this conversation. If the cards do not say why, the Teacher says
  plainly that the why is not covered here — never invents one.
- Cover every card. Every ANSWER must be said in full in its answer turn, even
  where the mechanism talk already touched it.
- Speak numbers, units and abbreviations the way a person says them: "fifteen
  hundred milliliters", "B twelve", "G I", "H two blocker", "I and O", "N G tube".
- She is listening, not reading: never say "the card", "this card", "the deck",
  "the flashcard", "the list", "the explanation", "as written". No headings,
  bullets, stage directions, brackets or markdown of any kind. The ONLY things
  in the script are Teacher lines, Student lines and ${PAUSE_MARK} lines.
- Contractions. Short sentences. Real speech. Dry humour is welcome; no jokes.
- ${priorQuestions.length
      ? `Cards already covered in an earlier part of this conversation (build on them, do not re-teach them):\n  - ${priorQuestions.join('\n  - ')}`
      : 'This is the first part of the conversation for this objective.'}
- Length: about ${target} words for these ${cards.length} cards, roughly
  ${WORDS_PER_CARD} per card. Room to build the why, not a quota — and a HARD
  CEILING of ${cards.length * WORDS_CAP_PER_CARD} words. Past that it stops being
  a fifteen-minute listen. Cut mechanism talk to fit, never a question, a
  frame, a pause or an answer.

FORMAT
Return ONLY JSON: {"script": "<the dialogue>"}. The dialogue is plain lines:
Teacher: ...
Student: ...
${PAUSE_MARK}
Teacher: Okay — ...
Every turn starts on its own line with its label. No other labels exist.

OBJECTIVE: ${objLabel}${objDesc ? ' — ' + objDesc : ''}
LECTURE: ${lectureLabel}${parts > 1 ? `\nPART ${part} OF ${parts}` : ''}

CARDS, IN ORDER:
${cards.map((c, i) => `${i + 1}. QUESTION: ${c.question}\n   ANSWER: ${c.answer}\n   WHY: ${(c.explanation || '').trim() || '(not given — do not invent one)'}`).join('\n')}`;
}

function dialogueRepairPrompt(script: string, issues: string[], missing: string[]) {
  return `Revise this two-voice conversation. Keep everything that is right; change
only what the problems below require. Same voices, same rules: Teacher and
Student lines only, ${PAUSE_MARK} on its own line exactly once per card, the
card's question copied character for character followed by a framing sentence
in the same Teacher turn, and an answer turn beginning "Okay —" after each pause.
The cards remain the only source.

PROBLEMS FOUND:
${issues.length ? issues.map((x) => '- ' + x).join('\n') : '- (structure is fine)'}

ANSWERS A LISTENER WOULD NOT COME AWAY KNOWING (each must be said in full in its
answer turn, and its why built beforehand):
${missing.length ? missing.map((x) => '- ' + x).join('\n') : '- (none)'}

Return ONLY JSON: {"script": "<the full revised dialogue>"}

CURRENT SCRIPT:
"""
${script}
"""`;
}

const FRAME_RE = /(take a (second|moment|beat)|think it through|think about it|give it a moment|see if you can|say it in your head|before i say it|give yourself a second|sit with it)/i;
const OKAY_RE = /^Teacher:\s*(okay|alright|right|ok)\b/i;
const DECK_REF_RE = /\b(the|this|that|each|every)\s+(card|cards|flashcard|flashcards|deck)\b|\bthe list\b|\bthe explanation\b|\bas written\b/i;

/* Everything the structure demands, checked locally — a rule a script must
   follow is not something to ask the model whether it followed. */
function lintDialogue(script: string, cards: Card[]) {
  const issues: string[] = [];
  const lines = script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !/^(Teacher|Student):/.test(l) && l !== PAUSE_MARK);
  if (bad.length) issues.push(`${bad.length} line(s) that are neither a Teacher/Student turn nor ${PAUSE_MARK}: "${bad[0].slice(0, 60)}"`);
  const pauses = lines.filter((l) => l === PAUSE_MARK).length;
  if (pauses !== cards.length) issues.push(`${pauses} ${PAUSE_MARK} lines for ${cards.length} cards — exactly one per card, after its question`);
  const words = wordCount(script);
  if (words > cards.length * WORDS_LINT_PER_CARD) issues.push(`too long: ${words} words for ${cards.length} cards — cut to about ${cards.length * WORDS_PER_CARD} `
    + `(hard ceiling ${cards.length * WORDS_CAP_PER_CARD}). Trim the mechanism talk; keep every question, frame, pause and full answer`);
  for (let i = 1; i < lines.length; i++) if (lines[i] === PAUSE_MARK && lines[i - 1] === PAUSE_MARK) { issues.push('two pauses in a row'); break; }

  /* each card: its question, verbatim, in a Teacher turn, followed by a frame,
     then a pause, then an Okay turn — in deck order */
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normLines = lines.map(norm);
  let cursor = 0;
  const perCard: any[] = [];
  cards.forEach((c, ci) => {
    const qn = norm(c.question);
    let at = -1;
    for (let i = cursor; i < lines.length; i++) if (/^teacher/.test(normLines[i]) && normLines[i].includes(qn)) { at = i; break; }
    const rec: any = { id: c.id, question: c.question, asked: at > -1, framed: false, paused: false, answered: false };
    if (at < 0) {
      issues.push(`card ${ci + 1}: the question is not asked verbatim in a Teacher turn: "${c.question.slice(0, 70)}"`);
    } else {
      const qAt = normLines[at].indexOf(qn);
      /* what follows the question inside the same turn, on the normalised view */
      const afterNorm = normLines[at].slice(qAt + qn.length).trim();
      rec.framed = FRAME_RE.test(lines[at]) || afterNorm.length > 8;
      if (!rec.framed) issues.push(`card ${ci + 1}: no framing sentence after the question ("Take a second." or similar, same turn)`);
      rec.paused = lines[at + 1] === PAUSE_MARK;
      if (!rec.paused) issues.push(`card ${ci + 1}: the line after the question must be ${PAUSE_MARK}`);
      rec.answered = rec.paused && OKAY_RE.test(lines[at + 2] || '');
      if (rec.paused && !rec.answered) issues.push(`card ${ci + 1}: the line after the pause must be a Teacher turn starting "Okay —"`);
      cursor = at + 1;
    }
    perCard.push(rec);
  });
  const deckRefs = lines.filter((l) => DECK_REF_RE.test(l)).slice(0, 3);
  if (deckRefs.length) issues.push(`refers to the deck she cannot see: "${deckRefs[0].slice(0, 80)}"`);
  const docRefs = findDocumentReferences(script);
  if (docRefs.length) issues.push(`describes a document: "${docRefs[0].context.slice(0, 80)}"`);
  return { issues, perCard, pauses, deckRefs, docRefs, words };
}

/* One checkpoint per pause, so Listen stops there, opens the microphone and
   the turn function grades what she says against the card — the conversation
   talks back. The k-th pause is checkpoint k, which is exactly how the audio
   planner numbers the segment that ends on it. The question is the card's
   own; the expected points are its answer, split into the pieces a complete
   answer has to contain. */
function answerPoints(answer: string): string[] {
  const pieces = answer.split(/;\s+|(?<=[.!?])\s+(?=[A-Z0-9])/).map((x) => x.trim()).filter((x) => x.length > 2);
  return (pieces.length ? pieces : [answer.trim()]).slice(0, 6);
}
function dialogueCheckpoints(script: string, cards: Card[]) {
  const lines = script.split('\n');
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const out: any[] = [];
  let offset = 0, k = 0, cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === PAUSE_MARK) {
      /* the Teacher turn carrying the question is the nearest one above */
      let q = '';
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j].trim() === PAUSE_MARK) break;
        if (/^Teacher:/.test(lines[j].trim())) { q = lines[j].trim(); break; }
      }
      const qn = norm(q);
      let card: Card | undefined;
      for (let c = cursor; c < cards.length; c++) if (qn.includes(norm(cards[c].question))) { card = cards[c]; cursor = c + 1; break; }
      if (!card) card = cards.find((c) => qn.includes(norm(c.question)));
      out.push({
        ordinal: k++,
        position_in_script: offset + line.length,
        question: card ? card.question : q.replace(/^Teacher:\s*/, '').trim().slice(0, 300),
        expected_points: card ? answerPoints(card.answer) : [],
        card_id: card ? card.id : null,
      });
    }
    offset += line.length + 1;
  }
  return out;
}

function splitParts(cards: Card[], perPart: number) {
  const parts = Math.max(1, Math.ceil(cards.length / perPart));
  const size = Math.ceil(cards.length / parts);
  const out: Card[][] = [];
  for (let i = 0; i < cards.length; i += size) out.push(cards.slice(i, i + size));
  return out;
}

/* "N144_L1_O4" -> its lecture "N144_L1"; a lecture -> null */
const parentOf = (id: string) => { const p = id.replace(/_O\d+$/, ''); return p === id ? null : p; };
const objectiveNum = (id: string) => { const m = /_O(\d+)$/.exec(id); return m ? Number(m[1]) : null; };

async function requireAdmin(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Missing Authorization bearer token.' };

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const ANON = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_URL || !ANON) return { ok: false, status: 500, error: 'Supabase env not configured.' };

  let uid = '';
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    uid = payload.sub || '';
  } catch (_) { /* handled below */ }
  if (!uid) return { ok: false, status: 401, error: 'Could not read user from token.' };

  /* read through the caller's own token so RLS applies */
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=role&id=eq.${uid}`,
    { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  const rows = await res.json().catch(() => []);
  const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
  if (role !== 'admin') return { ok: false, status: 403, error: 'Admin access required.' };
  return { ok: true, uid, token, SUPABASE_URL, ANON };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }),
      { status: 500, headers: JSON_HDR });
  }

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return new Response(JSON.stringify({ error: gate.error }), { status: gate.status, headers: JSON_HDR });

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'generate';
    /* one ledger per request; see the Ledger comment for why it is not global */
    const ledger = new Ledger();
    /* reads through the caller's own token, so RLS applies */
    const hdr = { apikey: gate.ANON!, Authorization: `Bearer ${gate.token}` };
    const get = async (path: string) => {
      const r = await fetch(`${gate.SUPABASE_URL}/rest/v1/${path}`, { headers: hdr });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`${path.split('?')[0]} read failed (${r.status})`);
      return Array.isArray(j) ? j : [];
    };
    const writeCheckpoints = async (episodeId: string, cps: any[]) => {
      const cpRes = await fetch(`${gate.SUPABASE_URL}/rest/v1/podcast_checkpoints`, {
        method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(cps.map((c) => ({ ...c, episode_id: episodeId }))),
      });
      if (!cpRes.ok) throw new Error(`Saving checkpoints failed (${cpRes.status}): ${(await cpRes.text()).slice(0, 300)}`);
    };

    if (action === 'list-models') {
      const available = await availableModels(apiKey);
      return new Response(JSON.stringify({
        available,
        ranked: rankModels(available),
        would_use: (() => {
          const g = pickModel(available);
          return { generation: g, verification: pickModel(available, g) };
        })(),
      }), { headers: JSON_HDR });
    }

    /* ── checkpoints-cards: the stops of an existing conversation ──
       A part written before Listen could talk back has no checkpoint rows.
       This recomputes them from the stored script and its cards and replaces
       whatever rows the episode had, without rewriting a word. */
    if (action === 'checkpoints-cards') {
      const episodeId = String(body.episode_id || '').trim();
      if (!episodeId) throw new Error('episode_id is required');
      const ep = (await get(`podcast_episodes?select=id,script,format,card_ids&id=eq.${encodeURIComponent(episodeId)}`))[0];
      if (!ep) throw new Error('Episode not found.');
      if (String(ep.format || '') !== 'dialogue') throw new Error('Only conversation episodes have per-card checkpoints.');
      const ids: number[] = (Array.isArray(ep.card_ids) ? ep.card_ids : []).map(Number).filter((n: number) => Number.isFinite(n));
      if (!ids.length) throw new Error('This episode records no card ids.');
      const rows = await get(`flashcards?select=id,question,answer,explanation&id=in.(${ids.join(',')})`);
      const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
      const cards: Card[] = ids.map((id) => byId.get(id)).filter(Boolean).map((r: any) => ({
        id: Number(r.id), question: String(r.question || '').trim(), answer: String(r.answer || '').trim(),
        explanation: r.explanation == null ? null : String(r.explanation),
      }));
      const cps = dialogueCheckpoints(String(ep.script || '').replace(/\r/g, ''), cards);
      if (!body.dry_run) {
        const del = await fetch(`${gate.SUPABASE_URL}/rest/v1/podcast_checkpoints?episode_id=eq.${encodeURIComponent(episodeId)}`,
          { method: 'DELETE', headers: hdr });
        if (!del.ok) throw new Error(`Clearing old checkpoints failed (${del.status})`);
        if (cps.length) await writeCheckpoints(episodeId, cps);
      }
      return new Response(JSON.stringify({
        episode_id: episodeId, cards: cards.length, checkpoints: cps,
        unmatched: cps.filter((c) => c.card_id == null).length, dry_run: !!body.dry_run,
      }), { headers: JSON_HDR });
    }

    /* ── generate-cards: the conversation ── */
    if (action === 'generate-cards') {
      const objectiveId = String(body.objective_id || '').trim();
      const course = String(body.course || '').trim();
      if (!objectiveId) throw new Error('objective_id is required (e.g. N144_L1_O4, or a lecture N144_L1)');
      if (!course) throw new Error('course is required (e.g. NUR144)');
      const perPart = Math.max(1, Math.min(30, Number(body.cards_per_part ?? CARDS_PER_PART_DEFAULT)));

      /* names from the objectives table; the lecture is the objective's parent */
      const lectureId = parentOf(objectiveId) || objectiveId;
      const objRows = await get(`objectives?select=id,lecture,description&id=in.(${encodeURIComponent(objectiveId)},${encodeURIComponent(lectureId)})`);
      const objRow = objRows.find((r: any) => r.id === objectiveId) || {};
      const lecRow = objRows.find((r: any) => r.id === lectureId) || {};
      const num = objectiveNum(objectiveId);
      const lm = /_L(\d+)$/.exec(lectureId);
      const lectureLabel = String(lecRow.lecture || '').trim() || (lm ? 'Lecture ' + lm[1] : lectureId);
      const objLabel = num != null ? `Objective ${num}` : lectureLabel;
      const objDesc = num != null ? String(objRow.description || '').trim()
        : String(lecRow.description || '').replace(/^.*? - /, '').trim();

      /* the deck, in deck order: card ids ascend in the order the deck was
         built (foundation first, then shared features, discriminators,
         treatment), so id order IS the structure */
      const cardRows = await get(`flashcards?select=id,question,answer,explanation,objective_ids&course=eq.${encodeURIComponent(course)}&objective_ids=cs.{${encodeURIComponent(objectiveId)}}&order=id.asc`);
      const cards: Card[] = cardRows.map((r: any) => ({
        id: Number(r.id), question: String(r.question || '').trim(), answer: String(r.answer || '').trim(),
        explanation: r.explanation == null ? null : String(r.explanation),
      })).filter((c: Card) => c.question && c.answer);
      if (!cards.length) throw new Error(`No flashcards carry ${objectiveId} in ${course}.`);

      const partsArr = splitParts(cards, perPart);
      const parts = partsArr.length;
      const part = Math.max(1, Math.min(parts, Number(body.part ?? 1)));
      const mine = partsArr[part - 1];
      const prior = partsArr.slice(0, part - 1).flat().map((c) => c.question);

      /* the lecture this belongs to, for the voice pin and the Listen library */
      let guideSlug = String(body.guide_slug || '').trim();
      if (!guideSlug) {
        const units = await get(`objective_units?select=unit&objective_id=eq.${encodeURIComponent(lectureId)}`);
        const unit = units[0] && units[0].unit ? Number(units[0].unit) : 1;
        const cn = (/^NUR(\d+)/i.exec(course) || [])[1] || course.toLowerCase();
        guideSlug = `nur${cn}-u${unit}-${lm ? 'l' + lm[1] : lectureId.split('_').pop()!.toLowerCase()}`;
      }
      const heading = `${objLabel}${objDesc ? ' — ' + objDesc : ''}${parts > 1 ? ` (part ${part} of ${parts})` : ''}`;
      const ordinal = (num != null ? 100 + num * 10 : 50) + part;

      const available = await availableModels(apiKey);
      const genModel = body.gen_model || pickModel(available);
      const checkModel = body.check_model || pickModel(available, genModel);
      if (!genModel || !checkModel) throw new Error('No usable Gemini model found for this API key.');
      const maxRetries = Math.max(0, Math.min(4, Number(body.max_retries ?? 2)));

      const facts = mine.map((c) => `${c.question} — ${c.answer}`);
      let script = '', lint: any = null, coverage: any[] = [], missing: string[] = [];
      const attempts: any[] = [];
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
          ? dialoguePrompt(objLabel, objDesc, lectureLabel, mine, part, parts, prior)
          : dialogueRepairPrompt(script, lint.issues, missing);
        const out = parseJson(await gemini(apiKey, genModel, prompt,
          { json: true, temperature: attempt === 0 ? 0.7 : 0.4, stage: attempt === 0 ? 'dialogue-write' : 'dialogue-repair', ledger }));
        script = String(out.script || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (!script) throw new Error('Model returned an empty script.');
        lint = lintDialogue(script, mine);
        coverage = await checkCoverage(apiKey, checkModel, facts, script, ledger, 'dialogue-coverage');
        missing = coverage.filter((c) => !c.covered).map((c) => c.fact);
        attempts.push({ attempt: attempt + 1, words: wordCount(script), pauses: lint.pauses,
          issues: lint.issues.length, answers_missed: missing.length });
        if (!lint.issues.length && !missing.length) break;
      }
      const status = (lint.issues.length || missing.length) ? 'incomplete' : 'complete';
      const est = Math.round(wordCount(script) / 150 * 60 + mine.length * 4.5);
      const coverage_report = {
        format: 'dialogue',
        objective_id: objectiveId, lecture_id: lectureId, course, part, parts,
        cards: lint.perCard.map((r: any, i: number) => ({ ...r, answer_covered: coverage[i] ? coverage[i].covered : null })),
        cards_total: mine.length, pauses: lint.pauses,
        structure_issues: lint.issues,
        answers: { total: facts.length, covered: coverage.filter((c) => c.covered).length, missed: missing.length, missing_facts: missing, facts: coverage },
        document_references: lint.docRefs, deck_references: lint.deckRefs,
        words: wordCount(script), estimated_seconds: est,
        summary: `cards ${mine.length}, questions asked ${lint.perCard.filter((r: any) => r.asked).length}/${mine.length}, `
          + `answers covered ${coverage.filter((c) => c.covered).length}/${facts.length}, pauses ${lint.pauses}, structure issues ${lint.issues.length}`,
        attempts, models: { generation: genModel, verification: checkModel },
        usage: ledger.summary(), generated_at: new Date().toISOString(),
      };

      /* one stop per card: where the player pauses, listens, and answers back */
      const cps = dialogueCheckpoints(script, mine);
      let episodeId: string | null = null;
      if (!body.dry_run) {
        const epRes = await fetch(`${gate.SUPABASE_URL}/rest/v1/podcast_episodes`, {
          method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({
            guide_slug: guideSlug, section_heading: heading, ordinal, script, coverage_report, status,
            usage: ledger.summary(), format: 'dialogue', objective_id: objectiveId,
            card_ids: mine.map((c) => c.id), part, parts,
          }),
        });
        const epRows = await epRes.json().catch(() => null);
        if (!epRes.ok) throw new Error(`Saving episode failed (${epRes.status}): ${JSON.stringify(epRows).slice(0, 300)}`);
        episodeId = epRows && epRows[0] && epRows[0].id;
        if (episodeId && cps.length) await writeCheckpoints(episodeId, cps);
      }
      return new Response(JSON.stringify({
        episode_id: episodeId, format: 'dialogue', guide_slug: guideSlug, section_heading: heading, ordinal,
        objective_id: objectiveId, part, parts, cards: mine.map((c) => c.id), status, script,
        checkpoints: cps, coverage_report, usage: ledger.summary(),
      }), { headers: JSON_HDR });
    }

    /* markdown comes from the caller (the app already has it); source_url is a
       fallback so the function is usable without the app. */
    let markdown: string = body.markdown || '';
    if (!markdown && body.source_url) {
      const r = await fetch(body.source_url);
      if (!r.ok) throw new Error(`Could not fetch source_url (${r.status})`);
      markdown = await r.text();
    }
    if (!markdown) throw new Error('markdown (or source_url) is required');

    const sections = splitSections(markdown);

    if (action === 'list-sections') {
      return new Response(JSON.stringify({
        guide_slug: body.guide_slug || null,
        sections: sections.map((s) => ({ ordinal: s.ordinal, heading: s.heading, chars: s.body.length })),
      }), { headers: JSON_HDR });
    }

    /* ── scope-audit ──
       The scoping decision, on its own, with nothing else running. It exists
       because "in_section: 18" is a number you have to take on trust: this
       prints every fact the pass evaluated, its verdict, the model's own reason
       and the lexical overlap, so the filter can be argued with instead of
       believed. Read-only, no script is written, nothing is saved. */
    if (action === 'scope-audit') {
      const gs = body.guide_slug;
      const hd = body.section_heading;
      if (!gs) throw new Error('guide_slug is required');
      if (!hd) throw new Error('section_heading is required');
      const sec = sections.find((x) => x.heading === hd)
        || sections.find((x) => x.heading.trim() === String(hd).trim());
      if (!sec) throw new Error(`Section "${hd}" not found. Available: ${sections.map((x) => x.heading).join(' | ')}`);

      const avail = await availableModels(apiKey);
      const model = body.check_model || pickModel(avail, pickModel(avail));

      let filter = '';
      if (Array.isArray(body.quiz_objective_ids) && body.quiz_objective_ids.length) {
        filter = 'objective_id=in.(' + body.quiz_objective_ids.map(encodeURIComponent).join(',') + ')';
      } else {
        const mm = String(gs).match(/^nur(\d+)/i);
        const prefix = body.quiz_objective_prefix || (mm ? 'N' + mm[1] : '');
        if (!prefix) throw new Error('Could not derive a quiz objective prefix from guide_slug.');
        filter = 'objective_id=like.' + encodeURIComponent(prefix + '%');
      }
      const qr = await fetch(
        `${gate.SUPABASE_URL}/rest/v1/quiz_questions?select=id,objective_id,fact_tested&${filter}`,
        { headers: { apikey: gate.ANON!, Authorization: `Bearer ${gate.token}` } });
      const rows = await qr.json();
      if (!qr.ok) throw new Error(`quiz_questions read failed (${qr.status})`);

      const pool: { objective_id: string; fact: string }[] = [];
      const dupes: string[] = [];
      const seen2 = new Set<string>();
      (Array.isArray(rows) ? rows : []).forEach((r: any) => {
        const f = String(r.fact_tested || '').trim();
        if (!f) return;
        const k = f.toLowerCase();
        if (seen2.has(k)) { dupes.push(f); return; }
        seen2.add(k);
        pool.push({ objective_id: r.objective_id, fact: f });
      });

      const scoped = await scopeToSection(apiKey, model, sec.heading, sec.body, pool.map((q) => q.fact),
                                          ledger);
      const bw = new Set(contentWords(sec.body + ' ' + sec.heading));
      const evaluated = pool.map((q, i) => ({
        objective_id: q.objective_id,
        fact: q.fact,
        in_section: scoped.flags[i] === true,
        reason: scoped.reasons[i] || '',
        overlap: overlapScore(q.fact, bw),
      }));
      const inn = evaluated.filter((r) => r.in_section).sort((a, b) => b.overlap - a.overlap);
      const outn = evaluated.filter((r) => !r.in_section).sort((a, b) => b.overlap - a.overlap);

      return new Response(JSON.stringify({
        guide_slug: gs, section_heading: sec.heading, ordinal: sec.ordinal,
        model,
        objective_ids: [...new Set(pool.map((q) => q.objective_id))].sort(),
        pool: pool.length,
        duplicates_collapsed: dupes.length,
        in_section: inn.length,
        out_of_section: outn.length,
        /* nothing is truncated here — the whole point is to see everything */
        scoped_in: inn,
        scoped_out: outn,
        /* verdicts with no reason mean the model returned fewer entries than
           facts sent; those default to false and would silently under-admit */
        missing_reason: evaluated.filter((r) => !r.reason).length,
        section_chars: sec.body.length,
        usage: ledger.summary(),
      }), { headers: JSON_HDR });
    }

    /* ── generate ── */
    const guideSlug = body.guide_slug;
    const heading = body.section_heading;
    if (!guideSlug) throw new Error('guide_slug is required');
    if (!heading) throw new Error('section_heading is required');

    const section = sections.find((s) => s.heading === heading)
      || sections.find((s) => s.heading.trim() === String(heading).trim());
    if (!section) {
      throw new Error(`Section "${heading}" not found. Available: ${sections.map((s) => s.heading).join(' | ')}`);
    }
    if (!section.body.trim()) throw new Error(`Section "${heading}" has no body text.`);

    const available = await availableModels(apiKey);
    const genModel = body.gen_model || pickModel(available);
    const checkModel = body.check_model || pickModel(available, genModel);
    if (!genModel || !checkModel) throw new Error('No usable Gemini model found for this API key.');

    const maxRetries = Math.max(0, Math.min(5, Number(body.max_retries ?? MAX_RETRIES_DEFAULT)));

    /* 1a — model-extracted facts (this function reads the section itself) */
    const factsRaw = await gemini(apiKey, checkModel, extractFactsPrompt(section.heading, section.body),
      { json: true, temperature: 0.1, stage: 'extract-facts', ledger });
    const facts: string[] = parseJson(factsRaw)
      .map((f: any) => String(typeof f === 'string' ? f : (f.fact || ''))).map((s: string) => s.trim())
      .filter(Boolean);
    if (!facts.length) throw new Error('Fact extraction returned nothing.');

    /* 1b — quiz-derived facts: fact_tested written in a separate earlier pass
       over the same source, so they catch what extraction above missed. Scoped
       to this section against the SECTION SOURCE, never against the script. */
    const crossCheck = body.cross_check !== false;
    let quizPool: { id: any; objective_id: string; fact: string }[] = [];
    let quizFacts: string[] = [];
    let quizScopeError: string | null = null;
    const scopedIn: any[] = [];
    const scopedOut: any[] = [];

    if (crossCheck) {
      try {
        let filter = '';
        if (Array.isArray(body.quiz_objective_ids) && body.quiz_objective_ids.length) {
          filter = 'objective_id=in.(' + body.quiz_objective_ids.map(encodeURIComponent).join(',') + ')';
        } else {
          /* "nur144-u1-l1" -> "N144"; overridable via quiz_objective_prefix */
          const m = String(guideSlug).match(/^nur(\d+)/i);
          const prefix = body.quiz_objective_prefix || (m ? 'N' + m[1] : '');
          if (!prefix) throw new Error('Could not derive a quiz objective prefix from guide_slug.');
          filter = 'objective_id=like.' + encodeURIComponent(prefix + '%');
        }
        const qRes = await fetch(
          `${gate.SUPABASE_URL}/rest/v1/quiz_questions?select=id,objective_id,fact_tested&${filter}`,
          { headers: { apikey: gate.ANON!, Authorization: `Bearer ${gate.token}` } });
        const qRows = await qRes.json();
        if (!qRes.ok) throw new Error(`quiz_questions read failed (${qRes.status})`);

        const seen = new Set<string>();
        (Array.isArray(qRows) ? qRows : []).forEach((r: any) => {
          const f = String(r.fact_tested || '').trim();
          if (!f) return;
          const key = f.toLowerCase();
          if (seen.has(key)) return;          /* same fact behind several questions */
          seen.add(key);
          quizPool.push({ id: r.id, objective_id: r.objective_id, fact: f });
        });

        if (quizPool.length) {
          const scoped = await scopeToSection(apiKey, checkModel, section.heading, section.body,
            quizPool.map((q) => q.fact), ledger);
          quizFacts = quizPool.filter((_, i) => scoped.flags[i]).map((q) => q.fact);

          /* Full audit of the scoping decision. Admitted facts are listed in
             full; rejected ones are ranked by lexical overlap with the section
             so the near-misses — the ones worth arguing about — are at the top
             instead of buried under facts from unrelated lectures. */
          const bodyWords = new Set(contentWords(section.body + ' ' + section.heading));
          quizPool.forEach((q, i) => {
            const row = {
              objective_id: q.objective_id,
              fact: q.fact,
              reason: scoped.reasons[i] || '',
              overlap: overlapScore(q.fact, bodyWords),
            };
            if (scoped.flags[i]) scopedIn.push(row); else scopedOut.push(row);
          });
          scopedIn.sort((a, b) => b.overlap - a.overlap);
          scopedOut.sort((a, b) => b.overlap - a.overlap);
        }
      } catch (e) {
        quizScopeError = String((e as Error).message || e);
      }
    }

    /* 2..5 — write, verify against BOTH lists, repair */
    let script = '', placed: any[] = [];
    let coverage: any[] = [], missing: string[] = [];
    let quizCoverage: any[] = [], quizMissing: string[] = [];
    let unsourced: any[] = [];
    let docRefs: any[] = [];
    const attempts: any[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const prompt = attempt === 0
        ? scriptPrompt(section.heading, section.body, facts)
        : repairPrompt(section.heading, section.body, facts, script, missing, quizMissing,
                       unsourced.map((u: any) => u.claim),
                       docRefs.map((h: any) => h.context));

      const out = parseJson(await gemini(apiKey, genModel, prompt,
        { json: true, temperature: attempt === 0 ? 0.6 : 0.35,
          stage: attempt === 0 ? 'write' : 'repair', ledger }));

      const raw = String(out.script || '');
      const cp = placeCheckpoints(raw, Array.isArray(out.checkpoints) ? out.checkpoints : []);
      script = cp.script;
      placed = cp.placed;
      if (!script) throw new Error('Model returned an empty script.');

      coverage = await checkCoverage(apiKey, checkModel, facts, script, ledger, 'coverage-model');
      missing = coverage.filter((c) => !c.covered).map((c) => c.fact);

      quizCoverage = await checkCoverage(apiKey, checkModel, quizFacts, script, ledger, 'coverage-quiz');
      quizMissing = quizCoverage.filter((c) => !c.covered).map((c) => c.fact);

      unsourced = await findUnsourced(apiKey, checkModel, section.heading, section.body, script, ledger);
      docRefs = findDocumentReferences(script);

      attempts.push({
        attempt: attempt + 1, words: wordCount(script),
        model_covered: coverage.length - missing.length, model_missed: missing.length,
        quiz_covered: quizCoverage.length - quizMissing.length, quiz_missed: quizMissing.length,
        unsourced: unsourced.length,
        document_references: docRefs.length,
        checkpoints: placed.length,
        checkpoints_anchored: placed.filter((p: any) => p.how === 'question').length,
      });
      if (!missing.length && !quizMissing.length && !unsourced.length && !docRefs.length) break;
    }

    /* a miss on either list, an unsourced claim, or a sentence that describes
       the document she cannot see, all make the section incomplete */
    const status = (missing.length || quizMissing.length || unsourced.length || docRefs.length)
      ? 'incomplete' : 'complete';

    const finalCheckpoints = placed
      .filter((c: any) => c.question)
      .map((c: any, i: number) => ({
        ordinal: i,
        position_in_script: c.pos,
        question: c.question,
        expected_points: Array.isArray(c.expected_points)
          ? c.expected_points.map((p: any) => String(p).trim()).filter(Boolean) : [],
      }));

    /* how each pause was located, and what the listener hears right before it */
    const checkpoint_placement = placed.filter((c: any) => c.question).map((c: any, i: number) => ({
      ordinal: i,
      position_in_script: c.pos,
      placed_by: c.how,
      preceding_text: script.slice(Math.max(0, c.pos - 90), c.pos).trim(),
      gap_from_previous: c.gap_from_previous,
      crowded: c.crowded === true,
    }));

    /* The two passes stay separate on purpose: merging them into one score
       would hide which check found the gap. */
    const coverage_report = {
      model_extracted: {
        total: facts.length,
        covered: coverage.filter((c) => c.covered).length,
        missed: missing.length,
        missing_facts: missing,
        facts: coverage,
      },
      quiz_derived: {
        enabled: crossCheck,
        pool: quizPool.length,          /* distinct fact_tested for the course */
        in_section: quizFacts.length,   /* of those, present in this section's source */
        total: quizFacts.length,
        covered: quizCoverage.filter((c) => c.covered).length,
        missed: quizMissing.length,
        missing_facts: quizMissing,
        facts: quizCoverage,
        error: quizScopeError,
        scoped_in: scopedIn,
        scoped_out: scopedOut.slice(0, 40),
        scoped_out_total: scopedOut.length,
      },
      unsourced_claims: unsourced,
      document_references: docRefs,
      checkpoint_placement,
      summary: `model-extracted facts ${coverage.filter((c) => c.covered).length}/${facts.length}`
        + (crossCheck && !quizScopeError
            ? `, quiz-derived facts ${quizCoverage.filter((c) => c.covered).length}/${quizFacts.length}`
            : '')
        + `, unsourced claims ${unsourced.length}`
        + `, document references ${docRefs.length}`,
      attempts,
      words: wordCount(script),
      models: { generation: genModel, verification: checkModel },
      /* measured, not estimated — see the Ledger comment */
      usage: ledger.summary(),
      generated_at: new Date().toISOString(),
    };

    let episodeId: string | null = null;
    if (!body.dry_run) {
      const insHdr = {
        apikey: gate.ANON!, Authorization: `Bearer ${gate.token}`,
        'Content-Type': 'application/json', Prefer: 'return=representation',
      };
      const epRes = await fetch(`${gate.SUPABASE_URL}/rest/v1/podcast_episodes`, {
        method: 'POST', headers: insHdr,
        body: JSON.stringify({
          guide_slug: guideSlug, section_heading: section.heading, ordinal: section.ordinal,
          script, coverage_report, status, usage: ledger.summary(),
        }),
      });
      const epRows = await epRes.json().catch(() => null);
      if (!epRes.ok) throw new Error(`Saving episode failed (${epRes.status}): ${JSON.stringify(epRows).slice(0, 300)}`);
      episodeId = epRows && epRows[0] && epRows[0].id;

      if (episodeId && finalCheckpoints.length) {
        const cpRes = await fetch(`${gate.SUPABASE_URL}/rest/v1/podcast_checkpoints`, {
          method: 'POST', headers: insHdr,
          body: JSON.stringify(finalCheckpoints.map((c: any) => ({ ...c, episode_id: episodeId }))),
        });
        if (!cpRes.ok) throw new Error(`Saving checkpoints failed (${cpRes.status}): ${(await cpRes.text()).slice(0, 300)}`);
      }
    }

    return new Response(JSON.stringify({
      episode_id: episodeId, guide_slug: guideSlug, section_heading: section.heading,
      ordinal: section.ordinal, status, script,
      facts, quiz_facts: quizFacts,
      checkpoints: finalCheckpoints, coverage_report,
      usage: ledger.summary(),
    }), { headers: JSON_HDR });

  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error).message || err) }),
      { status: 500, headers: JSON_HDR });
  }
});
