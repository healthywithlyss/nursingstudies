/* The whole audio handler, with fetch faked: PostgREST, Storage, ListModels and
   the TTS call. Proves the plan/synthesize/status/delete flow, the admin gate,
   TTS model discovery, and that a segment's audio actually reaches Storage and
   a row. It tests wiring, not audio quality. */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let handler = null;
globalThis.Deno = { serve: (h) => { handler = h; },
  env: { get: (k) => ({ SUPABASE_URL: 'https://x.test', SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'k' }[k]) } };

const EPISODE = '11111111-2222-3333-4444-555555555555';
const para = (s, n) => Array.from({ length: n }, (_, i) => `${s} sentence ${i} about the gastric mucosa and its barrier.`).join(' ');
const Q = ['What is the difference between erosive and nonerosive gastritis?',
           'Why does parietal cell atrophy cause a B twelve problem?'];
const SCRIPT = [para('a', 30), Q[0], para('b', 30), Q[1], para('c', 20)].join(' ');
const CPS = Q.map((q, i) => ({ ordinal: i, position_in_script: SCRIPT.indexOf(q) + q.length, question: q }));

/* the fake world */
let audioRows = [];
const stored = new Map();
const seen = [];
let ttsCalls = [];
let modelList = [
  { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.8-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/imagen-4.0-generate', supportedGenerationMethods: ['generateContent'] },
];
let profileRole = 'admin';
const SAMPLE_RATE = 24000;

globalThis.fetch = async (url, init = {}) => {
  url = String(url); seen.push(url.split('?')[0]);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const method = (init.method || 'GET').toUpperCase();

  if (url.includes('/rest/v1/profiles')) return J([{ role: profileRole }]);
  if (url.includes('/rest/v1/podcast_episodes')) {
    return J([{ id: EPISODE, guide_slug: 'nur144-u1-l1', section_heading: 'GASTRITIS', ordinal: 14, script: SCRIPT, status: 'complete' }]);
  }
  if (url.includes('/rest/v1/podcast_checkpoints')) return J(CPS);
  if (url.includes('/rest/v1/podcast_audio')) {
    if (method === 'POST') {
      const rows = JSON.parse(init.body);
      rows.forEach((r) => {
        audioRows = audioRows.filter((x) => !(x.episode_id === r.episode_id && x.ordinal === r.ordinal));
        audioRows.push(r);
      });
      return J(rows);
    }
    if (method === 'DELETE') { audioRows = []; return J([]); }
    return J(audioRows.slice().sort((a, b) => a.ordinal - b.ordinal));
  }
  if (url.includes('/storage/v1/object/podcast-audio')) {
    if (method === 'DELETE') { stored.clear(); return J({}); }
    stored.set(url.split('/podcast-audio/')[1], new Uint8Array(init.body));
    return J({ Key: 'ok' });
  }
  if (url.includes('models?key')) return J({ models: modelList });
  if (url.includes(':generateContent')) {
    const b = JSON.parse(init.body);
    ttsCalls.push({ url, body: b });
    /* two seconds of silence, as headerless PCM, base64 like the real API */
    const pcm = Buffer.alloc(SAMPLE_RATE * 2 * 2);
    return J({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: {
      mimeType: `audio/L16;codec=pcm;rate=${SAMPLE_RATE}`, data: pcm.toString('base64') } }] } }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 900, totalTokenCount: 1020 } });
  }
  throw new Error('unexpected fetch ' + url);
};

const srcFile = (() => {
  const src = readFileSync(new URL('../../supabase/functions/generate-podcast-audio/index.ts', import.meta.url), 'utf8')
    .replace(/^import "jsr:[^\n]*\n/, '// stripped for the node harness\n');
  const f = join(mkdtempSync(join(tmpdir(), 'fn-')), 'fn.ts');
  writeFileSync(f, src); return f;
})();
await import(srcFile);

const tok = 'x.' + Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64') + '.y';
const call = async (body, token = tok) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await handler(new Request('https://x/', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: r.status, json: await r.json() };
};

let fail = 0;
const ck = (n, ok, v) => { if (ok) console.log('  PASS  ' + n); else { fail++; console.log('  FAIL  ' + n + ' -> ' + JSON.stringify(v)); } };

console.log('admin gate');
ck('no token is 401', (await call({ action: 'voices' }, null)).status === 401);
profileRole = 'student';
const denied = await call({ action: 'voices' });
ck('non-admin is 403', denied.status === 403, denied);
ck('a non-admin never reaches Gemini', !seen.some((u) => u.includes('generativelanguage')), seen.filter((u) => u.includes('google')));
profileRole = 'admin';

console.log('voice and TTS model discovery');
const v = (await call({ action: 'voices' })).json;
ck('picks a TTS model, not a text model', /tts/i.test(v.would_use || ''), v.would_use);
ck('picks the NEWEST tts model', v.would_use === 'gemini-3.8-flash-preview-tts', v.tts_models);
ck('excludes the plain text model', !v.tts_models.includes('gemini-3.8-flash'), v.tts_models);
ck('excludes imagen', !v.tts_models.some((m) => /imagen/.test(m)), v.tts_models);
ck('offers voices with a default', v.voices.length > 5 && v.default_voice === 'Charon', v.default_voice);
ck('says plainly that voices are not discovered', v.voices_are_hardcoded === true);

/* the inverted-filter trap: if only preview TTS models exist, excluding
   previews the way the text side does would leave nothing */
modelList = [{ name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] }];
ck('a preview-only world still finds a TTS model',
  (await call({ action: 'voices' })).json.would_use === 'gemini-2.5-flash-preview-tts');
