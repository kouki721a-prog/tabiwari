/* Browser test: LINE login (stand-in), automatic backup, restore on another device, account deletion.
   Needs playwright and a built dist/.   node test/account.e2e.mjs */
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { startServer } from './wrangler-dev.mjs';
import { startFakeLine } from './fake-line.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const line = await startFakeLine(9911);
const srv = await startServer(8788, { LINE_CHANNEL_ID: line.clientId, LINE_CHANNEL_SECRET: line.clientSecret, AUTH_SECRET: 'e2e-secret-0123456789abcdef0123456789', LINE_AUTH_BASE: line.base, LINE_API_BASE: line.base });
const base = srv.base, b = await chromium.launch(), errs = [];
const device = async () => {
  const ctx = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET/.test(m.text())) errs.push(m.text()); });
  return { ctx, p };
};
const see = (p, t, ms = 9000) => p.waitForSelector('text=' + t, { timeout: ms });
const newTrip = async (p, name, me = 'あおい') => { await p.click('[data-a=new]'); await p.fill('#d-name', name); await p.fill('#d-budget', '30000'); await p.fill('#d-me', me); await p.click('[data-a=save-trip]'); };
const addExpense = async (p, amount, title) => { await p.click('[data-a=add-exp]'); await p.fill('#f-amount', String(amount)); await p.fill('#f-title', title); await p.click('[data-a=save-exp]'); await see(p, '記録しました'); };

