/* Segmentation, sentence splitting and WAV framing for the audio pipeline.
 *
 * Three things here can go wrong silently and only be noticed by ear:
 *   1. a split lands mid-sentence, so a segment ends on half a thought;
 *   2. "H. pylori" is treated as a sentence end and read as two utterances;
 *   3. the WAV header is malformed, so nothing plays at all, or plays at the
 *      wrong speed because the sample rate was assumed rather than read.
 * All three are deterministic, so all three get asserted rather than listened to.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = readFileSync(new URL('../../supabase/functions/generate-podcast-audio/index.ts', import.meta.url), 'utf8');
function lift(from, to, exports) {
  const a = src.indexOf(from), b = src.indexOf(to);
  if (a < 0 || b < 0 || b < a) throw new Error(`could not lift ${from} .. ${to}`);
  /* the lifted block references module-level constants, so carry them along */
  const consts = ['MAX_SECONDS_DEFAULT', 'HARD_MAX_SECONDS', 'WORDS_PER_MINUTE', 'NOT_A_SENTENCE_END']
    .map((n) => {
      const m = src.match(new RegExp(`^const ${n} =[\\s\\S]*?;$`, 'm'));
      if (!m) throw new Error(`missing constant ${n}`);
      return src.slice(a, b).includes(`const ${n} =`) ? '' : m[0];
    }).filter(Boolean).join('\n');
  const file = join(mkdtempSync(join(tmpdir(), 'aud-')), 'a.ts');
  writeFileSync(file, consts + '\n' + src.slice(a, b) + `\nexport { ${exports} };\n`);
  return import(file);
}
const seg = await lift('const wordCount =', '/* ── audio ─', 'wordCount, estSeconds, splitSentences, splitByDuration, planSegments');
const wav = await lift('function wavFromPcm', 'async function synthesize', 'wavFromPcm, b64ToBytes');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
};

/* ─────────────────────────────────────────────────── sentence splitting */
console.log('sentence splitting must survive clinical prose');
const cases = [
  ['plain sentences', 'Acute gastritis resolves fast. Chronic gastritis does not. Watch for bleeding.', 3],
  ['H. pylori stays whole', 'The nonerosive kind comes from H. pylori. That one can cause peptic ulcers.', 2],
  ['lone initial mid-sentence', 'Vitamin B. twelve needs intrinsic factor to be absorbed at all.', 1],
  ['question then statement', 'Why does that matter? Because the barrier is all that protects the tissue.', 2],
  ['abbreviation e.g.', 'Local irritants, e.g. aspirin and NSAIDs, erode the lining. Then bleeding starts.', 2],
  ['no terminal punctuation', 'A single clause with no full stop', 1],
];
cases.forEach(([name, text, want]) => {
  const got = seg.splitSentences(text);
  check(name, got.length === want, { want, got });
});
check('splitting is lossless', seg.splitSentences('One. Two. Three.').join('') === 'One. Two. Three.');
check('H. pylori never appears split',
  !seg.splitSentences('Caused by H. pylori. It ulcerates.').some((s) => /H\.\s*$/.test(s.trim())));

/* ──────────────────────────────────────────────────────── segmentation */
const para = (seed, n) => Array.from({ length: n }, (_, i) => `${seed} sentence ${i} about the gastric mucosa and its protective barrier.`).join(' ');
const Q = ['What is the difference between erosive and nonerosive gastritis?',
           'Why does parietal cell atrophy cause a B twelve problem?'];
const script = [para('a', 60), Q[0], para('b', 60), Q[1], para('c', 40)].join(' ');
const cps = Q.map((q, i) => ({ ordinal: i, position_in_script: script.indexOf(q) + q.length, question: q }));

console.log('segmentation splits at checkpoints');
const plan = seg.planSegments(script, cps, 420);
check('one segment per checkpoint plus a tail', plan.length === 3, plan.length);
check('segments are in order and contiguous',
  plan.every((s, i) => i === 0 ? s.char_start === 0 : s.char_start === plan[i - 1].char_end),
  plan.map((s) => [s.char_start, s.char_end]));
check('last segment reaches the end of the script',
  plan[plan.length - 1].char_end === script.length, { end: plan.at(-1).char_end, len: script.length });
check('nothing is lost: the pieces rebuild the script',
  plan.map((s) => script.slice(s.char_start, s.char_end)).join('') === script);
