/* Browser test of link sharing: several browser contexts (= several people/devices) against a local Worker + D1.
   Needs playwright and a built dist/ (npm run test:share does both).   node test/share.e2e.mjs */
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');   // playwright is not a project dependency
import { startServer } from './wrangler-dev.mjs';

const srv = await startServer(8788), base = srv.base;
const b = await chromium.launch(), errs = [];
const person = async () => {
  const ctx = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  if (process.env.DEBUG_API) p.on('response', async r => { if (r.url().includes('/api/')) console.log('API', r.request().method(), r.url().replace(base, ''), r.status(), r.request().method() === 'POST' ? (r.request().postData() || '').slice(0, 260) : ''); });
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET/.test(m.text())) errs.push(m.text()); });
  return { ctx, p };
};
const newTripFor = async (p, name) => { await p.click('[data-a=new]'); await p.fill('#d-name', name); await p.fill('#d-budget', '30000'); await p.fill('#d-me', 'あおい'); await p.click('[data-a=save-trip]'); await p.waitForSelector('[data-a=add-exp]'); };
const see = (p, t) => p.waitForSelector('text=' + t, { timeout: 9000 });
const gone = async (p, t) => { await p.waitForTimeout(400); assert.strictEqual(await p.locator('text=' + t).count(), 0, t + ' should not be visible'); };
const refresh = p => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // same trigger as returning to the app
const fits = p => p.evaluate(() => { const b = document.querySelector('.sheet-body'); return { scroll: b.scrollHeight, client: b.clientHeight, ok: b.scrollHeight <= b.clientHeight + 1 }; });
const addExpense = async (p, amount, title) => { await p.click('[data-a=add-exp]'); await p.fill('#f-amount', String(amount)); await p.fill('#f-title', title); await p.click('[data-a=save-exp]'); await see(p, '記録しました'); };