modelList = [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
             { name: 'models/gemini-3.8-flash-preview-tts', supportedGenerationMethods: ['generateContent'] }];

console.log('plan');
const plan = (await call({ action: 'plan', episode_id: EPISODE })).json;
ck('three segments for two checkpoints', plan.segments.length === 3, plan.segments.length);
ck('plan writes nothing', audioRows.length === 0 && stored.size === 0);
ck('plan does not call the TTS model', ttsCalls.length === 0);
ck('reports estimated total', plan.estimated_total_seconds > 0, plan.estimated_total_seconds);
ck('not complete before anything is generated', plan.complete === false);

console.log('synthesize');
const s0 = (await call({ action: 'synthesize', episode_id: EPISODE, segment: 0, voice: 'Iapetus' })).json;
ck('measured duration comes from the bytes, not the estimate', s0.actual_seconds === 2, s0.actual_seconds);
ck('reports how wrong the estimate was', typeof s0.estimate_error_pct === 'number', s0.estimate_error_pct);
ck('stored one object', stored.size === 1, [...stored.keys()]);
ck('path is ordered and zero-padded', [...stored.keys()][0] === `episodes/${EPISODE}/000.wav`, [...stored.keys()]);
ck('row written with the voice and model used', audioRows.length === 1 && audioRows[0].voice === 'Iapetus' && /tts/.test(audioRows[0].model), audioRows[0]);
ck('row records the checkpoint it ends on', audioRows[0].ends_at_checkpoint === 0, audioRows[0]);
ck('bytes match a WAV of the PCM', audioRows[0].bytes === SAMPLE_RATE * 2 * 2 + 44, audioRows[0].bytes);
const wavBytes = [...stored.values()][0];
ck('object really is a WAV', String.fromCharCode(...wavBytes.slice(0, 4)) === 'RIFF'
  && String.fromCharCode(...wavBytes.slice(8, 12)) === 'WAVE');
ck('not marked done on the first of three', s0.done === false);
ck('no checkpoint marker was ever sent to the synthesiser',
  !ttsCalls.some((c) => /CHECKPOINT/i.test(JSON.stringify(c.body))));
ck('the spoken text ends with the question', ttsCalls[0].body.contents[0].parts[0].text.trim().endsWith(Q[0]),
   ttsCalls[0].body.contents[0].parts[0].text.slice(-80));
ck('no style prefix by default', ttsCalls[0].body.contents[0].parts[0].text.startsWith('a sentence 0'),
   ttsCalls[0].body.contents[0].parts[0].text.slice(0, 40));
ck('voice was passed through to the API',
   ttsCalls[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === 'Iapetus');
ck('asked for AUDIO modality', JSON.stringify(ttsCalls[0].body.generationConfig.responseModalities) === '["AUDIO"]');

console.log('validation and idempotency');
ck('a bad segment index is rejected', (await call({ action: 'synthesize', episode_id: EPISODE, segment: 99 })).status === 500);
ck('an unknown voice is rejected', /Unknown voice/.test((await call({ action: 'synthesize', episode_id: EPISODE, segment: 1, voice: 'Gandalf' })).json.error || ''));
ck('a missing episode_id is rejected', /episode_id/.test((await call({ action: 'plan' })).json.error || ''));
await call({ action: 'synthesize', episode_id: EPISODE, segment: 0, voice: 'Charon' });
ck('regenerating a segment replaces rather than duplicates', audioRows.length === 1 && audioRows[0].voice === 'Charon', audioRows);

console.log('finish the episode');
const s1 = (await call({ action: 'synthesize', episode_id: EPISODE, segment: 1 })).json;
const s2 = (await call({ action: 'synthesize', episode_id: EPISODE, segment: 2 })).json;
ck('last segment reports done', s2.done === true);
ck('middle segment is not done', s1.done === false);
ck('last segment ends the episode, not a checkpoint', s2.ends_at_checkpoint === null, s2.ends_at_checkpoint);
const st = (await call({ action: 'status', episode_id: EPISODE })).json;
ck('status reports complete', st.complete === true, { generated: st.generated.length, segments: st.segments.length });
ck('status totals the real durations', st.generated_seconds === 6, st.generated_seconds);

console.log('delete');
const del = (await call({ action: 'delete', episode_id: EPISODE })).json;
ck('reports what it removed', del.deleted_segments === 3, del);
ck('rows and objects are gone', audioRows.length === 0 && stored.size === 0);

console.log(fail ? `\n${fail} FAILING` : '\nall audio pipeline checks passed');
process.exit(fail ? 1 : 0);
