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
const WORDS_MIN = 1200;
const WORDS_MAX = 1600;

/* Model names change often, so nothing is hardcoded as "the" model: the list
   is fetched from the API and the first available preference is used. */
const GEN_PREFS = [
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-pro-latest',
  'gemini-flash-latest', 'gemini-2.0-flash',
];
const CHECK_PREFS = [
  'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash',
  'gemini-2.5-pro', 'gemini-pro-latest',
];

let modelCache: string[] | null = null;

async function availableModels(apiKey: string): Promise<string[]> {
  if (modelCache) return modelCache;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`);
  if (!res.ok) throw new Error(`ListModels failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const names: string[] = (data.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m: any) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  modelCache = names;
  return names;
}

function pickModel(available: string[], prefs: string[]): string {
  for (const p of prefs) {
    if (available.includes(p)) return p;
    const pre = available.find((m) => m.startsWith(p));   // e.g. -preview suffixes
    if (pre) return pre;
  }
  /* nothing preferred is present — fall back to any non-preview gemini model */
  const gem = available.filter((m) => m.startsWith('gemini') && !/vision|embedding|tts|image/.test(m));
  const stable = gem.filter((m) => !/preview|exp/.test(m));
  const pool = stable.length ? stable : gem;
  return pool.find((m) => m.includes('pro')) || pool[0] || '';
}

async function gemini(apiKey: string, model: string, prompt: string, opts: {
  json?: boolean; temperature?: number; maxOutputTokens?: number;
} = {}): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.6,
        maxOutputTokens: opts.maxOutputTokens ?? 16384,
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
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${JSON.stringify(data).slice(0, 600)}`);
  const cand = data.candidates && data.candidates[0];
  if (!cand) throw new Error(`Gemini ${model} returned no candidate: ${JSON.stringify(data).slice(0, 400)}`);
  if (cand.finishReason && cand.finishReason !== 'STOP' && !cand.content)
    throw new Error(`Gemini ${model} stopped: ${cand.finishReason}`);
  const parts = (cand.content && cand.content.parts) || [];
  return parts.map((p: any) => p.text || '').join('').trim();
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
  Convey ★ emphasis in words ("she flagged this one — it's on the exam").`;

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
- ONE narrator speaking directly to her as "you". Warm, plain, direct.
- Conversational but DENSE. This is a full lecture, not a summary. Every fact
  below must be taught, not gestured at.
- Plain flowing prose meant to be read aloud. NO stage directions, NO [pause]
  or [beat] markers, NO speaker labels, NO headings, NO bullet points, NO
  markdown, NO numbered lists. Just paragraphs.
- Spell out symbols and abbreviations as speech: "↓" becomes "decreased",
  "1500 mL" becomes "fifteen hundred milliliters", "GI" stays "G I".
- Explain mechanism where the source explains it ("the reason that matters is…").
- Target ${WORDS_MIN}-${WORDS_MAX} words.

CHECKPOINTS:
- Every 700-900 words, stop and ask ONE open recall question, then place a line
  containing exactly [[CHECKPOINT]] on its own line immediately after the
  question. Expect 2 checkpoints for a script this length; 1 is acceptable if
  the section is short.
- Open recall only: "what's the difference between…", "why does…", "walk me
  through what happens when…". NEVER multiple choice, never yes/no.
- Ask about something already taught ABOVE that point in the script.
- After the [[CHECKPOINT]] line, resume teaching naturally — do not answer your
  own question immediately; continue as if she has just answered.

