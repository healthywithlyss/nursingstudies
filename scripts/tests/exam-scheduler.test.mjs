/* The four things the exam scheduler promises, tested as behaviour rather than
   as implementation:

     1. an interval is never scheduled past the exam it belongs to
     2. unit 1 material resurfaces before the comprehensive final
     3. nothing goes into an exam unseen
     4. being behind is reported, with the daily number needed

   Plus readiness maths, which has to be right from zero reviews — "0% ready,
   460 never seen, 34 days" is the number that is supposed to make her study,
   and a readiness section that hides itself until there is data would never
   show it. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const FSRS = require('../../vendor/fsrs.js');
const ES = require('../../lib/exam-scheduler.js');

let fail = 0;
const ck = (n, ok, v) => { if (ok) console.log('  PASS  ' + n); else { fail++; console.log('  FAIL  ' + n + ' -> ' + JSON.stringify(v)); } };

const sched = new FSRS.Scheduler();
const DAY = 86400000;
const NOW = new Date(2026, 8, 7, 9, 0, 0).getTime();     /* local, like the app */
const dstr = (ms) => { const d = new Date(ms); return d.getFullYear() + '-'
  + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const inDays = (n) => dstr(NOW + n * DAY);

let nextId = 1;
function item(over) {
  return Object.assign({
    kind: 'card', id: nextId++, objectiveIds: ['N144_L1'],
    state: 'review', stability: 10, difficulty: 5,
    due_date: NOW + 5 * DAY, last_reviewed_at: NOW - 2 * DAY,
    repetitions: 3, lapses: 0
  }, over);
}
const UNITS = { N144_L1: 1, N144_SKILLS: 1, N144_PSY: 2 };

/* ── 1. clamping ─────────────────────────────────────────────────────── */
console.log('clamping intervals to the exam');
{
  const exam = { key: 'unit1', date: ES.parseDate(inDays(12)) };
  const far = NOW + 40 * DAY;
  const clamped = ES.clampDue(far, exam, NOW);
  ck('a 40-day interval with a test in 12 days is pulled back',
    clamped < exam.date && clamped <= exam.date - DAY, { clamped: dstr(clamped), exam: inDays(12) });
  ck('and lands before the exam, not on it', ES.daysBetween(clamped, exam.date) <= -1,
    ES.daysBetween(clamped, exam.date));

  const near = NOW + 3 * DAY;
  ck('an interval that already fits is left alone', ES.clampDue(near, exam, NOW) === near);

  const step = NOW + 10 * 60000;
  ck('a sub-day learning step is never clamped', ES.clampDue(step, exam, NOW) === step);

  const tight = { key: 'unit1', date: ES.parseDate(inDays(1)) };
  ck('with the exam tomorrow the clamp never schedules into the past',
    ES.clampDue(NOW + 40 * DAY, tight, NOW) >= ES.startOfDay(NOW) + DAY);

  ck('no exam set means no clamp at all', ES.clampDue(far, null, NOW) === far);
}

/* ── 2. resurfacing ──────────────────────────────────────────────────── */
console.log('\nresurfacing unit 1 before the final');
{
  /* the unit 1 test is behind us; the final is 20 days out */
  const exams = { unit1: inDays(-10), unit2: inDays(40), final: inDays(20) };

  const u1 = ES.nextExamFor(1, exams, NOW);
  ck('once the unit 1 date passes, unit 1 answers to the final',
    u1 && u1.key === 'final', u1 && u1.key);
  const u2 = ES.nextExamFor(2, exams, NOW);
  ck('unit 2 still answers to the unit 2 test', u2 && u2.key === 'unit2', u2 && u2.key);

  /* a unit 1 item with a long interval reaching past the final */
  const stale = item({ stability: 60, due_date: NOW + 45 * DAY,
    last_reviewed_at: ES.parseDate(inDays(-30)) });
  const pulled = ES.clampDue(stale.due_date, u1, NOW);
  ck('its interval is pulled back inside the final',
    pulled <= ES.parseDate(exams.final) - DAY, dstr(pulled));

  const debt = ES.coverageDebt([stale], UNITS, exams, NOW);
  ck('and it is flagged as not seen since the unit 1 test',
    debt.length === 1 && debt[0].why === 'not seen since the unit 1 test', debt);

  /* a unit 1 item reviewed AFTER the unit 1 test is not resurfacing debt */
  const fresh = item({ last_reviewed_at: ES.parseDate(inDays(-2)) });
  ck('one already revisited since the test is not flagged again',
    ES.coverageDebt([fresh], UNITS, exams, NOW).length === 0);

  /* with no final date there is nothing to resurface for */
  ck('no final date means no resurfacing',
    ES.coverageDebt([stale], UNITS, { unit1: inDays(-10) }, NOW).length === 0);
}

/* ── 3. coverage ─────────────────────────────────────────────────────── */
console.log('\nguaranteeing nothing goes in unseen');
{
  const exams = { unit1: inDays(9), unit2: '', final: '' };
  const unseen = Array.from({ length: 90 }, () => item({
    state: 'new', stability: null, difficulty: null, due_date: null,
    last_reviewed_at: null, repetitions: 0
  }));
  const scheduled = Array.from({ length: 200 }, () => item({ due_date: NOW - DAY }));

  const debt = ES.coverageDebt(unseen.concat(scheduled), UNITS, exams, NOW);
  ck('every never-seen item is coverage debt', debt.length === 90, debt.length);

  const plan = ES.buildQueue(sched, unseen.concat(scheduled), UNITS, exams, NOW,
    { dailyCap: 40, settings: { newCardsPerDay: 12, newQuizPerDay: 15 } });
  /* New material is governed by the daily cap, not by dividing the syllabus by
     the days left — capping at 10 when 12 a day is comfortable would just be
     slower. Whether 12 a day actually finishes in time is newItemPlan's job,
     and it says so out loud rather than quietly rationing. */
  ck('new items come in at the configured rate, not a derived one',
    plan.coverage.unit1.introduced.card === 12, plan.coverage.unit1);
  const firstTen = plan.queue.slice(0, 10);
  ck('unseen items take the front of the queue over 200 overdue reviews',
    firstTen.every((i) => ES.neverSeen(i)), firstTen.map((i) => i.state));
  ck('but the day is not ONLY unseen items — due work still gets in',
    plan.queue.some((i) => !ES.neverSeen(i)), plan.queue.length);
  ck('the working set is capped and the true due count still reported',
    plan.queue.length === 40 && plan.totalDue === 200, { q: plan.queue.length, due: plan.totalDue });

  /* One schedule across BOTH banks. Sorting the debt by id alone put all 144
     flashcards ahead of all 316 quiz questions, so the quiz side would not have
     started moving for ten days. */
  const mixed = Array.from({ length: 144 }, (_, i) => item({
    kind: 'card', id: i + 1, state: 'new', stability: null, due_date: null,
    last_reviewed_at: null, repetitions: 0
  })).concat(Array.from({ length: 316 }, (_, i) => item({
    kind: 'quiz', id: 1000 + i, state: 'new', stability: null, due_date: null,
    last_reviewed_at: null, repetitions: 0
  })));
  const mp = ES.buildQueue(sched, mixed, UNITS, { unit1: inDays(34) }, NOW,
    { settings: { newCardsPerDay: 20, newQuizPerDay: 15 } });
  ck('a day of coverage draws from both flashcards and quiz',
    mp.counts.cards > 0 && mp.counts.quiz > 0, mp.counts);
  /* Each bank advances at its own configured rate — the point of two settings
     is that a flashcard and a quiz question are not the same unit of work. */
  ck('and each at its own cap rather than one starving the other',
    mp.counts.cards === 20 && mp.counts.quiz === 15, mp.counts);

  /* the closer exam wins the day */
  const two = unseen.slice(0, 10).map((i) => ({ ...i, objectiveIds: ['N144_PSY'] }))
    .concat(unseen.slice(10, 20));
  const q2 = ES.buildQueue(sched, two, UNITS, { unit1: inDays(3), unit2: inDays(30), final: '' }, NOW, {});
  ck('when two exams compete, the nearer one is served first',
    ES.unitOf(q2.queue[0], UNITS) === 1, q2.queue[0].objectiveIds);
}

/* ── 4. pace ─────────────────────────────────────────────────────────── */
console.log('\nwarning when behind');
{
  const exams = { unit1: inDays(10), unit2: '', final: '' };
  const items = Array.from({ length: 300 }, () => item({
    state: 'new', stability: null, due_date: null, last_reviewed_at: null, repetitions: 0
  }));
  const slow = ES.projection(sched, items, UNITS, exams, NOW, 12)[0];
  ck('300 items in 10 days at 12/day reports behind', slow.behind === true, slow);
  ck('and names the daily number needed', slow.needPerDay === 30, slow.needPerDay);
  ck('and does not claim it finishes in time', slow.finishesInTime === false);

  const fast = ES.projection(sched, items, UNITS, exams, NOW, 60)[0];
  ck('at 60/day it is on track', fast.behind === false && fast.finishesInTime === true, fast);

  const noData = ES.projection(sched, items, UNITS, exams, NOW, 0)[0];
  ck('with no pace history it says so rather than inventing one',
    noData.noPaceData === true && noData.behind === true, noData);

  const unsetExam = ES.projection(sched, items, UNITS, {}, NOW, 12)[0];
  ck('an unset exam is not applicable rather than zero days',
    unsetExam.applicable === false && unsetExam.isSet === false, unsetExam);
}

/* ── readiness ───────────────────────────────────────────────────────── */
console.log('\nreadiness, including from a standing start');
{
  const items = Array.from({ length: 460 }, () => item({
    state: 'new', stability: null, difficulty: null, due_date: null,
    last_reviewed_at: null, repetitions: 0
  }));
  const rep = ES.examReport(sched, items, UNITS, { unit1: inDays(34), unit2: '', final: '' }, NOW, {});
  const u1 = rep.find((r) => r.key === 'unit1');
  ck('zero reviews reads 0% ready, 460 never seen, 34 days',
    u1.readyPct === 0 && u1.neverSeen === 460 && u1.daysRemaining === 34, u1);
  ck('a never-seen item is never counted as ready', u1.ready === 0);

  const unsetFinal = rep.find((r) => r.key === 'final');
  ck('an exam with no date still reports its scope instead of hiding',
    unsetFinal.isSet === false && unsetFinal.total === 460, unsetFinal);

  /* an item just reviewed with big stability IS ready; the same item with a
     distant exam is not */
  const solid = item({ stability: 200, last_reviewed_at: NOW, repetitions: 5 });
  const near = ES.examReport(sched, [solid], UNITS, { unit1: inDays(7) }, NOW, {})[0];
  const far = ES.examReport(sched, [solid], UNITS, { unit1: inDays(300) }, NOW, {})[0];
  ck('solid material is ready for a test next week', near.readyPct === 100, near);
  ck('the same material is not ready for one 300 days out', far.readyPct === 0, far);

  ck('scope follows the unit: unit 2 material is not on the unit 1 test',
    ES.examReport(sched, [item({ objectiveIds: ['N144_PSY'] })], UNITS,
      { unit1: inDays(7), unit2: inDays(30), final: inDays(60) }, NOW, {})
      .find((r) => r.key === 'unit1').total === 0);
  ck('but it IS on the final',
    ES.examReport(sched, [item({ objectiveIds: ['N144_PSY'] })], UNITS,
      { unit1: inDays(7), unit2: inDays(30), final: inDays(60) }, NOW, {})
      .find((r) => r.key === 'final').total === 1);
}

/* ── courses with no dates keep working ──────────────────────────────── */
console.log('\ncourses with no exam dates');
{
  const items = Array.from({ length: 50 }, () => item({ due_date: NOW - DAY }));
  const plan = ES.buildPlan({ scheduler: sched, now: NOW, items, units: UNITS, exams: {} });
  ck('nothing is coverage debt without a date', Object.keys(plan.queue.coverage).length === 0);
  ck('the due queue still works', plan.queue.totalDue === 50, plan.queue.totalDue);
  ck('and the plan says plainly that no exam is set', plan.anyExamSet === false);
}

/* ── cram ────────────────────────────────────────────────────────────── */
console.log('\ncram mode');
{
  const unseen = item({ state: 'new', stability: null, due_date: null, last_reviewed_at: null, repetitions: 0 });
  const failing = item({ stability: 0.3, last_reviewed_at: NOW - 20 * DAY, lapses: 4 });
  const solid = item({ stability: 400, last_reviewed_at: NOW });
  const other = item({ objectiveIds: ['N144_PSY'] });
  const q = ES.cramQueue(sched, [solid, failing, unseen, other], UNITS, 1, NOW);
  ck('cram ignores due dates and takes the whole unit', q.length === 3, q.length);
  ck('never-seen comes first', q[0].id === unseen.id, q.map((i) => i.id));
  ck('then the material being failed', q[1].id === failing.id, q.map((i) => i.id));
  ck('solid material comes last', q[2].id === solid.id, q.map((i) => i.id));
  ck('unit 2 is excluded when cramming unit 1', q.every((i) => i.id !== other.id));
  ck('cramming "all" takes everything',
    ES.cramQueue(sched, [solid, failing, unseen, other], UNITS, 'all', NOW).length === 4);
}

/* ── weakest topics ──────────────────────────────────────────────────── */
console.log('\nweakest topics');
{
  const items = [
    item({ objectiveIds: ['A'], stability: 400, last_reviewed_at: NOW }),
    item({ objectiveIds: ['B'], state: 'new', stability: null, last_reviewed_at: null, repetitions: 0 }),
    item({ objectiveIds: ['C'], stability: 3, last_reviewed_at: NOW - 30 * DAY })
  ];
  const w = ES.weakestObjectives(sched, items, { A: 1, B: 1, C: 1 }, {}, NOW, 5);
  ck('an objective never opened ranks weakest', w[0].objective_id === 'B', w.map((x) => x.objective_id));
  ck('and it is not scored as strong just for being unanswered', w[0].pct === 0, w[0]);
  ck('solid material ranks last', w[w.length - 1].objective_id === 'A', w.map((x) => x.objective_id));
}

/* ── daily load control ──────────────────────────────────────────────── */
console.log('\nnew-item caps');
{
  const exams = { unit1: inDays(60) };            /* far enough that the cap, not the exam, governs */
  const items = Array.from({ length: 100 }, (_, i) => item({
    kind: i < 50 ? 'card' : 'quiz', state: 'new', stability: null,
    due_date: null, last_reviewed_at: null, repetitions: 0
  }));
  const q = ES.buildQueue(sched, items, UNITS, exams, NOW,
    { settings: { newCardsPerDay: 5, newQuizPerDay: 3 } });
  const intro = q.coverage.unit1.introduced;
  ck('flashcards and quiz have separate caps and both are honoured',
    intro.card === 5 && intro.quiz === 3, intro);

  const dflt = ES.buildQueue(sched, items, UNITS, exams, NOW, {}).coverage.unit1.introduced;
  ck('defaults are 20 new cards and 15 new questions',
    ES.DEFAULT_SETTINGS.newCardsPerDay === 20 && ES.DEFAULT_SETTINGS.newQuizPerDay === 15
    && dflt.card === 20 && dflt.quiz === 15, dflt);

  /* a cap is a ceiling, not a target */
  const few = Array.from({ length: 3 }, () => item({
    kind: 'card', state: 'new', stability: null, due_date: null,
    last_reviewed_at: null, repetitions: 0 }));
  ck('with less new material than the cap, the day is just shorter',
    ES.buildQueue(sched, few, UNITS, exams, NOW, {}).coverage.unit1.introduced.card === 3);

  /* resurfacing is not new material */
  const resurface = item({ objectiveIds: ['N144_L1'],
    last_reviewed_at: ES.parseDate(inDays(-40)) });
  const rq = ES.buildQueue(sched, [resurface], UNITS,
    { unit1: inDays(-20), final: inDays(30) }, NOW, { settings: { newCardsPerDay: 0 } });
  ck('a cap of zero new items does not block resurfacing already-started work',
    rq.queue.length === 1, rq.queue.length);
}

console.log('\nsmoothing the review load');
{
  /* 200 items all answered the same day come back on the same day */
  const spike = {}; for (let d = 0; d <= 21; d++) spike[d] = 0;
  spike[10] = 200; spike[11] = 15; spike[9] = 12;
  const base = NOW + 10 * DAY;
  const moved = ES.balanceDue(base, null, NOW, spike);
  ck('an interval landing on a heavy day slides to a lighter one',
    ES.daysBetween(moved, NOW) !== 10, ES.daysBetween(moved, NOW));
  ck('and only by a day or two', Math.abs(ES.daysBetween(moved, NOW) - 10) <= 2,
    ES.daysBetween(moved, NOW));
  ck('it picks a genuinely empty day, not just a lighter one',
    spike[ES.daysBetween(moved, NOW)] === 0, ES.daysBetween(moved, NOW));
  ck('the time of day is preserved, only the date moves',
    (moved - ES.startOfDay(moved)) === (base - ES.startOfDay(base)));

  const flat = {}; for (let d = 0; d <= 21; d++) flat[d] = 20;
  ck('on a flat load it is a no-op', ES.balanceDue(base, null, NOW, flat) === base);

  ck('short intervals have no room to slide — moving a 2-day interval is a 50% change',
    ES.slideRoom(2) === 0 && ES.slideRoom(5) === 1 && ES.slideRoom(10) === 2 && ES.slideRoom(30) === 3);
  ck('a 2-day interval is never moved',
    ES.balanceDue(NOW + 2 * DAY, null, NOW, spike) === NOW + 2 * DAY);

  /* levelling must never break the exam clamp */
  const exam = { key: 'unit1', date: ES.parseDate(inDays(12)) };
  const clampedThenBalanced = ES.balanceDue(NOW + 40 * DAY, exam, NOW, spike);
  ck('levelling never pushes an item past its exam',
    clampedThenBalanced <= exam.date - DAY,
    { got: ES.daysBetween(clampedThenBalanced, NOW), latest: 11 });
  ck('and never before tomorrow',
    ES.balanceDue(NOW + DAY, null, NOW, spike) >= ES.startOfDay(NOW) + DAY);
  ck('a sub-day learning step is never levelled',
    ES.balanceDue(NOW + 600000, null, NOW, spike) === NOW + 600000);

  /* The case this exists for: a batch answered in one sitting is in identical
     FSRS state, so it gets an identical interval and, unlevelled, comes back as
     one wall. Levelling each against the load the previous ones just took
     spreads them. */
  const load = {}; for (let d = 0; d <= 60; d++) load[d] = 0;
  const target = NOW + 29 * DAY, placedDays = {};
  for (let i = 0; i < 30; i++) {
    const at = ES.balanceDue(target, null, NOW, load);
    const d = ES.daysBetween(at, NOW);
    load[d]++; placedDays[d] = (placedDays[d] || 0) + 1;
  }
  const spreadDays = Object.keys(placedDays).length;
  const busiest = Math.max.apply(null, Object.keys(placedDays).map((k) => placedDays[k]));
  ck('30 identical items do not all land on the same day',
    spreadDays >= 5, placedDays);
  ck('and no day takes more than a fraction of them', busiest <= 8, busiest);
  ck('all still within the slide room of the original day',
    Object.keys(placedDays).every((d) => Math.abs(Number(d) - 29) <= ES.slideRoom(29)),
    Object.keys(placedDays));
}

console.log('\nthe forecast');
{
  const items = [];
  for (const [day, n] of [[0, 30], [1, 5], [3, 200], [13, 7]])
    for (let i = 0; i < n; i++) items.push(item({ due_date: NOW + day * DAY }));
  items.push(item({ due_date: NOW - 9 * DAY }));      /* overdue */
  const f = ES.forecast(items, NOW, 14, 120);
  ck('fourteen days', f.length === 14);
  ck('overdue counts as today, because that is when it gets answered',
    f[0].count === 31, f[0].count);
  ck('each day carries its own count', f[1].count === 5 && f[3].count === 200 && f[13].count === 7,
    f.map((d) => d.count));
  ck('a day over the ceiling is flagged',
    f[3].over === true && f[1].over === false, f.map((d) => d.over));
  ck('day zero is marked as today', f[0].isToday === true && f[1].isToday === false);
  ck('a quiet day is zero, not missing', ES.forecast([], NOW, 14, 120)[5].count === 0);
}

console.log('\nwhen the cap and the exam date disagree');
{
  const mk = (n) => Array.from({ length: n }, () => item({
    kind: 'card', state: 'new', stability: null, due_date: null,
    last_reviewed_at: null, repetitions: 0 }));

  /* 460 items, 34 days, 20/day — the case that works */
  const ok = ES.newItemPlan(mk(460), UNITS, { unit1: inDays(34) }, NOW,
    { newCardsPerDay: 20 })[0];
  ck('460 items in 34 days at 20/day is fine', ok.ok === true && ok.shortfall === 0, ok);

  /* 460 items, 15 days — the case that does not */
  const bad = ES.newItemPlan(mk(460), UNITS, { unit1: inDays(15) }, NOW,
    { newCardsPerDay: 20 })[0];
  ck('460 items in 15 days at 20/day does not cover it', bad.ok === false, bad);
  ck('it says how many will actually be seen', bad.willSee === 160, bad.willSee);
  ck('and the rate that would be needed', bad.needPerDay === Math.ceil(460 / bad.days),
    { need: bad.needPerDay, days: bad.days });
  ck('the sweep week is excluded from the days new material can start in',
    bad.days === Math.max(0, ES.daysBetween(ES.parseDate(inDays(15)), ES.startOfDay(NOW))
      - ES.EXAM_BUFFER_DAYS + 1 - ES.SWEEP_DAYS), bad.days);

  /* the worked example from the spec */
  const spec = ES.newItemPlan(mk(460), UNITS, { unit1: inDays(24) }, NOW,
    { newCardsPerDay: 20 })[0];
  ck('the shortfall and the required rate are both concrete numbers',
    spec.willSee < 460 && spec.needPerDay > 20,
    { willSee: spec.willSee, need: spec.needPerDay });

  /* accepting the higher rate resolves it */
  const fixed = ES.newItemPlan(mk(460), UNITS, { unit1: inDays(24) }, NOW,
    { newCardsPerDay: spec.needPerDay })[0];
  ck('taking the suggested rate clears the shortfall', fixed.ok === true, fixed);

  /* the two banks are reported separately */
  const both = ES.newItemPlan(
    mk(300).concat(Array.from({ length: 300 }, () => item({
      kind: 'quiz', state: 'new', stability: null, due_date: null,
      last_reviewed_at: null, repetitions: 0 }))),
    UNITS, { unit1: inDays(20) }, NOW, { newCardsPerDay: 20, newQuizPerDay: 15 });
  ck('flashcards and quiz get their own verdicts',
    both.length === 2 && both.some((r) => r.kind === 'card') && both.some((r) => r.kind === 'quiz'),
    both.map((r) => r.kind));
  ck('no exam date means nothing to conflict with',
    ES.newItemPlan(mk(460), UNITS, {}, NOW, {}).length === 0);

  /* Inside the sweep window there are no days left to start new material on,
     so "you need 316/day" would be arithmetic noise rather than advice. The
     sweep is the mechanism there and reports its own number. */
  ck('no rate is suggested once the sweep window has opened',
    ES.newItemPlan(mk(316), UNITS, { unit1: inDays(5) }, NOW, { newCardsPerDay: 15 }).length === 0,
    ES.newItemPlan(mk(316), UNITS, { unit1: inDays(5) }, NOW, { newCardsPerDay: 15 }));
  ck('but it is still suggested the day before the window opens',
    ES.newItemPlan(mk(316), UNITS, { unit1: inDays(9) }, NOW, { newCardsPerDay: 15 }).length === 1);
}

/* ── the week before ─────────────────────────────────────────────────── */
console.log('\nthe sweep');
{
  const mk = (n, over) => Array.from({ length: n }, () => item(over || {}));
  /* reviewed well before any sweep window opens, so it starts as uncovered */
  const stale = { last_reviewed_at: NOW - 40 * DAY };
  const scope = mk(60, stale).concat(
    Array.from({ length: 20 }, () => item({ state: 'new', stability: null,
      due_date: null, last_reviewed_at: null, repetitions: 0 })),
    Array.from({ length: 10 }, () => item({ stability: 0.3, lapses: 3,
      last_reviewed_at: NOW - 30 * DAY })));
  /* 60 stale + 20 never seen + 10 failing = 90 in the unit */

  ck('no sweep while the exam is further out than a week',
    ES.sweepPlan(sched, scope, UNITS, { unit1: inDays(9) }, NOW).active === false);

  const sw = ES.sweepPlan(sched, scope, UNITS, { unit1: inDays(7) }, NOW);
  ck('it starts exactly seven days out', sw.active === true, sw.active);
  ck('day 1 of 7 on the day it opens', sw.day === 1 && sw.totalDays === 7, sw);
  ck('the whole unit is in scope', sw.total === 90, sw.total);
  ck('nothing counts as covered before the window opens', sw.covered === 0, sw.covered);
  ck('the work is spread, not dumped', sw.perDay === Math.ceil(90 / 7) && sw.todayList.length === 13,
    { perDay: sw.perDay, today: sw.todayList.length });
  ck('never-seen items lead', sw.todayList.slice(0, 13).every((i) => ES.neverSeen(i)),
    sw.todayList.map((i) => i.state));

  const mid = ES.sweepPlan(sched, scope, UNITS, { unit1: inDays(5) }, NOW);
  ck('day 3 of 7 two days in', mid.day === 3, mid.day);

  /* items reviewed inside the window count as covered */
  const partly = scope.map((it, i) => i < 42
    ? Object.assign({}, it, { last_reviewed_at: NOW - DAY, repetitions: 2, stability: 5, state: 'review' })
    : it);
  const sw2 = ES.sweepPlan(sched, partly, UNITS, { unit1: inDays(5) }, NOW);
  ck('coverage is counted from the window start, not from all time',
    sw2.covered === 42 && sw2.remaining === 48, { c: sw2.covered, r: sw2.remaining });
  ck('the countdown has the numbers the dashboard needs',
    sw2.day === 3 && sw2.total === 90 && sw2.covered === 42, sw2);

  /* it overrides both caps */
  const q = ES.buildQueue(sched, scope, UNITS, { unit1: inDays(7) }, NOW,
    { dailyCap: 5, settings: { newCardsPerDay: 1, newQuizPerDay: 1 } });
  ck('the sweep overrides the daily working set rather than being trimmed to it',
    q.queue.length >= 13, q.queue.length);
  ck('and overrides the new-item cap: 20 never-seen items still get swept',
    q.queue.filter(ES.neverSeen).length >= 13, q.queue.filter(ES.neverSeen).length);
  ck('the queue reports the sweep so the number shown is the real one',
    q.sweep.active === true && q.cap >= 13, { cap: q.cap, requested: q.requestedCap });

  /* a late sweep with a lot left is honestly large */
  const late = ES.sweepPlan(sched, mk(180, stale), UNITS, { unit1: inDays(2) }, NOW);
  ck('two days out with 180 items it says 90 a day rather than quietly trimming',
    late.perDay === 90, late.perDay);

  ck('no exam, no sweep', ES.sweepPlan(sched, scope, UNITS, {}, NOW).active === false);
  ck('a passed exam does not sweep',
    ES.sweepPlan(sched, scope, UNITS, { unit1: inDays(-2) }, NOW).active === false);
}

console.log('\nbuildPlan carries all of it');
{
  const items = Array.from({ length: 100 }, (_, i) => item({
    kind: i % 2 ? 'quiz' : 'card', state: 'new', stability: null,
    due_date: null, last_reviewed_at: null, repetitions: 0 }));
  const plan = ES.buildPlan({ scheduler: sched, now: NOW, items, units: UNITS,
    exams: { unit1: inDays(20) }, settings: { newCardsPerDay: 7, newQuizPerDay: 4, dailyCeiling: 50 } });
  ck('settings are echoed back', plan.settings.newCardsPerDay === 7 && plan.settings.dailyCeiling === 50);
  ck('forecast is fourteen days', plan.forecast.length === 14);
  ck('the new-item verdicts are there', plan.newItems.length === 2, plan.newItems.length);
  ck('the sweep is there', plan.sweep.active === false);
  ck('the queue honours the caps', plan.queue.coverage.unit1.introduced.card === 7);
}

/* ── compressing the ladder into the runway ──────────────────────────── */
console.log('\ncompressing intervals into the time that is left');
{
  const exam = { key: 'unit1', date: ES.parseDate(inDays(35)) };
  /* what FSRS actually asked for on a review card with stability 30, 31 days
     elapsed — the case that shipped broken */
  const raw = { 1: 10 * 60000, 2: 64 * DAY, 3: 86 * DAY, 4: 135 * DAY };
  const maxRaw = raw[4];
  const got = {};
  [1, 2, 3, 4].forEach((r) => { got[r] = ES.compressToRunway(raw[r], maxRaw, exam, NOW); });

  ck('the runway is the days to the exam minus the sweep week',
    ES.runwayDays(exam, NOW) === 28, ES.runwayDays(exam, NOW));
  ck('nothing lands past the exam',
    [1, 2, 3, 4].every((r) => got[r].ms <= 35 * DAY), Object.keys(got).map((r) => got[r].ms / DAY));
  ck('nothing lands inside the sweep week either',
    [1, 2, 3, 4].every((r) => got[r].ms <= 28 * DAY),
    [1, 2, 3, 4].map((r) => Math.round(got[r].ms / DAY)));
  ck('the ordering survives: Again < Hard < Good < Easy',
    got[1].ms < got[2].ms && got[2].ms < got[3].ms && got[3].ms < got[4].ms,
    [1, 2, 3, 4].map((r) => Math.round(got[r].ms / DAY)));
  ck('they land on FOUR different days, not all on exam minus one',
    new Set([1, 2, 3, 4].map((r) => Math.round(got[r].ms / DAY))).size === 4,
    [1, 2, 3, 4].map((r) => Math.round(got[r].ms / DAY)));
  ck('roughly 3 / 6 / 14 days rather than 2mo / 3mo / 4mo',
    Math.round(got[2].ms / DAY) === 3 && Math.round(got[3].ms / DAY) === 6
    && Math.round(got[4].ms / DAY) === 14,
    [2, 3, 4].map((r) => Math.round(got[r].ms / DAY)));
  ck('the longest leaves room for another review before the sweep',
    got[4].ms <= (28 / 2 + 0.5) * DAY, got[4].ms / DAY);
  ck('each says whether it was compressed',
    got[2].compressed && got[3].compressed && got[4].compressed && !got[1].compressed,
    [1, 2, 3, 4].map((r) => got[r].compressed));
  ck('and keeps the raw figure so the UI can show both',
    got[4].rawMs === 135 * DAY, got[4].rawMs / DAY);

  /* a learning step is not a schedule and must never be compressed */
  ck('sub-day learning steps pass through untouched',
    ES.compressToRunway(10 * 60000, maxRaw, exam, NOW).ms === 10 * 60000
    && ES.compressToRunway(60000, maxRaw, exam, NOW).compressed === false);
}

console.log('\nnormal spacing when the runway is long enough');
{
  const far = { key: 'unit1', date: ES.parseDate(inDays(400)) };
  const r = ES.compressToRunway(60 * DAY, 120 * DAY, far, NOW);
  ck('an interval that already fits is left exactly as FSRS wanted it',
    r.ms === 60 * DAY && r.compressed === false, r);
  ck('no exam date means no compression at all',
    ES.compressToRunway(400 * DAY, 400 * DAY, null, NOW).compressed === false);

  /* the boundary: compression starts when the top of the ladder exceeds half
     the runway, not before */
  const exam60 = { key: 'unit1', date: ES.parseDate(inDays(60)) };   /* usable 53, longest 26.5 */
  ck('just inside the threshold is untouched',
    ES.compressToRunway(26 * DAY, 26 * DAY, exam60, NOW).compressed === false);
  ck('just past it compresses', ES.compressToRunway(27 * DAY, 27 * DAY, exam60, NOW).compressed === true);
}

console.log('\ninside the sweep week');
{
  const soon = { key: 'unit1', date: ES.parseDate(inDays(4)) };
  const r = ES.compressToRunway(90 * DAY, 135 * DAY, soon, NOW);
  ck('there is no runway left', ES.runwayDays(soon, NOW) <= 0, ES.runwayDays(soon, NOW));
  ck('a long interval becomes a few days, not months', r.ms <= 3 * DAY, r.ms / DAY);
  ck('and never lands on or after the exam itself', r.ms < 4 * DAY, r.ms / DAY);
  ck('it is reported as compressed', r.compressed === true && r.reason === 'sweep', r);
  ck('the exam tomorrow still yields at least a day',
    ES.compressToRunway(90 * DAY, 90 * DAY, { key: 'unit1', date: ES.parseDate(inDays(1)) }, NOW).ms
      >= DAY);
}

console.log(fail ? `\n${fail} FAILING` : '\nall exam scheduler checks passed');
process.exit(fail ? 1 : 0);
