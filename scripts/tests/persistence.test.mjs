/* ══════════════════════════════════════════════════════════════════════════
   PERSISTENCE

   Three bugs meant no rating was ever saved after the first one on a card, and
   nothing said so. This suite exists so that cannot recur.

   1. THE UPSERT AIMED AT THE WRONG KEY
      card_mastery and question_mastery have a SURROGATE primary key (`id`) and
      a separate natural unique key (user_id, card_id). PostgREST infers the
      ON CONFLICT target from the PRIMARY KEY unless `on_conflict=` is given in
      the query string. So `Prefer: resolution=merge-duplicates` with no
      on_conflict compiled to `ON CONFLICT (id) DO UPDATE` — and since `id` was
      never supplied it never conflicted, so every write was a plain INSERT that
      then hit the natural unique index and came back 409.

      The first rating on a card landed. Every rating after it was rejected.

   2. THE FAILURE WAS INVISIBLE
      fetch() does not reject on an HTTP error status, so `.catch(console.warn)`
      never fired for a 409. The promise resolved, the app carried on, and the
      row silently stayed at its first value.

   3. THE READ PATH DROPPED THE LEARNING STEP
      toItem() never copied learning_step or interval_days off the row, so even
      a correctly stored card came back at step 0 and was offered a step it had
      already passed.

   These are source-level and logic-level checks; the database side was
   verified directly against the live schema.
   ══════════════════════════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SS = require(path.join(ROOT, 'lib/study-session.js'));
const ES = require(path.join(ROOT, 'lib/exam-scheduler.js'));

let fail = 0;
function ck(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); return; }
  fail++;
  console.log('  FAIL  ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ── 1. every upsert names its conflict target ───────────────────────── */
