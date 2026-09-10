/* Cards generated from missed quiz questions.

   The design was settled by looking at the real bank rather than guessing:
   all 316 NUR144 questions carry a fact_tested, all 316 facts are distinct,
   not one stem is "which of the following"-shaped, and 313 of 316 already end
   in a question mark. So the stem IS the front, the fact IS the back, and no
   language model is needed to invent either. These tests pin that down. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../../lib/card-gen.js');

let fail = 0;
const ck = (n, ok, v) => { if (ok) console.log('  PASS  ' + n); else { fail++; console.log('  FAIL  ' + n + ' -> ' + JSON.stringify(v)); } };

const Q = {
  id: 2874, objective_id: 'N144_L1',
  stem: 'Which term describes painful swallowing?',
  fact_tested: 'odynophagia = painful swallowing; dysphagia = difficulty swallowing',
  explanation: 'Odynophagia is PAINFUL swallowing. Dysphagia is DIFFICULTY swallowing.'
};

console.log('the draft');
{
  const d = G.draft(Q, 'NUR144');
  ck('the front is the question the bank already asks', d.front === Q.stem, d.front);
  ck('the back is the fact under test', /odynophagia/i.test(d.back), d.back);
  ck('the back is capitalised for a card', /^[A-Z]/.test(d.back), d.back);
  ck('the explanation is carried over', d.explanation === Q.explanation);
  ck('objective and course follow the question',
    d.objective_ids[0] === 'N144_L1' && d.course === 'NUR144', d);
  ck('and it remembers where it came from', d.question_id === 2874);

  /* a stem that is not a question must not be shipped as a prompt */
  const stmt = Object.assign({}, Q, { stem: 'The nurse assesses the abdomen.' });
  ck('a non-question stem falls back to asking for the fact',
    /^What do you need to know about/.test(G.draft(stmt, 'NUR144').front),
    G.draft(stmt, 'NUR144').front);

  ck('a question with no fact_tested produces nothing at all',
    G.draft(Object.assign({}, Q, { fact_tested: '' }), 'NUR144') === null);
}

console.log('\nthe duplicate checks');
{
  const base = { suggestions: [], cards: [] };
  ck('a clean question proposes', G.propose(Q, 'NUR144', base).ok === true);

  ck('the same question does not propose twice',
    G.propose(Q, 'NUR144', { suggestions: [{ question_id: 2874, status: 'pending' }], cards: [] }).ok === false);
  ck('and a REJECTED one does not come back — that was a decision',
    G.propose(Q, 'NUR144', { suggestions: [{ question_id: 2874, status: 'rejected' }], cards: [] }).ok === false);

  ck('a card already generated from it blocks a second',
    G.propose(Q, 'NUR144', { suggestions: [],
      cards: [{ id: 9, source_question_id: 2874, question: 'x', answer: 'y', objective_ids: ['N144_L1'] }] }).ok === false);

  const handWritten = { id: 5, question: 'What is odynophagia?',
    answer: 'Odynophagia is painful swallowing; dysphagia is difficulty swallowing',
    objective_ids: ['N144_L1'] };
  const dup = G.propose(Q, 'NUR144', { suggestions: [], cards: [handWritten] });
  ck('a hand-written card covering the same fact blocks it',
    dup.ok === false && /already covers/.test(dup.reason), dup.reason);
  ck('and says how close it was', dup.duplicate.similarity >= G.DUPLICATE_AT, dup.duplicate);

  /* the same words under a DIFFERENT objective are not a duplicate */
  const elsewhere = Object.assign({}, handWritten, { objective_ids: ['N144_SKILLS'] });
  ck('a similar card in another lecture is not a duplicate',
    G.propose(Q, 'NUR144', { suggestions: [], cards: [elsewhere] }).ok === true);

  ck('an unrelated card does not block anything',
    G.propose(Q, 'NUR144', { suggestions: [], cards: [{ id: 6,
      question: 'How often is an ostomy appliance replaced?',
      answer: 'Every 3-7 days or sooner if soiled', objective_ids: ['N144_L1'] }] }).ok === true);
}

console.log('\nthe similarity measure');
{
  ck('identical text scores 1', Math.abs(G.similarity('a b c dog cat', 'a b c dog cat') - 1) < 1e-9);
  ck('nothing in common scores 0',
    G.similarity('remove dentures before inspection', 'confirm placement radiographically') < 0.15);
  ck('a rewording of the same fact scores above the threshold',
    G.similarity('replace appliance every 3-7 days or sooner if soiled',
      'change the ostomy appliance every 3 to 7 days or sooner when soiled') >= G.DUPLICATE_AT);
  ck('empty text never matches', G.similarity('', 'anything') === 0);
  ck('stop words alone do not make a match',
    G.similarity('what is the of and to', 'which are the of and to') === 0);
}

console.log(fail ? `\n${fail} FAILING` : '\nall card generation checks passed');
process.exit(fail ? 1 : 0);
