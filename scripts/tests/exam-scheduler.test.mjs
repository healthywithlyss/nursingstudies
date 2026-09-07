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

  const plan = ES.buildQueue(sched, unseen.concat(scheduled), UNITS, exams, NOW, { dailyCap: 40 });
  ck('the debt is spread over the days left, not dumped on day one',
    plan.coverage.unit1.perDay === Math.ceil(90 / 9), plan.coverage);
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
  const mp = ES.buildQueue(sched, mixed, UNITS, { unit1: inDays(34) }, NOW, {});
  ck('a day of coverage draws from both flashcards and quiz',
    mp.counts.cards > 0 && mp.counts.quiz > 0, mp.counts);
  ck('and roughly in proportion to the two banks',
    Math.abs(mp.counts.quiz / (mp.counts.cards + mp.counts.quiz) - 316 / 460) < 0.2,
    mp.counts);

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

console.log(fail ? `\n${fail} FAILING` : '\nall exam scheduler checks passed');
process.exit(fail ? 1 : 0);
