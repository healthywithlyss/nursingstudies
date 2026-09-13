/* Objectives as a tree: course -> lecture -> objective.

   The ids carry the shape: N144_L1 is a lecture, N144_L1_O4 is objective 4 of
   that lecture, N144_SKILLS is a lecture with no objectives. Names come from
   the objectives table (lecture, description) — never from a map in code, so a
   new objective needs no edit here. A card may carry both its lecture tag and
   an objective tag; every count in this file is per NODE and counts a card
   once, and a selection of "lecture plus one of its objectives" matches such a
   card once, not twice.

   Pure: no DOM, no fetch. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ObjectiveTree = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var OBJ_RE = /_O(\d+)$/;

  /* N144_L1_O4 -> N144_L1; a lecture (no _On suffix) -> null */
  function parentOf(id) {
    if (!id) return null;
    var p = String(id).replace(OBJ_RE, '');
    return p === id ? null : p;
  }
  function lectureOf(id) { return parentOf(id) || id; }
  function objectiveNum(id) { var m = OBJ_RE.exec(String(id || '')); return m ? Number(m[1]) : null; }

  /* does an item with these tags fall inside a selection of node ids?
     sel null/empty = everything. A lecture in the selection covers the cards
     that carry the lecture tag; an objective covers the cards that carry it. */
  function matches(tags, sel) {
    if (!sel || !sel.length) return true;
    var t = tags || [];
    for (var i = 0; i < t.length; i++) if (sel.indexOf(t[i]) > -1) return true;
    return false;
  }

  function shortDesc(desc) {
    var s = String(desc || '');
    var cut = s.indexOf(' - ');
    if (cut > -1) s = s.slice(cut + 3);
    if (s.length > 48) s = s.slice(0, 45).replace(/\s+\S*$/, '') + '…';
    return s;
  }
  function derivedName(id) {
    var m = /_L(\d+)$/.exec(id || '');
    if (m) return 'Lecture ' + m[1];
    if (/SKILLS/i.test(id || '')) return 'Skills';
    return String(id || '');
  }

  /* rows: [{id, lecture, description}] from the objectives table.
     opts.ids: ids seen in content that may have no row (still get a node).
     opts.units: {id: unit} — objectives inherit their lecture's unit.
     opts.filter: fn(id) -> bool, e.g. one course's prefix. */
  function build(rows, opts) {
    opts = opts || {};
    var rowById = {};
    (rows || []).forEach(function (r) { if (r && r.id) rowById[r.id] = r; });
    var ids = {};
    Object.keys(rowById).forEach(function (id) { ids[id] = 1; });
    (opts.ids || []).forEach(function (id) { if (id) ids[id] = 1; });
    var keep = Object.keys(ids).filter(function (id) { return !opts.filter || opts.filter(id); });
    /* every objective's lecture exists as a node even without a row */
    keep.forEach(function (id) { var p = parentOf(id); if (p && !ids[p] && (!opts.filter || opts.filter(p))) { ids[p] = 1; keep.push(p); } });
    keep = keep.filter(function (id, i) { return keep.indexOf(id) === i; });

    var units = opts.units || {};
    var byId = {};
    function labelFor(id) {
      var r = rowById[id] || {};
      var num = objectiveNum(id);
      if (num != null) {
        var desc = String(r.description || '').trim();
        return { name: 'Objective ' + num, num: num, sub: desc, full: desc || String(r.lecture || id) };
      }
      return { name: String(r.lecture || '').trim() || derivedName(id), num: null,
               sub: shortDesc(r.description), full: String(r.description || '') };
    }
    keep.forEach(function (id) {
      var lab = labelFor(id);
      byId[id] = { id: id, parent: parentOf(id), name: lab.name, num: lab.num, sub: lab.sub, full: lab.full,
                   objectives: [], unit: null };
    });
    Object.keys(byId).forEach(function (id) {
      var n = byId[id];
      n.unit = units[id] != null ? units[id] : (n.parent && units[n.parent] != null ? units[n.parent] : null);
      if (n.parent && byId[n.parent]) byId[n.parent].objectives.push(n);
    });
    var lectures = Object.keys(byId).filter(function (id) { return !byId[id].parent; })
      .map(function (id) { return byId[id]; })
      .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    lectures.forEach(function (l) { l.objectives.sort(function (a, b) { return (a.num || 0) - (b.num || 0) || (a.id < b.id ? -1 : 1); }); });

    var tree = {
      lectures: lectures,
      byId: byId,
      has: function (id) { return !!byId[id]; },
      isLecture: function (id) { return !!byId[id] && !byId[id].parent; },
      parentOf: parentOf,
      lectureOf: lectureOf,
      unitOf: function (id) { var n = byId[id]; return n ? n.unit : (units[id] != null ? units[id] : null); },
      label: function (id) {
        var n = byId[id];
        if (n) return { name: n.name, sub: n.sub, full: n.full };
        var l = labelFor(id); return { name: l.name, sub: l.sub, full: l.full };
      },
      /* nodes of a selection: the lecture ids and objective ids named, no expansion —
         matches() already covers a lecture's cards through the lecture tag */
      stats: function (items, fns) { return stats(tree, items, fns); }
    };
    return tree;
  }

  /* Per-node counts over items ({id, objectiveIds}), each item counted once
     per node. A lecture node counts an item that carries the lecture tag OR
     any of its objectives' tags. fns: {seen(item), failing(item), isNew(item)}. */
  function stats(tree, items, fns) {
    fns = fns || {};
    var out = {};
    var seenIn = {};   /* node -> {itemId: 1} */
    function bump(node, it) {
      var s = seenIn[node] || (seenIn[node] = {});
      if (s[it.id]) return;
      s[it.id] = 1;
      var o = out[node] || (out[node] = { cards: 0, seen: 0, failing: 0, newLeft: 0 });
      o.cards++;
      var isNew = fns.isNew ? fns.isNew(it) : false;
      if (isNew) o.newLeft++;
      if (fns.seen ? fns.seen(it) : !isNew) o.seen++;
      if (fns.failing && fns.failing(it)) o.failing++;
    }
    (items || []).forEach(function (it) {
      (it.objectiveIds || []).forEach(function (tag) {
        bump(tag, it);
        var p = parentOf(tag);
        if (p) bump(p, it);
      });
    });
    return out;
  }

  return { build: build, parentOf: parentOf, lectureOf: lectureOf, objectiveNum: objectiveNum,
           matches: matches, stats: stats, shortDesc: shortDesc };
}));
