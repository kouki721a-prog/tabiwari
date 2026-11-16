/* たびまる (worker/ai.js): login only, a daily and a monthly limit, the AI's answer is checked, a failed call is not charged, the key never leaves the Worker.   node test/ai.api.test.mjs */
import assert from 'node:assert';
import { startServer } from './wrangler-dev.mjs';
import { startFakeLine } from './fake-line.mjs';
import { startFakeAi } from './fake-ai.mjs';
import { cleanAnswer } from '../worker/ai.js';

const line = await startFakeLine(9915), ai = startFakeAi(9916);
const vars = { LINE_CHANNEL_ID: line.clientId, LINE_CHANNEL_SECRET: line.clientSecret, AUTH_SECRET: 'ai-test-secret-0123456789abcdef0123456789', LINE_AUTH_BASE: line.base, LINE_API_BASE: line.base, TEST_HOOKS: '1' };
const srv = await startServer(8793, { ...vars, ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_API_BASE: ai.base, AI_DAILY_LIMIT: '3', AI_MONTHLY_LIMIT: '6' }), B = srv.base;
const off = await startServer(8794, vars);
const j = async (base, p, { cookie, method = 'GET', body } = {}) => { const r = await fetch(base + p, { method, headers: { ...(method !== 'GET' ? { Origin: base } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); let d = null; try { d = await r.json(); } catch (e) {} return { status: r.status, data: d }; };
async function login(base, sub, name) {
  line.setIdentity(sub, name); const b = (await j(base, '/api/auth/begin', { method: 'POST', body: {} })).data;
  const s = await fetch(base + b.url, { redirect: 'manual' }), a = await fetch(s.headers.get('Location'), { redirect: 'manual' }); await fetch(a.headers.get('Location'), { redirect: 'manual' });
  const r = await fetch(base + '/api/auth/poll', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.id, secret: b.secret }) }); return r.headers.get('set-cookie').split(';')[0];
}
const ask = (cookie, extra = {}, base = B) => j(base, '/api/ai/parse', { cookie, method: 'POST', body: { text: '昨日の夕食、けんたが立て替えて3人で割った 6000円', names: ['こうき', 'あおい', 'けんた'], me: 'こうき', today: '2026-11-16', start: '2026-11-15', end: '2026-11-17', ...extra } });
const GOOD = { readable: true, title: '夕食', amount: 6000, category: 'food', date: '2026-11-15', payer: 'けんた', split_all: true, split_names: [], comment: '夕食 6,000円ですね！けんたさんが払って、3人で割ります。' };
try {
  // status: public; not logged in -> login false; off when no key
  assert.deepStrictEqual((await j(B, '/api/ai/status')).data, { enabled: true, login: false, remaining: null });
  assert.deepStrictEqual((await j(off.base, '/api/ai/status')).data, { enabled: false, login: false, remaining: null });
  assert.strictEqual((await ask(null)).status, 401, 'not logged in'); assert.strictEqual(ai.calls.length, 0, 'nothing sent to the AI');
  const u1 = await login(B, 'U-ai-1', 'エー'); assert.deepStrictEqual((await j(B, '/api/ai/status', { cookie: u1 })).data, { enabled: true, login: true, remaining: 3, limit: 3 });
  const u0 = await login(off.base, 'U-ai-0', 'ゼロ'); assert.strictEqual((await ask(u0, {}, off.base)).status, 503, 'no key: off');
  // a good answer: checked, and what is sent is what we promised
  ai.answer(GOOD); let r = await ask(u1); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.result, { ok: true, title: '夕食', amount: 6000, category: 'food', date: '2026-11-15', payer: 'けんた', split: 'all', fixed: {}, comment: '夕食 6,000円ですね。けんたさんが払って、3人で割ります。' }, 'no "！" in the comment'); assert.strictEqual(r.data.remaining, 2);
  const c = ai.calls[0]; assert.strictEqual(c.url, '/v1/messages'); assert.strictEqual(c.headers['x-api-key'], 'sk-ant-test-key'); assert.strictEqual(c.headers['anthropic-version'], '2023-06-01'); assert.strictEqual(c.body.model, 'claude-haiku-5-5');
  assert.deepStrictEqual(c.body.tool_choice, { type: 'tool', name: 'record_expense' }); assert.ok(JSON.stringify(c.body.messages).includes('<user_text>昨日の夕食'), 'the text is wrapped as data'); assert.ok(JSON.stringify(c.body.messages).includes('こうき、あおい、けんた') && JSON.stringify(c.body.messages).includes('2026-11-16'));
  assert.ok(!JSON.stringify(r.data).includes('sk-ant'), 'the key never goes back to the app');
  // limits: 3 a day (a refused one is not counted); the 4th is refused without calling the AI
  assert.strictEqual((await ask(u1)).status, 200); assert.strictEqual((await ask(u1)).status, 200); const n = ai.calls.length;
  r = await ask(u1); assert.strictEqual(r.status, 429); assert.strictEqual(r.data.error, 'limit'); assert.strictEqual(ai.calls.length, n, 'over the limit: the AI is not called'); assert.strictEqual((await j(B, '/api/ai/status', { cookie: u1 })).data.remaining, 0);
  // another person has their own count; a failed call is refunded; an unreadable answer counts
  const u2 = await login(B, 'U-ai-2', 'ビー'); ai.fail(500); r = await ask(u2); assert.strictEqual(r.status, 502); assert.strictEqual(r.data.error, 'upstream'); assert.strictEqual((await j(B, '/api/ai/status', { cookie: u2 })).data.remaining, 3, 'an upstream error is not charged');
  ai.answer(null); r = await ask(u2); assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'unreadable'); assert.strictEqual(r.data.remaining, 2);
  ai.answer({ readable: false, comment: 'x' }); r = await ask(u2); assert.strictEqual(r.status, 422); assert.strictEqual(r.data.error, 'unreadable');
  // the monthly cap (6): 3 + 2 so far (the 4th of u1 and the failed one were refunded) -> one more, then paused
  const u3 = await login(B, 'U-ai-3', 'シー'); ai.answer(GOOD); assert.strictEqual((await ask(u3)).status, 200); r = await ask(u3); assert.strictEqual(r.status, 429); assert.strictEqual(r.data.error, 'paused', 'the month is used up');
  assert.strictEqual((await j(B, '/api/ai/status', { cookie: u3 })).data.remaining, 2, 'a paused month does not use the daily count');
  // bad requests are refused before anything is counted
  for (const bad of [{ text: '' }, { names: [] }, { today: 'x' }, { image: 'data:text/html;base64,AAAA', text: '' }, { image: 'AAAA', text: '' }]) assert.strictEqual((await ask(u3, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.strictEqual((await ask(u3, { text: 'x'.repeat(100) })).status, 429, 'month is still used up (sanity)');
  console.log('ai api tests (server) passed');
} finally { srv.stop(); off.stop(); ai.stop(); line.stop(); }

// the answer is checked on its own, too
const names = ['こうき', 'あおい', 'けんた'], ok = (o) => cleanAnswer({ readable: true, amount: 6000, ...o }, names);
assert.strictEqual(ok({ payer: 'ゆうた' }).error, 'unknown_name'); assert.strictEqual(ok({ payer: 'けんたさん' }).payer, 'けんた', 'an honorific is allowed');
assert.deepStrictEqual(ok({ split_all: false, split_names: ['あおい', 'けんた'] }).split, ['あおい', 'けんた']); assert.strictEqual(ok({ split_all: false, split_names: ['こうき', 'あおい', 'けんた'] }).split, 'all', 'everybody = all');
assert.strictEqual(ok({ split_all: false, split_names: ['ゆうた'] }).error, 'unknown_name');
assert.deepStrictEqual(ok({ fixed: [{ name: 'けんた', amount: 1000 }] }).fixed, { けんた: 1000 }); assert.deepStrictEqual(ok({ fixed: [{ name: 'けんた', amount: 9000 }] }).fixed, {}, 'more than the amount: dropped');
assert.deepStrictEqual(ok({ fixed: [{ name: 'こうき', amount: 1 }, { name: 'あおい', amount: 1 }, { name: 'けんた', amount: 1 }] }).fixed, {}, 'everybody fixed but not adding up: dropped');
assert.strictEqual(ok({ amount: 0 }).error, 'unreadable'); assert.strictEqual(ok({ amount: 1.5 }).error, 'unreadable'); assert.strictEqual(ok({ category: 'zzz' }).category, 'other'); assert.strictEqual(ok({ date: '昨日' }).date, null); assert.strictEqual(cleanAnswer(null, names).error, 'unreadable');
console.log('ai answer tests passed'); process.exit(0);
