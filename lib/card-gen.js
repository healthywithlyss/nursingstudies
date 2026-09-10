/* ══════════════════════════════════════════════════════════════════════════
   CARDS FROM MISSED QUESTIONS

   A missed quiz question is not a question problem, it is a knowledge gap, and
   gaps are what flashcards are for. So a miss proposes a card.

   NOTHING IS INVENTED. Looking at the real bank first settled the design: all
   316 NUR144 questions have a fact_tested, all 316 facts are distinct, not one
   stem is "which of the following"-shaped, and 313 of 316 already end in a
   question mark. The stems ARE real questions asking for exactly the fact:

     "Which term describes painful swallowing?"
        -> odynophagia = painful swallowing; dysphagia = difficulty swallowing

   So the front is the stem, the back is fact_tested, and the explanation is the
   question's own explanation, which already carries the reasoning and the
   distractor logic. Writing a language model into this path would replace
   something already good with something that needs checking.

   A suggestion is never a card until it is accepted.
   ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardGen = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Words that carry no meaning for a duplicate check. */
  var STOP = ('a an and are as at be but by for from has have in is it its of on or that the to'
    + ' was were will with which who this these those not no can may do does what when how why'
    + ' patient nurse must should').split(' ');
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w] = 1; });

  function words(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).filter(function (w) { return w.length > 2 && !STOPSET[w]; });
  }

  /* Jaccard over content words. Cheap, and good enough to catch "the same fact
     worded differently", which is the case that matters. */
  function similarity(a, b) {
    var A = {}, n = 0, hit = 0;
    words(a).forEach(function (w) { if (!A[w]) { A[w] = 1; n++; } });
    var B = {}, m = 0;
    words(b).forEach(function (w) { if (!B[w]) { B[w] = 1; m++; } });
    if (!n || !m) return 0;
    Object.keys(A).forEach(function (w) { if (B[w]) hit++; });
    return hit / (n + m - hit);
  }

  /* Above this, two texts are treated as the same fact. Set by hand against the
     real bank: distinct facts in it score well below 0.5, and a reworded
     duplicate scores well above. */
  var DUPLICATE_AT = 0.6;

  /* The draft. `question` is a quiz_questions row. */
  function draft(question, course) {
    var stem = String(question.stem || '').trim();
    var fact = String(question.fact_tested || '').trim();
    if (!fact) return null;
    /* A stem that is not a question is not a card front; fall back to asking
       for the fact directly rather than shipping a statement as a prompt. */
    var front = /\?\s*$/.test(stem) && stem.length > 8
      ? stem
      : 'What do you need to know about: ' + firstClause(fact) + '?';
    return {
      question_id: question.id,
      course: course,
      objective_ids: question.objective_id ? [question.objective_id] : [],
      fact_tested: fact,
      front: front,
      back: capitalise(fact),
      explanation: String(question.explanation || '').trim() || null
    };
  }

  function firstClause(s) {
    var t = String(s).split(/[;—,]/)[0].trim();
    return t.length > 4 ? t : String(s).trim();
  }
  function capitalise(s) {
    var t = String(s).trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  }

  /* Would this be a duplicate?

     Three ways it can be, and all three are checked because they fail
     differently: the same question proposing twice, a card already generated
     from it, and a hand-written card that already covers the fact. */
  function findDuplicate(d, opts) {
    opts = opts || {};
    var existingSuggestions = opts.suggestions || [];
    var cards = opts.cards || [];

    for (var i = 0; i < existingSuggestions.length; i++) {
      if (existingSuggestions[i].question_id === d.question_id) {
        return { reason: 'already proposed from this question',
                 status: existingSuggestions[i].status, suggestion: existingSuggestions[i] };
      }
    }
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      if (c.source_question_id && c.source_question_id === d.question_id) {
        return { reason: 'a card was already generated from this question', card: c };
      }
    }
    /* only compare against cards sharing an objective — a fact in another
       lecture that happens to use the same words is not a duplicate */
    for (var k = 0; k < cards.length; k++) {
      var card = cards[k];
      var shares = (card.objective_ids || []).some(function (o) {
        return d.objective_ids.indexOf(o) > -1;
      });
      if (!shares) continue;
      var sim = Math.max(similarity(card.answer, d.back), similarity(card.question, d.front));
      if (sim >= DUPLICATE_AT) {
        return { reason: 'an existing card already covers this fact', card: card,
                 similarity: Math.round(sim * 100) / 100 };
      }
    }
    return null;
  }

  /* One call: what should happen when this question is missed. */
  function propose(question, course, opts) {
    var d = draft(question, course);
    if (!d) return { ok: false, reason: 'the question has no fact_tested to build from' };
    var dup = findDuplicate(d, opts);
    if (dup) return { ok: false, duplicate: dup, reason: dup.reason, draft: d };
    return { ok: true, draft: d };
  }

  return {
    draft: draft,
    propose: propose,
    findDuplicate: findDuplicate,
    similarity: similarity,
    DUPLICATE_AT: DUPLICATE_AT
  };
}));
