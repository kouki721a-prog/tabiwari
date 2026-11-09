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
      await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.TABIWARI={supabaseUrl:'http://fake',supabaseKey:'k'}" }));
      await ctx.route('**/vendor/supabase.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8') }));
    }
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
    return { ctx, p };
  };
  const txt = (p, s) => p.waitForSelector('text=' + s, { timeout: 3000 });

  // 1. local-only mode: no login UI, create trip + expense, nothing cloud-ish
  let { ctx, p } = await mk(false);
  await p.goto('http://localhost:8791/'); await txt(p, 'サンプル 箱根');
  assert.strictEqual(await p.locator('text=ログイン').count(), 0);
  await p.click('[data-a=new]'); await p.fill('#d-name', 'ローカル旅'); await p.fill('#d-budget', '30000'); await p.click('[data-a=save-trip]');
  await p.click('[data-a=add-exp]'); await p.fill('#f-amount', '500'); await p.click('[data-a=save-exp]'); await txt(p, '記録しました');
  await p.click('[data-a=settings]'); assert.ok(await p.locator('text=ログインすると、招待リンクで友だちを誘えます').count() === 1);
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
  await p.click('[data-a=home]'); await p.click('[data-a=logout]'); await txt(p, 'サンプル 箱根');
  assert.strictEqual(await p.locator('text=端末の旅').count(), 0);
  await ctx.close();

  // 3. invalid link -> message
  ({ ctx, p } = await mk(true));
  await p.goto('http://localhost:8791/#join=BAD'); await txt(p, '招待を受けるには、メールでログインしてください');
  await ctx.close();

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('e2e passed'); await b.close(); srv.kill();
})().catch(e => { console.error(e); process.exit(1); });
