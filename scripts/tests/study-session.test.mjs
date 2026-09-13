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
console.log('\nwaiting for a step: the interval on the button is real');
{
  const s = SS.create({ items: [newCard()], now: NOW });
  const id = s.serve(NOW).id;
  s.answer(id, GOOD, NOW);                      /* due in 10 minutes */
  ck('with nothing else to do it does NOT show the card it just rated early',
    s.serve(NOW + 60000) === null, s.serve(NOW + 60000));
  ck('and it can say how long until it is properly due',
    s.waitMs(NOW + 60000) > 8 * MIN && s.waitMs(NOW + 60000) <= 9 * MIN,
    s.waitMs(NOW + 60000));
  ck('the user may choose to drill ahead', s.serve(NOW + 60000, { ahead: true }) !== null
    && s.serve(NOW + 60000, { ahead: true }).id === id);
  const s2 = SS.create({ items: [newCard()], now: NOW });
  const id2 = s2.serve(NOW).id;
  s2.answer(id2, AGAIN, NOW);
  ck('once its minute is up it comes back on its own', s2.serve(NOW + 61000) !== null && s2.serve(NOW + 61000).id === id2);
  ck('no wait once the moment has passed', s2.waitMs(NOW + 11 * MIN) === 0);
  ck('the session is still not complete while it waits', s2.isComplete() === false);
  ck('the served log marks the return as a repeat that was on time',
    s2.served.length === 2 && s2.served[1].repeat === true && s2.served[1].early === false, s2.served);
}

/* ── 12. the rating lands on the card that was read ──────────────────── */
console.log('\na rating belongs to the card on screen, not to whichever learning card came due meanwhile');
{
  /* Reconstructed from a real session on 2026-09-13: card A rated Again, card
     B put on screen, and a minute later the rating meant for B was applied to
     A because the rating path asked next() again at press time. B then stayed
     on screen, which looked exactly like "the card I just rated came back". */
  const A = newCard(), B = newCard(), C = newCard();
  const s = SS.create({ items: [A, B, C], now: NOW });
  ck('A is served first', s.serve(NOW).id === A.id);
  s.answer(A.id, AGAIN, NOW);                          /* A due at NOW+1m */
  const onScreen = s.serve(NOW + 1000);
  ck('B goes on screen while A waits its minute', onScreen.id === B.id, onScreen.id);
  const press = NOW + 70000;                           /* she reads B for 70 s: A is now due */
  ck('by press time A has come due, so a naive next() would hand it the rating',
    s.next(press).id === A.id, s.next(press) && s.next(press).id);
  ck('but the card on screen is still B', s.current === B.id && s.currentAnswered === false);
  const before = JSON.stringify(s.cards[A.id]);
  s.answer(s.current, GOOD, press);
  ck('the rating changed B', s.cards[B.id].reps === 1 && s.cards[B.id].last_review === press, s.cards[B.id]);
  ck('and left A exactly as it was', JSON.stringify(s.cards[A.id]) === before);
  const after = s.serve(press);
  ck('A, now due, is the next card — B is not shown twice', after.id === A.id, after.id);
  ck('the served log reads A, B, A', s.served.map((e) => e.id).join(',') === [A.id, B.id, A.id].join(','), s.served.map((e) => e.id));
  ck('no consecutive repeat in the log', SS.repeatIn(s.served) === null, SS.repeatIn(s.served));
}

