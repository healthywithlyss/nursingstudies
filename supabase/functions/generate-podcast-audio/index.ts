import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* ═══════════════════════════════════════════════════════════════════════
   generate-podcast-audio  —  coached audio study, phase 2

   Turns a saved episode's script into audio segments in Supabase Storage.

   WHY ONE SEGMENT PER CALL
   Synthesising a whole 90-minute section in a single invocation would run for
   many minutes and hold tens of megabytes of PCM in memory. Instead the client
   asks for a plan, then calls 'synthesize' once per segment. Each call is short,
   progress is visible, and a failure costs one segment rather than the lot.

   WHERE THE SEGMENT BOUNDARIES COME FROM
   Primarily the checkpoints: a segment ends immediately after a question is
   asked, which is exactly where playback has to stop and wait. That also means
   every resume after a pause is driven by a tap on Continue — a real user
   gesture, which is what iOS requires to start audio.
   The duration cap is a secondary splitter for stretches with no checkpoint in
   them. It splits on paragraph boundaries, and only inside a paragraph that is
   itself too long does it fall back to sentence boundaries. Never mid-sentence.

   Admin only for every generating action, same gate as the script function.
   Reading the plan is admin-only too; playback reads the database directly
   under RLS and never calls this function.

   POST body:
     action        'plan' | 'synthesize' | 'status' | 'voices' | 'delete'
     episode_id    uuid                              (all but 'voices')
     segment       integer                           (synthesize)
     voice         prebuilt voice name               (plan, synthesize)
     tts_model     optional model override
     style         optional natural-language delivery instruction, default none
     max_seconds   per-segment ceiling, default 420
   ═══════════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const JSON_HDR = { ...CORS, 'Content-Type': 'application/json' };

/* One request is capped near 655 s of audio. 420 leaves real headroom, and
   keeps a single response's PCM near 20 MB rather than 32 MB. With checkpoints
   landing every 400-500 words this cap rarely binds at all. */
const MAX_SECONDS_DEFAULT = 420;
const HARD_MAX_SECONDS = 640;
/* Gemini TTS reads at roughly this rate. Only used to DECIDE where to split;
   every duration actually reported is measured from the returned bytes. */
const WORDS_PER_MINUTE = 150;

const BUCKET = 'podcast-audio';

/* ── model discovery ───────────────────────────────────────────────────────
   The text side of this project filters TTS models OUT. Here the filter is
   inverted: we want exactly the models it rejects. It is written as its own
   predicate rather than a negated import so that a change to the text-model
   exclusion list cannot silently change which model speaks. */
const IS_TTS = /tts/i;
const NOT_TTS_EVEN_IF_MATCHED = /(image|embedding|robotics|computer-use|lyria|nano-banana|deep-research|transcribe)/i;

function modelVersion(name: string): number {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}
function ttsTier(name: string): number {
  if (/flash-lite/i.test(name)) return 1;
  if (/flash/i.test(name)) return 2;
  if (/pro/i.test(name)) return 3;
  return 0;
}

async function listModels(apiKey: string) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`);
  if (!res.ok) throw new Error(`ListModels failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m: any) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean) as string[];
}

/* Ranked TTS candidates, newest first. Preview names are NOT excluded here:
   at the time of writing every Gemini TTS model is a preview, so excluding
   them the way the text side does would leave nothing at all. */
function rankTtsModels(available: string[]): string[] {
  return available
    .filter((m) => /^gemini/i.test(m) && IS_TTS.test(m) && !NOT_TTS_EVEN_IF_MATCHED.test(m))
    .sort((a, b) => (modelVersion(b) - modelVersion(a)) || (ttsTier(b) - ttsTier(a)));
}

/* The prebuilt voice names are NOT discoverable through the API — ListModels
   says nothing about them — so unlike the model name this list is written down.
   If one of these is rejected with a 400, it has been renamed or retired: fix
   it here. The descriptors are Google's own. */