EVERY ONE of these facts must be taught somewhere in the script:
${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Return ONLY JSON of the form:
{"script":"<the full narration, with [[CHECKPOINT]] lines in place>",
 "checkpoints":[{"question":"<the question exactly as it appears in the script>",
                 "expected_points":["<specific fact a correct answer must contain>", "..."]}]}
The checkpoints array must be in the same order as the [[CHECKPOINT]] markers,
one entry per marker. expected_points are the concrete things she has to say
for the answer to count as correct — drawn only from the section text.

SECTION HEADING: ${heading}

SECTION TEXT:
"""
${body}
"""`;
}

function repairPrompt(heading: string, body: string, facts: string[], script: string,
                      missing: string[], quizMissing: string[]) {
  const blocks: string[] = [];
  if (missing.length) blocks.push(
`These facts are MISSING and must now be taught explicitly:
${missing.map((f, i) => `${i + 1}. ${f}`).join('\n')}`);
  if (quizMissing.length) blocks.push(
`These points are stated in the SECTION TEXT but are missing from your script.
Find each one in the section text and teach it. If you genuinely cannot find it
in the section text, leave it out — do NOT supply it from outside knowledge:
${quizMissing.map((f, i) => `${i + 1}. ${f}`).join('\n')}`);

  return `The lecture script below is missing content it was required to teach. Revise it.

${SOURCE_RULES}

${blocks.join('\n\n')}

Rules for the revision:
- Keep everything already covered. Do not drop anything to make room.
- Keep the same single-narrator second-person voice and plain prose.
- Keep [[CHECKPOINT]] lines and their questions, and return the matching
  checkpoints array. You may add one checkpoint if the script grew a lot.
- No stage directions, labels, headings, bullets or markdown.
- Length may grow to about ${WORDS_MAX + 400} words if needed to fit the misses.

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

Return ONLY a JSON array, one entry per fact, in the same order:
[{"i":0,"in_section":true}]

SECTION HEADING: ${heading}

SECTION TEXT:
"""
${body}
"""

FACTS:
${facts.map((f, i) => `${i}. ${f}`).join('\n')}`;
}

function coveragePrompt(facts: string[], script: string) {
  return `Check whether each fact is actually TAUGHT in the narration script below.

Judge by MEANING, not wording. A fact counts as covered when a listener who
heard only this script would know it. Paraphrase is fine. Different word order
is fine. Spelled-out numbers ("fifteen hundred milliliters" for "1500 mL") are
fine.

A fact is NOT covered when:
- it is absent,
- only the topic is mentioned without the specific content,
- a number, unit, range, direction or term differs from the fact,
- the fact records a CONFLICT between sources and the script gives only one
  variant or resolves it.

Be strict. If you are unsure, mark it not covered.

Return ONLY a JSON array, one entry per fact, in the same order:
[{"i":0,"covered":true,"evidence":"<short quote from the script, or empty>"}]

FACTS:
${facts.map((f, i) => `${i}. ${f}`).join('\n')}

SCRIPT:
"""
${script}
"""`;
}

/* pull [[CHECKPOINT]] markers out, recording where each one sat */
function extractCheckpoints(rawScript: string) {
  const raw = rawScript.replace(/^\s+/, '');
  const re = /^[ \t]*\[\[\s*CHECKPOINT\s*\]\][ \t]*$/gm;
  let out = '', last = 0, m: RegExpExecArray | null;
  const positions: number[] = [];
  while ((m = re.exec(raw)) !== null) {
    out += raw.slice(last, m.index);
    out = out.replace(/\s+$/, '');
    positions.push(out.length);
    out += '\n\n';
    last = m.index + m[0].length;
    while (last < raw.length && /[ \t\n]/.test(raw[last])) last++;
  }
  out += raw.slice(last);
  return { script: out.trim(), positions };
}

const wordCount = (s: string) => (s.trim().match(/\S+/g) || []).length;

/* one coverage pass over an arbitrary fact list */
async function checkCoverage(apiKey: string, model: string, facts: string[], script: string) {
  if (!facts.length) return [] as any[];
  const rows: any[] = [];
  const CHUNK = 120;
  for (let s = 0; s < facts.length; s += CHUNK) {
    const slice = facts.slice(s, s + CHUNK);
    const out = parseJson(await gemini(apiKey, model, coveragePrompt(slice, script),
      { json: true, temperature: 0 }));
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
async function scopeToSection(apiKey: string, model: string, heading: string, body: string, facts: string[]) {
  const flags: boolean[] = new Array(facts.length).fill(false);
  const CHUNK = 120;
  for (let s = 0; s < facts.length; s += CHUNK) {
    const slice = facts.slice(s, s + CHUNK);
    const out = parseJson(await gemini(apiKey, model, scopePrompt(heading, body, slice),
      { json: true, temperature: 0 }));
    (Array.isArray(out) ? out : []).forEach((r: any, idx: number) => {
      const i = Number.isInteger(r && r.i) ? r.i : idx;
      if (i >= 0 && i < slice.length) flags[s + i] = (r.in_section === true);
    });
  }
  return flags;
}

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

    if (action === 'list-models') {
      const available = await availableModels(apiKey);
      return new Response(JSON.stringify({
        available,
        would_use: { generation: pickModel(available, GEN_PREFS), verification: pickModel(available, CHECK_PREFS) },
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
    const genModel = body.gen_model || pickModel(available, GEN_PREFS);
    const checkModel = body.check_model || pickModel(available, CHECK_PREFS);
    if (!genModel || !checkModel) throw new Error('No usable Gemini model found for this API key.');

    const maxRetries = Math.max(0, Math.min(5, Number(body.max_retries ?? MAX_RETRIES_DEFAULT)));

    /* 1a — model-extracted facts (this function reads the section itself) */
    const factsRaw = await gemini(apiKey, checkModel, extractFactsPrompt(section.heading, section.body),
      { json: true, temperature: 0.1 });
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
          const flags = await scopeToSection(apiKey, checkModel, section.heading, section.body,
            quizPool.map((q) => q.fact));
          quizFacts = quizPool.filter((_, i) => flags[i]).map((q) => q.fact);
        }
      } catch (e) {
        quizScopeError = String((e as Error).message || e);
      }
    }

    /* 2..5 — write, verify against BOTH lists, repair */
    let script = '', checkpoints: any[] = [], positions: number[] = [];
    let coverage: any[] = [], missing: string[] = [];
    let quizCoverage: any[] = [], quizMissing: string[] = [];
    const attempts: any[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const prompt = attempt === 0
        ? scriptPrompt(section.heading, section.body, facts)
        : repairPrompt(section.heading, section.body, facts, script, missing, quizMissing);

      const out = parseJson(await gemini(apiKey, genModel, prompt,
        { json: true, temperature: attempt === 0 ? 0.6 : 0.35 }));

      const cleaned = extractCheckpoints(String(out.script || ''));
      script = cleaned.script;
      positions = cleaned.positions;
      checkpoints = Array.isArray(out.checkpoints) ? out.checkpoints : [];
      if (!script) throw new Error('Model returned an empty script.');

      coverage = await checkCoverage(apiKey, checkModel, facts, script);
      missing = coverage.filter((c) => !c.covered).map((c) => c.fact);

      quizCoverage = await checkCoverage(apiKey, checkModel, quizFacts, script);
      quizMissing = quizCoverage.filter((c) => !c.covered).map((c) => c.fact);

      attempts.push({
        attempt: attempt + 1, words: wordCount(script),
        model_covered: coverage.length - missing.length, model_missed: missing.length,
        quiz_covered: quizCoverage.length - quizMissing.length, quiz_missed: quizMissing.length,
      });
      if (!missing.length && !quizMissing.length) break;
    }

    /* either list having a miss makes the section incomplete */
    const status = (missing.length || quizMissing.length) ? 'incomplete' : 'complete';

    /* pair checkpoints with the marker positions actually found */
    const pairedCount = Math.min(checkpoints.length, positions.length);
    const finalCheckpoints = checkpoints.slice(0, Math.max(pairedCount, checkpoints.length))
      .map((c: any, i: number) => ({
        ordinal: i,
        position_in_script: i < positions.length ? positions[i] : script.length,
        question: String((c && c.question) || '').trim(),
        expected_points: Array.isArray(c && c.expected_points)
          ? c.expected_points.map((p: any) => String(p).trim()).filter(Boolean) : [],
      }))
      .filter((c: any) => c.question);

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
      },
      summary: `model-extracted facts ${coverage.filter((c) => c.covered).length}/${facts.length}`
        + (crossCheck && !quizScopeError
            ? `, quiz-derived facts ${quizCoverage.filter((c) => c.covered).length}/${quizFacts.length}`
            : ''),
      attempts,
      words: wordCount(script),
      models: { generation: genModel, verification: checkModel },
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
          script, coverage_report, status,
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
    }), { headers: JSON_HDR });

  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error).message || err) }),
      { status: 500, headers: JSON_HDR });
  }
});
