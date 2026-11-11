/* Row-level sync helpers for たびわり's shared trips: flatten a trip into rows, diff two snapshots into ops, assemble rows back into a trip.
   Pure functions; tested in test/sync.test.js. Used by share.js's callers in index.html (the server side is worker/index.js). */
(function (root) {
  'use strict';
  var ORDER = ['trips', 'members', 'expenses', 'settlements', 'adjustments', 'paid', 'savings'];
  var KEYS = { trips: ['id'], members: ['id'], expenses: ['id'], settlements: ['trip_id', 'id'], adjustments: ['trip_id', 'id'], paid: ['trip_id', 'key'], savings: ['trip_id', 'member_id'] };
  /* settlements are written once; an adjustment only ever gets its settle_id filled in (when a round is confirmed) */
  var UPDATABLE = { trips: true, expenses: true, savings: true, adjustments: true, members: false, paid: false, settlements: false };

  function empty() { return { trips: {}, members: {}, expenses: {}, settlements: {}, adjustments: {}, paid: {}, savings: {} }; }

  /* app state (trips[]) -> row maps keyed by primary key */
  function flatten(trips) {
    var out = empty();
    trips.forEach(function (t) {
      out.trips[t.id] = { id: t.id, name: t.name, start_date: t.start, end_date: t.end, budget: t.budget };
      var ids = {};
      t.members.forEach(function (m, i) {
        ids[m.id] = 1;
        out.members[m.id] = { id: m.id, trip_id: t.id, name: m.name, position: m.pos != null ? m.pos : i,
          user_id: m.userId || null, status: m.userId ? 'joined' : 'invited' };
      });
      t.expenses.forEach(function (e) {
        out.expenses[e.id] = { id: e.id, trip_id: t.id, title: e.title || '', amount: e.amount, payer: e.payer, cat: e.cat, spent_on: e.date, split: e.split.slice(), settle_id: e.settleId || null };
      });
      (t.settlements || []).forEach(function (st, i) {
        out.settlements[t.id + '|' + st.id] = { id: st.id, trip_id: t.id, n: st.n != null ? st.n : i + 1, at: st.at, total: st.total || 0,
          transfers: (st.transfers || []).map(function (x) { return { from: x.from, to: x.to, amount: x.amount }; }) };
      });
      (t.adjustments || []).forEach(function (a) {
        out.adjustments[t.id + '|' + a.id] = { id: a.id, trip_id: t.id, settle_id: a.settleId || null, nets: Object.assign({}, a.nets), note: a.note || '', at: a.at };
      });
      Object.keys(t.paid || {}).forEach(function (k) { if (t.paid[k]) out.paid[t.id + '|' + k] = { trip_id: t.id, key: k }; });
      Object.keys(t.savings || {}).forEach(function (mid) {
        if (ids[mid]) out.savings[t.id + '|' + mid] = { trip_id: t.id, member_id: mid, amount: t.savings[mid] };
      });
    });
    return out;
  }

  /* ordered operations that turn `prev` into `next`: inserts (parents first), updates, deletes (children first) */
  function diff(prev, next) {
    prev = prev || empty();
    var ins = [], upd = [], del = [], gone = {};
    Object.keys(prev.trips).forEach(function (id) { if (!next.trips[id]) gone[id] = true; });
    ORDER.forEach(function (tb) {
      var rows = [];
      Object.keys(next[tb]).forEach(function (k) {
        var r = next[tb][k], p = prev[tb][k];
        if (!p) rows.push(r);
        else if (UPDATABLE[tb] && JSON.stringify(p) !== JSON.stringify(r)) upd.push({ kind: 'update', table: tb, row: r });
      });
      if (rows.length) ins.push({ kind: 'insert', table: tb, rows: rows });
    });
    ORDER.slice().reverse().forEach(function (tb) {
      Object.keys(prev[tb]).forEach(function (k) {
        if (next[tb][k]) return;
        var r = prev[tb][k];
        if (tb !== 'trips' && gone[r.trip_id]) return;   // removed by ON DELETE CASCADE
        del.push({ kind: 'delete', table: tb, row: r });
      });
    });
    return ins.concat(upd, del);
  }

  /* nested select result -> app state trips[] */
  function assemble(rows) {
    return (rows || []).map(function (r) {
      var members = (r.trip_members || []).slice().sort(function (a, b) { return a.position - b.position || (a.id < b.id ? -1 : 1); })
        .map(function (m) { return { id: m.id, name: m.name, pos: m.position, userId: m.user_id || undefined, pending: m.status !== 'joined' }; });
      var expenses = (r.expenses || []).slice().sort(function (a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1); })
        .map(function (e) { var x = { id: e.id, title: e.title, amount: e.amount, payer: e.payer, cat: e.cat, date: e.spent_on, split: e.split }; if (e.settle_id) x.settleId = e.settle_id; return x; });
      var settlements = (r.settlements || []).slice().sort(function (a, b) { return a.n - b.n || (a.id < b.id ? -1 : 1); })
        .map(function (st) { return { id: st.id, n: st.n, at: st.at, total: st.total || 0, transfers: st.transfers || [] }; });
      var adjustments = (r.adjustments || []).slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id < b.id ? -1 : 1); })
        .map(function (a) { return { id: a.id, settleId: a.settle_id || null, nets: a.nets || {}, note: a.note || '', at: a.at }; });
      var paid = {}, savings = {};
      (r.paid || []).forEach(function (p) { paid[p.key] = true; });
      (r.savings || []).forEach(function (s) { savings[s.member_id] = s.amount; });
      return { id: r.id, name: r.name, start: r.start_date, end: r.end_date, budget: r.budget, owner: r.owner, members: members, expenses: expenses, settlements: settlements, adjustments: adjustments, paid: paid, savings: savings };
    });
  }

  var Sync = { flatten: flatten, diff: diff, assemble: assemble, empty: empty };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Sync; return; }
  root.Sync = Sync;
})(typeof window !== 'undefined' ? window : globalThis);
