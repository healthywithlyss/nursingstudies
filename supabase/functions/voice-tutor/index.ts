import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* ═══════════════════════════════════════════════════════════════════════
   voice-tutor  —  say the answer, hear it graded

   One spoken turn on one flashcard. The student taps the mic, says her
   answer (or a follow-up, or an argument), and this does exactly three
   things, in order, and nothing else, because she is waiting in silence:

     1. transcribe   OpenAI whisper-1 on the recording she sent
     2. reply        OpenAI gpt-4o-mini, with the CARD (fetched here, by id,
                     through her own token so RLS applies) in the system
                     prompt and the conversation so far
     3. speak        OpenAI tts-1, voice "nova", one mp3 back to the page

   A text turn (the page's fallback when the mic is unavailable) skips step
   one. The conversation lives in the page's memory per card; this function
   is stateless and trusts only what it is sent as prior turns, trimmed.

   ADMIN ONLY, by request: profiles.role must be 'admin'.

   Secret:  OPENAI_API_KEY   (Supabase → Edge Functions → Secrets)

   POST body:
     card_id     number                       required
     audio_b64   base64 recording             one of audio_b64 / text
     mime_type   e.g. audio/webm              default audio/webm
     text        typed answer                 the no-mic fallback
     messages    [{role:'user'|'assistant', content}]   prior turns, optional

   Response:
     { transcript, replyText, replyAudio (base64 mp3), card_id, models,
       usage, timing_ms }
   ═══════════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const JSON_HDR = { ...CORS, 'Content-Type': 'application/json' };

const OPENAI = 'https://api.openai.com/v1';
const TRANSCRIBE_MODEL = 'whisper-1';
const CHAT_MODEL = 'gpt-4o-mini';
const TTS_MODEL = 'tts-1';
const TTS_VOICE = 'nova';
/* under 80 words spoken; 160 tokens is room for that and a stop */
const MAX_REPLY_TOKENS = 160;
/* prior turns kept: enough to argue back, not enough to drift off the card */
const MAX_PRIOR_TURNS = 10;
const MAX_TURN_CHARS = 1500;

type Card = { id: number; question: string; answer: string; explanation: string | null;
              objective_ids: string[]; course: string };

/* ── the tutor ────────────────────────────────────────────────────────── */
function tutorPrompt(card: Card, lecture: string, objective: string) {
  const why = (card.explanation || '').trim();
  return `You are a voice tutor for one nursing student working through a flashcard. She
speaks; you reply out loud. Everything you write is read aloud to her.

THE CARD
Question: ${card.question}
Answer: ${card.answer}
Why: ${why || '(the card gives no explanation — reason from the answer, and say when something is not on the card)'}
Lecture: ${lecture || '(unknown)'}
Objective: ${objective || '(unknown)'}

HOW TO REPLY
- She has just spoken her answer. In the FIRST sentence say whether it is
  correct, partially correct, or wrong.
- Then say what was missing or wrong and WHY: the mechanism, not just the
  fact. Two or three sentences.
- If her reasoning was wrong (for example "the liver makes bilirubin"),
  correct the reasoning, not just the fact.
- If she asks a follow-up or pushes back, answer it directly. Prefer
  mechanism over lists.
- Under 80 words, every time. No bullets, no headers, no markdown, no stage
  directions: this is speech.
- Do not praise. Do not restate the whole explanation unless she asks.
- Stay on this card. If she wanders, bring it back in one clause.
- The card's answer and why are the reference: ground every correction in
  them and never contradict them.
- Spell for the ear: "B twelve", "I and O", "H two blocker", "N G tube".`;
}

/* ── OpenAI calls ──────────────────────────────────────────────────────── */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)) as any);
  return btoa(s);
}
const extFor = (mime: string) =>
  /ogg/.test(mime) ? 'ogg' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : 'webm';

async function transcribe(key: string, audio: Uint8Array, mime: string) {
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mime }), 'answer.' + extFor(mime));
  fd.append('model', TRANSCRIBE_MODEL);
  fd.append('language', 'en');
  fd.append('response_format', 'json');
  /* the words a generic transcriber gets wrong */
  fd.append('prompt', 'Nursing: bilirubin, hepatic, cirrhosis, ascites, varices, achalasia, melena, hematemesis, pyrosis, H. pylori, B12, NG tube.');
  const r = await fetch(`${OPENAI}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Transcription failed (${r.status}): ${JSON.stringify(j).slice(0, 300)}`);
  return String(j.text || '').trim();
}

