/* The flashcard loop, as behaviour.

   The headline assertion is "a failed card cannot escape a session unseen" —
   the bug this whole module exists to fix — and it is tested by driving a full
   session to completion and checking that every card that was ever failed was
   answered again afterwards, not by inspecting a flag. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const FSRS = require('../../vendor/fsrs.js');
const SS = require('../../lib/study-session.js');

let fail = 0;
const ck = (n, ok, v) => { if (ok) console.log('  PASS  ' + n); else { fail++; console.log('  FAIL  ' + n + ' -> ' + JSON.stringify(v)); } };

const MIN = 60000, DAY = 86400000;
const NOW = Date.parse('2026-09-10T09:00:00Z');
const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

let nid = 1;
const newCard = (over) => Object.assign({
  id: nid++, kind: 'card', objectiveIds: ['N144_L1'],
  state: 'new', stability: null, difficulty: null, due_date: null,
  last_reviewed_at: null, repetitions: 0, lapses: 0, learning_step: null
}, over);
const reviewCard = (over) => newCard(Object.assign({
  state: 'review', stability: 20, difficulty: 5, learning_step: null,
  due_date: NOW - DAY, last_reviewed_at: NOW - 21 * DAY, repetitions: 5
}, over));

/* ── 1. a missed card comes back in the same session ─────────────────── */
console.log('a card you miss comes back, in minutes, not after the whole deck');
{
  const s = SS.create({ items: [newCard(), newCard(), newCard()], now: NOW });
  const first = s.next(NOW);
  const r = s.answer(first.id, AGAIN, NOW);
  ck('Again keeps it inside the session', r.inSession === true, r);
  ck('and brings it back in about a minute', r.deltaMs <= 2 * MIN, r.deltaMs);
  ck('the button label says so', r.label === '1m', r.label);
  ck('the message names this sitting, not a date',
    /Back in/.test(r.text) && !/Next review/.test(r.text), r.text);

  /* the other two get shown while it waits out its minute */
  const second = s.next(NOW + 1000);
  ck('another card is shown while the failed one waits',
    second.id !== first.id, { first: first.id, second: second.id });

  /* once the minute is up it is the next thing */
  ck('when its minute is up it comes straight back',
    s.next(NOW + 90000).id === first.id, s.next(NOW + 90000).id);
}

console.log('\nthe old behaviour is gone');
{
  /* getting a new card right first time used to master it forever */
  const s = SS.create({ items: [newCard()], now: NOW });
  const id = s.next(NOW).id;
  const r = s.answer(id, GOOD, NOW);
  ck('Good on a NEW card does not finish it — it has steps to pass',
    r.inSession === true && r.graduated === false, r);
  ck('it is still in the session', s.isComplete() === false);
  const r2 = s.answer(id, GOOD, NOW + 10 * MIN);
  ck('a second Good graduates it to a real interval',
    r2.graduated === true && r2.deltaMs >= DAY, { d: r2.deltaMs, label: r2.label });
  ck('and only now is the session done', s.isComplete() === true);
}

/* ── 2. THE GUARANTEE ────────────────────────────────────────────────── */
console.log('\nTHE GUARANTEE: a failed card cannot escape a session unseen');
{
  const items = Array.from({ length: 25 }, () => newCard());
  const s = SS.create({ items, now: NOW });
  let t = NOW;
  const failedAt = {}, answeredAfterFail = {};
  let guard = 0;

  /* Drive a whole session. Fail the first eight answers outright, then answer
     Good from then on, and check every failure was revisited. */
  while (!s.isComplete() && guard++ < 5000) {
    const card = s.next(t);
    if (!card) break;
    const rating = s.answered < 8 ? AGAIN : GOOD;
    if (failedAt[card.id] != null) answeredAfterFail[card.id] = true;
    const r = s.answer(card.id, rating, t);
    if (rating === AGAIN) failedAt[card.id] = t;
    /* time passes as she works; jump to the next card's moment when idle */
    t += 30000;
    const w = s.waitMs(t);
    if (s.next(t) == null && w > 0) t += w;
  }
  ck('the session terminates', s.isComplete() === true, { guard, remaining: s.remaining().length });
  const failedIds = Object.keys(failedAt);
  ck('cards were actually failed during it', failedIds.length > 0, failedIds.length);
  ck('EVERY failed card was answered again before the session ended',
    failedIds.every((id) => answeredAfterFail[id]),
    failedIds.filter((id) => !answeredAfterFail[id]));
  ck('nothing is left in learning at the end', s.hasUnfinishedLearning() === false);
  ck('and every card ended on a real interval, past today',
    s.remaining().length === 0 && Object.keys(s.cards).every((id) => s.cards[id].state === 'review'),
    Object.keys(s.cards).map((id) => s.cards[id].state).filter((x) => x !== 'review'));
}

