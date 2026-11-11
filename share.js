/* Client for the sharing API (worker/index.js). A shared trip is identified by a secret token that lives in the
   link (https://…/#t=<token>); the server only ever sees it in the Authorization header. */
(function (root) {
  'use strict';
  var b64u = function (bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  function newToken() { return b64u(crypto.getRandomValues(new Uint8Array(24))); }   // 192 random bits -> 32 characters
  async function sha256hex(s) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function linkFor(token, loc) { return loc.origin + loc.pathname + '#t=' + token; }
  /* accepts the full link, a pasted message that contains it, or the bare token */
  function parseToken(text) {
    var m = /(?:[#&?]t=|^\s*)([A-Za-z0-9_-]{32,64})(?=\s|$)/.exec(String(text || ''));
    return m ? m[1] : null;
  }
  async function call(token, method, path, body) {
    var r = await fetch(path, { method: method, cache: 'no-store', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    var data = null; try { data = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok) { var err = new Error((data && data.error) || ('http ' + r.status)); err.status = r.status; throw err; }
    return data;
  }
  function errText(e) {
    var s = e && e.status;
    if (s === 404) return '共有リンクが見つかりません。リンクが正しいか、共有が終了していないか確認してください。';
    if (s === 429) return '短い間に、操作が多すぎます。少し待ってから、もう一度お試しください。';
    if (s === 413) return '旅行が大きすぎます（メンバーは12人、支出は2000件までです）。';
    if (s === 400) return '送れない内容が含まれています。';
    return 'ネットワークにつながりません。接続を確認して、もう一度お試しください。';
  }
  var Share = {
    newToken: newToken, sha256hex: sha256hex, linkFor: linkFor, parseToken: parseToken, errText: errText,
    get: function (t, rev) { return call(t, 'GET', '/api/trip' + (rev ? '?rev=' + rev : '')); },
    ops: function (t, ops) { return call(t, 'POST', '/api/ops', { ops: ops }); },
    reach: function (t) { return call(t, 'GET', '/api/reach'); },
    remove: function (t) { return call(t, 'DELETE', '/api/trip'); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Share; else root.Share = Share;
})(typeof window !== 'undefined' ? window : globalThis);