/* ── 13. never the same card twice in a row ──────────────────────────── */
console.log('\nnever the same card twice in a row while anything else is available');
{
  /* Again on the first card of a deck of three: the other two come first */
  const s = SS.create({ items: [newCard(), newCard(), newCard()], now: NOW });
  const a = s.serve(NOW).id; s.answer(a, AGAIN, NOW);
  const b = s.serve(NOW + 2000).id;
  ck('Again is not followed by the same card', b !== a, { a, b });
  s.answer(b, AGAIN, NOW + 2000);
  const c = s.serve(NOW + 4000).id;
  ck('nor is the second Again', c !== b && c !== a, { a, b, c });
  s.answer(c, GOOD, NOW + 4000);                    /* c due in 10 min; a due at +1m, b at +1m2s */
  const d = s.serve(NOW + 6000);
  ck('with only early learning cards left, the earliest OTHER card is shown ahead of time',
    d.id === a && d.id !== c, d && d.id);
  ck('and the log says it was early and not a repeat', s.served[3].early === true && s.served[3].repeat === false, s.served[3]);

  /* Random sessions: sizes 1..8, random ratings and think times, with the
     countdown modelled (advance to waitMs when serve() says wait). */
  let seed = 20260913;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let sessions = 0, serves = 0, waits = 0, offenders = [], nonTerminating = 0, notOnScreen = 0;
  for (let n = 1; n <= 8; n++) for (let k = 0; k < 40; k++) {
    const items = Array.from({ length: n }, () => (rnd() < 0.3 ? reviewCard() : newCard()));
    const s = SS.create({ items, now: NOW });
    let t = NOW, guard = 0;
    const leftAtServe = [];                        /* cards unfinished when each serve happened */
    while (!s.isComplete() && guard++ < 3000) {
      const card = s.serve(t);
      if (card && s.served.length > leftAtServe.length) leftAtServe.push(s.remaining().length);
      if (!card) {
        const w = s.waitMs(t);
        if (w <= 0) { break; }
        waits++; t += w; continue;                  /* the countdown ran out */
      }
      t += 3000 + Math.floor(rnd() * 90000);      /* she reads for 3-93 s */
      if (s.current !== card.id) notOnScreen++;
      const r = rnd(); const rating = r < 0.3 ? AGAIN : r < 0.45 ? HARD : r < 0.9 ? GOOD : EASY;
      s.answer(s.current, rating, t);
    }
    sessions++; serves += s.served.length;
    if (!s.isComplete()) nonTerminating++;
    const bad = SS.repeatIn(s.served);
    if (bad) offenders.push({ n, k, bad });
    /* the strict form of the assertion, independent of the log's own flags:
       the same id in two consecutive positions is allowed only when it was
       the ONLY unfinished card at that moment, and it was on time */
    for (let i = 1; i < s.served.length; i++) if (s.served[i].id === s.served[i - 1].id) {
      if (leftAtServe[i] !== 1 || s.served[i].early) offenders.push({ n, k, i, strict: true, left: leftAtServe[i], early: s.served[i].early });
    }
    /* and every early serve was of a card other than the one just answered, or an explicit drill-ahead */
    for (let i = 1; i < s.served.length; i++) {
      const e = s.served[i];
      if (e.early && e.repeat && !e.ahead) offenders.push({ n, k, i, earlyRepeat: e });
    }
  }
  ck(`${sessions} random sessions, ${serves} serves, ${waits} countdowns: every session terminated`, nonTerminating === 0, nonTerminating);
  ck('THE ASSERTION: no card id was served in two consecutive positions while any other card was unfinished, and a lone card only came back on time',
    offenders.length === 0, offenders.slice(0, 3));
  ck('the card answered was always the card on screen', notOnScreen === 0, notOnScreen);
}

/* ── 14. undo and resume keep the screen honest ──────────────────────── */
console.log('\nundo and resume keep track of what is on screen');
{
  const A = newCard(), B = newCard();
  const s = SS.create({ items: [A, B], now: NOW });
  s.serve(NOW); s.answer(A.id, AGAIN, NOW);
  s.serve(NOW + 1000);
  ck('B is on screen after A', s.current === B.id);
  s.undo();
  ck('undo puts A back as the unanswered card on screen', s.current === A.id && s.currentAnswered === false, [s.current, s.currentAnswered]);
  ck('and forgets the serve of B', s.served.length === 1 && s.served[0].id === A.id, s.served);
  ck('so A is served again', s.serve(NOW + 1000).id === A.id);

  s.answer(A.id, AGAIN, NOW + 1000);
  s.serve(NOW + 2000);
  const back = SS.restore(JSON.parse(JSON.stringify(s.toJSON())), [A, B], { now: NOW + 2000 });
  ck('a restored session knows what was on screen', back.current === B.id && back.currentAnswered === false, [back.current, back.currentAnswered]);
  ck('and keeps the served log', back.served.length === s.served.length && back.served[1].id === B.id, back.served);
  const aBefore = JSON.stringify(back.cards[A.id]);
  back.answer(back.current, GOOD, NOW + 3000);
  ck('after the restore the rating still goes to the card on screen',
    back.cards[B.id].reps === 1 && JSON.stringify(back.cards[A.id]) === aBefore, [back.cards[B.id].reps, back.cards[A.id]]);
}