console.log('\nthe session cannot be finished early by rating Again forever');
{
  const s = SS.create({ items: [newCard()], now: NOW });
  let t = NOW;
  for (let i = 0; i < 40; i++) {
    const c = s.next(t);
    ck2(c != null);
    s.answer(c.id, AGAIN, t);
    t += 5 * MIN;
  }
  function ck2(x) { if (!x) { fail++; console.log('  FAIL  next() went empty while a card was still failing'); } }
  ck('forty failures later it is still in the session and still asked for',
    s.isComplete() === false && s.next(t) != null, s.remaining());
}

/* ── 3. a review card that fails goes to relearning ──────────────────── */
console.log('\nAgain on a review card drops it into relearning');
{
  const s = SS.create({ items: [reviewCard()], now: NOW });
  const id = s.next(NOW).id;
  const before = s.cards[id].stability;
  const r = s.answer(id, AGAIN, NOW);
  ck('it enters relearning', r.card.state === 'relearning', r.card.state);
  ck('it comes back inside the session', r.inSession === true, r.deltaMs);
  ck('and its stability takes a hit', r.card.stability < before,
    { before, after: r.card.stability });
  ck('the lapse is counted', r.card.lapses === 1, r.card.lapses);
  ck('the session is not finished', s.isComplete() === false);
  const r2 = s.answer(id, GOOD, NOW + 10 * MIN);
  ck('a Good graduates it back out', r2.graduated === true && r2.card.state === 'review', r2.card.state);
}

/* ── 4. Hard vs Again ────────────────────────────────────────────────── */
console.log('\nHard is not Again');
{
  const s = SS.create({ items: [reviewCard()], now: NOW });
  const id = s.next(NOW).id;
  const p = s.peek(id, NOW);
  ck('on a review card, Hard schedules days out, not minutes',
    p[HARD].ms >= DAY && p[HARD].inSession === false, p[HARD]);
  ck('while Again comes back this sitting',
    p[AGAIN].ms < DAY && p[AGAIN].inSession === true, p[AGAIN]);
  ck('Hard is shorter than Good, which is shorter than Easy',
    p[HARD].ms < p[GOOD].ms && p[GOOD].ms < p[EASY].ms,
    { hard: p[HARD].label, good: p[GOOD].label, easy: p[EASY].label });

  /* on a card still in learning, Hard legitimately does stay in the session */
  const s2 = SS.create({ items: [newCard()], now: NOW });
  const p2 = s2.peek(s2.next(NOW).id, NOW);
  ck('on a new card every button except Easy is still this sitting',
    p2[AGAIN].inSession && p2[HARD].inSession && p2[GOOD].inSession,
    { a: p2[AGAIN].label, h: p2[HARD].label, g: p2[GOOD].label, e: p2[EASY].label });
}