async function reply(key: string, system: string, prior: { role: string; content: string }[], said: string) {
  const r = await fetch(`${OPENAI}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL, temperature: 0.4, max_tokens: MAX_REPLY_TOKENS,
      messages: [{ role: 'system', content: system }, ...prior, { role: 'user', content: said }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Reply failed (${r.status}): ${JSON.stringify(j).slice(0, 300)}`);
  const text = String(j.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('The tutor returned nothing.');
  return { text, usage: j.usage || null };
}

async function speak(key: string, text: string) {
  const r = await fetch(`${OPENAI}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'mp3' }),
  });
  if (!r.ok) throw new Error(`Speech failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return new Uint8Array(await r.arrayBuffer());
}

/* ── auth: admin only ─────────────────────────────────────────────────── */
async function requireAdmin(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Missing Authorization bearer token.' };
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const ANON = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_URL || !ANON) return { ok: false, status: 500, error: 'Supabase env not configured.' };
  let uid = '';
  try { uid = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || ''; } catch (_) { /* below */ }
  if (!uid) return { ok: false, status: 401, error: 'Could not read user from token.' };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=role&id=eq.${uid}`,
    { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  const rows = await res.json().catch(() => []);
  const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
  if (role !== 'admin') return { ok: false, status: 403, error: 'The voice tutor is admin-only for now.' };
  return { ok: true, uid, token, SUPABASE_URL, ANON };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) return new Response(JSON.stringify({ error: 'OPENAI_API_KEY is not set. Add it under Supabase → Edge Functions → Secrets.' }),
    { status: 500, headers: JSON_HDR });
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return new Response(JSON.stringify({ error: gate.error }), { status: gate.status, headers: JSON_HDR });
    const body = await req.json().catch(() => ({}));
    const t0 = Date.now();

    const cardId = Number(body.card_id);
    if (!Number.isFinite(cardId)) throw new Error('card_id is required');
    const hdr = { apikey: gate.ANON!, Authorization: `Bearer ${gate.token}` };
    const get = async (path: string) => {
      const r = await fetch(`${gate.SUPABASE_URL}/rest/v1/${path}`, { headers: hdr });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`${path.split('?')[0]} read failed (${r.status})`);
      return Array.isArray(j) ? j : [];
    };
    /* the card, by id, through her token — never trusted from the page */
    const card = (await get(`flashcards?select=id,question,answer,explanation,objective_ids,course&id=eq.${cardId}`))[0] as Card | undefined;
    if (!card) throw new Error(`Card ${cardId} not found.`);
    const tags: string[] = Array.isArray(card.objective_ids) ? card.objective_ids : [];
    let lecture = '', objective = '';
    if (tags.length) {
      const rows = await get(`objectives?select=id,lecture,description&id=in.(${tags.map(encodeURIComponent).join(',')})`);
      const byId = new Map<string, any>(rows.map((r: any) => [r.id, r]));
      const lec = tags.find((t) => !/_O\d+$/.test(t)), obj = tags.find((t) => /_O\d+$/.test(t));
      const lr = lec ? byId.get(lec) : null, or = obj ? byId.get(obj) : null;
      lecture = lr ? `${lr.lecture || lec}${lr.description ? ' — ' + lr.description : ''}` : (lec || '');
      objective = or ? `${or.lecture || obj}${or.description ? ' — ' + or.description : ''}` : (obj || '');
    }

    /* prior turns: only the two roles, only strings, only the last few */
    const prior = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m: any) => ({ role: m.role, content: m.content.trim().slice(0, MAX_TURN_CHARS) }))
      .slice(-MAX_PRIOR_TURNS);

    /* 1. what she said */
    let transcript = String(body.text || '').trim().slice(0, MAX_TURN_CHARS);
    let tTranscribe = 0;
    const mime = String(body.mime_type || 'audio/webm');
    if (!transcript) {
      const b64 = String(body.audio_b64 || '');
      if (!b64) throw new Error('audio_b64 or text is required');
      const tA = Date.now();
      transcript = await transcribe(key, b64ToBytes(b64), mime);
      tTranscribe = Date.now() - tA;
    }

    /* nothing usable: say so out loud and skip the grading call */
    if (!transcript) {
      const heard = "I didn't catch that. Tap the mic and try again.";
      const tS = Date.now();
      const mp3 = await speak(key, heard);
      return new Response(JSON.stringify({
        transcript: '', replyText: heard, replyAudio: bytesToB64(mp3), card_id: cardId, heard: false,
        models: { transcribe: TRANSCRIBE_MODEL, chat: null, tts: TTS_MODEL }, usage: null,
        timing_ms: { transcribe: tTranscribe, reply: 0, speak: Date.now() - tS, total: Date.now() - t0 },
      }), { headers: JSON_HDR });
    }

    /* 2. the tutor */
    const tB = Date.now();
    const out = await reply(key, tutorPrompt(card, lecture, objective), prior, transcript);
    const tReply = Date.now() - tB;

    /* 3. said aloud */
    const tC = Date.now();
    const mp3 = await speak(key, out.text);
    const tSpeak = Date.now() - tC;

    return new Response(JSON.stringify({
      transcript, replyText: out.text, replyAudio: bytesToB64(mp3), card_id: cardId, heard: true,
      models: { transcribe: body.text ? null : TRANSCRIBE_MODEL, chat: CHAT_MODEL, tts: TTS_MODEL + '/' + TTS_VOICE },
      usage: out.usage,
      timing_ms: { transcribe: tTranscribe, reply: tReply, speak: tSpeak, total: Date.now() - t0 },
    }), { headers: JSON_HDR });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error).message || err) }), { status: 500, headers: JSON_HDR });
  }
});
