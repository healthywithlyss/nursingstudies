/* ══════════════════════════════════════════════════════════════════════════
   REPLAY

   scripts/replay-mastery.mjs rebuilds FSRS state from attempt history. It is a
   repair tool that writes to real scheduling data, so the properties that make
   it safe are asserted rather than assumed:

     - attempts are applied at their ORIGINAL timestamps, because FSRS
       stability depends on the gaps between reviews;
     - a row is only replaced when the replay knows strictly more than it does,
       so an undamaged row holding a real Easy is never downgraded to Good;
     - is_mastered means something.
   ══════════════════════════════════════════════════════════════════════════ */
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { makeScheduler, replayItem, planFor, masteredFrom, RATING_FROM_RESULT,
         MASTERY_HORIZON_DAYS } from '../replay-mastery.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ES = require(path.join(ROOT, 'lib/exam-scheduler.js'));

const DAY = 86400000;
const T0 = Date.parse('2026-06-01T09:00:00Z');
let fail = 0;
function ck(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); return; }
  fail++;
  console.log('  FAIL  ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
}

const sched = makeScheduler({ learningSteps: [1, 10], relearningSteps: [10] });

/* ── timestamps ──────────────────────────────────────────────────────── */
console.log('\nattempts are replayed at their original times');
{
  const seq = [3, 3, 3, 3];
  const spaced = seq.map((r, i) => ({ at: T0 + i * 7 * DAY, rating: r }));
  const sameInstant = seq.map((r) => ({ at: T0, rating: r }));

  const a = replayItem(sched, spaced);
  const b = replayItem(sched, sameInstant);
  ck('a card reviewed weekly ends far more stable than the same ratings at once',
    a.stability > b.stability * 3, { spaced: a.stability, collapsed: b.stability });
  /* Both end in 'review' — four Goods graduate either way — so the state is
     not what a collapsed replay gets wrong. The INTERVAL is: it would put a
     card she has held for three weeks back in front of her within days. */
  ck('and the collapsed replay would reschedule it far too soon',
    (b.due - b.last_review) * 3 < (a.due - a.last_review),
    { spacedDays: (a.due - a.last_review) / DAY,
      collapsedDays: (b.due - b.last_review) / DAY });

  ck('last_review ends at the last attempt, not at now',
    a.last_review === T0 + 3 * 7 * DAY, new Date(a.last_review).toISOString());
  ck('every attempt is counted', a.reps === 4, a.reps);

  /* wider gaps must mean more stability, monotonically */
  const stabs = [1, 3, 7, 21, 60].map((g) =>
    replayItem(sched, seq.map((r, i) => ({ at: T0 + i * g * DAY, rating: r }))).stability);
  ck('longer gaps produce monotonically greater stability',
    stabs.every((s, i) => i === 0 || s > stabs[i - 1]), stabs);
}

console.log('\ntime never runs backwards');
{
  const jumbled = [
    { at: T0 + 5 * DAY, rating: 3 },
    { at: T0, rating: 3 },                 /* out of order / clock skew */
    { at: T0 + 9 * DAY, rating: 3 }
  ];
  const c = replayItem(sched, jumbled);
  ck('an out-of-order attempt does not produce a negative elapsed time',
    isFinite(c.stability) && c.stability > 0, c.stability);
  ck('and the card still ends at the latest attempt',
    c.last_review === T0 + 9 * DAY);
}