try {
  // ---------- A creates a trip, records one expense, adds a member, shares
  const A = await person();
  await A.p.goto(base + '/'); await see(A.p, '最初の旅行をつくりましょう');
  await A.p.click('[data-a=new]'); await A.p.fill('#d-name', '共有テスト'); await A.p.fill('#d-budget', '30000'); await A.p.fill('#d-me', 'あおい'); await A.p.click('[data-a=save-trip]');
  await addExpense(A.p, 3000, '夕食');
  await A.p.setViewportSize({ width: 390, height: 780 });
  await A.p.click('[data-a=settings]'); await see(A.p, '友だちと共有');
  assert.strictEqual(await A.p.locator('#s-newmember').count(), 0, 'the organizer cannot type members in');
  assert.strictEqual(await A.p.locator('[data-a=add-tmember]').count(), 0);
  assert.strictEqual(await A.p.locator('text=参加待ち').count(), 0, 'no "waiting to join" badge in link-sharing mode');
  { const f = await fits(A.p); assert.ok(f.ok, 'settings fits one screen before sharing: ' + JSON.stringify(f)); }
  await A.p.click('[data-a=share-start]'); await A.p.waitForSelector('#s-sharelink', { timeout: 9000 });
  const link = await A.p.inputValue('#s-sharelink'); assert.match(link, /^http:\/\/localhost:8788\/#t=[A-Za-z0-9_-]{32}$/);
  { const f = await fits(A.p); assert.ok(f.ok, 'settings fits one screen while shared: ' + JSON.stringify(f)); }
  await A.p.click('[data-a=close-sheet]'); await see(A.p, '共有中');

  // ---------- B opens the link (a fresh browser), picks who they are, sees A's data
  const Bp = await person();
  await Bp.p.goto(link); await see(Bp.p, '共有された旅行'); await see(Bp.p, '共有テスト');
  assert.ok(!Bp.p.url().includes('#t='), 'token is removed from the address bar after it is read');
  await Bp.p.click('[data-a=join-share-go]'); await see(Bp.p, '名前を入力するか');             // nothing entered yet -> asked
  await Bp.p.fill('#j-name', 'けんた'); await Bp.p.click('[data-a=join-share-go]');
  await see(Bp.p, '参加しました'); await see(Bp.p, '夕食'); await see(Bp.p, '3,000円');

  // ---------- B records; A sees it; A edits; B sees it; both compute the same settlement
  await addExpense(Bp.p, 1200, 'コーヒー');
  await refresh(A.p); await see(A.p, 'コーヒー');
  await A.p.locator('[data-a=edit-exp]', { hasText: '夕食' }).click(); await A.p.fill('#f-amount', '3600'); await A.p.click('[data-a=save-exp]'); await see(A.p, '保存しました');
  await refresh(Bp.p); await see(Bp.p, '3,600円');
  for (const [i, x] of [A, Bp].entries()) { await x.p.click('[data-a=tab][data-t=settle]'); try { await see(x.p, 'あおい → けんた'); } catch (e) { console.log('DEBUG person', i, (await x.p.locator('.scroll').innerText()).replace(/\n+/g, ' | ')); throw e; } await see(x.p, '600円'); await x.p.click('[data-a=tab][data-t=exp]'); }
  // B is "けんた": default payer on the form is B's own member
  await Bp.p.click('[data-a=add-exp]'); assert.ok(await Bp.p.locator('.chip.on', { hasText: 'けんた' }).count() >= 1); await Bp.p.click('[data-a=close-sheet]');

  // ---------- offline edits wait, then go out when the connection returns
  await Bp.ctx.setOffline(true); await addExpense(Bp.p, 500, 'ガム'); await see(Bp.p, '同期待ち');
  await Bp.ctx.setOffline(false); await Bp.p.evaluate(() => window.dispatchEvent(new Event('online')));
  await refresh(A.p); await see(A.p, 'ガム'); await Bp.p.waitForFunction(() => document.body.innerText.indexOf('同期待ち') < 0);

  // ---------- C joins by pasting a message that contains the link (the home-screen-app route), as a new name
  const C = await person();
  await C.p.goto(base + '/'); await C.p.click('[data-a=join-paste]'); await C.p.fill('#p-link', 'https://example.invalid/#t=short');
  await C.p.click('[data-a=join-paste-go]'); await see(C.p, 'リンクの形式を確認してください');
  await C.p.fill('#p-link', '「共有テスト」の割り勘に参加してね。\n' + link + '\n'); await C.p.click('[data-a=join-paste-go]'); await see(C.p, '共有された旅行');
  await C.p.fill('#j-name', 'けんた'); await C.p.click('[data-a=join-share-go]'); await see(C.p, '同じ名前のメンバーがいます');
  await C.p.fill('#j-name', 'みく'); await C.p.click('[data-a=join-share-go]'); await see(C.p, '参加しました'); await see(C.p, '共有テスト'); await C.p.waitForTimeout(1200);   // let C's new member reach the server
  await refresh(A.p); await A.p.waitForTimeout(1500); await A.p.click('[data-a=settings]'); await see(A.p, 'みく'); await see(A.p, 'けんた');
  { const f = await fits(A.p); assert.ok(f.ok, 'settings with 3 members fits one screen: ' + JSON.stringify(f)); } await A.p.click('[data-a=close-sheet]');

  // ---------- a wrong link
  const D = await person(); await D.p.goto(base + '/#t=' + 'Z'.repeat(40)); await see(D.p, '共有リンクが見つかりません');

  // ---------- C stops sharing on their device: their later edits stay local
  await C.p.click('[data-a=settings]'); await C.p.click('[data-a=share-stop]'); await C.p.click('[data-a=share-stop-go]'); await see(C.p, 'この端末の共有をやめました');
  await C.p.click('[data-a=close-sheet]'); await addExpense(C.p, 777, 'ひとりごと');
  await refresh(A.p); await A.p.waitForTimeout(800); await gone(A.p, 'ひとりごと');

  // ---------- A ends sharing for everyone: B is told, keeps a local copy
  await A.p.click('[data-a=settings]'); await A.p.click('[data-a=share-erase]'); await A.p.click('[data-a=share-erase-go]'); await see(A.p, '共有を終了しました');
  await refresh(Bp.p); await see(Bp.p, '共有が終了しました'); await see(Bp.p, 'コーヒー'); await gone(Bp.p, '共有中');

  // ---------- "invite a friend" on the home screen: only while I am the only member; it makes the share link and opens LINE with the message ready
  await A.p.route('https://line.me/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>LINE</title>' }));
  if (await A.p.locator('.sheet').count()) await A.p.click('[data-a=close-sheet]');
  await A.p.click('[data-a=home]'); await newTripFor(A.p, '招待旅行');
  await A.p.click('[data-a=home]'); await A.p.waitForSelector('.home1');
  assert.strictEqual(await A.p.locator('[data-a=invite]').count(), 1, 'one trip with only me: one invite button (the other trips have more members or are not mine alone)');
  const lineReq = A.p.waitForRequest(r => r.url().startsWith('https://line.me/R/msg/text/?'), { timeout: 12000 });
  await A.p.click('[data-a=invite]'); const sent = decodeURIComponent((await lineReq).url().split('?')[1]);
  assert.ok(sent.includes('「招待旅行」の割り勘に参加してね。') && /#t=[A-Za-z0-9_-]{32}/.test(sent), 'the LINE message carries the trip name and the share link: ' + sent);

  // the same invite button on the trip screen ("＋招待"): stays on the trip screen and opens LINE
  await A.p.goto(base + '/'); await A.p.waitForSelector('.home1');   // the first invite left the app for LINE
  await A.p.locator('.trip', { hasText: '招待旅行' }).click(); await A.p.waitForSelector('.mem-row');
  const lineReq2 = A.p.waitForRequest(r => r.url().startsWith('https://line.me/R/msg/text/?'), { timeout: 12000 });
  await A.p.click('.mem-row [data-a=invite]'); const sent2 = decodeURIComponent((await lineReq2).url().split('?')[1]);
  assert.ok(sent2.includes('「招待旅行」') && /#t=[A-Za-z0-9_-]{32}/.test(sent2), sent2);

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('share e2e passed');
} finally { await b.close(); srv.stop(); }
