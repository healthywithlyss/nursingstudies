import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* ═══════════════════════════════════════════════════════════════════════
   podcast-turn  —  coached audio study, phase 3

   One spoken turn at a checkpoint: hear her, work out whether she ANSWERED or
   ASKED, respond to what she actually said, and speak the response back.

   NOT admin-only. Generation is; this is the student-facing half, so it needs
   nothing but a valid signed-in user.

   THE CRITICAL PATH IS SHORT ON PURPOSE
   She is sitting in silence waiting to hear something, so 'turn' does the
   minimum: transcribe, reason, speak. Mapping her misses onto flashcards and
   quiz questions is real work but nobody is waiting for it, so it is a separate
   'attribute' action the client fires afterwards, while the response plays.

   ANSWERING FROM SOURCE ONLY
   The same rule that governs the script governs this: the section text is the
   only permitted source. If she asks something the section does not cover, the
   honest answer is that it is not in her materials — not a correct answer from
   general nursing knowledge, which would quietly teach her something her exam
   may not agree with. Where the source CONFLICTS with itself, every variant is
   given and the conflict is named.

   POST body:
     action              'turn' (default) | 'attribute' | 'models'
     episode_id          uuid
     checkpoint_ordinal  integer
     audio_b64           16 kHz mono WAV from the browser
     section_text        the section markdown — the only permitted source
     voice               the episode's voice, so the reply sounds like the narrator
     missed / question_text / expected  (attribute)
   ═══════════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const JSON_HDR = { ...CORS, 'Content-Type': 'application/json' };

const DEFAULT_VOICE = 'Charon';
/* a spoken correction that runs longer than this stops being a correction */
const MAX_REPLY_WORDS = 110;

/* ── models ───────────────────────────────────────────────────────────────
   Same live discovery as everywhere else in this project. Audio understanding
   is a capability of the general models rather than a separate product, so a
   dedicated transcription name is PREFERRED where the key has one and the
   ranked text model is used otherwise — reported either way, so which one
   actually ran is never a guess. */
const NOT_TEXT = /(tts|image|vision|embedding|robotics|computer-use|lyria|nano-banana|deep-research|omni|antigravity|gemma)/i;
const IS_TTS = /tts/i;
const NOT_TTS = /(image|embedding|robotics|computer-use|lyria|nano-banana|deep-research)/i;
const IS_TRANSCRIBE = /(transcribe|speech-to-text|stt)/i;

function modelVersion(n: string){ const m=n.match(/gemini-(\d+(?:\.\d+)?)/i); return m?parseFloat(m[1]):0; }
function modelTier(n: string){
  if(/flash-lite/i.test(n)) return 1;
  if(/flash/i.test(n)) return 2;
  if(/pro/i.test(n)) return 3;
  return 0;
}
const byRank = (a: string,b: string) => (modelVersion(b)-modelVersion(a)) || (modelTier(b)-modelTier(a));