const VOICES: { name: string; character: string }[] = [
  { name: 'Charon',        character: 'informative' },
  { name: 'Iapetus',       character: 'clear' },
  { name: 'Erinome',       character: 'clear' },
  { name: 'Schedar',       character: 'even' },
  { name: 'Rasalgethi',    character: 'informative' },
  { name: 'Sadaltager',    character: 'knowledgeable' },
  { name: 'Alnilam',       character: 'firm' },
  { name: 'Kore',          character: 'firm' },
  { name: 'Orus',          character: 'firm' },
  { name: 'Gacrux',        character: 'mature' },
  { name: 'Algieba',       character: 'smooth' },
  { name: 'Despina',       character: 'smooth' },
  { name: 'Umbriel',       character: 'easy-going' },
  { name: 'Callirrhoe',    character: 'easy-going' },
  { name: 'Achernar',      character: 'soft' },
  { name: 'Vindemiatrix',  character: 'gentle' },
  { name: 'Sulafat',       character: 'warm' },
  { name: 'Achird',        character: 'friendly' },
  { name: 'Zephyr',        character: 'bright' },
  { name: 'Autonoe',       character: 'bright' },
  { name: 'Aoede',         character: 'breezy' },
  { name: 'Leda',          character: 'youthful' },
  { name: 'Puck',          character: 'upbeat' },
  { name: 'Laomedeia',     character: 'upbeat' },
  { name: 'Zubenelgenubi', character: 'casual' },
  { name: 'Sadachbia',     character: 'lively' },
  { name: 'Pulcherrima',   character: 'forward' },
  { name: 'Enceladus',     character: 'breathy' },
  { name: 'Algenib',       character: 'gravelly' },
  { name: 'Fenrir',        character: 'excitable' },
];
/* Ninety minutes of medical terminology wants intelligibility, not character. */
const DEFAULT_VOICE = 'Charon';

/* ── segmentation ─────────────────────────────────────────────────────────── */

const wordCount = (s: string) => (s.trim().match(/\S+/g) || []).length;
const estSeconds = (s: string) => (wordCount(s) / WORDS_PER_MINUTE) * 60;

/* Sentence boundaries that survive clinical prose. A naive /(?<=\.)\s+/ splits
   "H. pylori" in half, which would cut a segment mid-term and read the halves
   as two utterances. A period only ends a sentence when the token before it is
   not a lone initial or a known abbreviation. */