/* ── 5. the previews on the buttons ──────────────────────────────────── */
console.log('\ninterval previews');
{
  const s = SS.create({ items: [newCard()], now: NOW });
  const id = s.next(NOW).id;
  const p = s.peek(id, NOW);
  ck('every button has a label', [1, 2, 3, 4].every((r) => !!p[r].label), p);
  /* The default first step is one minute, so Again reads "1m". "<1m" is
     reserved for a genuinely sub-minute step rather than used as decoration
     for a one-minute one. */
  ck('a new card reads Again 1m, Hard 6m, Good 10m, Easy in days',
    p[AGAIN].label === '1m' && p[HARD].label === '6m' && p[GOOD].label === '10m'
    && /d$/.test(p[EASY].label),
    { a: p[AGAIN].label, h: p[HARD].label, g: p[GOOD].label, e: p[EASY].label });
  ck('peeking does not change anything',
    s.cards[id].reps === 0 && s.answered === 0 && s.isComplete() === false);
  ck('peeking twice gives the same answer',
    JSON.stringify(s.peek(id, NOW)) === JSON.stringify(p));

  ck('formatting covers every scale',
    [[30000, '<1m'], [6 * MIN, '6m'], [90 * MIN, '1.5h'], [4 * DAY, '4d'],
     [60 * DAY, '2mo'], [800 * DAY, '2.2y']]
      .every(([ms, want]) => SS.formatInterval(ms) === want),
    [30000, 6 * MIN, 90 * MIN, 4 * DAY, 60 * DAY, 800 * DAY].map(SS.formatInterval));
}

/* ── 6. configurable steps ───────────────────────────────────────────── */
console.log('\nconfigurable steps');
{
  const s = SS.create({ items: [newCard()], now: NOW,
    settings: { learningSteps: [5, 25, 60], relearningSteps: [20] } });
  const id = s.next(NOW).id;
  const p = s.peek(id, NOW);
  ck('Again uses the first configured step', p[AGAIN].label === '5m', p[AGAIN].label);
  ck('Good advances to the second', p[GOOD].label === '25m', p[GOOD].label);
  const a = s.answer(id, GOOD, NOW);
  const b = s.answer(id, GOOD, NOW + 25 * MIN);
  ck('three steps means three passes before graduating',
    a.graduated === false && b.graduated === false, { a: a.label, b: b.label });
  const c = s.answer(id, GOOD, NOW + 90 * MIN);
  ck('and the third graduates it', c.graduated === true, c.label);

  const r = SS.create({ items: [reviewCard()], now: NOW,
    settings: { relearningSteps: [20] } });
  const rid = r.next(NOW).id;
  ck('the relearning step is configurable too',
    r.peek(rid, NOW)[AGAIN].label === '20m', r.peek(rid, NOW)[AGAIN].label);

  ck('nonsense steps fall back to the defaults rather than breaking',
    SS.minutesToMs([0, -5], SS.DEFAULT_LEARNING_STEPS).length === 2
    && SS.minutesToMs([], SS.DEFAULT_LEARNING_STEPS)[0] === MIN,
    SS.minutesToMs([0, -5], SS.DEFAULT_LEARNING_STEPS));
}

/* ── 7. queue counts and progress ────────────────────────────────────── */
console.log('\ncounts and progress');
{
  const items = [
    ...Array.from({ length: 5 }, () => newCard()),
    ...Array.from({ length: 3 }, () => reviewCard()),
    ...Array.from({ length: 2 }, () => reviewCard({ state: 'relearning',
      learning_step: 0, due_date: NOW - MIN, last_reviewed_at: NOW - 30 * MIN }))
  ];
  const s = SS.create({ items, now: NOW });
  const c = s.counts();
  ck('new, learning and due are counted separately',
    c.newItems === 5 && c.learning === 2 && c.due === 3, c);
  ck('progress starts at zero of the opening size',
    s.progress().done === 0 && s.progress().total === 10, s.progress());

  const id = s.next(NOW).id;
  s.answer(id, EASY, NOW);
  ck('a graduated card advances progress', s.progress().done === 1, s.progress());
  const id2 = s.next(NOW).id;
  s.answer(id2, AGAIN, NOW);
  ck('a failed card does NOT advance progress — it is not done',
    s.progress().done === 1, s.progress());
  ck('but it does count as work answered', s.progress().answered === 2, s.progress());
}

