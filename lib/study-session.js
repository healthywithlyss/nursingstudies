/* ══════════════════════════════════════════════════════════════════════════
   STUDY SESSION

   The queue a flashcard sitting actually runs on. FSRS decides what an answer
   means; this decides what you see next, and it is the piece that was missing.

   THE BUG THIS EXISTS TO FIX
   The old loop cycled the whole deck: a card you missed came back only after
   every other card had been shown — 144 cards later on NUR144 — and a card you
   got right on the first try was marked mastered and never came back at all.
   Neither is spaced repetition. Failing a card has to mean seeing it again in
   about a minute, and the only way out of a session is getting it right.

   THE TWO QUEUES
     learning   sub-day cards, ordered by when they are due back. A card lands
                here from Again on a new card, or from Again on a review card
                (relearning). It leaves by graduating: FSRS moves it to 'review'
                and it gets a real interval.
     scheduled  new cards and cards genuinely due today, in that day's order.

   next() prefers a learning card whose moment has come, then scheduled work,
   then a learning card whose moment has NOT come — because making someone sit
   and wait out a timer is worse than showing it forty seconds early.

   THE GUARANTEE
   isComplete() is false while anything is still in learning or relearning. A
   card you failed cannot leave the session unseen, because the session does not
   end while it is still in the queue. That is asserted directly in
   scripts/tests/study-session.test.mjs.

   Pure: no DOM, no fetch, no clock of its own. `now` is always passed in.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory(typeof require === 'function' ? require('../vendor/fsrs.js') : root.FSRS);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudySession = api;
}(typeof self !== 'undefined' ? self : this, function (FSRS) {
  'use strict';

  var MINUTE = 60000;
  var DAY = 86400000;

  /* Anki's defaults, and the ones the schema defaults to. Minutes. */
  var DEFAULT_LEARNING_STEPS = [1, 10];
  var DEFAULT_RELEARNING_STEPS = [10];

  /* A card scheduled further out than this is done for today; anything inside
     it stays in the session. One day, because that is what "sub-day step"
     means — it is not a tuning knob. */
  var SESSION_HORIZON = DAY;

  function minutesToMs(steps, fallback) {
    var a = (steps && steps.length ? steps : fallback)
      .map(Number).filter(function (n) { return isFinite(n) && n > 0; });
    return (a.length ? a : fallback).map(function (m) { return m * MINUTE; });
  }

  /* ── how long until this comes back, in words ────────────────────────── */
  function formatInterval(ms) {
    if (ms == null) return '';
    if (ms < MINUTE) return '<1m';
    if (ms < 60 * MINUTE) return Math.round(ms / MINUTE) + 'm';
    if (ms < DAY) {
      var h = ms / (60 * MINUTE);
      return (h < 10 ? Math.round(h * 10) / 10 : Math.round(h)) + 'h';
    }
    var d = ms / DAY;
    if (d < 30) return Math.round(d) + 'd';
    if (d < 365) return Math.round(d / 30.4) + 'mo';
    return Math.round(d / 365 * 10) / 10 + 'y';
  }

  /* The sentence shown after answering. Deliberately different wording for the
     two cases: "back in 1 minute" is this sitting, "next review in 4 days" is
     not, and blurring them is how you end up not trusting either. */
  function outcomeText(ms) {
    if (ms < SESSION_HORIZON) {
      if (ms < MINUTE) return 'Back in under a minute';
      var m = Math.round(ms / MINUTE);
      if (m < 60) return 'Back in ' + m + ' minute' + (m === 1 ? '' : 's');
      var h = Math.round(ms / (60 * MINUTE));
      return 'Back in ' + h + ' hour' + (h === 1 ? '' : 's');
    }
    var d = Math.round(ms / DAY);
    if (d < 30) return 'Next review in ' + d + ' day' + (d === 1 ? '' : 's');
    if (d < 365) return 'Next review in ' + Math.round(d / 30.4) + ' months';
    return 'Next review in ' + (Math.round(d / 365 * 10) / 10) + ' years';
  }

  /* ── the card record the session carries ─────────────────────────────── */
  function cardFrom(item) {
    return {
      state: item.state && item.state !== 'new' ? item.state : 'learning',
      step: item.learning_step == null ? 0 : item.learning_step,
      stability: item.stability == null ? null : item.stability,
      difficulty: item.difficulty == null ? null : item.difficulty,
      due: item.due_date == null ? null : item.due_date,
      last_review: item.last_reviewed_at == null ? null : item.last_reviewed_at,
      reps: item.repetitions || 0,
      lapses: item.lapses || 0,
      interval_days: item.interval_days || 0
    };
  }

  function isNewItem(item) {
    return !item.last_reviewed_at || !item.repetitions || item.state === 'new';
  }

  /* ══ the session ══════════════════════════════════════════════════════ */
  function Session(opts) {
    opts = opts || {};
    this.now = opts.now == null ? Date.now() : opts.now;
    this.mode = opts.mode === 'extra' ? 'extra' : 'scheduled';
    this.settings = opts.settings || {};

    var learn = minutesToMs(this.settings.learningSteps, DEFAULT_LEARNING_STEPS);
    var relearn = minutesToMs(this.settings.relearningSteps, DEFAULT_RELEARNING_STEPS);
    this.scheduler = opts.scheduler || new FSRS.Scheduler({
      learningSteps: learn, relearningSteps: relearn
    });
    this.learningSteps = learn;
    this.relearningSteps = relearn;

    /* How a raw FSRS interval is turned into a scheduled one. Injected rather
       than built in, because the exam rules belong to lib/exam-scheduler.js and
       this file should not know what an exam is. Signature:
         (rawMs, maxRawMs, now) -> {ms, compressed, rawMs}
       Default: leave FSRS exactly as it is. */
    this.clamp = opts.clamp || function (rawMs) {
      return { ms: rawMs, compressed: false, rawMs: rawMs };
    };

    /* card id -> live FSRS state for this session */
    this.cards = {};
    /* card id -> when it is next wanted, in ms. Absent = not in the session. */
    this.dueAt = {};
    this.order = [];          /* scheduled work, in the order it was handed to us */
    this.learning = [];       /* ids currently in learning/relearning */
    this.doneIds = {};        /* answered and scheduled past today */
    this.answered = 0;        /* total ratings given, including repeats */
    this.history = [];        /* for undo */
    this.items = {};

    var self = this;
    (opts.items || []).forEach(function (it) {
      self.items[it.id] = it;
      self.cards[it.id] = cardFrom(it);
      self.order.push(it.id);
      /* Extra study ignores due dates entirely; scheduled study takes what it
         was given, which the caller has already filtered and capped. */
      self.dueAt[it.id] = self.mode === 'extra'
        ? self.now
        : (it.due_date == null ? self.now : Math.min(it.due_date, self.now));
      var st = self.cards[it.id].state;
      if ((st === 'learning' || st === 'relearning') && !isNewItem(it)) {
        self.learning.push(it.id);
      }
    });

    /* The counts as they were when the session opened — a progress bar that
       moves because its own denominator shrank is worse than none. */
    this.startingTotal = this.order.length;
    this.startCounts = this.counts();
  }

  Session.prototype.counts = function () {
    var self = this, c = { newItems: 0, learning: 0, due: 0 };
    this.order.forEach(function (id) {
      if (self.doneIds[id]) return;
      var card = self.cards[id];
      if (self.learning.indexOf(id) > -1) { c.learning++; return; }
      if (isNewItem(self.items[id]) && !card.last_review) { c.newItems++; return; }
      c.due++;
    });
    return c;
  };

  /* Everything still wanted, whether or not its moment has arrived. */
  Session.prototype.remaining = function () {
    var self = this;
    return this.order.filter(function (id) { return !self.doneIds[id]; });
  };

  /* THE GUARANTEE. While anything sits in learning or relearning the session is
     not finished, so a card you failed cannot be left behind. */
  Session.prototype.isComplete = function () {
    return this.remaining().length === 0;
  };

  Session.prototype.hasUnfinishedLearning = function () {
    var self = this;
    return this.learning.some(function (id) { return !self.doneIds[id]; });
  };

  /* What to show now.
       1. a learning card whose time has come, earliest first
       2. otherwise the next scheduled card
       3. otherwise the earliest learning card even though it is early —
          sitting watching a timer is worse than a card forty seconds sharp */
  Session.prototype.next = function (now) {
    var t = now == null ? this.now : now;
    var self = this;
    var live = this.learning.filter(function (id) { return !self.doneIds[id]; });
    live.sort(function (a, b) { return self.dueAt[a] - self.dueAt[b]; });

    if (live.length && self.dueAt[live[0]] <= t) return this.items[live[0]];

    var sched = this.order.filter(function (id) {
      return !self.doneIds[id] && live.indexOf(id) === -1;
    });
    if (sched.length) return this.items[sched[0]];

    if (live.length) return this.items[live[0]];
    return null;
  };

  /* How long until the next learning card is wanted, for the waiting message. */
  Session.prototype.waitMs = function (now) {
    var t = now == null ? this.now : now;
    var self = this;
    var live = this.learning.filter(function (id) { return !self.doneIds[id]; });
    if (!live.length) return 0;
    var soonest = Math.min.apply(null, live.map(function (id) { return self.dueAt[id]; }));
    return Math.max(0, soonest - t);
  };

  /* Every rating's raw FSRS outcome for one card, in one place.

     The four are computed together because the clamp scales them against the
     longest of them: that is what keeps Again < Hard < Good < Easy after
     compression, and it is why the number shown on a button is exactly the
     number that gets stored — peek and answer run the identical calculation. */
  Session.prototype.rawOutcomes = function (itemId, now) {
    var t = now == null ? this.now : now;
    var card = this.cards[itemId];
    if (!card) return null;
    var self = this, raw = {}, maxRaw = 0;
    [1, 2, 3, 4].forEach(function (r) {
      var after = self.scheduler.review(card, r, t);
      raw[r] = { after: after, delta: after.due - t };
      if (raw[r].delta > maxRaw) maxRaw = raw[r].delta;
    });
    return { raw: raw, maxRaw: maxRaw, t: t };
  };

  /* Apply the clamp to one rating's raw outcome. */
  Session.prototype.place = function (itemId, rating, now) {
    var o = this.rawOutcomes(itemId, now);
    if (!o) return null;
    var r = o.raw[rating];
    var c = this.clamp(r.delta, o.maxRaw, o.t);
    var after = r.after;
    if (c.ms !== r.delta) {
      /* rebuild the card on the scheduled date rather than the raw one; the
         FSRS memory state (stability, difficulty, lapses) is untouched — only
         WHEN it comes back changes */
      after = Object.assign({}, after, {
        due: o.t + c.ms,
        interval_days: c.ms >= DAY ? Math.round(c.ms / DAY) : 0
      });
    }
    return {
      after: after, deltaMs: c.ms, rawMs: r.delta,
      compressed: !!c.compressed, t: o.t
    };
  };

  /* ── what each button would do, without doing it ─────────────────────── */
  Session.prototype.peek = function (itemId, now) {
    var t = now == null ? this.now : now;
    var self = this, out = {};
    [1, 2, 3, 4].forEach(function (r) {
      var p = self.place(itemId, r, t);
      if (!p) return;
      out[r] = {
        ms: p.deltaMs,
        label: formatInterval(p.deltaMs),
        rawMs: p.rawMs,
        rawLabel: formatInterval(p.rawMs),
        compressed: p.compressed,
        inSession: p.deltaMs < SESSION_HORIZON,
        state: p.after.state
      };
    });
    return out;
  };

  /* ── answer ──────────────────────────────────────────────────────────── */
  Session.prototype.answer = function (itemId, rating, now) {
    var t = now == null ? this.now : now;
    var card = this.cards[itemId];
    if (!card) return null;

    /* everything needed to put it back exactly as it was */
    this.history.push({
      id: itemId,
      card: JSON.parse(JSON.stringify(card)),
      dueAt: this.dueAt[itemId],
      wasLearning: this.learning.indexOf(itemId) > -1,
      wasDone: !!this.doneIds[itemId],
      orderIndex: this.order.indexOf(itemId),
      answered: this.answered
    });

    var placed = this.place(itemId, rating, t);
    var after = placed.after;
    this.cards[itemId] = after;
    this.answered++;

    var delta = placed.deltaMs;
    var inSession = delta < SESSION_HORIZON;

    if (inSession) {
      this.dueAt[itemId] = after.due;
      if (this.learning.indexOf(itemId) === -1) this.learning.push(itemId);
      delete this.doneIds[itemId];
      /* move it to the back of the scheduled order so it does not also come up
         as "the next scheduled card" before its timer */
      var i = this.order.indexOf(itemId);
      if (i > -1) { this.order.splice(i, 1); this.order.push(itemId); }
    } else {
      this.doneIds[itemId] = true;
      var j = this.learning.indexOf(itemId);
      if (j > -1) this.learning.splice(j, 1);
    }

    return {
      card: after,
      dueMs: after.due,
      deltaMs: delta,
      inSession: inSession,
      graduated: !inSession,
      label: formatInterval(delta),
      rawMs: placed.rawMs,
      rawLabel: formatInterval(placed.rawMs),
      compressed: placed.compressed,
      text: outcomeText(delta)
        + (placed.compressed ? ' — compressed to fit the exam' : ''),
      /* the caller persists only when this is a real, scheduled outcome */
      persist: this.mode !== 'extra'
    };
  };

  Session.prototype.canUndo = function () { return this.history.length > 0; };

  Session.prototype.undo = function () {
    var h = this.history.pop();
    if (!h) return null;
    this.cards[h.id] = h.card;
    this.dueAt[h.id] = h.dueAt;
    this.answered = h.answered;
    if (h.wasDone) this.doneIds[h.id] = true; else delete this.doneIds[h.id];
    var i = this.learning.indexOf(h.id);
    if (h.wasLearning && i === -1) this.learning.push(h.id);
    if (!h.wasLearning && i > -1) this.learning.splice(i, 1);
    /* put it back where it was in the running order */
    var j = this.order.indexOf(h.id);
    if (j > -1) this.order.splice(j, 1);
    this.order.splice(Math.max(0, Math.min(h.orderIndex, this.order.length)), 0, h.id);
    return { id: h.id, card: h.card, item: this.items[h.id] };
  };

  /* Answered vs the size the session opened at. Repeats of a failed card count
     as work done, which is why this can pass 100% — it is a count of answers,
     not of cards, and the label says so. */
  Session.prototype.progress = function () {
    var done = this.startingTotal - this.remaining().length;
    return {
      done: done,
      total: this.startingTotal,
      answered: this.answered,
      remaining: this.remaining().length,
      pct: this.startingTotal ? Math.round((done / this.startingTotal) * 100) : 0
    };
  };

  /* ── serialising, so leaving mid-session and coming back resumes ─────── */
  Session.prototype.toJSON = function () {
    return {
      v: 1, mode: this.mode, now: this.now,
      order: this.order, learning: this.learning, doneIds: this.doneIds,
      dueAt: this.dueAt, cards: this.cards, answered: this.answered,
      startingTotal: this.startingTotal, startCounts: this.startCounts,
      settings: this.settings
    };
  };

  Session.restore = function (saved, items, opts) {
    if (!saved || saved.v !== 1) return null;
    var byId = {};
    (items || []).forEach(function (it) { byId[it.id] = it; });
    /* Anything the saved session referred to that is no longer in the deck is
       dropped rather than resurrected — a card deleted since must not reappear. */
    var live = (saved.order || []).filter(function (id) { return byId[id]; });
    if (!live.length) return null;

    var s = new Session(Object.assign({}, opts, {
      items: live.map(function (id) { return byId[id]; }),
      mode: saved.mode, settings: saved.settings || (opts && opts.settings)
    }));
    s.order = live;
    s.learning = (saved.learning || []).filter(function (id) { return byId[id]; });
    s.doneIds = {};
    Object.keys(saved.doneIds || {}).forEach(function (id) {
      if (byId[id]) s.doneIds[id] = true;
    });
    Object.keys(saved.dueAt || {}).forEach(function (id) {
      if (byId[id]) s.dueAt[id] = saved.dueAt[id];
    });
    Object.keys(saved.cards || {}).forEach(function (id) {
      if (byId[id]) s.cards[id] = saved.cards[id];
    });
    s.answered = saved.answered || 0;
    s.startingTotal = saved.startingTotal || live.length;
    s.startCounts = saved.startCounts || s.counts();
    return s;
  };

  return {
    Session: Session,
    create: function (opts) { return new Session(opts); },
    restore: Session.restore,
    formatInterval: formatInterval,
    outcomeText: outcomeText,
    minutesToMs: minutesToMs,
    isNewItem: isNewItem,
    DEFAULT_LEARNING_STEPS: DEFAULT_LEARNING_STEPS,
    DEFAULT_RELEARNING_STEPS: DEFAULT_RELEARNING_STEPS,
    SESSION_HORIZON: SESSION_HORIZON,
    MINUTE: MINUTE, DAY: DAY
  };
}));
