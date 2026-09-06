/* Checkpoint placement regression test.
 *
 * WHY THIS EXISTS
 * The first real generated episode returned two checkpoints both at
 * position_in_script = 8760 — the script length. Playback would have run the
 * whole episode with no pause and then fired both questions back to back.
 * The previous test passed because its fixture put [[CHECKPOINT]] alone on its
 * own line, which is the format the PROMPT asks for. The model emits the
 * marker inline, and before the question. The regex matched nothing, positions
 * came back empty, and every checkpoint fell through to script.length.
 *
 * So every fixture below is written in a format the model has actually
 * produced, never the format the prompt requests. The test runs the real
 * placement code lifted verbatim out of the deployed edge function.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = new URL('../../supabase/functions/generate-podcast-script/index.ts', import.meta.url);

/* Lift the placement block out of the shipped function, verbatim. If someone
   renames or removes these, the test fails loudly rather than testing a copy
   that has drifted from production. */
function loadPlacement() {
  const src = readFileSync(SRC, 'utf8');
  const start = src.indexOf('const MIN_CHECKPOINT_GAP');
  const endMark = '\nconst wordCount';
  const end = src.indexOf(endMark);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('Could not locate the checkpoint placement block in index.ts');
  }
  let block = src.slice(start, end);
  for (const name of ['cleanScript', 'normIndex', 'placeCheckpoints']) {
    if (!block.includes(`function ${name}`)) throw new Error(`missing ${name} in extracted block`);
  }
  block += '\nexport { cleanScript, normIndex, placeCheckpoints, MIN_CHECKPOINT_GAP };\n';
  const dir = mkdtempSync(join(tmpdir(), 'cp-'));
  const file = join(dir, 'placement.ts');
  writeFileSync(file, block);
  return import(file);
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
}

const filler = (seed, n) => {
  /* deterministic prose-shaped padding, long enough that real gaps exceed 500 */
  const s = [];
  for (let i = 0; i < n; i++) s.push(`${seed} sentence ${i} about the gastric mucosa and its barrier.`);
  return s.join(' ');
};

const { placeCheckpoints, MIN_CHECKPOINT_GAP } = await loadPlacement();

/* ---------------------------------------------------------------- fixture A
   The exact shape the model produced on the real run: [[CHECKPOINT]] appears
   INLINE and BEFORE the question, and the questions themselves are ordinary
   sentences inside flowing paragraphs. */
const qA = [
  "What's the difference between the erosive and the nonerosive form, and what causes each?",
  'Why does losing parietal cells lead to a B twelve problem rather than an iron problem?',
  'A patient is two days out from an acute flare and still vomiting; what are you watching for?',
];
const scriptA = [
  filler('alpha', 12), `[[CHECKPOINT]] ${qA[0]}`,
  filler('beta', 12), `[[CHECKPOINT]] ${qA[1]}`,
  filler('gamma', 12), `[[CHECKPOINT]] ${qA[2]}`,
  filler('delta', 8),
].join(' ');

const a = placeCheckpoints(scriptA, qA.map((q) => ({ question: q, expected_points: ['x', 'y'] })));

console.log('fixture A — inline markers, questions verbatim');
check('marker text is stripped from the script', !/CHECKPOINT/i.test(a.script));
check('every checkpoint is present', a.placed.length === 3, a.placed.length);
check('at least 2 checkpoints', a.placed.length >= 2);
check('all anchored to their question', a.placed.every((p) => p.how === 'question'),
  a.placed.map((p) => p.how));

/* THE BUG: both offsets were script.length. */
check('no offset is the script length', a.placed.every((p) => p.pos !== a.script.length),
  { len: a.script.length, pos: a.placed.map((p) => p.pos) });
check('offsets are strictly increasing',
  a.placed.every((p, i) => i === 0 || p.pos > a.placed[i - 1].pos), a.placed.map((p) => p.pos));
check('each offset is more than 500 chars from the next',
  a.placed.every((p, i) => i === 0 || p.pos - a.placed[i - 1].pos > 500),
  a.placed.map((p, i) => (i === 0 ? p.pos : p.pos - a.placed[i - 1].pos)));
check('none flagged crowded', a.placed.every((p) => !p.crowded));

/* the text immediately before each offset is that checkpoint's own question */
a.placed.forEach((p, i) => {
  const before = a.script.slice(Math.max(0, p.pos - p.question.length - 4), p.pos).trim();
  check(`text before offset ${i} ends with its question`, before.endsWith(p.question),
    { pos: p.pos, before: before.slice(-70) });
});
/* and the pause must land AFTER the question, not before it */
a.placed.forEach((p, i) => {
  check(`offset ${i} is past the question, not before it`,
    a.script.indexOf(p.question) >= 0 && p.pos > a.script.indexOf(p.question));
});

