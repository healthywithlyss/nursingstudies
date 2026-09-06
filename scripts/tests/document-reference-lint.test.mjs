/* The narrator must never describe the document she is listening to.
 *
 * The first gastritis script said: "The source lays these two out side by side
 * in a comparison table so you can appreciate their differences directly."
 * She is on headphones — there is no table. Neither coverage nor the
 * unsourced-claims pass sees this, because it is a narration defect and not a
 * factual one, so it gets its own deterministic lint.
 *
 * The risk with a lint like this is false positives on ordinary clinical prose,
 * so the CLEAN fixtures below matter as much as the DIRTY ones.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = readFileSync(new URL('../../supabase/functions/generate-podcast-script/index.ts', import.meta.url), 'utf8');
const start = src.indexOf('const DOC_REF_PATTERNS');
const end = src.indexOf('/* Checkpoint placement.');
if (start < 0 || end < 0) throw new Error('could not locate the document-reference lint in index.ts');
const file = join(mkdtempSync(join(tmpdir(), 'lint-')), 'lint.ts');
writeFileSync(file, src.slice(start, end) + '\nexport { findDocumentReferences };\n');
const { findDocumentReferences } = await import(file);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
};

/* the real sentence from the run, plus the other shapes it takes */
const DIRTY = [
  ['the actual regression', 'The source lays these two out side by side in a comparison table so you can appreciate their differences directly.'],
  ['names a table', 'Look at the comparison table for acute versus chronic.'],
  ['names the guide', 'The study guide flags this one as must-know.'],
  ['names the source', 'The source does not say anything about that.'],
  ['names a slide', 'She put this on the slides in lecture.'],
  ['names a section', 'We will come back to that in this section.'],
  ['names bullets', 'There are four bullet points to remember here.'],
  ['describes layout', 'These two are listed side by side so the contrast is obvious.'],
  ['as you can see', 'As you can see, erosive gastritis causes melena.'],
  ['names a column', 'The first column is acute and the second is chronic.'],
];
console.log('dirty fixtures — every one must be caught');
DIRTY.forEach(([name, text]) => {
  const hits = findDocumentReferences(text);
  check(name, hits.length > 0, { text, hits });
});

/* Ordinary clinical narration that happens to use words the patterns care
   about. A lint that trips on these is worse than no lint. */
const CLEAN = [
  ['barrier prose', 'The stomach makes acid strong enough to digest tissue, and the only thing stopping it is the mucosal barrier.'],
  ['contrast taught directly', 'Acute comes on fast and burns out in one to three days; chronic just grinds on, and that is the one that atrophies the tissue.'],
  ['a real clinical list', 'You are watching for dehydration, electrolyte imbalance, and hemorrhage.'],
  ['second person address', 'Here is why that matters for the patient in front of you.'],
  ['the word section, clinically', 'A cesarean section is not what we are talking about here.'],
  ['shown as a symptom', 'Pernicious anemia shows up because B twelve cannot be absorbed.'],
  ['above meaning anatomy', 'The pain sits above the umbilicus in the epigastric area.'],
  ['listed as a verb about symptoms', 'Hiccups belong with acute gastritis and not with chronic.'],
  ['table as furniture', 'Raise the head of the bed before the patient eats at the table.'],
  ['a checkpoint question', 'What is the difference between erosive and nonerosive gastritis?'],
];
console.log('clean fixtures — none may be flagged');
CLEAN.forEach(([name, text]) => {
  const hits = findDocumentReferences(text);
  check(name, hits.length === 0, { text, hits: hits.map((h) => h.phrase) });
});

/* shape of what it reports */
const hits = findDocumentReferences('The source lays these two out side by side in a comparison table.');
console.log('report shape');
check('reports phrase, kind and context', hits.every((h) => h.phrase && h.kind && h.context), hits);
check('context is single-spaced for reading', hits.every((h) => !/\s\s/.test(h.context)));

console.log(failures ? `\n${failures} FAILING CHECK(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
