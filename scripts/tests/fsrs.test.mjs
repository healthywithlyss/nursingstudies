/* The vendored FSRS-6 engine, checked against the reference implementation.

   scripts/tests/fixtures/fsrs-reference.json was produced by running py-fsrs
   (open-spaced-repetition/py-fsrs, fuzzing disabled) over 120 random review
   sequences plus the retrievability and interval curves. A port is only worth
   anything if it agrees with what it was ported from, so this asserts stability,
   difficulty, state, step and due timestamp at EVERY review, not just the end.

   Regenerating the fixture: see the command in the commit that added it. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const FSRS = require('../../vendor/fsrs.js');

const ref = JSON.parse(readFileSync(new URL('./fixtures/fsrs-reference.json', import.meta.url), 'utf8'));
let fail = 0;
const ck = (n, ok, v) => { if (ok) console.log('  PASS  ' + n); else { fail++; console.log('  FAIL  ' + n + ' -> ' + JSON.stringify(v)); } };

console.log('parameters');
ck('21 weights, matching the reference exactly',
  FSRS.DEFAULT_PARAMS.length === 21
  && FSRS.DEFAULT_PARAMS.every((w, i) => Math.abs(w - ref.params[i]) < 1e-12),
  FSRS.DEFAULT_PARAMS);
ck('decay is the last weight', Math.abs(FSRS.DEFAULT_PARAMS[20] - FSRS.DEFAULT_DECAY) < 1e-12);

const s = new FSRS.Scheduler({ desiredRetention: ref.desired_retention });

console.log('\nretrievability and interval curves');
let curveErr = 0, worstCurve = null;
for (const c of ref.curves) {
  if (c.R !== undefined) {
    const got = s.retrievability(c.S, c.t);
    const d = Math.abs(got - c.R);
    if (d > 1e-12) { curveErr++; if (!worstCurve) worstCurve = { ...c, got }; }
  } else {
    const got = s.intervalFor(c.S);
    if (got !== c.interval) { curveErr++; if (!worstCurve) worstCurve = { ...c, got }; }
  }
}
ck('every R(S,t) and interval(S) matches py-fsrs', curveErr === 0, worstCurve);

/* stabilityFor is the inverse the readiness maths needs; py-fsrs has no such
   function, so it is checked against the forward curve instead */
let invErr = 0;
for (const days of [1, 3, 7, 14, 30, 90]) {
  for (const r of [0.8, 0.9, 0.95]) {
    const S = s.stabilityFor(days, r);
    if (Math.abs(s.retrievability(S, days) - r) > 1e-9) invErr++;
  }
}
ck('stabilityFor inverts retrievability', invErr === 0, invErr);

console.log('\n120 review sequences, every step compared');
let seqFail = 0, firstBad = null, steps = 0;
ref.sequences.forEach((seq, si) => {
  let card = FSRS.newCard();
  seq.steps.forEach((want, i) => {
    card = s.review(card, want.rating, want.at);
    steps++;
    const bad =
      Math.abs(card.stability - want.stability) > 1e-9 ||
      Math.abs(card.difficulty - want.difficulty) > 1e-9 ||
      card.state !== want.state ||
      card.due !== want.due ||
      (card.step === null ? null : card.step) !== (want.step === null ? null : want.step);
    if (bad) {
      seqFail++;
      if (!firstBad) firstBad = { seq: si, step: i, rating: want.rating,
        want, got: { stability: card.stability, difficulty: card.difficulty,
                     state: card.state, due: card.due, step: card.step } };
    }
  });
});
ck(`all ${steps} reviews across 120 sequences match the reference`, seqFail === 0, firstBad);

console.log('\nproperties that must hold whatever the weights are');
{
  let c = FSRS.newCard();
  c = s.review(c, FSRS.GOOD, Date.parse('2026-01-01T00:00:00Z'));
  ck('a new card starts in learning, not review', c.state === 'learning', c.state);
  ck('a first review counts as one rep', c.reps === 1 && c.lapses === 0, c);

  /* Again on a card still in learning is not a lapse — nothing was retained to
     lose yet. Only a review-state failure is. */
  let d = s.review(FSRS.newCard(), FSRS.AGAIN, Date.parse('2026-01-01T00:00:00Z'));
  ck('failing a brand-new card is not counted as a lapse', d.lapses === 0, d.lapses);

  let e = FSRS.newCard();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  e = s.review(e, FSRS.GOOD, t0);
  e = s.review(e, FSRS.GOOD, e.due);
  ck('two Goods graduate to review', e.state === 'review', e.state);
  const before = e.lapses;
  e = s.review(e, FSRS.AGAIN, e.due);
  ck('failing a graduated card IS a lapse', e.lapses === before + 1, e.lapses);
  ck('and drops it into relearning', e.state === 'relearning', e.state);
}
{
  /* Easy must never schedule sooner than Good from the same state */
  let base = FSRS.newCard();
  const t = Date.parse('2026-01-01T00:00:00Z');
  base = s.review(base, FSRS.GOOD, t);
  base = s.review(base, FSRS.GOOD, base.due);
  const at = base.due;
  const good = s.review(base, FSRS.GOOD, at), easy = s.review(base, FSRS.EASY, at),
        hard = s.review(base, FSRS.HARD, at);
  ck('Easy >= Good >= Hard on the next interval',
    easy.due >= good.due && good.due >= hard.due,
    { hard: hard.interval_days, good: good.interval_days, easy: easy.interval_days });
  ck('review() does not mutate its input', base.stability !== undefined && base.due === at);
}
{
  ck('R falls monotonically with time',
    [0, 1, 5, 20, 100].every((t, i, a) => i === 0 || s.retrievability(10, t) < s.retrievability(10, a[i - 1])));
  ck('R at t=0 is 1', Math.abs(s.retrievability(10, 0) - 1) < 1e-12);
  ck('an unseen item has R=0, not R=1', s.retrievability(null, 5) === 0 && s.retrievability(0, 0) === 0);
  ck('interval at the desired retention round-trips',
    Math.abs(s.retrievability(20, s.intervalFor(20)) - 0.9) < 0.01, s.intervalFor(20));
}

console.log(fail ? `\n${fail} FAILING` : '\nall FSRS engine checks passed');
process.exit(fail ? 1 : 0);
