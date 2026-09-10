/* ══════════════════════════════════════════════════════════════════════════
   EXAM SCHEDULER

   FSRS answers one question: when should this item come up so that it is still
   retrievable? That is the right question when the horizon is open-ended. It is
   the wrong question on its own when there is a test on the 14th, for three
   reasons this module exists to fix.

   1. CLAMPING. FSRS will happily schedule an item 40 days out. If the exam is
      in 12, that review never happens before it counts. Every interval is
      capped so an item is always seen again before the exam it belongs to.

   2. RESURFACING. Once the unit 1 test is behind her she moves to unit 2, and
      unclamped unit 1 intervals stretch straight past the comprehensive final.
      The moment the unit 1 date passes, unit 1 material becomes accountable to
      the FINAL instead, so the clamp above starts pulling it back — and on top
      of that, no unit 1 item may go into the final without having been seen
      since the unit 1 test.

   3. COVERAGE. FSRS optimises retention of what you have already seen. It has
      nothing to say about an item you have never opened, because it has no
      state for it. Nothing may go unseen into an exam, so never-seen items are
      a separate, higher-priority track that gets sized against the days left
      rather than left to the due queue.

   Everything here is pure: dates and item state in, plan out. No DOM, no fetch,
   no clock of its own — `now` is always passed in. That is what makes it
   testable, and scripts/tests/exam-scheduler.test.mjs is where it is tested.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory(typeof require === 'function' ? require('../vendor/fsrs.js') : root.FSRS);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExamScheduler = api;
}(typeof self !== 'undefined' ? self : this, function (FSRS) {
  'use strict';

  var DAY = 86400000;

  /* Readiness threshold. 0.9 is FSRS's own desired retention: the stability
     figure literally means "the number of days until P(recall) hits 0.9", so
     scoring readiness at anything else would be measuring against a bar the
     scheduler is not aiming at. */
  var READY_THRESHOLD = 0.9;

  /* How many items to actually put in front of her on one day. Not a cap on
     what is due — the true due count is always reported alongside — but a
     working set. Without it, a backlog of 1,300 overdue items reads as an
     unclimbable wall and gets abandoned, which is worse than any scheduling
     error. */
  var DAILY_CAP = 120;

  /* Reviews before the exam are held back from the last day: an item whose
     final review is the morning of the test was not really scheduled. */
  var EXAM_BUFFER_DAYS = 1;

  /* How much new material to start each day. Two numbers because a flashcard is
     a smaller unit of work than a quiz question, so the comfortable rate is not
     the same. These are CEILINGS, not targets: if there is less new material
     than the cap, the day is simply shorter. */
  var DEFAULT_SETTINGS = {
    newCardsPerDay: 20,
    newQuizPerDay: 15,
    /* The load the review side is levelled toward. Not a hard cut — reviews
       that are genuinely due are still due — but the number the balancer aims
       under and the forecast marks against. */
    dailyCeiling: 120
  };

  /* The sweep: the last stretch before an exam, where every item in the unit is
     seen at least once whatever the scheduler thinks. */
  var SWEEP_DAYS = 7;

  /* How far an interval may slide to level the load. Anki calls this fuzz. The
     longer the interval, the less a day or two matters to retention, so longer
     intervals get more room. Below three days there is no room at all: moving a
     two-day interval by a day is a 50% change. */
  function slideRoom(intervalDays) {
    if (intervalDays >= 21) return 3;
    if (intervalDays >= 7) return 2;
    if (intervalDays >= 3) return 1;
    return 0;
  }

  var EXAMS = ['unit1', 'unit2', 'final'];

  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]).getTime();   /* local midnight */
  }
  function daysBetween(a, b) { return Math.round((startOfDay(a) - startOfDay(b)) / DAY); }

  /* ── which exam is an item accountable to ──────────────────────────────
     Unit 1 material answers to the unit 1 test until that date passes, then to
     the final, because the final covers both units. Unit 2 the same. An exam
     whose date is not set imposes nothing — that is how NUR116 and NUR118,
     which have no dates, fall back to plain FSRS. */
  function nextExamFor(unit, exams, now) {
    var today = startOfDay(now);
    var own = parseDate(unit === 2 ? exams.unit2 : exams.unit1);
    var fin = parseDate(exams.final);
    if (own !== null && own >= today) return { key: unit === 2 ? 'unit2' : 'unit1', date: own };
    if (fin !== null && fin >= today) return { key: 'final', date: fin };
    return null;
  }

  /* Every exam an item is in scope for, which is what readiness needs: the
     unit test AND the final both count it. */
  function examsCovering(unit) {
    return unit === 2 ? ['unit2', 'final'] : ['unit1', 'final'];
  }

  function unitOf(item, units) {
    var ids = item.objectiveIds || [];
    for (var i = 0; i < ids.length; i++) {
      var u = units[ids[i]];
      if (u === 2) return 2;
      if (u === 1) return 1;
    }
    return 1;   /* unassigned material is unit 1 until someone says otherwise */
  }

  /* ── the clamp ─────────────────────────────────────────────────────────
     An interval that lands after the exam is worthless, so it is pulled back
     to the last useful day. Never earlier than tomorrow — pulling a 40-day
     item to today would just churn — and sub-day learning steps are left alone
     because they are within this sitting. */
  function clampDue(dueMs, exam, now) {
    if (!exam) return dueMs;
    if (dueMs - now < DAY) return dueMs;                  /* learning step */
    var latest = exam.date - EXAM_BUFFER_DAYS * DAY;
    if (dueMs <= latest) return dueMs;
    return Math.max(latest, startOfDay(now) + DAY);
  }

  /* ══ compressing a schedule into the runway ════════════════════════════
     A ceiling alone is not enough. Capping every long interval at the exam
     collapses Hard, Good and Easy onto the same day: the ordering that makes
     the four buttons mean anything is destroyed, and the card comes back once,
     the day before the test, which is no use to anyone.

     So the whole ladder is compressed into the time actually available,
     keeping its shape.

       usable   days until the exam, minus the sweep week — the sweep covers
                everything anyway, so scheduling into it wastes the slot
       longest  half the usable runway, so even the Easy button leaves room for
                one more real review before the sweep opens
       shape    each interval keeps its position on the ladder relative to the
                longest one, squared. Squaring pulls the weak end down harder
                than the strong end: a card you found Hard should come back
                several times before the exam, not once.

     With 35 days to the test, FSRS asking 64/86/135 days becomes roughly
     4/8/14 — spread across the runway instead of piled on its last day.

     Below the threshold nothing happens at all: if FSRS already fits inside
     the runway, this returns the interval untouched, and `compressed` is false
     so the UI can say plainly which schedule she is on. */

  var COMPRESSION_EXPONENT = 2;

  /* Days of real scheduling space before the sweep takes over. */
  function runwayDays(exam, now) {
    if (!exam) return null;
    var today = startOfDay(now);
    return daysBetween(exam.date, today) - SWEEP_DAYS;
  }

  /* rawMs      what FSRS asked for, for THIS rating
     maxRawMs   what FSRS asked for at the top of the ladder (Easy), so every
                rating on one card is scaled against the same reference and the
                number on the button is the number that gets stored
     Returns {ms, compressed, rawMs, reason}. */
  function compressToRunway(rawMs, maxRawMs, exam, now) {
    var out = { ms: rawMs, compressed: false, rawMs: rawMs, reason: null };
    if (!exam) return out;                       /* no date: normal spacing */
    if (rawMs < DAY) return out;                 /* a learning step is not a schedule */

    var usable = runwayDays(exam, now);

    /* Inside the sweep week there is no runway left before the exam, but there
       are still days, and the ladder has to keep its shape in them. Capping
       every long interval at the last available day put Hard, Good and Easy all
       on day 4 — the same collapse this function exists to prevent, just moved
       inside the window. Same squared shape, smaller space. */
    if (usable <= 0) {
      var left = Math.max(1, daysBetween(exam.date, startOfDay(now)) - 1);
      var maxRawSweep = Math.max(rawMs, maxRawMs || rawMs);
      var shape = maxRawSweep > 0 ? (rawMs / maxRawSweep) : 1;
      var d = left * Math.pow(shape, COMPRESSION_EXPONENT);
      out.ms = Math.min(Math.max(1, Math.round(d)), left) * DAY;
      out.compressed = out.ms !== rawMs;
      out.reason = 'sweep';
      return out;
    }

    var longest = Math.max(1, usable / 2);
    var maxRaw = Math.max(rawMs, maxRawMs || rawMs);

    /* already fits, with room to spare — leave FSRS alone */
    if (maxRaw <= longest * DAY) return out;

    var ratio = maxRaw > 0 ? (rawMs / maxRaw) : 1;
    var days = longest * Math.pow(ratio, COMPRESSION_EXPONENT);
    out.ms = Math.max(1, Math.round(days)) * DAY;
    /* never past the sweep, whatever the arithmetic says */
    out.ms = Math.min(out.ms, usable * DAY);
    out.compressed = true;
    out.reason = 'runway';
    return out;
  }

  /* ── the forecast, and levelling against it ────────────────────────────
     A histogram of how many items are already due on each of the next N days,
     day 0 being today. Everything overdue counts as today, because that is when
     it will actually be answered. */
  function loadHistogram(items, now, days) {
    var today = startOfDay(now);
    var h = {};
    var n = days == null ? 21 : days;
    for (var i = 0; i <= n; i++) h[i] = 0;
    items.forEach(function (it) {
      if (it.due_date == null) return;
      var d = daysBetween(it.due_date, today);
      if (d < 0) d = 0;
      if (d <= n) h[d] = (h[d] || 0) + 1;
    });
    return h;
  }

  /* Reviews due per day for the next `days` days, for the chart. */
  function forecast(items, now, days, ceiling) {
    var n = days == null ? 14 : days;
    var cap = ceiling || DEFAULT_SETTINGS.dailyCeiling;
    var h = loadHistogram(items, now, n);
    var today = startOfDay(now);
    var out = [];
    for (var i = 0; i < n; i++) {
      var ms = today + i * DAY;
      out.push({
        dayIndex: i, ms: ms, date: new Date(ms),
        count: h[i] || 0,
        over: (h[i] || 0) > cap,
        isToday: i === 0
      });
    }
    return out;
  }

  /* Place an interval on the lightest day within its slide room.

     Left alone, FSRS puts every item answered on the same day back on the same
     day, so one heavy session echoes forward as a wall weeks later: 200 reviews
     on the Tuesday and 15 on the Wednesday. The interval is allowed to move a
     day or two — well inside the noise of the retention curve — to the emptiest
     day in that window.

     Ties go to the original day, so on a flat load this is a no-op. The exam
     clamp is applied FIRST and is never violated: levelling may only move an
     item to a day it was already allowed to be on. */
  function balanceDue(dueMs, exam, now, load, opts) {
    var base = clampDue(dueMs, exam, now);
    if (base - now < DAY) return base;                    /* learning step */
    var today = startOfDay(now);
    var baseDay = daysBetween(base, today);
    var room = (opts && opts.slideRoom != null) ? opts.slideRoom : slideRoom(baseDay);
    if (room <= 0 || !load) return base;

    var latestDay = exam
      ? daysBetween(exam.date - EXAM_BUFFER_DAYS * DAY, today)
      : Infinity;
    var best = baseDay, bestLoad = load[baseDay] == null ? 0 : load[baseDay];
    for (var d = baseDay - room; d <= baseDay + room; d++) {
      if (d < 1) continue;                                /* never earlier than tomorrow */
      if (d > latestDay) continue;                        /* never past the exam */
      var l = load[d] == null ? 0 : load[d];
      if (l < bestLoad || (l === bestLoad && Math.abs(d - baseDay) < Math.abs(best - baseDay))) {
        best = d; bestLoad = l;
      }
    }
    if (best === baseDay) return base;
    return base + (best - baseDay) * DAY;                 /* same time of day */
  }

  /* ── retrievability on a future day ──────────────────────────────────── */
  function predictR(sched, item, onMs) {
    if (!item.stability || !item.last_reviewed_at) return 0;
    return sched.retrievability(item.stability, Math.max(0, daysBetween(onMs, item.last_reviewed_at)));
  }

  /* An item counts as never seen if it has no scheduling state at all. A row
     that exists but was never graded is still unseen. */
  function neverSeen(item) {
    return !item.last_reviewed_at || !item.repetitions || item.state === 'new';
  }

  /* Failing = seen, and currently below the bar. Lapses alone are not enough:
     an item you failed once and have since relearned is not failing. */
  function isFailing(sched, item, now) {
    if (neverSeen(item)) return false;
    if (item.state === 'relearning') return true;
    return predictR(sched, item, now) < 0.5;
  }

  /* ══ readiness, per exam ══════════════════════════════════════════════ */
  function examReport(sched, items, units, exams, now, opts) {
    var threshold = (opts && opts.threshold) || READY_THRESHOLD;
    var today = startOfDay(now);
    return EXAMS.map(function (key) {
      var date = parseDate(exams[key]);
      var scope = items.filter(function (it) {
        return examsCovering(unitOf(it, units)).indexOf(key) > -1;
      });
      var onDay = date === null ? today : date;
      var ready = 0, unseen = 0, failing = 0;
      scope.forEach(function (it) {
        if (neverSeen(it)) { unseen++; return; }
        if (predictR(sched, it, onDay) >= threshold) ready++;
        if (isFailing(sched, it, now)) failing++;
      });
      return {
        key: key,
        label: key === 'final' ? 'Final' : (key === 'unit1' ? 'Unit 1 test' : 'Unit 2 test'),
        date: exams[key] || null,
        daysRemaining: date === null ? null : daysBetween(date, today),
        total: scope.length,
        ready: ready,
        readyPct: scope.length ? Math.round((ready / scope.length) * 100) : 0,
        neverSeen: unseen,
        failing: failing,
        threshold: threshold,
        /* the whole point of showing this from day one */
        isSet: date !== null,
        isPast: date !== null && date < today
      };
    });
  }

  /* ══ what must be seen before an exam, that FSRS would not surface ══════
     Two populations:
       - never seen at all, in scope for the exam
       - unit 1 material heading into the FINAL that has not been touched since
         the unit 1 test (the resurfacing rule)
     Both are coverage debt: FSRS has no opinion on the first, and would let
     the second drift past the comprehensive. */
  function coverageDebt(items, units, exams, now) {
    var today = startOfDay(now);
    var unit1Date = parseDate(exams.unit1);
    var finalDate = parseDate(exams.final);
    var out = [];
    items.forEach(function (it) {
      var unit = unitOf(it, units);
      var exam = nextExamFor(unit, exams, now);
      if (!exam) return;                       /* no dates set: plain FSRS */
      if (neverSeen(it)) { out.push({ item: it, why: 'never seen', exam: exam }); return; }
      if (unit === 1 && exam.key === 'final' && unit1Date !== null && finalDate !== null
          && startOfDay(it.last_reviewed_at) < unit1Date && finalDate >= today) {
        out.push({ item: it, why: 'not seen since the unit 1 test', exam: exam });
      }
    });
    return out;
  }

  /* Alternate between the kinds present, preserving each kind's own order.
     Proportional rather than strictly one-for-one, so 300 quiz questions and
     40 cards do not stall the quiz side waiting for a card to alternate with. */
  function interleaveKinds(rows, kindOf) {
    var buckets = {}, order = [];
    rows.forEach(function (r) {
      var k = kindOf(r);
      if (!buckets[k]) { buckets[k] = []; order.push(k); }
      buckets[k].push(r);
    });
    if (order.length < 2) return rows.slice();
    var total = rows.length, out = [], taken = {}, i;
    for (i = 0; i < order.length; i++) taken[order[i]] = 0;
    for (i = 0; i < total; i++) {
      /* take from whichever bucket is furthest behind its own share */
      var best = null, bestGap = -Infinity;
      for (var j = 0; j < order.length; j++) {
        var k = order[j];
        if (taken[k] >= buckets[k].length) continue;
        var share = buckets[k].length / total;
        var gap = share * (i + 1) - taken[k];
        if (gap > bestGap) { bestGap = gap; best = k; }
      }
      if (best === null) break;
      out.push(buckets[best][taken[best]++]);
    }
    return out;
  }

  /* ══ the day's queue ══════════════════════════════════════════════════
     Priority order, and the reasoning for it:
       1. coverage debt whose exam is closest — something unseen with a test in
          nine days beats anything already scheduled, because a scheduled item
          at least has state
       2. learning / relearning steps, which are within this sitting
       3. overdue review items, most overdue first
     Then cut to the working set. */
  function buildQueue(sched, items, units, exams, now, opts) {
    opts = opts || {};
    var st = Object.assign({}, DEFAULT_SETTINGS, opts.settings || {});
    var cap = opts.dailyCap || DAILY_CAP;
    var today = startOfDay(now);

    /* In the last week before an exam the sweep takes over: everything in that
       unit, spread across the days that remain, before anything else, and
       neither the new-item cap nor the daily ceiling trims it. */
    var sweep = sweepPlan(sched, items, units, exams, now);

    var debt = coverageDebt(items, units, exams, now);
    var debtIds = {};
    debt.forEach(function (d) { debtIds[d.item.kind + ':' + d.item.id] = d; });

    var dueAll = items.filter(function (it) {
      return it.due_date != null && it.due_date <= now;
    });

    /* How much of the debt has to be cleared TODAY to finish in time. Spread
       evenly over the days remaining rather than dumped on day one. */
    var debtToday = [];
    var byExam = {};
    debt.forEach(function (d) {
      (byExam[d.exam.key] || (byExam[d.exam.key] = { date: d.exam.date, rows: [] })).rows.push(d);
    });
    var perExamRate = {};
    Object.keys(byExam).forEach(function (k) {
      var g = byExam[k];
      var daysLeft = Math.max(1, daysBetween(g.date, today) - EXAM_BUFFER_DAYS + 1);
      /* the spread rate for RESURFACING only; new material is capped instead */
      var resurfaceRows = g.rows.filter(function (r) { return r.why !== 'never seen'; }).length;
      var rate = Math.ceil(resurfaceRows / daysLeft);
      perExamRate[k] = { needed: g.rows.length, daysLeft: daysLeft, perDay: rate,
                         resurfacing: resurfaceRows };
      /* never-seen first within an exam, then the resurfacing backlog */
      g.rows.sort(function (a, b) {
        if ((a.why === 'never seen') !== (b.why === 'never seen')) return a.why === 'never seen' ? -1 : 1;
        return (a.item.id || 0) - (b.item.id || 0);
      });
      /* Interleave flashcards and quiz questions. Sorting by id alone put every
         flashcard ahead of every quiz question, so a day's coverage was all
         cards and the quiz bank did not start moving until the cards ran out.
         The point is one schedule across BOTH, so both advance together. */
      var ordered = interleaveKinds(g.rows, function (r) { return r.item.kind; });

      /* TWO SEPARATE BUDGETS, which is the distinction that matters here.

         Starting NEW material is governed by the per-kind caps, full stop —
         they are what "20 new cards a day" means, and they do not bend to the
         spread rate. Whether that rate covers the syllabus in time is a
         different question, answered by newItemPlan and reported rather than
         silently enforced.

         RESURFACING is work already begun, not new material, so it is not
         capped by them; it is spread across the days remaining instead. */
      var used = { card: 0, quiz: 0 };
      var capFor = { card: st.newCardsPerDay, quiz: st.newQuizPerDay };
      var resurfaceBudget = rate;
      var picked = [];
      ordered.forEach(function (row) {
        if (row.why === 'never seen') {
          if (used[row.item.kind] >= capFor[row.item.kind]) return;
          used[row.item.kind]++;
        } else {
          if (resurfaceBudget <= 0) return;
          resurfaceBudget--;
        }
        picked.push(row);
      });
      perExamRate[k].introduced = { card: used.card, quiz: used.quiz };
      perExamRate[k].caps = { card: capFor.card, quiz: capFor.quiz };
      debtToday = debtToday.concat(picked);
    });
    /* closest exam wins when two exams both want the day */
    debtToday.sort(function (a, b) { return a.exam.date - b.exam.date; });

    var learning = dueAll.filter(function (it) {
      return (it.state === 'learning' || it.state === 'relearning')
        && !debtIds[it.kind + ':' + it.id];
    });
    var review = dueAll.filter(function (it) {
      return it.state === 'review' && !debtIds[it.kind + ':' + it.id];
    }).sort(function (a, b) { return a.due_date - b.due_date; });

    /* Sweep items go in front of everything, including coverage debt: inside
       the window the sweep IS the coverage rule, and a wider one. */
    var head = sweep.active ? sweep.todayList : [];
    var allOrdered = head
      .concat(debtToday.map(function (d) { return d.item; }))
      .concat(learning, review);

    /* de-dupe while preserving priority order */
    var seen = {}, queue = [];
    allOrdered.forEach(function (it) {
      var k = it.kind + ':' + it.id;
      if (seen[k]) return;
      seen[k] = 1;
      queue.push(it);
    });

    var split = function (arr, kind) { return arr.filter(function (i) { return i.kind === kind; }); };
    /* During a sweep the working set is whatever the sweep needs — showing 40
       of 90 and calling it the day would be the quiet trimming this is meant to
       avoid. Outside one, the cap holds. */
    var effectiveCap = sweep.active ? Math.max(cap, head.length) : cap;
    var shown = queue.slice(0, effectiveCap);
    return {
      queue: shown,
      cap: effectiveCap,
      requestedCap: cap,
      sweep: sweep,
      settings: st,
      totalDue: dueAll.length,
      totalQueued: queue.length,
      counts: {
        newItems: queue.filter(neverSeen).length,
        learning: queue.filter(function (i) { return !neverSeen(i) && (i.state === 'learning' || i.state === 'relearning'); }).length,
        due: queue.filter(function (i) { return !neverSeen(i) && i.state === 'review'; }).length,
        cards: split(queue, 'card').length,
        quiz: split(queue, 'quiz').length
      },
      shownCounts: {
        cards: split(shown, 'card').length,
        quiz: split(shown, 'quiz').length
      },
      coverage: perExamRate
    };
  }

  /* ══ the sweep ═════════════════════════════════════════════════════════
     The last SWEEP_DAYS before an exam, where the requirement stops being
     "retain what you have seen" and becomes "have seen all of it". Every item
     in the exam's scope is covered at least once inside the window, whatever
     the scheduler would otherwise have said.

     Coverage is measured from the window's start, not from all time: an item
     reviewed three weeks ago has not been swept.

     This overrides the new-item cap and the daily ceiling both. If that means
     ninety items in a day, the honest thing is to show ninety. */
  function sweepLabel(key) {
    return key === 'final' ? 'Final' : (key === 'unit1' ? 'Unit 1' : 'Unit 2');
  }

  function sweepPlan(sched, items, units, exams, now) {
    var today = startOfDay(now);

    /* EVERY open window, not just the nearest. With the Unit 2 test and the
       Final less than a week apart their windows overlap, and reporting only
       the nearer one hid the Final's sweep — all 460 items — until the day the
       Unit 2 test passed, at which point it appeared demanding 115 a day with
       four days left. That is the surprise this is meant to prevent. */
    var open = [];
    EXAMS.forEach(function (key) {
      var date = parseDate(exams[key]);
      if (date === null || date < today) return;
      var remaining = daysBetween(date, today);
      if (remaining > SWEEP_DAYS || remaining < 0) return;
      open.push({ key: key, date: date, daysRemaining: remaining });
    });
    if (!open.length) return { active: false, overlap: false, windows: [] };
    open.sort(function (a, b) { return a.date - b.date; });

    var rank = function (it) {
      if (neverSeen(it)) return 0;
      if (isFailing(sched, it, now)) return 1;
      return 2;
    };
    var byUrgency = function (a, b) {
      var d = rank(a) - rank(b);
      if (d) return d;
      return predictR(sched, a, today) - predictR(sched, b, today);
    };

    /* An item in scope for two open windows only has to be SEEN once to
       satisfy both, so it is assigned to the earlier deadline and counted
       there. Otherwise the combined daily figure double-counts every unit 2
       card during an overlap and reads as far more work than there is. */
    var assigned = {};
    open.forEach(function (w) { assigned[w.key] = { covered: [], remaining: [] }; });
    items.forEach(function (it) {
      var covers = examsCovering(unitOf(it, units));
      var w = null;
      for (var i = 0; i < open.length; i++) {
        if (covers.indexOf(open[i].key) > -1) { w = open[i]; break; }
      }
      if (!w) return;
      var start = w.date - SWEEP_DAYS * DAY;
      var seen = it.last_reviewed_at != null && startOfDay(it.last_reviewed_at) >= start;
      assigned[w.key][seen ? 'covered' : 'remaining'].push(it);
    });

    var windows = open.map(function (w) {
      var a = assigned[w.key];
      a.remaining.sort(byUrgency);
      var daysLeft = Math.max(1, w.daysRemaining);
      var perDay = Math.ceil(a.remaining.length / daysLeft);
      return {
        key: w.key, label: sweepLabel(w.key), date: exams[w.key],
        daysRemaining: w.daysRemaining,
        day: Math.min(SWEEP_DAYS, SWEEP_DAYS - w.daysRemaining + 1),
        totalDays: SWEEP_DAYS,
        total: a.covered.length + a.remaining.length,
        covered: a.covered.length,
        remaining: a.remaining.length,
        perDay: perDay,
        neverSeen: a.remaining.filter(neverSeen).length,
        failing: a.remaining.filter(function (it) { return isFailing(sched, it, now); }).length,
        todayList: a.remaining.slice(0, perDay)
      };
    });

    var primary = windows[0];
    /* today's work is every open window's share, nearest deadline first */
    var todayList = [], seenIds = {};
    windows.forEach(function (w) {
      w.todayList.forEach(function (it) {
        var k = it.kind + ':' + it.id;
        if (seenIds[k]) return;
        seenIds[k] = 1;
        todayList.push(it);
      });
    });
    var sum = function (f) {
      return windows.reduce(function (a, w) { return a + f(w); }, 0);
    };

    /* Backward compatible: the primary window's numbers stay at the top level,
       with the whole picture beside them. */
    return Object.assign({}, primary, {
      active: true,
      windows: windows,
      overlap: windows.length > 1,
      others: windows.slice(1),
      combined: {
        perDay: sum(function (w) { return w.perDay; }),
        remaining: sum(function (w) { return w.remaining; }),
        total: sum(function (w) { return w.total; }),
        covered: sum(function (w) { return w.covered; }),
        neverSeen: sum(function (w) { return w.neverSeen; })
      },
      todayList: todayList
    });
  }

  /* ══ does the new-item rate actually cover the material in time ════════
     The cap and the exam date can disagree, and a cap that is silently
     respected while the runway runs out is worse than no cap at all. Per kind,
     because the two have separate caps and separate banks. */
  function newItemPlan(items, units, exams, now, settings) {
    var st = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var today = startOfDay(now);
    var out = [];
    EXAMS.forEach(function (key) {
      var date = parseDate(exams[key]);
      if (date === null || date < today) return;
      /* Days on which new material can still be started. The sweep window is
         excluded: nothing new is begun in it. */
      var daysToExam = Math.max(0, daysBetween(date, today) - EXAM_BUFFER_DAYS + 1);
      var days = Math.max(0, daysToExam - SWEEP_DAYS);
      var scope = items.filter(function (it) {
        return examsCovering(unitOf(it, units)).indexOf(key) > -1;
      });
      [['card', st.newCardsPerDay, 'flashcards'], ['quiz', st.newQuizPerDay, 'quiz questions']]
        .forEach(function (row) {
          var kind = row[0], cap = row[1], noun = row[2];
          var unseen = scope.filter(function (it) { return it.kind === kind && neverSeen(it); }).length;
          if (!unseen) return;
          /* Inside the sweep window there are no days left to start new
             material on, so there is no rate that fixes anything — "you need
             316/day" is not advice, it is arithmetic noise. The sweep is the
             mechanism at that point and it reports its own real number. */
          if (days <= 0) return;
          /* the sweep will cover whatever is left, so "covered in time" means
             covered by the cap OR mopped up by the sweep — but arriving at the
             sweep with a backlog is exactly the failure worth naming */
          var willSee = Math.min(unseen, cap * days);
          var need = days > 0 ? Math.ceil(unseen / days) : unseen;
          out.push({
            exam: key, kind: kind, noun: noun,
            cap: cap, unseen: unseen, days: days,
            daysToExam: daysToExam,
            willSee: willSee,
            shortfall: Math.max(0, unseen - willSee),
            needPerDay: need,
            ok: willSee >= unseen
          });
        });
    });
    /* nearest exam first, worst shortfall first */
    out.sort(function (a, b) { return a.daysToExam - b.daysToExam || b.shortfall - a.shortfall; });
    return out;
  }

  /* ══ am I behind ══════════════════════════════════════════════════════
     Compares the work each exam actually requires against the pace of the last
     fortnight. Required work is the coverage debt plus everything already
     scheduled to fall due before the exam — the reviews that have to happen,
     not a guess. */
  function projection(sched, items, units, exams, now, recentPacePerDay) {
    var today = startOfDay(now);
    return EXAMS.map(function (key) {
      var date = parseDate(exams[key]);
      if (date === null || date < today) return { key: key, isSet: date !== null, applicable: false };
      var daysLeft = Math.max(1, daysBetween(date, today) - EXAM_BUFFER_DAYS + 1);
      var scope = items.filter(function (it) {
        return examsCovering(unitOf(it, units)).indexOf(key) > -1;
      });
      var unseen = scope.filter(neverSeen).length;
      var dueBefore = scope.filter(function (it) {
        return !neverSeen(it) && it.due_date != null && it.due_date <= date;
      }).length;
      var work = unseen + dueBefore;
      var needPerDay = Math.ceil(work / daysLeft);
      var pace = Math.max(0, Math.round(recentPacePerDay || 0));
      return {
        key: key, isSet: true, applicable: true,
        daysLeft: daysLeft, neverSeen: unseen, reviewsDue: dueBefore,
        totalWork: work, needPerDay: needPerDay, recentPace: pace,
        behind: pace > 0 ? needPerDay > pace : work > 0,
        /* honest about the case where there is no pace to compare against */
        noPaceData: !(recentPacePerDay > 0),
        finishesInTime: pace > 0 && needPerDay <= pace
      };
    });
  }

  /* ══ weakest objectives ═══════════════════════════════════════════════ */
  function weakestObjectives(sched, items, units, exams, now, limit) {
    var today = startOfDay(now);
    var byObj = {};
    items.forEach(function (it) {
      (it.objectiveIds || []).forEach(function (oid) {
        var g = byObj[oid] || (byObj[oid] = { objective_id: oid, total: 0, unseen: 0, rSum: 0, failing: 0, unit: units[oid] || 1 });
        g.total++;
        if (neverSeen(it)) { g.unseen++; return; }
        g.rSum += predictR(sched, it, today);
        if (isFailing(sched, it, now)) g.failing++;
      });
    });
    return Object.keys(byObj).map(function (k) {
      var g = byObj[k];
      /* unseen items count as R=0 — an objective you have never opened is not
         strong just because its two answered items went well */
      g.meanR = g.total ? g.rSum / g.total : 0;
      g.pct = Math.round(g.meanR * 100);
      return g;
    }).filter(function (g) { return g.total > 0; })
      .sort(function (a, b) { return a.meanR - b.meanR || b.total - a.total; })
      .slice(0, limit || 6);
  }

  /* ══ cram ═════════════════════════════════════════════════════════════
     For the last days before a test: scheduling is irrelevant, everything in
     the unit gets drilled, ordered by how badly it is going. */
  function cramQueue(sched, items, units, unit, now) {
    var today = startOfDay(now);
    var scope = unit === 'all'
      ? items.slice()
      : items.filter(function (it) { return unitOf(it, units) === unit; });
    return scope.map(function (it) {
      var unseen = neverSeen(it);
      /* lower score = drill sooner. Never-seen sorts ahead of everything,
         then weakest recall, with lapses breaking ties toward the ones that
         keep collapsing. */
      var score = unseen ? -1 : predictR(sched, it, today) - Math.min(0.25, (it.lapses || 0) * 0.05);
      return { item: it, score: score, unseen: unseen };
    }).sort(function (a, b) { return a.score - b.score; })
      .map(function (r) { return r.item; });
  }

  /* ══ one call for the dashboard ═══════════════════════════════════════ */
  function buildPlan(input) {
    var sched = input.scheduler || new FSRS.Scheduler();
    var now = input.now == null ? Date.now() : input.now;
    var items = input.items || [];
    var units = input.units || {};
    var exams = input.exams || {};
    var st = Object.assign({}, DEFAULT_SETTINGS, input.settings || {});
    return {
      now: now,
      settings: st,
      exams: examReport(sched, items, units, exams, now, input),
      queue: buildQueue(sched, items, units, exams, now,
        Object.assign({}, input, { settings: st })),
      projection: projection(sched, items, units, exams, now, input.recentPacePerDay),
      weakest: weakestObjectives(sched, items, units, exams, now, input.weakestLimit),
      forecast: forecast(items, now, input.forecastDays || 14, st.dailyCeiling),
      newItems: newItemPlan(items, units, exams, now, st),
      sweep: sweepPlan(sched, items, units, exams, now),
      anyExamSet: EXAMS.some(function (k) { return !!parseDate(exams[k]); })
    };
  }

  return {
    buildPlan: buildPlan,
    buildQueue: buildQueue,
    forecast: forecast,
    compressToRunway: compressToRunway,
    runwayDays: runwayDays,
    COMPRESSION_EXPONENT: COMPRESSION_EXPONENT,
    loadHistogram: loadHistogram,
    balanceDue: balanceDue,
    slideRoom: slideRoom,
    sweepPlan: sweepPlan,
    newItemPlan: newItemPlan,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SWEEP_DAYS: SWEEP_DAYS,
    examReport: examReport,
    projection: projection,
    weakestObjectives: weakestObjectives,
    coverageDebt: coverageDebt,
    cramQueue: cramQueue,
    clampDue: clampDue,
    nextExamFor: nextExamFor,
    examsCovering: examsCovering,
    unitOf: unitOf,
    predictR: predictR,
    neverSeen: neverSeen,
    parseDate: parseDate,
    startOfDay: startOfDay,
    daysBetween: daysBetween,
    EXAMS: EXAMS,
    READY_THRESHOLD: READY_THRESHOLD,
    DAILY_CAP: DAILY_CAP,
    EXAM_BUFFER_DAYS: EXAM_BUFFER_DAYS
  };
}));
