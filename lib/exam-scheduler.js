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
    var cap = opts.dailyCap || DAILY_CAP;
    var today = startOfDay(now);

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
      var rate = Math.ceil(g.rows.length / daysLeft);
      perExamRate[k] = { needed: g.rows.length, daysLeft: daysLeft, perDay: rate };
      /* never-seen first within an exam, then the resurfacing backlog */
      g.rows.sort(function (a, b) {
        if ((a.why === 'never seen') !== (b.why === 'never seen')) return a.why === 'never seen' ? -1 : 1;
        return (a.item.id || 0) - (b.item.id || 0);
      });
      /* Interleave flashcards and quiz questions. Sorting by id alone put every
         flashcard ahead of every quiz question, so a day's coverage was all
         cards and the quiz bank did not start moving until the cards ran out.
         The point is one schedule across BOTH, so both advance together. */
      debtToday = debtToday.concat(interleaveKinds(g.rows, function (r) { return r.item.kind; })
        .slice(0, rate));
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

    var ordered = debtToday.map(function (d) { return d.item; })
      .concat(learning, review);

    /* de-dupe while preserving priority order */
    var seen = {}, queue = [];
    ordered.forEach(function (it) {
      var k = it.kind + ':' + it.id;
      if (seen[k]) return;
      seen[k] = 1;
      queue.push(it);
    });

    var split = function (arr, kind) { return arr.filter(function (i) { return i.kind === kind; }); };
    var shown = queue.slice(0, cap);
    return {
      queue: shown,
      cap: cap,
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
    return {
      now: now,
      exams: examReport(sched, items, units, exams, now, input),
      queue: buildQueue(sched, items, units, exams, now, input),
      projection: projection(sched, items, units, exams, now, input.recentPacePerDay),
      weakest: weakestObjectives(sched, items, units, exams, now, input.weakestLimit),
      anyExamSet: EXAMS.some(function (k) { return !!parseDate(exams[k]); })
    };
  }

  return {
    buildPlan: buildPlan,
    buildQueue: buildQueue,
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
