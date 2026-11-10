const assert = require('assert'), S = require('../share.js');
const T = 'abcdefghijklmnopqrstuvwxyz012345_-AB';   // 36 chars
assert.strictEqual(S.parseToken('https://tabiwari.example.dev/#t=' + T), T);
assert.strictEqual(S.parseToken('「箱根」の割り勘に参加してね。\nhttps://x.dev/app/#t=' + T + '\n'), T, 'link inside a pasted message');
assert.strictEqual(S.parseToken('  ' + T + '  '), T, 'bare token');
assert.strictEqual(S.parseToken('https://x.dev/#t=short'), null);
assert.strictEqual(S.parseToken('hello world'), null);
assert.strictEqual(S.parseToken(''), null); assert.strictEqual(S.parseToken(null), null);
assert.strictEqual(S.linkFor(T, { origin: 'https://x.dev', pathname: '/' }), 'https://x.dev/#t=' + T);
const a = S.newToken(), b = S.newToken();
assert.ok(/^[A-Za-z0-9_-]{32}$/.test(a) && a !== b, 'tokens are 32 url-safe characters and differ');
S.sha256hex('abc').then(h => { assert.strictEqual(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); console.log('share tests passed'); });