console.log('\nevery merge-duplicates write names its conflict target');
{
  /* Find each fetch/sbFetch call whose options set merge-duplicates, and take
     the URL literal it was given. */
  const re = /(?:window\.)?(?:sb)?[Ff]etch\(\s*(?:SB_URL\s*\+\s*)?['"]([^'"]+)['"][\s\S]{0,400}?merge-duplicates/g;
  const urls = [];
  let m;
  while ((m = re.exec(html))) urls.push(m[1]);

  ck('the audit actually found the writes', urls.length >= 6, urls.length);

  /* '/rest/v1/' alone is srsUpsert's own prefix — its callers pass the rest. */
  const missing = urls.filter((u) => u !== '/rest/v1/' && !/on_conflict=/.test(u));
  ck('none of them relies on PostgREST guessing the key', missing.length === 0, missing);

  /* and the helper's own call sites */
  const calls = [];
  const cre = /srsUpsert\(\s*([^,]+),/g;
  let c;
  while ((c = cre.exec(html))) calls.push(c[1].trim());
  const helperCalls = calls.filter((x) => !/^path$/.test(x));
  ck('srsUpsert is actually used', helperCalls.length >= 2, helperCalls);
  ck('and every call site carries on_conflict',
    helperCalls.every((x) => /on_conflict=/.test(x)), helperCalls);

  /* the two tables that caused this: surrogate id PK, natural unique key */
  ck('card_mastery upserts target (user_id, card_id)',
    /card_mastery\?on_conflict=user_id,card_id/.test(html));
  ck('question_mastery upserts target (user_id, question_id)',
    /question_mastery\?on_conflict=user_id,question_id/.test(html)
    || /tableFor\(kind\) \+ '\?on_conflict=user_id,' \+ keyFor\(kind\)/.test(html));
  /* The legacy mastery upserts are GONE rather than merely fixed: the counting
     columns they wrote are derived by a trigger now, and a client write would
     race it. What remains is the SRS write, which owns the FSRS columns. */
  ck('the legacy mastery upserts no longer exist at all',
    !/sbFetch\('\/rest\/v1\/card_mastery\?on_conflict/.test(html)
    && !/sbFetch\('\/rest\/v1\/question_mastery\?on_conflict/.test(html));
  ck('but the SRS scheduling write is still there, and still targeted',
    /srsUpsert\('card_mastery\?on_conflict=user_id,card_id'/.test(html));
}

/* ── 2. a rejected write is never silent ─────────────────────────────── */
console.log('\na write that fails says so');
{
  ck('scheduling writes go through one helper rather than ad-hoc fetches',
    /function srsUpsert\(/.test(html));
  const body = html.slice(html.indexOf('function srsUpsert('),
                          html.indexOf('function srsUpsert(') + 1400);
  ck('it checks the HTTP status, because fetch does not reject on 4xx',
    /\br\.ok\b/.test(body), body.slice(0, 200));
  ck('it reports the failure loudly rather than console.warn',
    /console\.error/.test(body));
  ck('and it records it somewhere the UI can show',
    /srsWriteError\s*=/.test(body));
  ck('the dashboard actually surfaces it',
    /function writeErrorHtml\(/.test(html) && /\+ writeErrorHtml\(\)/.test(html));
  ck('no scheduling write swallows errors with a bare catch-and-warn any more',
    !/card_mastery[^]{0,300}?\.catch\(function\(e\)\{ console\.warn\('srs card/.test(html));
}

/* ── 3. the row survives a round trip ────────────────────────────────── */
console.log('\nthe stored row is enough to rebuild the card');

/* the exact row index.html's persistCard writes */
function rowFor(c) {
  return {
    state: c.state, learning_step: c.step == null ? null : c.step,
    stability: c.stability, difficulty: c.difficulty,
    due_date: new Date(c.due).toISOString(),
    last_reviewed_at: new Date(c.last_review).toISOString(),
    interval_days: c.interval_days, repetitions: c.reps, lapses: c.lapses
  };
}
/* the exact item index.html's toItem rebuilds from it */
function toItem(row) {
  return {
    id: 1, kind: 'card', objectiveIds: ['N144_L1'],
    state: row.state,
    stability: row.stability, difficulty: row.difficulty,
    due_date: row.due_date ? Date.parse(row.due_date) : null,
    last_reviewed_at: row.last_reviewed_at ? Date.parse(row.last_reviewed_at) : null,
    repetitions: row.repetitions || 0, lapses: row.lapses || 0,
    learning_step: row.learning_step != null ? row.learning_step : null,
    interval_days: row.interval_days || 0
  };
}

const T0 = Date.parse('2026-09-10T14:00:00Z');
const EXAM = { key: 'unit1', date: ES.parseDate('2026-10-15') };
const SETTINGS = { learningSteps: [1, 10], relearningSteps: [10] };
const clamp = (raw, max, t) => ES.compressToRunway(raw, max, EXAM, t, {});

function rate(item, rating, now) {
  const s = SS.create({ now, items: [item], settings: SETTINGS, clamp });
  const out = s.answer(item.id, rating, now);
  return { out, row: rowFor(out.card) };
}

{
  const fresh = { id: 1, kind: 'card', objectiveIds: ['N144_L1'], state: 'new',
    stability: null, difficulty: null, due_date: null, last_reviewed_at: null,
    repetitions: 0, lapses: 0, learning_step: null, interval_days: 0 };

  const a = rate(fresh, 1, T0);                 /* Again -> learning, step 0 */
  const back = toItem(a.row);
  ck('the learning step survives the trip to the row and back',
    back.learning_step === a.out.card.step,
    { stored: a.row.learning_step, rebuilt: back.learning_step });

  /* Good from step 0 must advance to step 1, and from step 1 must graduate.
     Before the fix the rebuilt card was always at step 0, so a card that had
     already passed the 1-minute step was offered the 1-minute step again. */
  const g1 = rate(back, 3, T0 + 60000);
  ck('Good from step 0 moves to step 1', g1.out.card.step === 1, g1.out.card.step);
  const g2 = rate(toItem(g1.row), 3, T0 + 660000);
  ck('and Good from step 1 graduates to review rather than repeating the step',
    g2.out.card.state === 'review' && g2.out.card.step == null,
    { state: g2.out.card.state, step: g2.out.card.step });

  /* the regression itself: drop learning_step on the way back, as toItem used
     to, and the card is stuck on the first step forever */
  const lossy = Object.assign({}, toItem(g1.row), { learning_step: null });
  const stuck = rate(lossy, 3, T0 + 660000);
  ck('WITHOUT the step, Good repeats the 10-minute step instead of graduating',
    stuck.out.card.state === 'learning',
    { withStep: g2.out.card.state, withoutStep: stuck.out.card.state });
}

/* ── 4. four consecutive ratings must all move the numbers ───────────── */
console.log('\nfour ratings in a row change the stored state every time');
{
  let item = { id: 1, kind: 'card', objectiveIds: ['N144_L1'], state: 'new',
    stability: null, difficulty: null, due_date: null, last_reviewed_at: null,
    repetitions: 0, lapses: 0, learning_step: null, interval_days: 0 };
  let now = T0;
  const rows = [];
  [1, 2, 3, 3].forEach((r) => {
    const step = rate(item, r, now);
    rows.push(step.row);
    item = toItem(step.row);                    /* the round trip, every time */
    now = Math.max(step.out.card.due, now + 60000);
  });

  ck('every rating is counted', rows.map((r) => r.repetitions).join(',') === '1,2,3,4',
    rows.map((r) => r.repetitions));
  ck('no two consecutive rows are identical',
    rows.every((r, i) => i === 0 || JSON.stringify(r) !== JSON.stringify(rows[i - 1])),
    rows);
  ck('due_date moves every time',
    new Set(rows.map((r) => r.due_date)).size === 4, rows.map((r) => r.due_date));
  ck('last_reviewed_at moves every time',
    new Set(rows.map((r) => r.last_reviewed_at)).size === 4);
  ck('difficulty responds to the rating, so struggling is recorded',
    rows[1].difficulty > rows[0].difficulty,
    { again: rows[0].difficulty, hard: rows[1].difficulty });
  ck('stability grows once it is climbing the steps',
    rows[3].stability > rows[1].stability,
    rows.map((r) => r.stability));
  ck('the ladder ends in review with a real interval',
    rows[3].state === 'review' && rows[3].interval_days >= 1, rows[3]);

  /* Hard on the same day holds stability flat rather than dropping it — FSRS-6
     floors a same-day increase at 1.0 for Hard/Good/Easy. Pinned here so it is
     not mistaken for this bug coming back. */
  ck('Hard holds stability rather than lowering it (FSRS-6 short-term floor)',
    rows[1].stability === rows[0].stability,
    { again: rows[0].stability, hard: rows[1].stability });
}

/* ── 5. new means never rated, in BOTH modules ───────────────────────── */
console.log('\n"new" means never rated, and both modules agree');
{
  const cases = [
    ['a card with no state at all', { }, true],
    ['a fresh card', { state: 'new', repetitions: 0, last_reviewed_at: null }, true],
    ['a row that exists but was never graded',
      { state: 'new', repetitions: 0, lapses: 0, last_reviewed_at: null }, true],
    ['a card part-way through its learning steps',
      { state: 'learning', repetitions: 1, last_reviewed_at: 1, learning_step: 1 }, false],
    ['a card in learning whose repetitions column reads 0',
      { state: 'learning', repetitions: 0, last_reviewed_at: 1 }, false],
    ['a relearning card', { state: 'relearning', repetitions: 4, last_reviewed_at: 1 }, false],
    ['a review card', { state: 'review', repetitions: 9, last_reviewed_at: 1 }, false]
  ];
  cases.forEach(function (c) {
    ck(c[0] + ' -> new? ' + c[2], SS.isNewItem(c[1]) === c[2], SS.isNewItem(c[1]));
  });
  ck('the scheduler and the session use the SAME rule',
    cases.every((c) => ES.neverSeen(c[1]) === SS.isNewItem(c[1])),
    cases.filter((c) => ES.neverSeen(c[1]) !== SS.isNewItem(c[1])).map((c) => c[0]));

  /* the specific regression: work already begun must not spend the daily cap */
  const inProgress = Array.from({ length: 8 }, (_, i) => ({
    id: 100 + i, kind: 'card', objectiveIds: ['N144_L1'], state: 'learning',
    repetitions: 0, last_reviewed_at: T0 - 3600000, learning_step: 0,
    stability: 0.21, difficulty: 6.4, due_date: T0 - 60000, interval_days: 0 }));
  ck('eight cards left in progress are not new material',
    inProgress.every((i) => !SS.isNewItem(i)));
  ck('and the scheduler does not count them as never seen either',
    inProgress.every((i) => !ES.neverSeen(i)));
}

/* ── 6. a resumed session keeps the exam rules ───────────────────────── */
console.log('\nresuming a session does not drop the exam clamp');
{
  ck('both paths build their options with the same function',
    /function sessionOpts\(/.test(html), 'sessionOpts missing');
  ck('starting a session uses it',
    /var opts = sessionOpts\(now, st, extra\);/.test(html));
  ck('restoring a session uses it too, rather than its own literal',
    /StudySession\.restore\(saved, deckItems\(\),\s*\n?\s*sessionOpts\(/.test(html));
  ck('and the only clamp definition is inside it',
    (html.match(/clamp: function\(rawMs, maxRawMs, t\)/g) || []).length === 1,
    (html.match(/clamp: function\(rawMs, maxRawMs, t\)/g) || []).length);

  /* The clamp has now gone missing twice, each time through a path that
     restated the rule instead of calling the one that owns it. So: exactly one
     call site, asserted. A second one is the bug coming back. */
  const calls = (html.match(/ES\.compressToRunway\(/g) || []).length;
  ck('compressToRunway is called from exactly ONE place in index.html',
    calls === 1, calls);
  ck('and that place is the named owner',
    /function examClamp\(rawMs, maxRawMs, t, exam\)\{[\s\S]{0,160}?ES\.compressToRunway\(/.test(html));
  ck('both scheduling paths go through it',
    (html.match(/examClamp\(/g) || []).length >= 3,
    (html.match(/examClamp\(/g) || []).length);

  /* behavioural: restore without a clamp gives raw FSRS, with one it is
     compressed — the difference the resume path was silently losing */
  const item = { id: 1, kind: 'card', objectiveIds: ['N144_L1'], state: 'review',
    stability: 30, difficulty: 5, due_date: T0 - 86400000,
    last_reviewed_at: T0 - 31 * 86400000, repetitions: 6, lapses: 0,
    learning_step: null, interval_days: 31 };
  const withClamp = SS.create({ now: T0, items: [item], settings: SETTINGS, clamp });
  const noClamp = SS.create({ now: T0, items: [item], settings: SETTINGS });
  const g = (s) => s.peek(1, T0)[3].ms / 86400000;
  ck('a clamped session schedules inside the runway, an unclamped one does not',
    g(withClamp) < g(noClamp), { clamped: g(withClamp), raw: g(noClamp) });
  ck('and the unclamped interval really does overshoot the exam',
    g(noClamp) > ES.daysBetween(EXAM.date, ES.startOfDay(T0)),
    { raw: g(noClamp), toExam: ES.daysBetween(EXAM.date, ES.startOfDay(T0)) });
}

/* ── 7. one owner per rule ───────────────────────────────────────────────
   The exam clamp went missing twice, each time through a path that restated
   the rule instead of calling the one that owns it. These assert the same
   shape for every rule that had been written out more than once. */
console.log('\nrules that exist in one place, not several');
{
  /* (a) the legacy session must not start under the SRS loop. Three paths
     reach startSession — startSessionForFilter, startSessionWithIds and
     startCards — so the guard belongs on startSession itself. */
  ck('the legacy session is wrapped exactly once',
    (html.match(/window\.startSession = function\(/g) || []).length === 1,
    (html.match(/window\.startSession = function\(/g) || []).length);
  ck('and the guard checks the SRS gate before delegating',
    /window\.startSession = function\(cards, filter\)\{[\s\S]{0,120}?fsrsPractice\(\)/.test(html));
  ck('the Trouble Spots path funnels into it rather than round it',
    /function startSessionWithIds\(ids\)\{[\s\S]{0,300}?startSession\(cards,'__trouble__'\)/.test(html));
  ck('so does startCards',
    /function startCards\(ids\)\{[\s\S]{0,900}?window\.startSession\(ordered, '__srs__'\)/.test(html));
  ck('an explicit card list starts an SRS session, not the legacy one',
    /function srsStudyCards\(cards\)\{/.test(html));

  /* (b) legacy result -> FSRS rating */
  ck('the rating map has one owner',
    /function ratingFromResult\(result, rating\)\{/.test(html));
  /* exactly one occurrence, and it is the one inside the owner */
  ck('the ternary appears exactly once',
    (html.match(/got_it'\s*\?\s*3\s*:/g) || []).length === 1,
    (html.match(/got_it'\s*\?\s*3\s*:/g) || []).length);
  ck('and that once is inside ratingFromResult',
    /function ratingFromResult\(result, rating\)\{[\s\S]{0,120}?got_it'\s*\?\s*3\s*:/.test(html));
  ck('both callers use it',
    (html.match(/ratingFromResult\(result, ?rating\)/g) || []).length >= 2,
    (html.match(/ratingFromResult\(result, ?rating\)/g) || []).length);

  /* (c) the exam clamp — already asserted above, restated here as the rule */
  ck('the exam clamp still has exactly one call site',
    (html.match(/ES\.compressToRunway\(/g) || []).length === 1);

  /* (d) "new" means the same thing in both modules — asserted in section 5 */
  ck('the new-item rule is shared, not restated',
    /Deliberately the SAME rule as StudySession\.isNewItem/.test(
      fs.readFileSync(path.join(ROOT, 'lib/exam-scheduler.js'), 'utf8')));
}

/* ── 8. the mastery counters belong to the database ─────────────────────
   is_mastered came from session state that startSession() resets every sitting,
   and total_attempts/total_correct were never written to card_mastery by any
   loop. Both are now derived by a trigger on the attempt tables. A client write
   would race that trigger and put the wrong answer back on top. */
console.log('\nthe mastery counters are derived, not posted');
{
  const mig = path.join(ROOT, 'supabase/migrations/20260911_mastery_from_history.sql');
  ck('the migration exists', fs.existsSync(mig));
  const sql = fs.existsSync(mig) ? fs.readFileSync(mig, 'utf8') : '';
  ck('it triggers on BOTH attempt tables, so both study loops are covered',
    /after insert on public\.card_attempts/.test(sql)
    && /after insert on public\.quiz_attempts/.test(sql));
  ck('and it states the rule: two correct in total, and the last two correct',
    /v_correct >= 2 and v_last_two_ok/.test(sql));
  ck('it does not touch the FSRS columns, which belong to the scheduler',
    !/\bstability\s*=/.test(sql) && !/\bdifficulty\s*=/.test(sql)
    && !/\bdue_date\s*=/.test(sql) && !/\blearning_step\s*=/.test(sql));

  /* the client must no longer post the derived columns */
  const cardUpsert = html.slice(html.indexOf('function upsertCardMastery('),
                                html.indexOf('function upsertCardMastery(') + 400);
  ck('upsertCardMastery no longer posts anything',
    !/sbFetch/.test(cardUpsert), cardUpsert.slice(0, 160));
  const qUpsert = html.slice(html.indexOf('function upsertQuestionMastery('),
                             html.indexOf('function upsertQuestionMastery(') + 400);
  ck('upsertQuestionMastery no longer posts anything',
    !/sbFetch/.test(qUpsert), qUpsert.slice(0, 160));
  ck('no request body sets is_mastered any more',
    !/is_mastered\s*:/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/quizMasteryData\[[^\]]*\][^;]*/g, '')
      .match(/body:\s*JSON\.stringify\([\s\S]{0,600}?\)/g)?.join('\n') || ''));

  /* and the label says what the flag means */
  ck('the dashboard no longer calls the flag "mastered"',
    !/<div class="dr-lbl">mastered<\/div>/.test(html));
  ck('it says what it actually measures',
    /<div class="dr-lbl">last 2 correct<\/div>/.test(html));
  ck('the stat rows agree', /cards, last 2 correct/.test(html)
    && />last 2 correct<\/span>/.test(html));
  ck('and the rule is spelled out once on the dashboard',
    /correctly twice in a row/.test(html));
  ck('the in-session counter is labelled as what IT counts, not mastery',
    /Cleared this session/.test(html));
}

console.log(fail ? `\n${fail} FAILING` : '\nall persistence checks passed');
process.exit(fail ? 1 : 0);