/* ---------------------------------------------------------------- fixture B
   The model paraphrases whitespace/case in the checkpoints array: newline for
   space, a capitalised first word, a double space. Placement is
   whitespace- and case-insensitive, so these still anchor. */
const qB = ['Which findings would push you toward chronic rather than acute?',
            'How would you explain the intrinsic factor problem to a patient?'];
const scriptB = [filler('one', 14),
  'Which findings would push you toward\nchronic  rather than acute?',
  filler('two', 14), 'how would you explain the intrinsic factor problem to a patient?',
  filler('three', 6)].join(' ');
const b = placeCheckpoints(scriptB, qB.map((q) => ({ question: q })));

console.log('fixture B — whitespace and case drift between array and script');
check('both anchored by question', b.placed.every((p) => p.how === 'question'),
  b.placed.map((p) => p.how));
check('strictly increasing', b.placed[1].pos > b.placed[0].pos, b.placed.map((p) => p.pos));
check('more than 500 apart', b.placed[1].pos - b.placed[0].pos > 500,
  b.placed[1].pos - b.placed[0].pos);
check('neither at script length', b.placed.every((p) => p.pos !== b.script.length));

/* ---------------------------------------------------------------- fixture C
   Worst case: the model rewrote one question so it cannot be found. That one
   must fall back proportionally and SAY SO — it must not silently collapse
   onto the end of the script alongside the other. */
const scriptC = [filler('one', 14),
  'What is the definitive test for chronic gastritis?', filler('two', 14)].join(' ');
const c = placeCheckpoints(scriptC, [
  { question: 'What is the definitive test for chronic gastritis?' },
  { question: 'A question the writer never actually put in the narration at all.' },
]);

console.log('fixture C — one question missing from the narration');
check('the found one is anchored', c.placed.some((p) => p.how === 'question'),
  c.placed.map((p) => p.how));
check('the missing one is labelled proportional, not silently placed',
  c.placed.some((p) => p.how === 'proportional'), c.placed.map((p) => p.how));
check('offsets still strictly increasing',
  c.placed.every((p, i) => i === 0 || p.pos > c.placed[i - 1].pos), c.placed.map((p) => p.pos));
check('the two did not collapse onto the same offset',
  new Set(c.placed.map((p) => p.pos)).size === c.placed.length, c.placed.map((p) => p.pos));

/* ---------------------------------------------------------------- fixture D
   The original failure, reconstructed exactly: nothing anchors. Before the
   fix both landed on script.length. Now they spread and are labelled. */
const scriptD = filler('solo', 60);
const d = placeCheckpoints(scriptD, [{ question: 'Q one not in script' },
                                     { question: 'Q two not in script' }]);
console.log('fixture D — the original failure, nothing anchors');
check('not both at script.length',
  !(d.placed[0].pos === d.script.length && d.placed[1].pos === d.script.length),
  { len: d.script.length, pos: d.placed.map((p) => p.pos) });
check('distinct offsets', d.placed[0].pos !== d.placed[1].pos, d.placed.map((p) => p.pos));
check('strictly increasing', d.placed[1].pos > d.placed[0].pos);
check('more than 500 apart', d.placed[1].pos - d.placed[0].pos > 500,
  d.placed[1].pos - d.placed[0].pos);
check('both reported as proportional so the report shows the anchoring failed',
  d.placed.every((p) => p.how === 'proportional'), d.placed.map((p) => p.how));

/* ---------------------------------------------------------------- fixture E
   Two questions genuinely back to back. Positions stay attached to their own
   questions (we do NOT move a pause away from its question), but the run is
   flagged crowded so the report shows it. */
const scriptE = [filler('one', 14), 'Why does that matter for the mucosal barrier?',
  ' And what would you expect to see on assessment?', filler('two', 10)].join(' ');
const e = placeCheckpoints(scriptE, [
  { question: 'Why does that matter for the mucosal barrier?' },
  { question: 'And what would you expect to see on assessment?' }]);
console.log('fixture E — back-to-back questions are flagged, not hidden');
check('both still anchored', e.placed.every((p) => p.how === 'question'));
check('gap is under the minimum', e.placed[1].gap_from_previous < MIN_CHECKPOINT_GAP,
  e.placed[1].gap_from_previous);
check('second is flagged crowded', e.placed[1].crowded === true);

console.log(failures ? `\n${failures} FAILING CHECK(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