let modelCache: string[] | null = null;
async function listModels(apiKey: string): Promise<string[]> {
  if (modelCache) return modelCache;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`);
  if (!r.ok) throw new Error(`ListModels failed (${r.status})`);
  const d = await r.json();
  modelCache = (d.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m: any) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  return modelCache!;
}
function pickText(all: string[]){
  const u = all.filter((m) => /^gemini/i.test(m) && !NOT_TEXT.test(m));
  const stable = u.filter((m) => !/preview|exp\b/i.test(m));
  let pool = (stable.length ? stable : u).filter((m) => modelVersion(m) > 0);
  const full = pool.filter((m) => modelTier(m) >= 2);
  if (full.length) pool = full;
  return pool.sort(byRank)[0] || '';
}
function pickTranscribe(all: string[]){
  const ded = all.filter((m) => /^gemini/i.test(m) && IS_TRANSCRIBE.test(m)).sort(byRank);
  return { model: ded[0] || pickText(all), dedicated: !!ded[0] };
}
function pickTts(all: string[]){
  return all.filter((m) => /^gemini/i.test(m) && IS_TTS.test(m) && !NOT_TTS.test(m)).sort(byRank)[0] || '';
}

async function gemini(apiKey: string, model: string, parts: any[], opts: any = {}) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: opts.temperature ?? 0,
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
          ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }) });
  const d = await r.json();
  if (!r.ok) throw new Error(`Gemini ${model} ${r.status}: ${JSON.stringify(d).slice(0, 400)}`);
  const c = d.candidates && d.candidates[0];
  if (!c) throw new Error(`Gemini ${model} returned no candidate`);
  const text = ((c.content && c.content.parts) || []).map((p: any) => p.text || '').join('').trim();
  if (c.finishReason === 'MAX_TOKENS') {
    throw new Error(`Gemini ${model} hit the output cap; reply truncated after ${text.length} chars.`);
  }
  return { text, usage: d.usageMetadata || {}, raw: d };
}

function parseJson(raw: string): any {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const s = t.indexOf('['), o = t.indexOf('{');
  const start = (s === -1) ? o : (o === -1 ? s : Math.min(s, o));
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (start !== -1 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error('Model did not return parsable JSON: ' + raw.slice(0, 200));
}

/* ── vocabulary bias ──────────────────────────────────────────────────────
   Generic transcription mangles this vocabulary — "hematochezia" becomes
   "hemato kesia", "Zenker" becomes "Zanker". The floor list is always sent;
   terms from the section itself are added so the bias tracks whatever she is
   actually studying rather than one lecture's worth of hardcoding. */
const FLOOR_TERMS = ['xiphoid','hematochezia','hematemesis','rectorrhagia','melena','pyrosis',
  'halitosis','dyspepsia','odynophagia','achalasia','Zenker','paraesophageal','parietal',
  'pernicious','Hashimoto','Addison','Graves','Helicobacter pylori','pyloric stenosis',
  'gastritis','duodenal'];

/* Words the guide uses that ordinary English does not. Long, capitalised or
   simply rare — cheap to compute and it costs nothing to over-include. */
function sectionTerms(md: string): string[] {
  const words = String(md).replace(/[^A-Za-zÀ-ɏ\s-]/g, ' ').split(/\s+/);
  const common = new Set(('the and for with that this from have been will not are was were which'
    + ' can may should must their there when where what who whom into onto over under between'
    + ' patient nursing assessment management treatment because before after while during'
    + ' about above below through against under more most less least both each other some').split(' '));
  const seen = new Set<string>(), out: string[] = [];
  for (const w0 of words) {
    const w = w0.trim();
    if (w.length < 6) continue;
    const low = w.toLowerCase();
    if (common.has(low) || seen.has(low)) continue;
    /* rare-looking: unusually long, or capitalised mid-text (a proper noun) */
    if (w.length >= 9 || /^[A-Z][a-z]{4,}/.test(w)) { seen.add(low); out.push(w); }
    if (out.length >= 220) break;
  }
  return out;
}

function transcribePrompt(terms: string[]) {
  return `Transcribe this recording of a nursing student speaking. She is answering a
recall question out loud, or asking one.

Return ONLY the words she said, verbatim. No commentary, no speaker labels, no
punctuation guesses beyond ordinary sentence punctuation, no summary. If a
stretch is unintelligible write [inaudible] for that stretch only. If the
recording contains no speech at all, return an empty string.

She is studying gastrointestinal nursing, so expect this vocabulary and spell it
correctly rather than phonetically:
${terms.join(', ')}`;
}

/* ── the turn ─────────────────────────────────────────────────────────────
   Classification and response in ONE call, because two round trips is two lots
   of latency while she sits in silence, and the response depends on the
   classification anyway. */
function turnPrompt(question: string, expected: string[], sectionText: string, transcript: string) {
  return `A nursing student is part-way through an audio lecture. It paused and asked her a
question. This is what she said back.

THE ONLY PERMITTED SOURCE is the SECTION TEXT below. Not general nursing
knowledge, not what you believe to be true, not another part of the guide.
- If she asks about something the section does not cover, say plainly that it is
  not in her lecture materials. Do NOT answer it from outside knowledge. Saying
  "I don't have that in your notes" is the correct, useful answer.
- Where the section CONFLICTS with itself — the same measurement given two or
  three different ways — say that her materials disagree and give every variant.
  Never pick one and present it as the answer.

FIRST decide what she did:
- "answer"   she attempted the question, however roughly
- "question" she asked something instead
- "unclear"  silence, noise, or nothing that resolves either way

IF SHE ANSWERED, grade it. Be GENEROUS ABOUT WORDING AND STRICT ABOUT CONCEPTS.
- She is speaking from memory, out loud, with no screen. Everyday phrasing for a
  clinical idea is CORRECT: "the nose to ear to sternum thing" is the NEX
  measurement and counts as knowing it. Name the proper term in your reply, but
  do not mark her wrong for it.
- A right concept with the wrong label is a right concept with the wrong label:
  credit the concept, correct the label.
- What is NOT generous: a missing concept, a wrong number, a wrong direction, a
  wrong drug, a wrong order of events. Those are misses, and saying otherwise
  would be lying to her.
- NEVER let a vague answer through. "Something about the stomach lining" is not
  the mucosal barrier — it is a gesture at it. If you cannot tell whether she
  knows it, she has not shown that she knows it.

verdict is one of:
- "right"   every expected point present, in any wording
- "partial" some present, some missing — the common case
- "wrong"   the substance is wrong, or she said nothing usable

THEN write what the narrator says next. This is SPOKEN, so:
- Plain speech, contractions, no markdown, no lists, no headings, no stage
  directions. Under ${MAX_REPLY_WORDS} words.
- right    → confirm briefly and move on. One short sentence. Do NOT praise at
             length; it wastes the time she came here to spend learning.
- partial  → name what she got, name what she missed, then restate the whole
             thing cleanly so she hears it correct and entire once.
- wrong    → give the answer WITH the mechanism, so it is learnable rather than
             a fact to memorise. Say plainly that it was not right. Do not soften
             it into sounding like she was close when she was not.
- a question → answer it from the section text, then hand her back to where she
             was in one short clause.
- Spell for the ear: "B twelve", "I and O", "H two receptor antagonists".

ALSO return the concepts she did not show she knew, as short phrases, for
prioritising her flashcards later. Empty when she got it all.

Return ONLY JSON:
{"kind":"answer|question|unclear",
 "verdict":"right|partial|wrong|na",
 "got":["<expected point she did show, verbatim from the list>"],
 "missed":["<expected point she did not show, verbatim from the list>"],
 "missed_concepts":["<short phrase naming what to revisit>"],
 "in_source":true,
 "reply":"<what the narrator says next, spoken>"}
in_source is false only when she asked about something the section does not cover.

THE QUESTION SHE WAS ASKED:
${question}

WHAT A COMPLETE ANSWER CONTAINS:
${(expected || []).map((e, i) => `${i + 1}. ${e}`).join('\n') || '(none recorded)'}

SECTION TEXT — the only permitted source:
"""
${sectionText}
"""

WHAT SHE SAID:
"""
${transcript}
"""`;
}

/* ── speech ───────────────────────────────────────────────────────────────
   Same voice as the episode, so the correction sounds like the narrator rather
   than a second person interrupting. */
function wavFromPcm(pcm: Uint8Array, rate: number){
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i=0;i<s.length;i++) out[o+i]=s.charCodeAt(i); };
  w(0,'RIFF'); dv.setUint32(4, 36+pcm.length, true); w(8,'WAVE'); w(12,'fmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,rate,true); dv.setUint32(28,rate*2,true);
  dv.setUint16(32,2,true); dv.setUint16(34,16,true);
  w(36,'data'); dv.setUint32(40,pcm.length,true); out.set(pcm,44);
  return out;
}
function b64ToBytes(b64: string){
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
function bytesToB64(b: Uint8Array){
  let s = '';
  for (let i=0;i<b.length;i+=0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i,i+0x8000)) as any);
  return btoa(s);
}

async function speak(apiKey: string, model: string, voice: string, text: string) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }) });
  const d = await r.json();
  if (!r.ok) throw new Error(`TTS ${model} ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  const part = ((d.candidates?.[0]?.content?.parts) || []).find((p: any) => p.inlineData?.data);
  if (!part) throw new Error('TTS returned no audio');
  const mime = String(part.inlineData.mimeType || '');
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
  const pcm = b64ToBytes(part.inlineData.data);
  return { b64: bytesToB64(wavFromPcm(pcm, rate)), seconds: pcm.length/(rate*2), usage: d.usageMetadata || {} };
}

