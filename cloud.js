/* Cloud sync for たびわり. Pure functions (flatten / diff / assemble) are tested in test/sync.test.js;
   the Cloud object wraps supabase-js and only exists in the browser. */
(function (root) {
  'use strict';
  var ORDER = ['trips', 'members', 'expenses', 'paid', 'savings'];
  var TABLE = { trips: 'trips', members: 'trip_members', expenses: 'expenses', paid: 'paid', savings: 'savings' };
  var KEYS = { trips: ['id'], members: ['id'], expenses: ['id'], paid: ['trip_id', 'key'], savings: ['trip_id', 'member_id'] };
  var UPDATABLE = { trips: true, expenses: true, savings: true, members: false, paid: false };

  function empty() { return { trips: {}, members: {}, expenses: {}, paid: {}, savings: {} }; }

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
        out.expenses[e.id] = { id: e.id, trip_id: t.id, title: e.title || '', amount: e.amount, payer: e.payer, cat: e.cat, spent_on: e.date, split: e.split.slice() };
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
        .map(function (e) { return { id: e.id, title: e.title, amount: e.amount, payer: e.payer, cat: e.cat, date: e.spent_on, split: e.split }; });
      var paid = {}, savings = {};
      (r.paid || []).forEach(function (p) { paid[p.key] = true; });
      (r.savings || []).forEach(function (s) { savings[s.member_id] = s.amount; });
      return { id: r.id, name: r.name, start: r.start_date, end: r.end_date, budget: r.budget, owner: r.owner, members: members, expenses: expenses, paid: paid, savings: savings };
    });
  }

  function match(tb, row) { var m = {}; KEYS[tb].forEach(function (k) { m[k] = row[k]; }); return m; }
  function patch(tb, row) { var p = {}; Object.keys(row).forEach(function (k) { if (KEYS[tb].indexOf(k) < 0) p[k] = row[k]; }); return p; }

  /* run ops against a supabase client; throws on the first error. Inserts ignore duplicates so a retry after a partial failure is safe. */
  async function apply(client, ops) {
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i], from = client.from(TABLE[op.table]), res;
      if (op.kind === 'insert') res = await from.upsert(op.rows, { onConflict: KEYS[op.table].join(','), ignoreDuplicates: true });
      else if (op.kind === 'update') res = await from.update(patch(op.table, op.row)).match(match(op.table, op.row));
      else res = await from.delete().match(match(op.table, op.row));
      if (res.error) throw res.error;
    }
  }

  var Sync = { flatten: flatten, diff: diff, assemble: assemble, apply: apply, empty: empty };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Sync; return; }
  root.Sync = Sync;

  /* ---- browser only: Supabase wrapper ---- */
  var Cloud = { enabled: false, client: null };
  var cfg = root.TABIWARI || {};
  if (cfg.supabaseUrl && cfg.supabaseKey && root.supabase) {
    Cloud.client = root.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    Cloud.enabled = true;
  }
  Cloud.sendCode = function (email) { return Cloud.client.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }); };
  Cloud.verify = function (email, code) { return Cloud.client.auth.verifyOtp({ email: email, token: code, type: 'email' }); };
  Cloud.signOut = function () { return Cloud.client.auth.signOut(); };
  Cloud.load = async function () {
    var r = await Cloud.client.from('trips').select('*, trip_members(*), expenses(*), paid(*), savings(*)');
    if (r.error) throw r.error;
    return assemble(r.data);
  };
  async function rpc(name, args) { var r = await Cloud.client.rpc(name, args); if (r.error) throw r.error; return r.data; }
  Cloud.invite = function (memberId) { return rpc('create_invite', { p_member: memberId }); };
  Cloud.inviteInfo = async function (token) { var d = await rpc('invite_info', { p_token: token }); return d && d[0] ? { trip: d[0].trip_name, member: d[0].member_name } : null; };
  Cloud.accept = function (token) { return rpc('accept_invite', { p_token: token }); };
  Cloud.leave = function (tripId) { return rpc('leave_trip', { p_trip: tripId }); };
  Cloud.subscribe = function (cb) {
    var ch = Cloud.client.channel('tabiwari').on('postgres_changes', { event: '*', schema: 'public' }, cb).subscribe();
    return function () { Cloud.client.removeChannel(ch); };
  };
  Cloud.errText = function (e) {
    var m = String((e && e.message) || e || '');
    if (/invite_not_found/.test(m)) return '招待リンクが無効です。すでに使われたか、取り消された可能性があります。';
    if (/invite_expired/.test(m)) return '招待リンクの期限が切れています。送ってくれた人に、新しいリンクをお願いしてください。';
    if (/already_member/.test(m)) return 'この旅行には、すでに参加しています。';
    if (/owner_cannot_leave/.test(m)) return '作成者は旅行から抜けられません。旅行を削除してください。';
    if (/already_joined/.test(m)) return 'この枠は、すでに参加済みです。';
    if (/expired or is invalid|Token has expired/i.test(m)) return 'コードが違うか、期限が切れています。もう一度送り直してください。';
    if (/rate limit|For security purposes/i.test(m)) return '送信が多すぎます。少し待ってから、もう一度お試しください。';
    if (/valid email|invalid format|Unable to validate email/i.test(m)) return 'メールアドレスの形式を確認してください。';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'ネットワークにつながりません。接続を確認してください。';
    return 'うまくいきませんでした。もう一度お試しください。';
  };
  root.Cloud = Cloud;
})(typeof window !== 'undefined' ? window : globalThis);