/* ── 15. the page uses serve() and rates the card on screen ─────────── */
console.log('\nindex.html: the rating path never asks next() at press time');
{
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const rate = html.slice(html.indexOf('window.srsRate = function'), html.indexOf('function persistCard('));
  ck('srsRate exists', rate.length > 20);
  ck('srsRate does not call SESS.next()', !/SESS\.next\(/.test(rate));
  ck('srsRate answers SESS.current', /SESS\.answer\(card\.id/.test(rate) && /SESS\.items\[SESS\.current\]/.test(rate));
  ck('srsRate refuses to rate when nothing is on screen or it was already rated', /SESS\.current == null \|\| SESS\.currentAnswered/.test(rate));
  const paint = html.slice(html.indexOf('function paintSession('), html.indexOf('function decorate('));
  ck('paintSession serves through SESS.serve()', /SESS\.serve\(now, opts\)/.test(paint));
  ck('when nothing else is available it shows the countdown, not the card', /if\(SESS\.waitMs\(now\) > 0\)\{ showWait\(\)/.test(paint));
  ck('no SESS.next() call site is left anywhere in the page', (html.match(/SESS\.next\(/g) || []).length === 0, (html.match(/SESS\.next\(/g) || []).length);
  ck('the countdown offers drill-ahead', /srsDrillAhead\(\)/.test(html) && /paintSession\(\{ahead:true\}\)/.test(html));
  const wait = html.slice(html.indexOf('function showWait('), html.indexOf('function clearWait('));
  ck('while waiting there is no card to flip, so a tap cannot reveal the last answer', /fcCurrentCard = null; fcFlipped = false;/.test(wait));
  ck('while waiting the rating buttons are disabled', /\['btn-missed','btn-unsure','btn-got','btn-easy'\]\.forEach\(function\(id\)\{\s*var b = \$\(id\); if\(b\) b\.disabled = true;/.test(wait));
}

/* ── 16. the daily new-card budget ──────────────────────────────────── */
console.log('\nnew cards are budgeted per day, not per session');
{
  /* Reconstructed from a real panel on 2026-09-13: 36 new cards started that
     day against a 30/day limit, and the panel still offered 30 more, because
     the cap was applied to the never-seen cards afresh on every render. */
  const day = Date.parse('2026-09-13T04:00:00Z');        /* local midnight */
  const now = day + 14 * 3600000;
  const startedToday = (n, over) => Array.from({ length: n }, () => newCard(Object.assign({
    state: 'review', introduced_at: now - 3 * 3600000, last_reviewed_at: now - 3600000,
    due_date: now + DAY, repetitions: 3 }, over)));
  const unseen = Array.from({ length: 196 }, () => newCard());
  const learning = startedToday(11, { state: 'learning', due_date: now - 60000, learning_step: 1 });
  /* 24 graduated, 11 in learning, 1 rated but its scheduling write was lost */
  const lostOne = newCard({ introduced_at: now - 60000 });
  const items = [...startedToday(24), ...learning, lostOne, ...unseen];
  const q = SS.todayQueue(items, { now, dayStart: day, newCardsPerDay: 30, all: items });
  ck('36 introduced today are counted', q.introducedToday === 36, q.introducedToday);
  ck('so the new budget is 0, not 30', q.newBudget === 0 && q.newItems.length === 0, [q.newBudget, q.newItems.length]);
  ck('the unseen cards are still reported as available (196 never seen + the one whose write was lost)', q.newAvailable === 197, q.newAvailable);
  ck('learning is never capped', q.learning.length === 11, q.learning.length);
  ck('nothing due: the 24 graduated today are scheduled for tomorrow', q.due.length === 0, q.due.length);
  ck('and those 24 are "done today"', q.done.length === 24, q.done.length);

  const q2 = SS.todayQueue(items, { now, dayStart: day, newCardsPerDay: 50, all: items });
  ck('with a 50/day limit, 14 more new cards are offered (50 - 36)', q2.newBudget === 14 && q2.newItems.length === 14, [q2.newBudget, q2.newItems.length]);

  /* the budget spans the course, not the selection */
  const l2 = Array.from({ length: 10 }, () => newCard({ objectiveIds: ['N144_L2'] }));
  const q3 = SS.todayQueue(l2, { now, dayStart: day, newCardsPerDay: 30, all: [...items, ...l2] });
  ck('selecting another lecture does not grant a fresh 30', q3.newBudget === 0 && q3.newItems.length === 0, q3.newBudget);

  /* yesterday does not count, and a learning card is not done */
  const y = startedToday(5, { introduced_at: day - 3600000, last_reviewed_at: day - 3600000, due_date: now + DAY });
  const q4 = SS.todayQueue([...y, ...unseen], { now, dayStart: day, newCardsPerDay: 30, all: [...y, ...unseen] });
  ck('cards introduced yesterday do not use today\'s budget', q4.introducedToday === 0 && q4.newBudget === 30, [q4.introducedToday, q4.newBudget]);
  ck('cards reviewed yesterday and due tomorrow are neither due nor done today', q4.due.length === 0 && q4.done.length === 0, [q4.due.length, q4.done.length]);
  const q5 = SS.todayQueue(learning, { now, dayStart: day, newCardsPerDay: 30, all: learning });
  ck('a card still in learning is not done', q5.done.length === 0 && q5.learning.length === 11);

  /* a card rated but whose scheduling write was lost (state new, introduced today) */
  const lost = newCard({ introduced_at: now - 60000 });
  const q6 = SS.todayQueue([lost], { now, dayStart: day, newCardsPerDay: 30, all: [lost] });
  ck('it counts as introduced today and is offered again as new', q6.introducedToday === 1 && q6.newItems.length === 1);
}

/* ── 17. index.html: the panel uses the budget and every tile is a door ── */
console.log('\nindex.html: daily budget wired through, tiles start a session of just that kind');
{
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  ck('the mastery loader fetches introduced_at', /card_mastery\?select=card_id,state,[\s\S]{0,200}?learning_step,introduced_at,last_result&user_id/.test(html));
  ck('toItem carries introduced_at as ms', /introduced_at: row && row\.introduced_at \? Date\.parse\(row\.introduced_at\) : null/.test(html));
  const qf = html.slice(html.indexOf('function queueFor('), html.indexOf('function nextDueMs('));
  ck('queueFor delegates to StudySession.todayQueue with the whole course as `all`', /StudySession\.todayQueue\(items, \{[^}]*all: all/.test(qf) && /kind === 'card'/.test(qf));
  ck('the day starts at LOCAL midnight', /setHours\(0,0,0,0\)/.test(html.slice(html.indexOf('function dayStartMs('), html.indexOf('function dayStartMs(') + 200)));
  const pc = html.slice(html.indexOf('function persistCard('), html.indexOf('function rating2legacy('));
  ck('the first real rating stamps introduced_at, and only the first', /var wasNew = window\.StudySession\.isNewItem\(item\);/.test(pc) && /if\(wasNew\)\{[^}]*row\.introduced_at = /.test(pc));
  const panel = html.slice(html.indexOf('function renderDeckPanel('), html.indexOf('function srsToggleDeck'));
  ck('a tile is a button that starts a session of only its kind', /var tile = function\(cls, n, label, extra, only\)/.test(panel) && /onclick="srsStartSession\('\+\(extra\?'true':'false'\)\+',\\''\+only\+'\\'\)"/.test(panel));
  ck('new, learning and due tiles start SCHEDULED sessions', /tile\('new',\s+q\.newItems\.length,\s+'new',\s+false,\s+'new'\)/.test(panel)
    && /tile\('learn', q\.learning\.length, 'learning',\s+false, 'learning'\)/.test(panel) && /tile\('due',\s+q\.due\.length,\s+'due',\s+false, 'due'\)/.test(panel));
  ck('the done tile is EXTRA study: re-drilling today\'s cards never reschedules them', /tile\('done',\s+q\.done\.length,\s+'done today', true,\s+'done'\)/.test(panel) && /if\(only === 'done'\) extra = true;/.test(html));
  const note = html.slice(html.indexOf('function budgetNote('), html.indexOf('function renderDeckPanel('));
  ck('when the budget is spent the note says so instead of counting "held back"', /q\.newBudget === 0/.test(note) && /started today/.test(note) && /resume tomorrow/.test(note));
  const start = html.slice(html.indexOf('window.srsStartSession = function(extra, only)'), html.indexOf('window.srsResumeSession'));
  ck('srsStartSession honours `only` for each kind', /only === 'new' \? q\.newItems/.test(start) && /only === 'learning' \? q\.learning/.test(start) && /only === 'due' \? q\.due/.test(start) && /only === 'done' \? q\.done/.test(start));

  /* "+N new today": past the limit for one local date only, and it counts */
  ck('settings read the per-day extra and its date', /extraNew:\s+\(r && r\.extra_new\)/.test(html) && /extraNewDate: \(r && r\.extra_new_date\)/.test(html));
  ck('settings write them back', /extra_new:\s+next\.extraNew \|\| 0/.test(html) && /extra_new_date:\s+next\.extraNewDate \|\| null/.test(html));
  ck('the extra applies only when its date is today (local)', /return st\.extraNewDate === localDateStr\(now\) \? \(Number\(st\.extraNew\) \|\| 0\) : 0;/.test(html));
  ck('queueFor budgets against the effective limit, not the bare setting', /newCardsPerDay: effectiveNewLimit\(st, now\)/.test(qf));
  ck('srsMoreNew adds to today\'s extra and stamps today\'s date', /next\.extraNew = extraNewToday\(next, now\) \+ /.test(html) && /next\.extraNewDate = localDateStr\(now\);/.test(html));
  ck('the panel offers +5 / +10 / +20 wherever new cards are being held back', /\[5,10,20\]\.map/.test(html.slice(html.indexOf('function budgetNote('), html.indexOf('function renderDeckPanel('))));
  const mig = fs.readFileSync(new URL('../../supabase/migrations/20260914_extra_new_today.sql', import.meta.url), 'utf8');
  ck('the migration adds the two columns additively with a safe default', /add column if not exists extra_new int not null default 0/.test(mig) && /add column if not exists extra_new_date date/.test(mig));
}

/* ── 18. per-lecture progress ────────────────────────────────────────── */
console.log('\nper-lecture progress: how far in, what is left, how well known');
{
  const day = Date.parse('2026-09-13T04:00:00Z'), now = day + 14 * 3600000;
  const L1 = (over) => newCard(Object.assign({ objectiveIds: ['N144_L1'] }, over));
  const items = [
    ...Array.from({ length: 5 }, () => L1()),                                                   /* never seen */
    L1({ state: 'learning', stability: 0.5, last_reviewed_at: now - 600000, due_date: now - 1000, learning_step: 1 }),
    L1({ state: 'review', stability: 8.3, last_reviewed_at: now - 3600000, due_date: now + 5 * DAY, repetitions: 1 }),   /* done today */
    L1({ state: 'review', stability: 20, last_reviewed_at: now - 10 * DAY, due_date: now - DAY, repetitions: 4 }),        /* due */
    L1({ state: 'review', stability: 20, last_reviewed_at: now - 2 * DAY, due_date: now + 18 * DAY, repetitions: 4 }),    /* reviewed before today */
    newCard({ objectiveIds: ['N144_SKILLS'] }),
    newCard({ objectiveIds: ['N144_L1', 'N144_SKILLS'], state: 'review', stability: 4, last_reviewed_at: now - DAY, due_date: now + 3 * DAY })
  ];
  const recall = (s, d) => Math.pow(1 + d / (9 * s), -1);          /* a simple forgetting curve, for the test */
  const st = SS.objectiveStats(items, { now, dayStart: day, recall });
  const l1 = st.N144_L1, sk = st.N144_SKILLS;
  ck('Lecture 1: 10 cards, 5 started, 5 new left, 50%', l1.total === 10 && l1.started === 5 && l1.newLeft === 5 && l1.pctStarted === 50, l1);
  ck('learning 1, learned 4, due 1, done today 1', l1.learning === 1 && l1.learned === 4 && l1.due === 1 && l1.doneToday === 1, l1);
  ck('recall averages the started cards that have a stability, between 0 and 1', l1.recall > 0.5 && l1.recall < 1, l1.recall);
  ck('a card in two lectures counts in both', sk.total === 2 && sk.started === 1 && sk.newLeft === 1, sk);
  ck('a lecture with nothing started has no recall figure', SS.objectiveStats([newCard()], { now, dayStart: day, recall }).N144_L1.recall === null);
  ck('without a recall function the counts still come back', SS.objectiveStats(items, { now, dayStart: day }).N144_L1.recall === null);
}

/* ── 19. index.html: names, chips, sidebar, flip back ────────────────── */
console.log('\nindex.html: lecture names, new-left chips, the sidebar shows progress, cards flip back');
{
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  ck('the loader fetches the objectives table for names', /\/rest\/v1\/objectives\?select=id,lecture,description/.test(html));
  ck('objLabel falls back to a name derived from the id, never the raw id for a lecture', /function objLabel\(id\)/.test(html) && /'Lecture '\+m\[1\]/.test(html));
  const panel = html.slice(html.indexOf('function renderDeckPanel('), html.indexOf('function srsToggleDeck'));
  ck('chips show the lecture name and the new cards left, not the objective id', /objLabel\(o\.id\)/.test(panel) && /newLeft\+' new/.test(panel) && !/esc2\(o\.id\)\+' <span>'\+o\.count/.test(panel));
  ck('the deck panel renders the sidebar progress on every paint', /renderObjProgress\(now\)/.test(panel));
  const side = html.slice(html.indexOf('function renderObjProgress('), html.indexOf('function renderDeckPanel('));
  ck('the sidebar uses StudySession.objectiveStats with the scheduler\'s recall', /StudySession\.objectiveStats\(/.test(side) && /recall: recallNow/.test(side));
  ck('each lecture row shows started %, new left, recall, learned and learning', /pctStarted/.test(side) && /newLeft/.test(side) && /recall/.test(side) && /learned/.test(side) && /learning/.test(side));
  ck('the sidebar never shows "Loading" under FSRS: the legacy bar renderer is a no-op there', /window\.renderObjBars = function\(\)\{\s*if\(fsrsPractice\(\)\) return;/.test(html));
  ck('idle, the top of the sidebar shows today\'s progress rather than an empty session', /'Done today'/.test(side));
  const flip = html.slice(html.indexOf('function fcFlip('), html.indexOf('function fcRate('));
  ck('tapping a flipped card flips it back to the question', /if\(fcFlipped\)\{ fcFlipBack\(\); return; \}/.test(flip) && /function fcFlipBack\(\)/.test(flip));
  const back = flip.slice(flip.indexOf('function fcFlipBack('));
  ck('flip back restores the question and hint without wiping the outcome line', /textContent=c\.question/.test(back) && /fc-flip-hint/.test(back) && !/fc-history/.test(back));
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