try {
  // ---------- device 1: two trips (one local, one shared), then log in
  const d1 = await device(); line.setIdentity('U-aoi', 'あおい（LINE）');
  await d1.p.goto(base + '/'); await see(d1.p, 'LINEでログインすると');
  await newTrip(d1.p, 'ローカルの旅'); await addExpense(d1.p, 1500, 'ランチ'); await d1.p.click('[data-a=home]');
  await newTrip(d1.p, '共有の旅'); await addExpense(d1.p, 900, 'コーヒー');
  await d1.p.click('[data-a=settings]'); await d1.p.click('[data-a=share-start]'); await d1.p.waitForSelector('#s-sharelink', { timeout: 9000 }); await d1.p.click('[data-a=close-sheet]'); await d1.p.click('[data-a=home]');

  await d1.p.click('[data-a=line-login]'); await d1.p.waitForURL(/\/api\/auth\/line\/callback/); await see(d1.p, 'ログインできました');
  await d1.p.click('a[href="/"]');                                                 // "back to たびわり": the app finds the finished login by itself
  await see(d1.p, 'LINEでログインしました'); await see(d1.p, 'あおい（LINE） でログイン中');
  await d1.p.waitForFunction(() => document.body.innerText.indexOf('バックアップ 2件') >= 0, null, { timeout: 12000 });
  assert.strictEqual(await d1.p.locator('text=LINEでログインすると').count(), 0, 'the login card goes away');

  // ---------- device 2: LINE opens in a *different* browser (what happens in an iPhone home-screen app); the app still gets logged in
  const d2 = await device(); const other = await device();
  await d2.p.goto(base + '/'); await see(d2.p, 'LINEでログインすると');
  const attempt = await d2.p.evaluate(async () => { const a = await Line.begin(); localStorage.setItem('tabiwari.lineattempt', JSON.stringify({ id: a.id, secret: a.secret, t: Date.now() })); return a; });
  await d2.p.evaluate(() => { linePoll(); }); await see(d2.p, 'LINEでのログインを待っています');
  await other.p.goto(base + attempt.url); await see(other.p, 'ログインできました');       // the "other browser" completes the login
  await see(d2.p, 'LINEでログインしました'); await see(d2.p, 'バックアップから戻す');         // restore sheet opens by itself: this device has none of the trips
  await see(d2.p, 'ローカルの旅'); await see(d2.p, '共有の旅'); await see(d2.p, '共有中');
  await d2.p.click('[data-a=bk-restore-go]'); await see(d2.p, '2件を戻しました');
  await see(d2.p, 'ローカルの旅'); await see(d2.p, '共有の旅');
  await d2.p.locator('.trip', { hasText: 'ローカルの旅' }).click(); await see(d2.p, 'ランチ'); await see(d2.p, '1,500円'); await d2.p.click('[data-a=home]');
  await d2.p.locator('.trip', { hasText: '共有の旅' }).click(); await see(d2.p, 'コーヒー'); await see(d2.p, '共有中');          // the shared trip came back live, from the server
  await d2.p.click('[data-a=home]');

  // ---------- backing up is automatic: a new expense on device 2 is on the server a few seconds later
  await d2.p.locator('.trip', { hasText: 'ローカルの旅' }).click(); await addExpense(d2.p, 700, '夜食'); await d2.p.click('[data-a=home]');
  await d2.p.waitForTimeout(5500);
  const server = await d2.p.evaluate(async () => (await Line.backupGet()).items.find(x => x.item.kind === 'local').item.trip.expenses.map(e => e.title));
  assert.deepStrictEqual(server, ['ランチ', '夜食']);

  // ---------- nothing left to restore here
  await d2.p.click('[data-a=line-account]'); await see(d2.p, 'LINEアカウント'); await d2.p.click('[data-a=bk-restore]'); await see(d2.p, '戻すものはありません'); await d2.p.click('[data-a=close-sheet]');

  // ---------- a different LINE person sees nothing
  const d3 = await device(); line.setIdentity('U-other', '別の人');
  await d3.p.goto(base + '/'); await d3.p.click('[data-a=line-login]'); await d3.p.waitForURL(/\/api\/auth\/line\/callback/); await d3.p.click('a[href="/"]');
  await see(d3.p, '別の人 でログイン中'); await d3.p.waitForTimeout(800);
  assert.strictEqual(await d3.p.locator('text=バックアップから戻す').count(), 0, 'no restore offered: this account has no backup');
  await d3.p.click('[data-a=line-account]'); await see(d3.p, 'LINEアカウント'); await d3.p.click('[data-a=bk-restore]'); await see(d3.p, '戻すものはありません');
  await d3.p.click('[data-a=close-sheet]');

  // ---------- a fourth device: deleting from the backup asks twice and only removes what was selected
  const d4 = await device(); line.setIdentity('U-aoi', 'あおい（LINE）');
  await d4.p.goto(base + '/'); await d4.p.click('[data-a=line-login]'); await d4.p.waitForURL(/\/api\/auth\/line\/callback/); await d4.p.click('a[href="/"]');
  await see(d4.p, 'バックアップから戻す'); await see(d4.p, '共有の旅');
  await d4.p.click('[data-a=bk-del-go]'); await see(d4.p, '本当に削除する'); await d4.p.click('[data-a=bk-del-no]'); await see(d4.p, '選んだ旅行を戻す');
  await d4.p.locator('[data-a=bk-pick]', { hasText: '共有の旅' }).click();                    // keep the shared trip in the backup
  await d4.p.click('[data-a=bk-del-go]'); await d4.p.click('[data-a=bk-del-yes]'); await see(d4.p, 'バックアップから削除しました');
  assert.deepStrictEqual(await d4.p.evaluate(async () => (await Line.backupGet()).items.map(x => x.item.kind)), ['shared'], 'only the selected one was removed');
  await d4.p.click('[data-a=close-sheet]'); assert.strictEqual(await d4.p.locator('.trip').count(), 0, 'deleting from the backup does not touch the device');

  // ---------- logout, then delete the account on device 2: local trips stay
  await d3.p.click('[data-a=line-account]'); await d3.p.click('[data-a=line-logout]'); await see(d3.p, 'ログアウトしました'); await see(d3.p, 'LINEでログインすると');
  await d2.p.click('[data-a=line-account]'); await d2.p.click('[data-a=line-del-ask]'); await d2.p.click('[data-a=line-del-go]'); await see(d2.p, 'アカウントを削除しました');
  await see(d2.p, 'LINEでログインすると'); await see(d2.p, 'ローカルの旅'); await see(d2.p, '共有の旅');
  // device 1's session died with the account
  await d1.p.reload(); await see(d1.p, 'LINEでログインすると');

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('account e2e passed');
} finally { await b.close(); srv.stop(); line.stop(); }