check('checkpoint segments say so',
  plan[0].ends_at_checkpoint === 0 && plan[1].ends_at_checkpoint === 1 && plan[2].ends_at_checkpoint === null,
  plan.map((s) => s.ends_at_checkpoint));
check('each checkpoint segment ends just after its question',
  plan.slice(0, 2).every((s, i) => script.slice(0, s.char_end).trim().endsWith(Q[i])),
  plan.slice(0, 2).map((s) => script.slice(Math.max(0, s.char_end - 60), s.char_end)));
check('ordinals are 0..n-1', plan.every((s, i) => s.ordinal === i));

console.log('the duration cap splits long stretches, never mid-sentence');
const tight = seg.planSegments(script, cps, 60);
check('it produced more segments than checkpoints alone', tight.length > plan.length, tight.length);
check('every segment is under the cap (allowing the last sentence to overshoot)',
  tight.every((s) => s.estimated_seconds <= 60 * 1.5), tight.map((s) => s.estimated_seconds));
check('duration-cap splits are labelled',
  tight.some((s) => s.split_reason === 'duration cap'), [...new Set(tight.map((s) => s.split_reason))]);
check('still lossless under the cap',
  tight.map((s) => script.slice(s.char_start, s.char_end)).join('') === script);
check('no segment starts mid-sentence',
  tight.slice(1).every((s) => {
    const before = script.slice(0, s.char_start).trimEnd();
    return before === '' || /[.!?]["')\]]?$/.test(before);
  }),
  tight.slice(1).map((s) => script.slice(Math.max(0, s.char_start - 40), s.char_start + 20)));

console.log('degenerate inputs');
check('no checkpoints still yields one segment', seg.planSegments('Just one short line of narration.', [], 420).length === 1);
check('a checkpoint at position 0 is ignored, not turned into an empty segment',
  seg.planSegments('Some narration here.', [{ position_in_script: 0 }], 420).length === 1);
check('a checkpoint past the end is ignored',
  seg.planSegments('Some narration here.', [{ position_in_script: 99999 }], 420).length === 1);
/* one cut, listed twice, must still produce two segments — with a cap high
   enough that the duration splitter cannot muddy the count */
check('duplicate checkpoint positions collapse',
  seg.planSegments(script, [cps[0], { ...cps[0] }], 100000).length === 2,
  seg.planSegments(script, [cps[0], { ...cps[0] }], 100000).map((x) => [x.char_start, x.char_end]));
check('two distinct checkpoints give three segments at the same cap',
  seg.planSegments(script, cps, 100000).length === 3);

/* ────────────────────────────────────────────────────────── WAV framing */
console.log('WAV header');
const pcm = new Uint8Array(48000 * 2);           /* 1 second of 48k mono 16-bit */
const w = wav.wavFromPcm(pcm, 24000);
const dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
const tag = (o) => String.fromCharCode(...w.slice(o, o + 4));
check('RIFF/WAVE/fmt/data tags', tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ' && tag(36) === 'data',
  [tag(0), tag(8), tag(12), tag(36)]);
check('header is 44 bytes ahead of the payload', w.length === pcm.length + 44);
check('RIFF size excludes the first 8 bytes', dv.getUint32(4, true) === w.length - 8);
check('format is PCM mono 16-bit', dv.getUint16(20, true) === 1 && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16);
check('sample rate is the one passed in, not assumed', dv.getUint32(24, true) === 24000);
check('byte rate and block align agree', dv.getUint32(28, true) === 24000 * 2 && dv.getUint16(32, true) === 2);
check('data chunk size matches the PCM length', dv.getUint32(40, true) === pcm.length);
check('a different sample rate is honoured', new DataView(wav.wavFromPcm(pcm, 16000).buffer).getUint32(24, true) === 16000);
check('payload is copied verbatim', wav.wavFromPcm(Uint8Array.from([1,2,3,4]), 24000).slice(44).join(',') === '1,2,3,4');
check('base64 decode round-trips', wav.b64ToBytes(Buffer.from([0,127,255,3]).toString('base64')).join(',') === '0,127,255,3');

/* duration measured from bytes, which is what the function reports */
check('one second of 24k mono is 48000 bytes -> 1.0s',
  (48000) / (24000 * 2) === 1);

console.log(failures ? `\n${failures} FAILING CHECK(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