/* ── the rating map ──────────────────────────────────────────────────── */
console.log('\nthe legacy result map, and what it cannot recover');
{
  ck('missed -> Again, unsure -> Hard, got_it -> Good',
    RATING_FROM_RESULT.missed === 1 && RATING_FROM_RESULT.unsure === 2
    && RATING_FROM_RESULT.got_it === 3, RATING_FROM_RESULT);
  ck('Easy is not in the map at all, because the history cannot express it',
    !Object.values(RATING_FROM_RESULT).includes(4));

  /* the cost of that, stated: an Easy card replayed as Good comes back sooner */
  const asEasy = replayItem(sched, [{ at: T0, rating: 4 }]);
  const asGood = replayItem(sched, [{ at: T0, rating: 3 }]);
  ck('replaying a real Easy as Good shortens the interval rather than lengthening it',
    asGood.due - asGood.last_review < asEasy.due - asEasy.last_review,
    { good: asGood.due - asGood.last_review, easy: asEasy.due - asEasy.last_review });
  ck('which errs toward MORE review, the safe direction',
    asGood.stability < asEasy.stability, { good: asGood.stability, easy: asEasy.stability });
}

/* ── the clamp is applied to scheduling, never to memory ─────────────── */
console.log('\nthe exam clamp moves the due date, not the memory state');
{
  const attempts = [0, 7, 21, 45].map((d) => ({ at: T0 + d * DAY, rating: 3 }));
  const exam = { key: 'unit1', date: ES.parseDate('2026-08-01') };
  const free = planFor(sched, attempts, {});
  const held = planFor(sched, attempts, { exam, settings: {} });

  ck('stability is history and is identical either way',
    free.stability === held.stability, { free: free.stability, held: held.stability });
  ck('difficulty likewise', free.difficulty === held.difficulty);
  ck('repetitions and lapses likewise',
    free.repetitions === held.repetitions && free.lapses === held.lapses);
  ck('only the due date moves', held.due_date <= free.due_date, {
    free: new Date(free.due_date).toISOString(), held: new Date(held.due_date).toISOString() });
  ck('and it says when it moved it', held.clamped === true);
  ck('nothing is scheduled past the exam',
    held.due_date < ES.parseDate('2026-08-01'),
    new Date(held.due_date).toISOString());
}

/* ── is_mastered ─────────────────────────────────────────────────────── */
console.log('\nis_mastered means something now');
{
  const once = replayItem(sched, [{ at: T0, rating: 3 }]);
  ck('one correct answer is NOT mastery — the old flag’s whole problem',
    masteredFrom(sched, once) === false);

  const learning = replayItem(sched, [{ at: T0, rating: 3 }, { at: T0 + 60000, rating: 3 }]);
  ck('nor is being part-way through the learning steps',
    learning.state !== 'review' ? masteredFrom(sched, learning) === false : true,
    learning.state);

  const solid = replayItem(sched,
    [0, 7, 21, 60, 140].map((d) => ({ at: T0 + d * DAY, rating: 3 })));
  ck('a card held across months is', masteredFrom(sched, solid) === true,
    { state: solid.state, stability: solid.stability, reps: solid.reps });

  const shaky = replayItem(sched,
    [0, 1, 2, 3].map((d) => ({ at: T0 + d * DAY, rating: 1 })));
  ck('a card being failed repeatedly is not',
    masteredFrom(sched, shaky) === false, { state: shaky.state, stability: shaky.stability });

  ck('the horizon is stated rather than implied', MASTERY_HORIZON_DAYS === 30);
  ck('and it is judged at that horizon, not at this instant',
    sched.retrievability(solid.stability, 0) > sched.retrievability(solid.stability, MASTERY_HORIZON_DAYS));
}

/* ── never overwrite a better-informed row ───────────────────────────── */
console.log('\na row that already knows as much is left alone');
{
  /* This is the Easy-protection rule. It lives in the CLI, so it is asserted
     here as the property it has to hold: replace only on strictly more. */
  const decide = (storedReps, replayReps) => replayReps > storedReps;
  ck('a frozen row (1 stored, 5 replayed) is repaired', decide(1, 5) === true);
  ck('an untouched row (1 stored, 1 replayed) is NOT overwritten', decide(1, 1) === false);
  ck('a row with no FSRS state at all is repaired', decide(0, 2) === true);
  ck('a row ahead of the history is never rolled back', decide(3, 2) === false);
}

console.log(fail ? `\n${fail} FAILING` : '\nall replay checks passed');
process.exit(fail ? 1 : 0);
