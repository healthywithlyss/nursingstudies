/* ══════════════════════════════════════════════════════════════════════════
   REPLAY MASTERY FROM ATTEMPT HISTORY

   Rebuilds card_mastery / question_mastery FSRS state by replaying every
   recorded attempt through the scheduler, AT ITS ORIGINAL TIMESTAMP.

   WHY THIS EXISTS
   The mastery upserts named no ON CONFLICT target, so PostgREST aimed them at
   the surrogate `id` primary key. Every write after the first on a given item
   was a plain INSERT that hit the natural unique index and came back 409, and
   nothing surfaced it. Roughly half of all ratings were discarded. The attempt
   tables were unaffected, so the history survived and the state can be rebuilt.

   TIMESTAMPS ARE THE WHOLE POINT
   FSRS stability depends on the elapsed time between reviews: a card reviewed
   after 30 days gains far more stability than the same card reviewed after 30
   seconds. Replaying everything at now() would collapse every gap to zero and
   send every card down the same-day short-term branch, producing stability
   values that describe a study session nobody had. So each attempt is applied
   at its own created_at, in order, and `last_review` walks forward with it.

   WHAT IS LOSSY
   card_attempts stores the legacy three-value result, so ratings map
     missed -> Again(1)   unsure -> Hard(2)   got_it -> Good(3)
   and EASY IS NEVER RECOVERED. A card actually rated Easy comes back as Good,
   which shortens its interval. That errs toward more review, which is the safe
   direction. quiz_attempts stores a boolean, so it maps
     is_correct=false -> Again(1)   is_correct=true -> Good(3)

   Usage:
     node scripts/replay-mastery.mjs <history.json> [--course NUR144] > plan.json
   The input is produced by the export query in the same directory's README
   block below; the output is a plan, not a write. Writing is a separate,
   deliberate step.
   ══════════════════════════════════════════════════════════════════════════ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FSRS = require(path.join(ROOT, 'vendor/fsrs.js'));
const ES = require(path.join(ROOT, 'lib/exam-scheduler.js'));

const MIN = 60000;
const DAY = 86400000;

/* the app's own defaults; the settings row is passed in when it differs */
export function makeScheduler(settings) {
  const s = settings || {};
  const learn = (s.learningSteps || [1, 10]).map((m) => m * MIN);
  const relearn = (s.relearningSteps || [10]).map((m) => m * MIN);
  return new FSRS.Scheduler({ learningSteps: learn, relearningSteps: relearn });
}

export const RATING_FROM_RESULT = { missed: 1, unsure: 2, got_it: 3 };

/* ── replay one item ─────────────────────────────────────────────────────
   attempts: [{ at: epochMs, rating: 1|2|3|4 }] in ascending time order.
   Returns the final FSRS card, or null if there is nothing to replay. */
export function replayItem(sched, attempts) {
  if (!attempts || !attempts.length) return null;
  let card = FSRS.newCard();
  let last = null;
  for (const a of attempts) {
    /* Time must never go backwards: a clock skew or an out-of-order export
       would otherwise hand FSRS a negative elapsed time and silently produce
       nonsense. Clamp to the previous review instead, and count it. */
    const at = last == null ? a.at : Math.max(a.at, last);
    card = sched.review(card, a.rating, at);
    last = at;
  }
  return card;
}

/* ── the plan for one item ───────────────────────────────────────────────
   `exam` is optional; when given, the final due date is pulled inside the
   runway exactly as a live rating would be. The MEMORY state (stability,
   difficulty, lapses, reps) is history and is never clamped — only when the
   item next comes up changes. */
export function planFor(sched, attempts, opts) {
  const o = opts || {};
  const card = replayItem(sched, attempts);
  if (!card) return null;

  let due = card.due;
  let clamped = false;
  if (o.exam && card.due - card.last_review >= DAY) {
    const c = ES.compressToRunway(card.due - card.last_review, card.due - card.last_review,
      o.exam, card.last_review, o.settings || {});
    if (c.ms !== card.due - card.last_review) {
      due = card.last_review + c.ms;
      clamped = true;
    }
  }

  return {
    state: card.state,
    learning_step: card.step == null ? null : card.step,
    stability: card.stability == null ? null : round4(card.stability),
    difficulty: card.difficulty == null ? null : round4(card.difficulty),
    interval_days: due - card.last_review >= DAY
      ? Math.round((due - card.last_review) / DAY) : 0,
    repetitions: card.reps,
    lapses: card.lapses,
    last_reviewed_at: card.last_review,
    due_date: due,
    clamped: clamped,
    attempts: attempts.length
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

/* ── is_mastered, recomputed from history rather than asserted ───────────
   The legacy flag was set the first time a card was answered correctly, which
   is why 960 of 961 "mastered" cards had exactly one correct answer: it meant
   "got it right once", not "you know this".

   Recomputed as the question the word actually implies: will she still know it
   a MONTH from now? That is FSRS's own predicted recall at a 30-day horizon,
   against the same readiness threshold the dashboard uses. A card still
   climbing its learning steps cannot qualify however well it is going — being
   mid-way through the first sitting is not mastery — so it must have graduated
   to 'review', and it must have been answered more than once. */
export const MASTERY_HORIZON_DAYS = 30;

export function masteredFrom(sched, card) {
  if (!card || card.stability == null) return false;
  if (card.state !== 'review') return false;
  if (card.reps < 2) return false;
  return sched.retrievability(card.stability, MASTERY_HORIZON_DAYS) >= ES.READY_THRESHOLD;
}

/* ── CLI ─────────────────────────────────────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith('replay-mastery.mjs')) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/replay-mastery.mjs <history.json>');
    process.exit(2);
  }
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sched = makeScheduler(input.settings);
  const now = input.now || Date.now();
  const exams = input.exams || {};
  const units = input.units || {};

  const out = [];
  for (const item of input.items) {
    const attempts = item.attempts.map((a) => ({ at: a[0], rating: a[1] }));
    const exam = item.course === input.clampCourse
      ? ES.nextExamFor(units[item.objective] || 1, exams, now) : null;
    const p = planFor(sched, attempts, { exam, settings: input.settings });
    if (!p) continue;
    const card = replayItem(sched, attempts);
    /* THE ROW IS ONLY REPLACED WHEN THE REPLAY KNOWS MORE THAN IT DOES.

       card_attempts cannot distinguish Easy from Good — rating2legacy folds
       both to 'got_it' — so for a card rated exactly once the STORED row is
       better informed than the replay: it may hold a real Easy that the replay
       would quietly downgrade. Card 2349 is exactly that case, with its
       difficulty pinned at the 1.0 floor only an Easy produces.

       So: replace a row only when the replay accounts for strictly more
       ratings than the row does. That repairs every row the 409s froze and
       leaves every undamaged row alone. */
    out.push(Object.assign({ id: item.id, kind: item.kind, course: item.course,
      storedReps: item.storedReps == null ? 0 : item.storedReps,
      replace: p.repetitions > (item.storedReps == null ? 0 : item.storedReps),
      is_mastered: masteredFrom(sched, card) }, p));
  }
  process.stdout.write(JSON.stringify({ now, rows: out }, null, 0));
}
