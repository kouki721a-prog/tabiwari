/* A stand-in for LINE Login (authorize / token / verify) so the Worker's login flow can be tested without LINE.
   It checks what the Worker sends (client id/secret, redirect_uri, nonce) the way LINE would. */
import http from 'node:http';

export function startFakeLine(port = 9911, { clientId = 'test-channel', clientSecret = 'test-secret' } = {}) {
  let who = { sub: 'U-first', name: 'テスト太郎' }, deny = false;
  const codes = {};   // code -> { nonce, redirect_uri }
  const log = [], friends = {}, pushes = [], authorizeLog = []; let pushStatus = 200;   // friends: sub -> true/false (official account)
  const body = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(new URLSearchParams(d))); });
  const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/oauth2/v2.1/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId || q.get('response_type') !== 'code' || !q.get('state') || !q.get('nonce') || !/openid/.test(q.get('scope') || '')) { res.writeHead(400); return res.end('bad authorize'); }
      authorizeLog.push(Object.fromEntries(q)); const redirect = new URL(q.get('redirect_uri'));
      if (deny) { redirect.searchParams.set('error', 'access_denied'); redirect.searchParams.set('state', q.get('state')); deny = false; }
      else { const code = 'code-' + Math.random().toString(36).slice(2); codes[code] = { nonce: q.get('nonce'), redirect_uri: q.get('redirect_uri') }; redirect.searchParams.set('code', code); if (q.get('bot_prompt')) redirect.searchParams.set('friendship_status_changed', String(!!friends[who.sub])); redirect.searchParams.set('state', q.get('state')); }
      log.push('authorize'); res.writeHead(302, { Location: redirect.toString() }); return res.end();
    }
    if (url.pathname === '/oauth2/v2.1/token' && req.method === 'POST') {
      const b = await body(req), c = codes[b.get('code')];
      if (!c || b.get('client_id') !== clientId || b.get('client_secret') !== clientSecret || b.get('redirect_uri') !== c.redirect_uri || b.get('grant_type') !== 'authorization_code') return json(res, 400, { error: 'invalid_grant' });
      log.push('token'); return json(res, 200, { access_token: 'at', id_token: 'idt:' + b.get('code'), token_type: 'Bearer' });
    }
    if (url.pathname === '/friendship/v1/status') { if (req.headers.authorization !== 'Bearer at') { res.writeHead(401); return res.end(); } return json(res, 200, { friendFlag: !!friends[who.sub] }); }
    if (url.pathname === '/v2/bot/message/push' && req.method === 'POST') {
      let d = ''; req.on('data', c => d += c); await new Promise(r => req.on('end', r));
      if (req.headers.authorization !== 'Bearer oa-test-token') return json(res, 401, {});
      const b = JSON.parse(d); pushes.push({ to: b.to, text: b.messages[0].text, retryKey: req.headers['x-line-retry-key'] }); return json(res, pushStatus, {});
    }
    if (url.pathname === '/oauth2/v2.1/verify' && req.method === 'POST') {
      const b = await body(req), code = (b.get('id_token') || '').replace('idt:', ''), c = codes[code];
      if (!c || b.get('client_id') !== clientId || b.get('nonce') !== c.nonce) return json(res, 400, { error: 'invalid_request', error_description: 'nonce mismatch' });
      delete codes[code]; log.push('verify');
      return json(res, 200, { iss: 'https://access.line.me', sub: who.sub, aud: clientId, exp: Math.floor(Date.now() / 1000) + 3600, nonce: c.nonce, name: who.name, picture: 'https://profile.line-scdn.net/example' });
    }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(port, () => resolve({
    base: 'http://localhost:' + port, clientId, clientSecret, log, pushes, authorizeLog, setFriend(sub, v) { friends[sub] = v; }, setPushStatus(s) { pushStatus = s; },
    setIdentity(sub, name) { who = { sub, name }; }, denyNext() { deny = true; },
    stop() { server.close(); }
  })));
}