const NOT_A_SENTENCE_END = /(?:^|\s)(?:[A-Za-z]|Dr|Mr|Mrs|Ms|St|Sr|Jr|vs|etc|approx|Fig|No|e\.g|i\.e|a\.m|p\.m)$/i;

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]["')\]]?\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const head = text.slice(start, m.index + 1);
    if (NOT_A_SENTENCE_END.test(text.slice(start, m.index))) continue;
    /* a sentence must actually start after this, not end the string */
    const rest = text.slice(m.index + m[0].length);
    if (!rest.trim()) break;
    out.push(text.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  const tail = text.slice(start);
  if (tail.trim()) out.push(tail);
  return out.length ? out : [text];
}

/* Break one over-long stretch into pieces under the cap, paragraph-first. */
function splitByDuration(text: string, offset: number, maxSeconds: number) {
  const pieces: { text: string; start: number; end: number }[] = [];
  if (estSeconds(text) <= maxSeconds) return [{ text, start: offset, end: offset + text.length }];

  /* keep the separators so offsets stay exact against the stored script */
  const paras = text.split(/(\n{2,})/);
  const units: string[] = [];
  for (let i = 0; i < paras.length; i += 2) {
    const body = paras[i] + (paras[i + 1] || '');
    if (!body) continue;
    if (estSeconds(body) > maxSeconds) units.push(...splitSentences(body));
    else units.push(body);
  }

  let buf = '', bufStart = offset, cursor = offset;
  for (const u of units) {
    if (buf && estSeconds(buf + u) > maxSeconds) {
      pieces.push({ text: buf, start: bufStart, end: cursor });
      buf = ''; bufStart = cursor;
    }
    buf += u;
    cursor += u.length;
  }
  if (buf.trim()) pieces.push({ text: buf, start: bufStart, end: cursor });
  return pieces.filter((p) => p.text.trim());
}

/* The plan: where the audio is cut, and why each cut is there. */
function planSegments(script: string, checkpoints: any[], maxSeconds: number) {
  const cuts = [...new Set(
    checkpoints
      .map((c: any) => Number(c.position_in_script))
      .filter((n) => Number.isFinite(n) && n > 0 && n < script.length),
  )].sort((a, b) => a - b);

  const base: { text: string; start: number; end: number; cp: number | null }[] = [];
  let prev = 0;
  cuts.forEach((cut, i) => {
    base.push({ text: script.slice(prev, cut), start: prev, end: cut, cp: i });
    prev = cut;
  });
  base.push({ text: script.slice(prev), start: prev, end: script.length, cp: null });

  const segments: any[] = [];
  for (const b of base) {
    if (!b.text.trim()) continue;
    const parts = splitByDuration(b.text, b.start, maxSeconds);
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      segments.push({
        ordinal: segments.length,
        char_start: p.start,
        char_end: p.end,
        text: p.text.trim(),
        words: wordCount(p.text),
        estimated_seconds: Math.round(estSeconds(p.text)),
        /* only the final piece of a checkpoint-bounded stretch actually ends on
           the question; the earlier pieces were cut by the duration cap */
        ends_at_checkpoint: last ? b.cp : null,
        split_reason: last ? (b.cp === null ? 'end of episode' : 'checkpoint') : 'duration cap',
      });
    });
  }
  return segments;
}

/* ── audio ────────────────────────────────────────────────────────────────── */

/* Gemini TTS returns headerless signed 16-bit little-endian PCM. An <audio>
   element cannot play that, so it gets a 44-byte WAV header. */
