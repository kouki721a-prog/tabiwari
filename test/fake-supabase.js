/* In-browser stand-in for supabase-js (just what cloud.js uses). Exposes window.__db and window.__log for assertions. */
(function () {
  var db = window.__db = { trips: [], trip_members: [], expenses: [], paid: [], savings: [], invites: [] }, log = window.__log = [], seq = 0;
  window.supabase = { createClient: function () {
    var session = null, ls = [];
    var emit = function (ev) { ls.forEach(function (l) { l(ev, session); }); };
    var auth = {
      onAuthStateChange: function (cb) { ls.push(cb); setTimeout(function () { cb('INITIAL_SESSION', session); }, 0); return { data: { subscription: {} } }; },
      signInWithOtp: async function (a) { window.__otpTo = a.email; return { error: null }; },
      verifyOtp: async function (a) { if (a.token !== '123456') return { error: { message: 'Token has expired or is invalid' } };
        session = { user: { id: 'U-' + a.email, email: a.email } }; emit('SIGNED_IN'); return { data: { session: session }, error: null }; },
      signOut: async function () { session = null; emit('SIGNED_OUT'); return { error: null }; },
      getSession: async function () { return { data: { session: session } }; }
    };
    var hit = function (m) { return function (x) { return Object.keys(m).every(function (k) { return x[k] === m[k]; }); }; };
    return {
      auth: auth,
      from: function (tb) { return {
        upsert: async function (rows, o) { log.push('insert ' + tb + ' x' + rows.length); var ks = o.onConflict.split(',');
          rows.forEach(function (r) { if (!db[tb].some(function (x) { return ks.every(function (c) { return x[c] === r[c]; }); })) {
            var row = Object.assign({ created_at: String(1000 + (++seq)) }, r); if (tb === 'trips') row.owner = session.user.id; db[tb].push(row); } });
          return { error: null }; },
        update: function (p) { return { match: async function (m) { log.push('update ' + tb); db[tb].filter(hit(m)).forEach(function (x) { Object.assign(x, p); }); return { error: null }; } }; },
        delete: function () { return { match: async function (m) { log.push('delete ' + tb); db[tb] = db[tb].filter(function (x) { return !hit(m)(x); });
          if (tb === 'trips') ['trip_members', 'expenses', 'paid', 'savings'].forEach(function (t) { db[t] = db[t].filter(function (x) { return x.trip_id !== m.id; }); }); return { error: null }; } }; },
        select: async function () { return { error: null, data: db.trips.map(function (t) { var id = t.id; var f = function (n) { return db[n].filter(function (x) { return x.trip_id === id; }); };
          return Object.assign({}, t, { trip_members: f('trip_members'), expenses: f('expenses'), paid: f('paid'), savings: f('savings') }); }) }; }
      }; },
      rpc: async function (n, a) {
        if (n === 'create_invite') { var t = 'TOK' + (++seq); db.invites.push({ token: t, member: a.p_member }); return { data: t, error: null }; }
        if (n === 'invite_info') return { data: a.p_token === 'BAD' ? [] : [{ trip_name: '京都 週末', member_name: 'みく' }], error: null };
        if (n === 'accept_invite') { db.trips.push({ id: 'JT', name: '京都 週末', start_date: '2026-12-01', end_date: '2026-12-02', budget: 50000, owner: 'U-other' });
          db.trip_members.push({ id: 'jm', trip_id: 'JT', name: 'みく', position: 0, user_id: session.user.id, status: 'joined' }); return { data: 'JT', error: null }; }
        return { data: null, error: null };
      },
      channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
      removeChannel: function () {}
    };
  } };
})();