/* ── 8. undo ─────────────────────────────────────────────────────────── */
console.log('\nundo — she will misclick on a phone');
{
  const s = SS.create({ items: [newCard(), newCard()], now: NOW });
  ck('nothing to undo at the start', s.canUndo() === false);
  const id = s.next(NOW).id;
  const before = JSON.stringify(s.cards[id]);
  const beforeProgress = JSON.stringify(s.progress());
  s.answer(id, EASY, NOW);
  ck('there is something to undo now', s.canUndo() === true);
  const u = s.undo();
  ck('it names the card it put back', u.id === id, u.id);
  ck('the card state is exactly as it was', JSON.stringify(s.cards[id]) === before);
  ck('progress is as it was', JSON.stringify(s.progress()) === beforeProgress);
  ck('and it is the next card again', s.next(NOW).id === id, s.next(NOW).id);
  ck('undo does not stack past the start', s.canUndo() === false && s.undo() === null);

  /* undoing an Again must take it back out of learning */
  const s2 = SS.create({ items: [reviewCard()], now: NOW });
  const id2 = s2.next(NOW).id;
  s2.answer(id2, AGAIN, NOW);
  ck('an Again put it in learning', s2.hasUnfinishedLearning() === true);
  s2.undo();
  ck('undoing takes it back out of learning', s2.hasUnfinishedLearning() === false);
  ck('and its lapse count is restored', s2.cards[id2].lapses === 0, s2.cards[id2].lapses);
}

/* ── 9. resume ───────────────────────────────────────────────────────── */
console.log('\nleaving and coming back resumes');
{
  const items = Array.from({ length: 6 }, () => newCard());
  const s = SS.create({ items, now: NOW });
  s.answer(s.next(NOW).id, GOOD, NOW);
  s.answer(s.next(NOW).id, AGAIN, NOW + MIN);
  const snapshot = JSON.parse(JSON.stringify(s.toJSON()));

  const back = SS.restore(snapshot, items, { now: NOW + 30 * MIN });
  ck('it comes back', back !== null);
  ck('with the same work outstanding', back.remaining().length === s.remaining().length,
    { back: back.remaining().length, was: s.remaining().length });
  ck('and the same card states',
    JSON.stringify(back.cards) === JSON.stringify(s.cards));
  ck('and the same progress denominator', back.progress().total === s.progress().total);
  ck('and it still knows what is in learning',
    back.hasUnfinishedLearning() === s.hasUnfinishedLearning());

  /* a card deleted since must not be resurrected */
  const fewer = items.slice(0, 4);
  const back2 = SS.restore(snapshot, fewer, { now: NOW });
  ck('cards no longer in the deck are dropped, not resurrected',
    back2.remaining().every((id) => fewer.some((i) => i.id === id)), back2.remaining());
  ck('a snapshot of an unknown version is refused',
    SS.restore({ v: 99 }, items, {}) === null);
  ck('a snapshot whose cards are all gone is refused',
    SS.restore(snapshot, [], {}) === null);
}

/* ── 10. extra study ─────────────────────────────────────────────────── */
console.log('\nextra study does not corrupt real intervals');
{
  const items = [reviewCard({ due_date: NOW + 40 * DAY })];
  const s = SS.create({ items, now: NOW, mode: 'extra' });
  ck('a card not due for 40 days is still offered', s.next(NOW) !== null);
  const r = s.answer(items[0].id, AGAIN, NOW);
  ck('the answer is explicitly marked not to be persisted', r.persist === false, r.persist);

  const real = SS.create({ items, now: NOW, mode: 'scheduled' });
  ck('a scheduled session does persist', real.answer(items[0].id, GOOD, NOW).persist === true);
}

