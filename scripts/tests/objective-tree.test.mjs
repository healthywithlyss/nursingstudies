/* ══════════════════════════════════════════════════════════════════════════
   OBJECTIVE TREE

   Cards now carry a lecture tag and an objective tag (N144_L1 + N144_L1_O4).
   The tree groups objectives under lectures, names them from the objectives
   table, and counts every card once per node. The bug this guards: a card
   tagged twice being counted twice, or served twice when its lecture and one
   of its objectives are both selected.
   ══════════════════════════════════════════════════════════════════════════ */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const OT = require('../../lib/objective-tree.js');
const SS = require('../../lib/study-session.js');

let fail = 0;
const ck = (n, ok, v) => { if (ok) console.log('  PASS  ' + n); else { fail++; console.log('  FAIL  ' + n + ' -> ' + JSON.stringify(v)); } };

const rows = [
  { id: 'N144_L1', lecture: 'Lecture 1', description: 'NUR 144 Unit 1 Lecture 1 - Gastrointestinal Assessment, Gastric and Duodenal Disorders' },
  { id: 'N144_L1_O1', lecture: 'L1 Obj 1', description: 'Review anatomy and physiology of the GI system' },
  { id: 'N144_L1_O4', lecture: 'L1 Obj 4', description: 'Describe common assessments of the GI system' },
  { id: 'N144_L1_O10', lecture: 'L1 Obj 10', description: 'Tenth objective' },
  { id: 'N144_L2', lecture: 'Lecture 2', description: 'NUR 144 Unit 1 Lecture 2 - Hepatic: liver dysfunction' },
  { id: 'N144_SKILLS', lecture: 'Skills', description: 'NUR 144 Skills Lab - NG tube insertion' },
  { id: 'N146_L1', lecture: 'Lecture 1', description: 'NUR 146 Unit 1 Lecture 1 - Endocrine Review' }
];

console.log('\nshape: lectures with objectives nested, names from the table');
{
  const t = OT.build(rows, { units: { N144_L1: 1, N144_SKILLS: 1 }, filter: (id) => id.startsWith('N144'), ids: ['N144_L2_O3'] });
  ck('three lectures for NUR144, in id order', t.lectures.map((l) => l.id).join(',') === 'N144_L1,N144_L2,N144_SKILLS', t.lectures.map((l) => l.id));
  ck('NUR146 is filtered out', !t.has('N146_L1'));
  const l1 = t.byId.N144_L1;
  ck('Lecture 1 named from the table, with a short subtitle', l1.name === 'Lecture 1' && l1.sub === 'Gastrointestinal Assessment, Gastric and…', [l1.name, l1.sub]);
  ck('its objectives are nested and sorted numerically (1, 4, 10 — not 1, 10, 4)', l1.objectives.map((o) => o.num).join(',') === '1,4,10', l1.objectives.map((o) => o.id));
  ck('an objective is named "Objective n" with the description as its text', t.label('N144_L1_O4').name === 'Objective 4' && t.label('N144_L1_O4').sub === 'Describe common assessments of the GI system', t.label('N144_L1_O4'));
  ck('an objective seen in content but missing from the table still gets a node under its lecture', t.has('N144_L2_O3') && t.byId.N144_L2.objectives[0].id === 'N144_L2_O3' && t.label('N144_L2_O3').name === 'Objective 3');
  ck('parentOf strips only the _On suffix', OT.parentOf('N144_L1_O4') === 'N144_L1' && OT.parentOf('N144_L1') === null && OT.parentOf('N144_SKILLS') === null);
  ck('a lecture with no row is derived from the id', OT.build([], { ids: ['N146_L2_O1'] }).label('N146_L2').name === 'Lecture 2');
}

console.log('\nunits: objectives inherit their lecture\'s unit');
{
  const t = OT.build(rows, { units: { N144_L1: 1, N144_L2: 2 } });
  ck('N144_L1_O4 is unit 1 through its lecture', t.unitOf('N144_L1_O4') === 1);
  ck('a Lecture 2 objective is unit 2 through its lecture', t.unitOf('N144_L2') === 2);
  ck('an unassigned lecture has no unit, and neither do its objectives', t.unitOf('N144_SKILLS') === null);
}

console.log('\ncounting: every card counts once per node');
{
  const items = [
    { id: 1, objectiveIds: ['N144_L1', 'N144_L1_O4'], state: 'review', last_result: 'missed' },
    { id: 2, objectiveIds: ['N144_L1', 'N144_L1_O4', 'N144_L1_O1'], state: 'new' },
    { id: 3, objectiveIds: ['N144_L1'], state: 'learning', last_result: 'got_it' },
    { id: 4, objectiveIds: ['N144_L1_O1'], state: 'review', last_result: 'got_it' },   /* objective tag only */
    { id: 5, objectiveIds: ['N144_L2'], state: 'new' }
  ];
  const fns = { isNew: (i) => i.state === 'new', failing: (i) => i.last_result === 'missed' };
  const s = OT.stats(null, items, fns);
  ck('Lecture 1 has 4 cards — the double-tagged ones once, the objective-only one included', s.N144_L1.cards === 4, s.N144_L1);
  ck('Objective 4 has 2 cards', s.N144_L1_O4.cards === 2, s.N144_L1_O4);
  ck('Objective 1 has 2 cards (one triple-tagged, one objective-only)', s.N144_L1_O1.cards === 2, s.N144_L1_O1);
  ck('seen / failing / new left are per node', s.N144_L1.seen === 3 && s.N144_L1.failing === 1 && s.N144_L1.newLeft === 1, s.N144_L1);
  ck('a lecture-only course counts too', s.N144_L2.cards === 1 && s.N144_L2.newLeft === 1);
  const total = new Set(items.map((i) => i.id)).size;
  ck('the deck total is the number of distinct cards, not the sum of node counts', total === 5 && s.N144_L1.cards + s.N144_L2.cards === 5);
}

console.log('\nselection: lecture plus one of its objectives serves a card once');
{
  const items = [
    { id: 1, objectiveIds: ['N144_L1', 'N144_L1_O4'] },
    { id: 2, objectiveIds: ['N144_L1', 'N144_L1_O1'] },
    { id: 3, objectiveIds: ['N144_L2'] },
    { id: 4, objectiveIds: ['N144_L1_O4'] }
  ];
  const pick = (sel) => items.filter((i) => OT.matches(i.objectiveIds, sel)).map((i) => i.id);
  ck('null selects everything', pick(null).join(',') === '1,2,3,4');
  ck('a whole lecture', pick(['N144_L1']).join(',') === '1,2');
  ck('one objective on its own', pick(['N144_L1_O4']).join(',') === '1,4');
  ck('several objectives across lectures', pick(['N144_L1_O1', 'N144_L2']).join(',') === '2,3');
  ck('lecture + one of its objectives: each card once, no duplicate', pick(['N144_L1', 'N144_L1_O4']).join(',') === '1,2,4');
  /* and the session itself cannot serve a duplicate: items are keyed by id */
  const s = SS.create({ items: items.filter((i) => OT.matches(i.objectiveIds, ['N144_L1', 'N144_L1_O4'])).map((i) => ({ id: i.id, kind: 'card', objectiveIds: i.objectiveIds, state: 'new', repetitions: 0, lapses: 0 })), now: Date.now() });
  ck('a session over that selection holds each card once', s.order.length === 3 && new Set(s.order).size === 3, s.order);
}

console.log(fail ? `\n${fail} FAILING` : '\nall objective tree checks passed');
process.exit(fail ? 1 : 0);