/* ── auth: any signed-in user ─────────────────────────────────────────── */
async function requireUser(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Missing Authorization bearer token.' };
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const ANON = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_URL || !ANON) return { ok: false, status: 500, error: 'Supabase env not configured.' };
  let uid = '';
  try {
    uid = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sub || '';
  } catch (_) { /* handled below */ }
  if (!uid) return { ok: false, status: 401, error: 'Could not read user from token.' };
  return { ok: true, uid, token, SUPABASE_URL, ANON };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }),
    { status: 500, headers: JSON_HDR });

  try {
    const gate = await requireUser(req);
    if (!gate.ok) return new Response(JSON.stringify({ error: gate.error }),
      { status: gate.status, headers: JSON_HDR });

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'turn';
    const rest = (path: string, init?: RequestInit) => fetch(`${gate.SUPABASE_URL}/rest/v1/${path}`, {
      ...(init || {}),
      headers: { apikey: gate.ANON!, Authorization: `Bearer ${gate.token}`,
                 'Content-Type': 'application/json', ...((init && (init.headers as any)) || {}) },
    });

    if (action === 'models') {
      const all = await listModels(apiKey);
      const t = pickTranscribe(all);
      return new Response(JSON.stringify({
        transcription: t.model, transcription_is_dedicated: t.dedicated,
        reasoning: pickText(all), tts: pickTts(all), models_seen: all.length,
      }), { headers: JSON_HDR });
    }

    /* ── attribute: map misses onto her flashcards and quiz questions ──
       Deliberately OFF the critical path — the client fires this while the
       spoken reply is playing, so its latency costs her nothing. */
    if (action === 'attribute') {
      const missed: string[] = Array.isArray(body.missed_concepts) ? body.missed_concepts : [];
      if (!missed.length) return new Response(JSON.stringify({ written: 0, reason: 'nothing missed' }),
        { headers: JSON_HDR });

      const prefix = String(body.objective_prefix || '');
      if (!prefix) throw new Error('objective_prefix is required');
      /* flashcards are keyed by course, not by objective prefix, and the two
         columns are question/answer rather than front/back — checked against
         the live schema rather than assumed */
      const course = String(body.course || '');

      const [qr, cr] = await Promise.all([
        rest(`quiz_questions?select=id,fact_tested&objective_id=like.${encodeURIComponent(prefix + '%')}`),
        course
          ? rest(`flashcards?select=id,question&course=eq.${encodeURIComponent(course)}`).catch(() => null as any)
          : Promise.resolve(null as any),
      ]);
      const questions = qr.ok ? await qr.json() : [];
      const cards = (cr && cr.ok) ? await cr.json() : [];

      const all = await listModels(apiKey);
      const model = pickText(all);
      const out = parseJson((await gemini(apiKey, model, [{ text:
`Match each CONCEPT she fumbled out loud to the specific study items that drill it.

Only match an item that genuinely tests that concept. An approximate or
topical match is worse than no match: a wrong match tells her flashcard
scheduler to drill something she already knows and hides something she does
not. Return an empty list for a concept with no good match — that is the
expected outcome much of the time.

Return ONLY JSON:
[{"concept":"<verbatim>","question_ids":[1,2],"card_ids":[3]}]

CONCEPTS SHE MISSED:
${missed.map((m, i) => `${i + 1}. ${m}`).join('\n')}

QUIZ QUESTIONS (id — what it tests):
${(questions || []).map((q: any) => `${q.id} — ${q.fact_tested}`).join('\n').slice(0, 24000)}

FLASHCARDS (id — the prompt side):
${(cards || []).map((c: any) => `${c.id} — ${c.question}`).join('\n').slice(0, 24000) || '(this course has no flashcards)'}` }],
        { json: true })).text);

      const qIds = new Set<number>(), cIds = new Set<number>();
      (Array.isArray(out) ? out : []).forEach((r: any) => {
        (r.question_ids || []).forEach((i: any) => Number.isFinite(+i) && qIds.add(+i));
        (r.card_ids || []).forEach((i: any) => Number.isFinite(+i) && cIds.add(+i));
      });

      /* Existing rows first: these tables carry running counters, and the
         existing writers increment rather than overwrite. Same shape here. */
      const now = new Date().toISOString();
      let written = 0;
      if (qIds.size) {
        const ex = await (await rest(`question_mastery?select=question_id,consecutive_correct,total_correct,total_attempts&user_id=eq.${gate.uid}&question_id=in.(${[...qIds].join(',')})`)).json();
        const byId: any = {}; (ex || []).forEach((r: any) => byId[r.question_id] = r);
        const rows = [...qIds].map((id) => {
          const p = byId[id] || { consecutive_correct: 0, total_correct: 0, total_attempts: 0 };
          return { user_id: gate.uid, question_id: id,
            consecutive_correct: 0,                       /* a miss breaks the streak */
            total_correct: p.total_correct || 0,
            total_attempts: (p.total_attempts || 0) + 1,
            is_mastered: false, last_result: false, last_attempted_at: now };
        });
        const w = await rest('question_mastery?on_conflict=user_id,question_id', { method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
        if (w.ok) written += rows.length;
      }
      if (cIds.size) {
        const rows = [...cIds].map((id) => ({ user_id: gate.uid, card_id: id,
          consecutive_correct: 0, is_mastered: false,
          last_result: 'missed', missed_lock: false, last_attempted_at: now }));
        const w = await rest('card_mastery?on_conflict=user_id,card_id', { method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
        if (w.ok) written += rows.length;
      }
      return new Response(JSON.stringify({
        written, question_ids: [...qIds], card_ids: [...cIds],
        matches: out, pool: { questions: (questions||[]).length, cards: (cards||[]).length },
        /* said out loud rather than left to look like a silent success: a
           course with no flashcards can only ever feed the quiz half */
        note: (cards || []).length ? null
          : `No flashcards exist for ${course || 'this course'}, so only quiz questions were updated.`,
      }), { headers: JSON_HDR });
    }

    if (action !== 'turn') throw new Error(`Unknown action "${action}".`);

    /* ── turn ── */
    const t0 = Date.now();
    const audioB64 = String(body.audio_b64 || '');
    if (!audioB64) throw new Error('audio_b64 is required');
    const sectionText = String(body.section_text || '');
    if (!sectionText) throw new Error('section_text is required — it is the only permitted source');

    const cpRes = await rest(`podcast_checkpoints?select=ordinal,question,expected_points&episode_id=eq.${encodeURIComponent(body.episode_id)}&ordinal=eq.${Number(body.checkpoint_ordinal)}`);
    const cps = await cpRes.json();
    const cp = Array.isArray(cps) && cps[0];
    if (!cp) throw new Error('Checkpoint not found.');
    const expected: string[] = Array.isArray(cp.expected_points) ? cp.expected_points : [];

    const all = await listModels(apiKey);
    const tPick = pickTranscribe(all);
    const reasonModel = body.reason_model || pickText(all);
    const ttsModel = body.tts_model || pickTts(all);

    const terms = [...new Set(FLOOR_TERMS.concat(sectionTerms(sectionText)))];

    const tA = Date.now();
    const tr = await gemini(apiKey, tPick.model, [
      { inlineData: { mimeType: String(body.mime_type || 'audio/wav'), data: audioB64 } },
      { text: transcribePrompt(terms) },
    ], { temperature: 0 });
    const transcript = tr.text.replace(/^["']|["']$/g, '').trim();
    const tTranscribe = Date.now() - tA;

    /* Nothing usable came back — say so rather than grading silence as wrong. */
    if (!transcript || /^\[inaudible\]$/i.test(transcript)) {
      const reply = "I didn't catch that. Have another go, or tap continue to move on.";
      const sp = ttsModel ? await speak(apiKey, ttsModel, String(body.voice || DEFAULT_VOICE), reply) : null;
      return new Response(JSON.stringify({
        kind: 'unclear', verdict: 'na', transcript: '', reply,
        got: [], missed: expected, missed_concepts: [], in_source: true,
        reply_audio_b64: sp ? sp.b64 : null, reply_seconds: sp ? sp.seconds : 0,
        models: { transcription: tPick.model, transcription_is_dedicated: tPick.dedicated,
                  reasoning: null, tts: ttsModel },
        timing_ms: { transcribe: tTranscribe, reason: 0, speak: 0, total: Date.now() - t0 },
      }), { headers: JSON_HDR });
    }

    const tB = Date.now();
    const j = parseJson((await gemini(apiKey, reasonModel,
      [{ text: turnPrompt(cp.question, expected, sectionText, transcript) }],
      { json: true, temperature: 0.2 })).text);
    const tReason = Date.now() - tB;

    const reply = String(j.reply || '').trim() || 'Let us keep going.';
    const tC = Date.now();
    const sp = ttsModel ? await speak(apiKey, ttsModel, String(body.voice || DEFAULT_VOICE), reply) : null;
    const tSpeak = Date.now() - tC;

    return new Response(JSON.stringify({
      kind: String(j.kind || 'unclear'),
      verdict: String(j.verdict || 'na'),
      transcript,
      got: Array.isArray(j.got) ? j.got : [],
      missed: Array.isArray(j.missed) ? j.missed : [],
      missed_concepts: Array.isArray(j.missed_concepts) ? j.missed_concepts : [],
      in_source: j.in_source !== false,
      reply,
      reply_audio_b64: sp ? sp.b64 : null,
      reply_seconds: sp ? Math.round((sp.seconds || 0) * 10) / 10 : 0,
      question: cp.question,
      expected,
      models: { transcription: tPick.model, transcription_is_dedicated: tPick.dedicated,
                reasoning: reasonModel, tts: ttsModel },
      vocabulary_terms: terms.length,
      usage: { transcribe: tr.usage, speak: sp ? sp.usage : null },
      timing_ms: { transcribe: tTranscribe, reason: tReason, speak: tSpeak, total: Date.now() - t0 },
    }), { headers: JSON_HDR });

  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error).message || err) }),
      { status: 500, headers: JSON_HDR });
  }
});
