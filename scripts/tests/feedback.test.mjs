/* ══════════════════════════════════════════════════════════════════════════
   FEEDBACK

   Storing a rating is not the same as USING it. The upsert bug was writes being
   rejected; this suite guards the other failure mode — writes landing but being
   ignored on the next computation.

   Every step here goes through the full round trip the app performs:

     peek()   the four button intervals
     answer() the outcome
     rowFor() exactly what persistCard writes to card_mastery
     toItem() exactly what loadAll rebuilds from that row
     a BRAND NEW Session built from the rebuilt item

   Nothing carries over in memory. If history did not survive the row, or were
   not read back into the calculation, the numbers would reset and these fail.

   Time advances to each card's own due date, so elapsed time is real — FSRS
   stability depends on it, and a harness that reviewed everything at one
   instant would prove nothing.
   ══════════════════════════════════════════════════════════════════════════ */
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SS = require(path.join(ROOT, 'lib/study-session.js'));
const ES = require(path.join(ROOT, 'lib/exam-scheduler.js'));

const DAY = 86400000;
const T0 = Date.parse('2026-09-13T09:00:00Z');
const SETTINGS = { learningSteps: [1, 10], relearningSteps: [10] };

let fail = 0;
function ck(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); return; }
  fail++;
  console.log('  FAIL  ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
}

/* No exam, so nothing is clamped and the raw FSRS response is visible. The
   clamp is exercised separately below — it has its own behaviour. */
const noclamp = (raw) => ({ ms: raw, compressed: false, rawMs: raw });

/* verbatim from index.html persistCard */
function rowFor(c) {
  return {
    state: c.state, learning_step: c.step == null ? null : c.step,
    stability: c.stability, difficulty: c.difficulty,
    due_date: new Date(c.due).toISOString(),
    last_reviewed_at: new Date(c.last_review).toISOString(),
    interval_days: c.interval_days, repetitions: c.reps, lapses: c.lapses
  };
}
/* verbatim from index.html toItem */
function toItem(row, id) {
  return {
    id, kind: 'card', objectiveIds: ['N144_L1'],
    state: row.state, stability: row.stability, difficulty: row.difficulty,
    due_date: row.due_date ? Date.parse(row.due_date) : null,
    last_reviewed_at: row.last_reviewed_at ? Date.parse(row.last_reviewed_at) : null,
    repetitions: row.repetitions || 0, lapses: row.lapses || 0,
    learning_step: row.learning_step != null ? row.learning_step : null,
    interval_days: row.interval_days || 0
  };
}
const fresh = (id) => ({
  id, kind: 'card', objectiveIds: ['N144_L1'], state: 'new',
  stability: null, difficulty: null, due_date: null, last_reviewed_at: null,
  repetitions: 0, lapses: 0, learning_step: null, interval_days: 0
});

let divergences = [];

/* Drive a card through a sequence of ratings, reloading from the stored row
   between every step. Returns the final row and the next four intervals. */
function drive(ratings, clamp) {
  const c = clamp || noclamp;
  let item = fresh(1);
  let now = T0;
  let row = null;
  for (const rating of ratings) {
    const s = SS.create({ now, items: [item], settings: SETTINGS, clamp: c });
    const buttons = s.peek(1, now);
    const out = s.answer(1, rating, now);
    row = rowFor(out.card);
    /* the number on the button must be the number that gets stored */
    const shown = buttons[rating].ms;
    const stored = Date.parse(row.due_date) - now;
    if (shown !== stored) divergences.push({ ratings, rating, shown, stored });
    item = toItem(row, 1);          /* THE RELOAD */
    now = Date.parse(row.due_date); /* answered exactly when due */
  }
  const s = SS.create({ now, items: [item], settings: SETTINGS, clamp: c });
  return { row, next: s.peek(1, now), item, now };
}