/* ── 11. waiting ─────────────────────────────────────────────────────── */
console.log('\nwaiting for a step');
{
  const s = SS.create({ items: [newCard()], now: NOW });
  const id = s.next(NOW).id;
  s.answer(id, GOOD, NOW);                      /* due in 10 minutes */
  ck('with nothing else to do it shows the card early rather than a blank wait',
    s.next(NOW + 60000) !== null, s.next(NOW + 60000));
  ck('and it can say how long until it is properly due',
    s.waitMs(NOW + 60000) > 8 * MIN && s.waitMs(NOW + 60000) <= 9 * MIN,
    s.waitMs(NOW + 60000));
  ck('no wait once the moment has passed', s.waitMs(NOW + 11 * MIN) === 0);
}

/* ── the session honours an injected clamp ───────────────────────────── */
console.log('\nthe session schedules through the clamp, not around it');
{
  const ES = require('../../lib/exam-scheduler.js');
  const examDate = ES.startOfDay(NOW + 35 * DAY);
  const exam = { key: 'unit1', date: examDate };
  const clamp = (raw, max, t) => ES.compressToRunway(raw, max, exam, t);

  const item = reviewCard({ stability: 30, last_reviewed_at: NOW - 31 * DAY });
  const s = SS.create({ items: [item], now: NOW, clamp });
  const p = s.peek(item.id, NOW);

  ck('nothing on the buttons lands past the exam',
    [1, 2, 3, 4].every((r) => NOW + p[r].ms <= examDate),
    [1, 2, 3, 4].map((r) => p[r].label));
  ck('nor inside the sweep week',
    [1, 2, 3, 4].every((r) => NOW + p[r].ms <= examDate - 7 * DAY),
    [1, 2, 3, 4].map((r) => p[r].label));
  ck('Hard is days, not months', /d$/.test(p[HARD].label), p[HARD].label);
  ck('ordering holds after compression',
    p[AGAIN].ms < p[HARD].ms && p[HARD].ms < p[GOOD].ms && p[GOOD].ms < p[EASY].ms,
    [1, 2, 3, 4].map((r) => p[r].label));
  ck('each button reports whether it was compressed, and from what',
    p[HARD].compressed === true && /mo$/.test(p[HARD].rawLabel)
    && p[AGAIN].compressed === false,
    { hard: p[HARD].label + ' was ' + p[HARD].rawLabel, again: p[AGAIN].label });

  /* THE THING THAT WAS BROKEN: what the button says must be what gets stored */
  [1, 2, 3, 4].forEach((r) => {
    const t = SS.create({ items: [item], now: NOW, clamp });
    const shown = t.peek(item.id, NOW)[r];
    const got = t.answer(item.id, r, NOW);
    ck('rating ' + r + ': the stored interval is exactly the one on the button',
      got.deltaMs === shown.ms && got.label === shown.label,
      { shown: shown.label, stored: got.label });
  });

  const graded = SS.create({ items: [item], now: NOW, clamp });
  const out = graded.answer(item.id, HARD, NOW);
  ck('the outcome line says it was compressed', /compressed to fit/.test(out.text), out.text);
  ck('the memory state itself is untouched — only the date moves',
    out.card.stability > 0 && out.card.difficulty > 0 && out.card.state === 'review',
    { s: out.card.stability, d: out.card.difficulty });
  ck('interval_days matches the compressed date, not the raw one',
    out.card.interval_days === Math.round(out.deltaMs / DAY), out.card.interval_days);

  /* with no exam the session behaves exactly as before */
  const plain = SS.create({ items: [item], now: NOW,
    clamp: (raw) => ES.compressToRunway(raw, raw, null, NOW) });
  ck('no exam means raw FSRS intervals, unchanged',
    /mo$/.test(plain.peek(item.id, NOW)[GOOD].label),
    plain.peek(item.id, NOW)[GOOD].label);
}

console.log(fail ? `\n${fail} FAILING` : '\nall study session checks passed');
process.exit(fail ? 1 : 0);