function wavFromPcm(pcm: Uint8Array, sampleRate: number, channels = 1, bits = 16): Uint8Array {
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);          /* PCM fmt chunk size */
  dv.setUint16(20, 1, true);           /* format 1 = PCM     */
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  ascii(36, 'data');
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function synthesize(apiKey: string, model: string, voice: string, text: string, style: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  /* No style prefix by default. A natural-language instruction is a documented
     feature, but it is sent as ordinary text, so a model that fails to read it
     as an instruction reads it ALOUD. Opt in, never by default. */
  const prompt = style ? `${style}\n\n${text}` : text;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`TTS ${model} ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  const cand = data.candidates && data.candidates[0];
  const part = cand && cand.content && (cand.content.parts || [])
    .find((p: any) => p.inlineData && p.inlineData.data);
  if (!part) {
    throw new Error(`TTS ${model} returned no audio (finishReason ${cand && cand.finishReason}): `
      + JSON.stringify(data).slice(0, 400));
  }
  const mime = String(part.inlineData.mimeType || '');
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
  const pcm = b64ToBytes(part.inlineData.data);
  return {
    wav: wavFromPcm(pcm, rate),
    sampleRate: rate,
    /* measured, not estimated: bytes / (rate * 2 bytes per mono sample) */
    seconds: pcm.length / (rate * 2),
    usage: data.usageMetadata || {},
    sourceMime: mime,
  };
}

/* ── auth ─────────────────────────────────────────────────────────────────── */

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

  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=role&id=eq.${uid}`,
    { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  const rows = await res.json().catch(() => []);
  const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
  if (role !== 'admin') return { ok: false, status: 403, error: 'Admin access required.' };
  return { ok: true, uid, token, SUPABASE_URL, ANON };
}

/* ── handler ──────────────────────────────────────────────────────────────── */

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
    const action = body.action || 'plan';
    const rest = (path: string, init?: RequestInit) => fetch(`${gate.SUPABASE_URL}/rest/v1/${path}`, {
      ...(init || {}),
      headers: {
        apikey: gate.ANON!, Authorization: `Bearer ${gate.token}`,
        'Content-Type': 'application/json', ...((init && (init.headers as any)) || {}),
      },
    });

    if (action === 'voices') {
      const available = await listModels(apiKey);
      const ranked = rankTtsModels(available);
      return new Response(JSON.stringify({
        tts_models: ranked,
        would_use: ranked[0] || null,
        /* so a missing TTS model is diagnosable rather than just "no model" */
        all_models_seen: available.length,
        voices: VOICES,
        default_voice: DEFAULT_VOICE,
        voices_are_hardcoded: true,
        note: 'Voice names are not exposed by ListModels; the model name is discovered live, the voice list is not.',
      }), { headers: JSON_HDR });
    }

    const episodeId = body.episode_id;
    if (!episodeId) throw new Error('episode_id is required');

    const epRes = await rest(`podcast_episodes?select=id,guide_slug,section_heading,ordinal,script,status&id=eq.${episodeId}`);
    const epRows = await epRes.json();
    if (!epRes.ok) throw new Error(`Episode read failed (${epRes.status})`);
    const episode = Array.isArray(epRows) && epRows[0];
    if (!episode) throw new Error(`Episode ${episodeId} not found.`);

    const cpRes = await rest(`podcast_checkpoints?select=ordinal,position_in_script,question&episode_id=eq.${episodeId}&order=position_in_script.asc`);
    const checkpoints = await cpRes.json();
    if (!cpRes.ok) throw new Error(`Checkpoint read failed (${cpRes.status})`);

    const maxSeconds = Math.max(60, Math.min(HARD_MAX_SECONDS, Number(body.max_seconds ?? MAX_SECONDS_DEFAULT)));
    const script = String(episode.script || '')
      /* belt and braces: the script is stored already stripped, but a marker
         must never reach the synthesiser and be read out as "bracket bracket" */
      .replace(/\[\[\s*CHECKPOINT\s*\]\]/gi, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (!script) throw new Error('Episode has an empty script.');

    const segments = planSegments(script, Array.isArray(checkpoints) ? checkpoints : [], maxSeconds);

    if (action === 'status' || action === 'plan') {
      const haveRes = await rest(`podcast_audio?select=ordinal,storage_path,duration_seconds,voice,model,bytes,ends_at_checkpoint&episode_id=eq.${episodeId}&order=ordinal.asc`);
      const have = await haveRes.json();
      const haveArr = Array.isArray(have) ? have : [];
      return new Response(JSON.stringify({
        episode_id: episodeId,
        section_heading: episode.section_heading,
        guide_slug: episode.guide_slug,
        script_chars: script.length,
        words: wordCount(script),
        checkpoints: (checkpoints || []).length,
        max_seconds: maxSeconds,
        segments: segments.map((s) => ({ ...s, text: undefined, preview: s.text.slice(0, 90) })),
        estimated_total_seconds: segments.reduce((a, s) => a + s.estimated_seconds, 0),
        generated: haveArr,
        generated_seconds: haveArr.reduce((a: number, r: any) => a + Number(r.duration_seconds || 0), 0),
        generated_bytes: haveArr.reduce((a: number, r: any) => a + Number(r.bytes || 0), 0),
        complete: haveArr.length === segments.length,
      }), { headers: JSON_HDR });
    }

    if (action === 'delete') {
      const listRes = await rest(`podcast_audio?select=storage_path&episode_id=eq.${episodeId}`);
      const rows = await listRes.json();
      const paths = (Array.isArray(rows) ? rows : []).map((r: any) => r.storage_path).filter(Boolean);
      if (paths.length) {
        await fetch(`${gate.SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
          method: 'DELETE',
          headers: { apikey: gate.ANON!, Authorization: `Bearer ${gate.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: paths }),
        });
      }
      const delRes = await rest(`podcast_audio?episode_id=eq.${episodeId}`, { method: 'DELETE' });
      if (!delRes.ok) throw new Error(`Deleting audio rows failed (${delRes.status})`);
      return new Response(JSON.stringify({ deleted_segments: paths.length }), { headers: JSON_HDR });
    }

    if (action !== 'synthesize') throw new Error(`Unknown action "${action}".`);

    /* ── synthesize one segment ── */
    const idx = Number(body.segment);
    if (!Number.isInteger(idx) || idx < 0 || idx >= segments.length) {
      throw new Error(`segment must be an integer 0..${segments.length - 1}`);
    }
    const seg = segments[idx];

    const voice = String(body.voice || DEFAULT_VOICE);
    if (!VOICES.some((v) => v.name.toLowerCase() === voice.toLowerCase())) {
      throw new Error(`Unknown voice "${voice}". Call action:"voices" for the list.`);
    }
    const available = await listModels(apiKey);
    const ranked = rankTtsModels(available);
    const model = body.tts_model || ranked[0];
    if (!model) {
      throw new Error(`No TTS model found among ${available.length} models available to this API key. `
        + `Call action:"voices" to see what came back.`);
    }

    const t0 = Date.now();
    const audio = await synthesize(apiKey, model, voice, seg.text, String(body.style || ''));
    const genMs = Date.now() - t0;

    if (audio.seconds > HARD_MAX_SECONDS + 30) {
      throw new Error(`Segment ${idx} came back ${Math.round(audio.seconds)}s long, past the request ceiling. `
        + `Lower max_seconds and re-plan.`);
    }

    const path = `episodes/${episodeId}/${String(idx).padStart(3, '0')}.wav`;
    const up = await fetch(`${gate.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: gate.ANON!, Authorization: `Bearer ${gate.token}`,
        'Content-Type': 'audio/wav', 'x-upsert': 'true',
      },
      body: audio.wav,
    });
    if (!up.ok) throw new Error(`Storage upload failed (${up.status}): ${(await up.text()).slice(0, 300)}`);

    /* upsert so regenerating a single segment replaces it rather than colliding
       on the (episode_id, ordinal) unique constraint */
    const row = {
      episode_id: episodeId, ordinal: idx, storage_path: path,
      duration_seconds: Math.round(audio.seconds * 100) / 100,
      voice, model,
      char_start: seg.char_start, char_end: seg.char_end,
      ends_at_checkpoint: seg.ends_at_checkpoint,
      bytes: audio.wav.length, mime_type: 'audio/wav',
    };
    const ins = await rest('podcast_audio?on_conflict=episode_id,ordinal', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([row]),
    });
    if (!ins.ok) throw new Error(`Saving audio row failed (${ins.status}): ${(await ins.text()).slice(0, 300)}`);

    return new Response(JSON.stringify({
      episode_id: episodeId,
      segment: idx,
      of: segments.length,
      storage_path: path,
      voice, model,
      words: seg.words,
      estimated_seconds: seg.estimated_seconds,
      actual_seconds: Math.round(audio.seconds * 100) / 100,
      /* the honest accuracy number for the words-per-minute guess */
      estimate_error_pct: seg.estimated_seconds
        ? Math.round(((audio.seconds - seg.estimated_seconds) / seg.estimated_seconds) * 1000) / 10
        : null,
      bytes: audio.wav.length,
      sample_rate: audio.sampleRate,
      source_mime: audio.sourceMime,
      generation_ms: genMs,
      usage: audio.usage,
      ends_at_checkpoint: seg.ends_at_checkpoint,
      split_reason: seg.split_reason,
      done: idx === segments.length - 1,
    }), { headers: JSON_HDR });

  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error).message || err) }),
      { status: 500, headers: JSON_HDR });
  }
});
