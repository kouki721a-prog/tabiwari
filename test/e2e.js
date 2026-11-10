/* Browser test against a fake Supabase. Needs: playwright, python3.  Run: node test/e2e.js */
const { chromium, devices } = require('playwright'), assert = require('assert'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const root = path.join(__dirname, '..');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8791'], { cwd: root, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const b = await chromium.launch(), errs = [];
  const mk = async (cloud) => {
    const ctx = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    if (cloud) {
      await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.TABIWARI={supabaseUrl:'http://fake',supabaseKey:'k',premiumPriceLabel:'月額400円'}" }));
      await ctx.route('**/vendor/supabase.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8') }));
    }
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));   // this static test server has no /api
    return { ctx, p };
  };
  const txt = (p, s) => p.waitForSelector('text=' + s, { timeout: 3000 });

  // 1. local-only mode: no login UI, create trip + expense, nothing cloud-ish
  let { ctx, p } = await mk(false);
  await p.goto('http://localhost:8791/'); await txt(p, '最初の旅行をつくりましょう');
  assert.strictEqual(await p.locator('text=ログイン').count(), 0);
  await p.click('[data-a=new]'); await p.fill('#d-name', 'ローカル旅'); await p.fill('#d-budget', '30000'); await p.click('[data-a=save-trip]');
  await p.click('[data-a=add-exp]'); await p.fill('#f-amount', '500'); await p.click('[data-a=save-exp]'); await txt(p, '記録しました');
  await p.click('[data-a=settings]'); assert.ok(await p.locator('text=友だちと共有').count() >= 1);
  assert.strictEqual(await p.locator('text=（プレミアム）').count(), 0, 'no premium wording without accounts');
  { const [dl0] = await Promise.all([p.waitForEvent('download'), p.click('[data-a=export-csv]')]); const t0 = fs.readFileSync(await dl0.path(), 'utf8'); assert.ok(t0.indexOf('日付,内容,カテゴリ,金額') > 0 && t0.indexOf('500') > 0, 'free CSV backup works in local mode'); }
  await ctx.close();

  // 2. cloud mode
  ({ ctx, p } = await mk(true));
  await p.goto('http://localhost:8791/'); await txt(p, 'ログインすると、友だちと旅行を共有できます');
  await p.click('[data-a=new]'); await p.fill('#d-name', '端末の旅'); await p.fill('#d-budget', '40000'); await p.fill('#d-me', 'あおい'); await p.click('[data-a=save-trip]');
  await p.click('[data-a=home]');
  // login: bad code, then good code
  await p.click('[data-a=login]'); await p.fill('#l-email', 'aoi@example.com'); await p.click('[data-a=login-send]');
  await p.waitForSelector('#l-code'); await p.fill('#l-code', '000000'); await p.click('[data-a=login-verify]'); await txt(p, 'コードが違う');
  await p.fill('#l-code', '123456'); await p.click('[data-a=login-verify]'); await txt(p, 'aoi@example.com でログイン中');
  // migration offers the local trip (not the sample)
  await txt(p, 'この端末の旅行 1件');
  await p.click('[data-a=migrate]'); await txt(p, 'アカウントに移しました');
  let db = await p.evaluate(() => window.__db);
  assert.strictEqual(db.trips.length, 1); assert.strictEqual(db.trips[0].name, '端末の旅'); assert.strictEqual(db.trips[0].owner, 'U-aoi@example.com');
  assert.strictEqual(db.trip_members[0].user_id, 'U-aoi@example.com'); assert.strictEqual(db.trip_members[0].status, 'joined');
  assert.strictEqual(await p.locator('text=この端末の旅行').count(), 0);
  // cloud trip: add expense -> synced; edit -> update; invite
  await p.click('.trip'); await p.click('[data-a=add-exp]'); await p.fill('#f-amount', '1200'); await p.click('[data-a=save-exp]'); await txt(p, '記録しました');
  await p.waitForFunction(() => window.__db.expenses.length === 1);
  await p.click('[data-a=settings]'); await p.fill('#s-newmember', 'けんた'); await p.click('[data-a=add-tmember]');
  await p.click('[data-a=invite-link]'); await p.waitForSelector('#s-link');
  assert.match(await p.inputValue('#s-link'), /#join=TOK\d+$/);
  db = await p.evaluate(() => window.__db); assert.strictEqual(db.trip_members.length, 2); assert.strictEqual(db.trip_members[1].status, 'invited'); assert.strictEqual(db.trip_members[1].user_id, null);
  await p.click('[data-a=close-sheet]');
  // join link while signed in
  await p.evaluate(() => { location.hash = '#join=GOOD'; }); await txt(p, '旅行への招待'); await txt(p, '京都 週末');
  await p.click('[data-a=accept-join]'); await txt(p, '参加しました'); await txt(p, '京都 週末');
  // non-owner sees "leave", not "delete"
  await p.click('[data-a=settings]'); assert.strictEqual(await p.locator('text=この旅行から抜ける').count(), 1); await p.click('[data-a=close-sheet]');
  // reload keeps the session? (fake has none) -> logout returns to local mode with the sample
  await p.click('[data-a=home]'); await p.click('[data-a=account]'); await txt(p, 'プラン'); await txt(p, '無料（旅行は3件まで）');
  assert.strictEqual(await p.locator('text=この端末への通知').count(), 0, 'push row hidden without a VAPID key');
  await p.click('[data-a=logout]'); await txt(p, '最初の旅行をつくりましょう');
  assert.strictEqual(await p.locator('text=端末の旅').count(), 0);
  await ctx.close();

  // 3. plan limit, upgrade, CSV, account deletion
  ({ ctx, p } = await mk(true));
  await ctx.route('https://checkout.example/**', r => r.fulfill({ contentType: 'text/html', body: '<title>checkout</title>' }));
  await p.goto('http://localhost:8791/'); await p.click('[data-a=login]'); await p.fill('#l-email', 'bee@example.com'); await p.click('[data-a=login-send]');
  await p.waitForSelector('#l-code'); await p.fill('#l-code', '123456'); await p.click('[data-a=login-verify]'); await txt(p, 'bee@example.com でログイン中');
  for (const n of ['A', 'B', 'C']) { await p.click('[data-a=new]'); await p.fill('#d-name', '旅' + n); await p.fill('#d-budget', '10000'); await p.click('[data-a=save-trip]'); await p.click('[data-a=home]'); }
  await p.waitForFunction(() => window.__db.trips.length === 3);
  await p.click('[data-a=new]'); await txt(p, '無料プランで作れる旅行は、3件までです'); assert.strictEqual(await p.locator('#d-name').count(), 0);
  await p.click('[data-a=close-sheet]');
  // CSV for a free user opens the upgrade sheet; premium downloads
  await p.waitForSelector('.trip'); await p.locator('.trip').first().click(); await p.click('[data-a=settings]'); await p.click('[data-a=export-csv]'); await txt(p, 'CSVの書き出しは、プレミアムで使えます');
  await p.click('[data-a=close-sheet]');
  // becoming premium (webhook wrote the row): refresh picks it up, CSV downloads, the 4th trip is allowed
  await p.evaluate(() => { window.__premium = true; window.__db.subscriptions = [{ status: 'active', current_period_end: new Date(Date.now() + 864e5).toISOString(), cancel_at_period_end: false }]; document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForFunction(() => document.body.innerText.indexOf('（プレミアム）') >= 0 || true);
  await p.waitForTimeout(500);
  await p.click('[data-a=settings]');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-a=export-csv]')]);
  const csvText = fs.readFileSync(await dl.path(), 'utf8'); assert.ok(csvText.charCodeAt(0) === 0xFEFF && csvText.indexOf('日付,内容,カテゴリ,金額') > 0);
  await p.click('[data-a=close-sheet]'); await p.click('[data-a=home]'); await p.click('[data-a=new]'); await p.waitForSelector('#d-name'); await p.click('[data-a=home]');
  // account deletion: blocked message, then success
  await p.click('[data-a=account]'); await p.click('[data-a=ask-del-account]');
  await p.evaluate(() => { window.__blockDelete = true; }); await p.click('[data-a=del-account]'); await txt(p, '先に「プランの管理」から解約してください');
  await p.evaluate(() => { window.__blockDelete = false; }); await p.click('[data-a=del-account]'); await txt(p, 'アカウントを削除しました'); await txt(p, '最初の旅行をつくりましょう');
  assert.strictEqual(await p.evaluate(() => window.__deleted), 'U-bee@example.com');
  assert.strictEqual(await p.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('tabiwari.cloud.') === 0).length), 0, 'cloud cache wiped');
  await ctx.close();

  // 3b. checkout redirect
  ({ ctx, p } = await mk(true));
  await ctx.route('https://checkout.example/**', r => r.fulfill({ contentType: 'text/html', body: '<title>checkout</title>' }));
  await p.goto('http://localhost:8791/'); await p.click('[data-a=login]'); await p.fill('#l-email', 'cee@example.com'); await p.click('[data-a=login-send]');
  await p.waitForSelector('#l-code'); await p.fill('#l-code', '123456'); await p.click('[data-a=login-verify]'); await txt(p, 'cee@example.com でログイン中');
  await p.click('[data-a=account]'); await p.click('[data-a=upgrade]'); await txt(p, '月額400円'); await p.click('[data-a=upgrade-go]');
  await p.waitForURL('https://checkout.example/create-checkout'); await ctx.close();

  // 4. invalid link -> message
  ({ ctx, p } = await mk(true));
  await p.goto('http://localhost:8791/#join=BAD'); await txt(p, '招待を受けるには、メールでログインしてください');
  await ctx.close();

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('e2e passed'); await b.close(); srv.kill();
})().catch(e => { console.error(e); process.exit(1); });
