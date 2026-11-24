/* Row-level sync helpers for Tabiflow's shared trips: flatten a trip into rows, diff two snapshots into ops, assemble rows back into a trip.
   Pure functions; tested in test/sync.test.js. Used by share.js's callers in index.html (the server side is worker/index.js). */
(function (root) {
  'use strict';
  var ORDER = ['trips', 'members', 'expenses', 'settlements', 'adjustments', 'paid', 'received', 'savings'];
  var KEYS = { trips: ['id'], members: ['id'], expenses: ['id'], settlements: ['trip_id', 'id'], adjustments: ['trip_id', 'id'], paid: ['trip_id', 'key'], received: ['trip_id', 'key'], savings: ['trip_id', 'member_id'] };
  /* settlements are written once; an adjustment only ever gets its settle_id filled in (when a round is confirmed) */
  var UPDATABLE = { trips: true, expenses: true, savings: true, adjustments: true, members: true, paid: false, received: false, settlements: false };

  function empty() { return { trips: {}, members: {}, expenses: {}, settlements: {}, adjustments: {}, paid: {}, received: {}, savings: {} }; }

  /* app state (trips[]) -> row maps keyed by primary key */
  function flatten(trips) {
    var out = empty();
    trips.forEach(function (t) {
      out.trips[t.id] = { id: t.id, name: t.name, start_date: t.start, end_date: t.end, budget: t.budget };
      if (t.caps && Object.keys(t.caps).length) out.trips[t.id].caps = Object.assign({}, t.caps);   // カテゴリごとの上限: only when set, so rows saved before it existed still compare equal
      var ids = {};
      t.members.forEach(function (m, i) {
        ids[m.id] = 1;
        out.members[m.id] = { id: m.id, trip_id: t.id, name: m.name, position: m.pos != null ? m.pos : i,
          user_id: m.userId || null, status: m.userId ? 'joined' : 'invited' };
        if (m.note) out.members[m.id].note = m.note;   // 受け取り方のメモ: only when set, so rows saved before it existed still compare equal
      });
      t.expenses.forEach(function (e) {
        out.expenses[e.id] = { id: e.id, trip_id: t.id, title: e.title || '', amount: e.amount, payer: e.payer, cat: e.cat, spent_on: e.date, split: e.split.slice(), settle_id: e.settleId || null };
        if (e.fixed) out.expenses[e.id].fixed = Object.assign({}, e.fixed);   // 金額の指定: only when set, like the weights
        if (e.parts) out.expenses[e.id].parts = Object.assign({}, e.parts);   // only when set, so rows of trips saved before weights existed still compare equal
        if (e.author) out.expenses[e.id].author = e.author;   // 変更履歴: only when set, so rows saved before it existed still compare equal (an older server / app never sees them)
        if (e.madeAt) out.expenses[e.id].made_at = e.madeAt;
        if (e.editor) out.expenses[e.id].editor = e.editor;
        if (e.editedAt) out.expenses[e.id].edited_at = e.editedAt;
        if (e.prev) out.expenses[e.id].prev = { amount: e.prev.amount, payer: e.prev.payer, split: e.prev.split.slice() };
      });
      (t.settlements || []).forEach(function (st, i) {
        out.settlements[t.id + '|' + st.id] = { id: st.id, trip_id: t.id, n: st.n != null ? st.n : i + 1, at: st.at, total: st.total || 0,
          transfers: (st.transfers || []).map(function (x) { return { from: x.from, to: x.to, amount: x.amount }; }) };
      });
      (t.adjustments || []).forEach(function (a) {
        out.adjustments[t.id + '|' + a.id] = { id: a.id, trip_id: t.id, settle_id: a.settleId || null, nets: Object.assign({}, a.nets), note: a.note || '', at: a.at };
      });
      Object.keys(t.paid || {}).forEach(function (k) { if (t.paid[k]) out.paid[t.id + '|' + k] = { trip_id: t.id, key: k }; });
      Object.keys(t.received || {}).forEach(function (k) { if (t.received[k]) out.received[t.id + '|' + k] = { trip_id: t.id, key: k }; });   // the receiver's "受け取った" (an older app never sends this table)
      Object.keys(t.savings || {}).forEach(function (mid) {
        if (ids[mid]) out.savings[t.id + '|' + mid] = { trip_id: t.id, member_id: mid, amount: t.savings[mid] };
      });
      /* the history of a person's savings rides on the same row as the total. A trip that never had one sends no `log` (so an older row is not touched); an EMPTIED list is sent as [] (that clears it) */
      Object.keys(t.savelog || {}).forEach(function (mid) {
        if (!ids[mid] || !Array.isArray(t.savelog[mid])) return;
        var k = t.id + '|' + mid, row = out.savings[k] || (out.savings[k] = { trip_id: t.id, member_id: mid, amount: (t.savings || {})[mid] || 0 });
        row.log = t.savelog[mid].map(function (x) { return { id: x.id, a: x.a, d: x.d, by: x.by || null }; });
      });
    });
    return out;
  }

  /* ordered operations that turn `prev` into `next`: inserts (parents first), updates, deletes (children first) */
  function diff(prev, next) {
    prev = prev || empty();
    ORDER.forEach(function (tb) { if (!prev[tb]) prev[tb] = {}; });   // a record saved by an older app has no table that was added later (e.g. received): treat it as empty, never stop the sync
    var ins = [], upd = [], del = [], gone = {};
    Object.keys(prev.trips).forEach(function (id) { if (!next.trips[id]) gone[id] = true; });
    ORDER.forEach(function (tb) {
      var rows = [];
      Object.keys(next[tb]).forEach(function (k) {
        var r = next[tb][k], p = prev[tb][k];
        if (!p) rows.push(r);
        else if (tb === 'members') { if ((p.note || '') !== (r.note || '')) upd.push({ kind: 'update', table: tb, row: Object.assign({}, r, { note: r.note || '' }) }); }   // only the memo of a member can change ('' = taken away)
        else if (UPDATABLE[tb] && JSON.stringify(p) !== JSON.stringify(r)) upd.push({ kind: 'update', table: tb, row: tb === 'trips' ? Object.assign({}, r, (p.caps && !r.caps ? { caps: null } : {})) : tb === 'expenses' ? Object.assign({}, r, (p.parts && !r.parts ? { parts: null } : {}), (p.fixed && !r.fixed ? { fixed: null } : {})) : r });   // weights taken away: say so (a missing key means "leave it" for older apps)
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
        .map(function (m) { return { id: m.id, name: m.name, pos: m.position, userId: m.user_id || undefined, pending: m.status !== 'joined', note: m.note || undefined }; });
      var expenses = (r.expenses || []).slice().sort(function (a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1); })
        .map(function (e) { var x = { id: e.id, title: e.title, amount: e.amount, payer: e.payer, cat: e.cat, date: e.spent_on, split: e.split }; if (e.settle_id) x.settleId = e.settle_id; if (e.parts) x.parts = e.parts; if (e.fixed) x.fixed = e.fixed; if (e.author) x.author = e.author; if (e.made_at) x.madeAt = e.made_at; if (e.editor) x.editor = e.editor; if (e.edited_at) x.editedAt = e.edited_at; if (e.prev) x.prev = e.prev; return x; });
      var settlements = (r.settlements || []).slice().sort(function (a, b) { return a.n - b.n || (a.id < b.id ? -1 : 1); })
        .map(function (st) { return { id: st.id, n: st.n, at: st.at, total: st.total || 0, transfers: st.transfers || [] }; });
      var adjustments = (r.adjustments || []).slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id < b.id ? -1 : 1); })
        .map(function (a) { return { id: a.id, settleId: a.settle_id || null, nets: a.nets || {}, note: a.note || '', at: a.at }; });
      var paid = {}, received = {}, savings = {}, savelog = {}, hasLog = false;
      (r.paid || []).forEach(function (p) { paid[p.key] = true; });
      (r.received || []).forEach(function (p) { received[p.key] = true; });
      (r.savings || []).forEach(function (s) { savings[s.member_id] = s.amount; if (Array.isArray(s.log)) { savelog[s.member_id] = s.log.map(function (x) { return { id: x.id, a: x.a, d: x.d, by: x.by || null }; }); hasLog = true; } });
      var tr = { id: r.id, name: r.name, start: r.start_date, end: r.end_date, budget: r.budget, caps: r.caps || undefined, owner: r.owner, members: members, expenses: expenses, settlements: settlements, adjustments: adjustments, paid: paid, received: received, savings: savings };
      if (hasLog) tr.savelog = savelog;   // no key at all for a trip that never had a history (the shape older data has)
      return tr;
    });
  }

  var Sync = { flatten: flatten, diff: diff, assemble: assemble, empty: empty };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Sync; return; }
  root.Sync = Sync;
})(typeof window !== 'undefined' ? window : globalThis);
