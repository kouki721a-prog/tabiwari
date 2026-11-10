/* Client for LINE login + backup endpoints (worker/account.js). Cookies are HttpOnly, so the app never sees the session token. */
(function (root) {
  'use strict';
  async function call(method, path, body) {
    var r = await fetch(path, { method: method, cache: 'no-store', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    var data = null; try { data = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok) { var err = new Error((data && data.error) || ('http ' + r.status)); err.status = r.status; throw err; }
    return data;
  }
  var Line = {
    me: function () { return call('GET', '/api/me'); },
    begin: function () { return call('POST', '/api/auth/begin', {}); },
    poll: function (id, secret) { return call('POST', '/api/auth/poll', { id: id, secret: secret }); },
    logout: function () { return call('POST', '/api/auth/logout', {}); },
    backupGet: function () { return call('GET', '/api/backup'); },
    backupPut: function (upsert, remove) { return call('PUT', '/api/backup', { upsert: upsert || [], remove: remove || [] }); },
    deleteAccount: function () { return call('DELETE', '/api/account'); },
    pushSubscribe: function (sub) { return call('POST', '/api/push/subscribe', sub); },
    pushTest: function () { return call('POST', '/api/push/test', {}); },
    pushUnsubscribe: function (endpoint) { return call('POST', '/api/push/unsubscribe', { endpoint: endpoint }); },
    errText: function (e) {
      var s = e && e.status;
      if (s === 401) return 'ログインが切れました。もう一度、LINEでログインしてください。';
      if (s === 404) return 'この端末の通知が、登録されていません。いったん「止める」→「受け取る」をお試しください。';
      if (s === 413) return 'バックアップできる旅行は、100件まで、通知を受け取れる端末は、10台までです。';
      if (s === 429) return '短い間に、操作が多すぎます。少し待ってから、もう一度お試しください。';
      if (s === 503) return 'LINEログインは、まだ準備中です。';
      return 'ネットワークにつながりません。接続を確認して、もう一度お試しください。';
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Line; else root.Line = Line;
})(typeof window !== 'undefined' ? window : globalThis);