/* ── the headline: a miss leaves a lasting mark ───────────────────────── */
console.log('\na card you missed stays harder than one you never missed');
{
  const A = drive([3, 3, 3, 3]);          /* Good Good Good Good */
  const B = drive([1, 3, 3, 3]);          /* Again Good Good Good */

  ck('both took four ratings', A.row.repetitions === 4 && B.row.repetitions === 4,
    { a: A.row.repetitions, b: B.row.repetitions });
  ck('the missed card ends LESS stable',
    B.row.stability < A.row.stability,
    { a: A.row.stability, b: B.row.stability });
  ck('and MORE difficult',
    B.row.difficulty > A.row.difficulty,
    { a: A.row.difficulty, b: B.row.difficulty });
  ck('its stored interval is shorter',
    B.row.interval_days < A.row.interval_days,
    { a: A.row.interval_days, b: B.row.interval_days });
  ck('it is due sooner',
    Date.parse(B.row.due_date) < Date.parse(A.row.due_date),
    { a: A.row.due_date, b: B.row.due_date });

  /* the point of the whole exercise: the NEXT offer differs */
  ck('and the Good it offers next is shorter, three clean answers later',
    B.next[3].ms < A.next[3].ms,
    { a: SS.formatInterval(A.next[3].ms), b: SS.formatInterval(B.next[3].ms) });
  ck('Hard and Easy too',
    B.next[2].ms < A.next[2].ms && B.next[4].ms < A.next[4].ms);
  ck('the gap is large, not a rounding wobble',
    A.next[3].ms > B.next[3].ms * 5,
    { a: SS.formatInterval(A.next[3].ms), b: SS.formatInterval(B.next[3].ms) });

  /* Again is a relearning STEP, a fixed 10 minutes, not a function of memory.
     Pinned so its sameness is never read as the feedback having died. */
  ck('Again is the same for both, because it is a fixed relearning step',
    A.next[1].ms === B.next[1].ms && A.next[1].ms === 10 * 60000,
    SS.formatInterval(A.next[1].ms));
}

/* ── it survives the reload, which is the actual claim ────────────────── */
console.log('\nthe effect lives in the stored row, not in memory');
{
  const B = drive([1, 3, 3, 3]);
  /* rebuild from the row one more time, in a fresh Session, and re-ask */
  const again = SS.create({ now: B.now, items: [toItem(B.row, 1)],
    settings: SETTINGS, clamp: noclamp }).peek(1, B.now);
  ck('re-reading the row gives the identical four intervals',
    [1, 2, 3, 4].every((r) => again[r].ms === B.next[r].ms),
    [1, 2, 3, 4].map((r) => [SS.formatInterval(B.next[r].ms), SS.formatInterval(again[r].ms)]));

  /* and if difficulty were dropped on the way back, the intervals would move */
  const lossy = Object.assign({}, toItem(B.row, 1), { difficulty: null });
  const blind = SS.create({ now: B.now, items: [lossy], settings: SETTINGS,
    clamp: noclamp }).peek(1, B.now);
  ck('losing difficulty on reload WOULD change them — so it is genuinely read',
    blind[3].ms !== again[3].ms,
    { withD: SS.formatInterval(again[3].ms), withoutD: SS.formatInterval(blind[3].ms) });
}

/* ── lapses ───────────────────────────────────────────────────────────── */
console.log('\nlapses: what increments it, and whether anything reads it');
{
  const newCardAgain = drive([1, 3, 3, 3]);
  ck('Again on a NEW card is not a lapse — it never left learning',
    newCardAgain.row.lapses === 0, newCardAgain.row.lapses);

  const trueLapse = drive([3, 3, 1, 3, 3]);
  ck('Again on a card in REVIEW is a lapse', trueLapse.row.lapses === 1,
    trueLapse.row.lapses);
  const twoLapses = drive([3, 3, 1, 3, 1, 3]);
  ck('and they accumulate', twoLapses.row.lapses === 2, twoLapses.row.lapses);

  const clean = drive([3, 3, 3, 3, 3]);
  ck('one lapse costs a lot of stability',
    trueLapse.row.stability < clean.row.stability / 10,
    { clean: clean.row.stability, lapsed: trueLapse.row.stability });
  ck('a SECOND lapse bites again rather than plateauing',
    twoLapses.row.difficulty > trueLapse.row.difficulty
    && twoLapses.row.stability < trueLapse.row.stability,
    { oneD: trueLapse.row.difficulty, twoD: twoLapses.row.difficulty,
      oneS: trueLapse.row.stability, twoS: twoLapses.row.stability });
  ck('and shortens the next Good further',
    twoLapses.next[3].ms < trueLapse.next[3].ms,
    { one: SS.formatInterval(trueLapse.next[3].ms),
      two: SS.formatInterval(twoLapses.next[3].ms) });

  /* lapses itself is a counter, NOT an input. The forgetting is carried by
     stability and difficulty. Pinned so nobody "fixes" a non-bug. */
  const base = { id: 1, kind: 'card', objectiveIds: ['N144_L1'], state: 'review',
    stability: 10, difficulty: 5, due_date: T0 - DAY, last_reviewed_at: T0 - 11 * DAY,
    repetitions: 5, lapses: 0, learning_step: null, interval_days: 10 };
  const at = (l) => SS.create({ now: T0, items: [Object.assign({}, base, { lapses: l })],
    settings: SETTINGS, clamp: noclamp }).peek(1, T0);
  ck('lapses is stored and displayed but is NOT an input to FSRS-6 itself',
    [1, 2, 3, 4].every((r) => at(0)[r].ms === at(20)[r].ms),
    { zero: SS.formatInterval(at(0)[3].ms), twenty: SS.formatInterval(at(20)[3].ms) });
  const byD = (d) => SS.create({ now: T0, items: [Object.assign({}, base, { difficulty: d })],
    settings: SETTINGS, clamp: noclamp }).peek(1, T0);
  ck('difficulty IS, which is where the lasting mark actually lives',
    byD(2)[3].ms > byD(8)[3].ms,
    { easy: SS.formatInterval(byD(2)[3].ms), hard: SS.formatInterval(byD(8)[3].ms) });
}

/* ── Hard, without ever failing ───────────────────────────────────────── */
console.log('\nHard leaves a mark too, with no lapse involved');
{
  const g = drive([3, 3, 3, 3]);
  const h1 = drive([2, 3, 3, 3]);
  const h2 = drive([2, 2, 3, 3]);
  ck('one Hard raises difficulty above an all-Good card',
    h1.row.difficulty > g.row.difficulty,
    { good: g.row.difficulty, hard: h1.row.difficulty });
  ck('two Hards raise it further', h2.row.difficulty > h1.row.difficulty,
    { one: h1.row.difficulty, two: h2.row.difficulty });
  ck('no lapse is recorded for any of them',
    g.row.lapses === 0 && h1.row.lapses === 0 && h2.row.lapses === 0);
  ck('and the next Good gets progressively shorter',
    g.next[3].ms > h1.next[3].ms && h1.next[3].ms > h2.next[3].ms,
    [g, h1, h2].map((x) => SS.formatInterval(x.next[3].ms)));
}

/* ── the ladder stays ordered at every strength ───────────────────────── */
console.log('\nthe four buttons stay in order however the card is doing');
{
  /* Never decreasing, always. Not always STRICTLY increasing: a review
     interval is a whole number of days with a floor of one, so on a very weak
     card Hard and Good both mean "tomorrow" — 0.72 and 1.02 days of stability
     both round to 1. That is the day granularity, not a lost distinction, and
     the stored stability below proves the two still part company. */
  [[3, 3, 3, 3], [1, 3, 3, 3], [3, 3, 1, 3, 1, 3], [2, 2, 3, 3]].forEach((path) => {
    const x = drive(path);
    const ms = [1, 2, 3, 4].map((r) => x.next[r].ms);
    ck('Again <= Hard <= Good <= Easy after ' + path.join(''),
      ms[0] <= ms[1] && ms[1] <= ms[2] && ms[2] <= ms[3],
      ms.map(SS.formatInterval));
    ck('  and Again is strictly shortest, Easy strictly longest, after '
      + path.join(''), ms[0] < ms[1] && ms[2] < ms[3], ms.map(SS.formatInterval));
  });

  /* Where two buttons tie on the day, the memory state they store must not. */
  const weak = drive([3, 3, 1, 3, 1, 3]);
  const s = SS.create({ now: weak.now, items: [weak.item], settings: SETTINGS,
    clamp: noclamp });
  const afterHard = s.place(1, 2, weak.now).after;
  const afterGood = s.place(1, 3, weak.now).after;
  ck('two buttons showing the same day still store different stability',
    afterHard.stability !== afterGood.stability
    && afterHard.stability < afterGood.stability,
    { hard: afterHard.stability, good: afterGood.stability,
      shown: [SS.formatInterval(weak.next[2].ms), SS.formatInterval(weak.next[3].ms)] });
  ck('so the choice still matters for every review after this one',
    afterHard.difficulty > afterGood.difficulty,
    { hard: afterHard.difficulty, good: afterGood.difficulty });
}

/* ── the display equals what is stored ────────────────────────────────── */
console.log('\nthe number on the button is the number that gets stored');
{
  ck('across every path driven above, with no exam clamp',
    divergences.length === 0, divergences.slice(0, 3));

  /* and again with the clamp engaged, which is where a divergence would hide */
  divergences = [];
  const exam = { key: 'unit1', date: ES.parseDate('2026-10-08') };
  const clamp = (raw, max, t) => ES.compressToRunway(raw, max, exam, t,
    { sweepDaysUnit: 15, sweepDaysFinal: 30 });
  [[3, 3, 3, 3], [1, 3, 3, 3], [3, 3, 1, 3, 3], [2, 2, 3, 3]].forEach((p) => drive(p, clamp));
  ck('and with a real exam clamp engaged, on high- and low-difficulty cards',
    divergences.length === 0, divergences.slice(0, 3));
}

console.log(fail ? `\n${fail} FAILING` : '\nall feedback checks passed');
process.exit(fail ? 1 : 0);
