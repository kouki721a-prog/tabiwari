/* Browser test for device-only features: undo after delete, expense search.  Needs playwright and a built dist/.   node test/ui.e2e.mjs */
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dist = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css' };
let slow = 0;   // a test can make the server slow, to see what comes from the service worker's cache
const srv = http.createServer((q, r) => { const pth = q.url.split('?')[0]; if (/^\/(terms|privacy)\.html$/.test(pth)){ r.writeHead(308, { Location: pth.replace('.html', '') }); return r.end(); }   // like the real host: x.html redirects to /x
  const f = path.join(dist, pth === '/' ? 'index.html' : /^\/(terms|privacy)$/.test(pth) ? pth + '.html' : pth); setTimeout(() => fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end('{}'); } else { r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' }); r.end(d); } }), slow); }).listen(8797);
const b = await chromium.launch(), errs = [];
const see = (p, t, ms = 5000) => p.waitForSelector('text=' + t, { timeout: ms });
try {
  const ctx = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.setViewportSize({ width: 390, height: 780 });
  await p.goto('http://localhost:8797/'); await see(p, '最初の旅行をつくりましょう');
  // the splash is plain HTML that is there before any script runs, and it is gone once the first screen is drawn
  assert.ok((await (await fetch('http://localhost:8797/')).text()).includes('<div id="splash"'), 'the splash is in the page itself'); await p.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 3000 });
  // the first screen: one screen without scrolling; main button right under the intro, then "join by link", the 3 steps, and the legal links at the very bottom
  { const y = sel => p.$eval(sel, e => e.getBoundingClientRect().top);
    const m = await p.$eval('.home0', e => ({ s: e.scrollHeight, c: e.clientHeight }));
    assert.ok(m.s <= m.c + 1, 'the first screen needs no scrolling: ' + JSON.stringify(m));
    const [intro, make, join, steps, legal] = [await y('.home0-intro'), await y('.home0 [data-a=new]'), await y('.home0 [data-a=join-paste]'), await y('.home0-steps'), await y('.home0 .legal')];
    assert.ok(intro < make && make < join && join < steps && steps < legal, JSON.stringify({ intro, make, join, steps, legal }));
    assert.ok(await p.$eval('.home0-intro', e => e.textContent.includes('予算を決めて記録するだけ。割り勘は自動で計算します。') && e.scrollWidth <= e.clientWidth), 'the intro sentence fits on one line');
    assert.strictEqual(await p.$$eval('.home0-intro', els => { const r = document.createRange(), n = els[0].lastChild; r.selectNodeContents(n); return r.getClientRects().length; }), 1, 'one line of text');
    assert.strictEqual(await p.locator('.home0-steps li').count(), 3); assert.strictEqual(await p.locator('.fab').count(), 0, 'no floating button on the first screen');
    assert.ok(await p.$eval('.home0-line', () => false).catch(() => true), 'no LINE login row without the server'); }
  await p.click('[data-a=new]'); await p.fill('#d-name', '箱根'); await p.fill('#d-budget', '100000');
  assert.strictEqual(await p.inputValue('#d-me'), '', 'your name starts empty');
  await p.click('[data-a=save-trip]'); await see(p, 'あなたの名前を入力してください'); assert.strictEqual(await p.locator('text=旅行をつくる').count() > 0, true, 'still on the create screen');
  await p.fill('#d-me', '   '); await p.click('[data-a=save-trip]'); await see(p, 'あなたの名前を入力してください');
  await p.fill('#d-me', 'あおい'); await p.click('[data-a=save-trip]');
  const add = async (amount, title) => { await p.click('[data-a=add-exp]'); await p.fill('#f-amount', String(amount)); await p.fill('#f-title', title); await p.click('[data-a=save-exp]'); await see(p, title); };

  // screen-reader basics: one main landmark, a level-1 heading, a named dialog that takes focus, the current tab marked, decorative letters hidden
  assert.strictEqual(await p.locator('main#app').count(), 1);
  await p.click('[data-a=add-exp]'); await p.waitForSelector('.sheet');
  assert.strictEqual(await p.getAttribute('.sheet', 'aria-labelledby'), 'sheet-title'); assert.ok((await p.textContent('#sheet-title')).length > 0);
  assert.strictEqual(await p.evaluate(() => document.activeElement && document.activeElement.className), 'sheet', 'the dialog gets focus when it opens (without opening the keyboard)');
  await p.click('[data-a=close-sheet]');
  assert.strictEqual(await p.getAttribute('.tab.on', 'aria-current'), 'page');

  // home with trips: a settings button at the top right replaces the three small links at the bottom; the settings sheet holds the rules and the version
  await p.click('[data-a=home]'); await p.waitForSelector('.home1');
  { const m = await p.evaluate(() => { const b = document.querySelector('[data-a=app-settings]').getBoundingClientRect(), h = document.querySelector('.brand').getBoundingClientRect(), fab = document.querySelector('.fab').getBoundingClientRect(); return { right: innerWidth - b.right, sameRow: Math.abs((b.top + b.bottom) / 2 - (h.top + h.bottom) / 2) < 14, scrolls: document.documentElement.scrollHeight - innerHeight, links: document.querySelectorAll('.home1 .legal, .foot1').length, fabBottom: innerHeight - fab.bottom }; });
    assert.ok(m.right < 40 && m.sameRow && m.scrolls <= 1 && m.links === 0, 'settings button at the top right, no footer links: ' + JSON.stringify(m)); }
  await p.click('[data-a=app-settings]'); await see(p, '規約'); await see(p, '利用規約'); await see(p, 'プライバシーポリシー'); await see(p, 'このアプリについて');
  assert.strictEqual(await p.locator('.sheet [data-a=line-login]').count(), 0, 'no LINE login without the server'); await p.click('[data-a=close-sheet]');
  await p.locator('.trip').first().click(); await p.waitForSelector('[data-a=add-exp]');

  // trip screen, no expenses yet: short guidance without an orphaned "す。", a button that opens the same sheet as the + button, members row with an invite button, "残りN日" label
  await see(p, '最初の支出を記録しましょう'); await see(p, '＋ボタンから入力できます');
  { const m = await p.evaluate(() => { const e = document.querySelector('.exp0'), lines = Array.from(e.querySelectorAll('b,span')).map(x => { const r = document.createRange(); r.selectNodeContents(x); return r.getClientRects().length; });
      const lab = Array.from(document.querySelectorAll('.t-bot .t-label')).map(x => x.textContent); return { lines, lab, hasBtn: !!e.querySelector('[data-a=add-exp]'), mem: !!document.querySelector('.mem-row [data-a=invite]'), avs: document.querySelectorAll('.mem-row .av').length }; });
    assert.deepStrictEqual(m.lines, [1, 1], 'each guidance line stays on one line: ' + JSON.stringify(m)); assert.ok(m.hasBtn && m.mem && m.avs === 1, JSON.stringify(m));
    assert.ok(/^1日あたりの目安（残り\d+日）$/.test(m.lab[0]), 'label: ' + m.lab[0]); assert.ok(!(await p.textContent('.ticket')).includes('今日からの1日目安')); }
  await p.click('.exp0 [data-a=add-exp]'); await p.waitForSelector('#f-amount'); await p.click('[data-a=close-sheet]');

  // the record screen: alone -> no pickers, invite instead; amount field; 0 yen cannot be saved; today is shown as 今日
  await p.click('.plus'); await p.waitForSelector('#f-amount');
  assert.strictEqual(await p.locator('[data-a=pick-payer]').count(), 0, 'alone: no "who paid" chips'); assert.strictEqual(await p.locator('[data-a=toggle-split]').count(), 0); await see(p, '友だちを招待すると、割り勘できます'); assert.strictEqual(await p.locator('.alone [data-a=invite]').count(), 1);
  assert.strictEqual(await p.$eval('[data-a=save-exp]', e => e.disabled), true, '0 yen: cannot be saved'); assert.strictEqual(await p.$eval('[data-a=save-exp]', e => +getComputedStyle(e).opacity < 0.6), true, 'and looks faded');
  assert.strictEqual(await p.textContent('#f-datetext'), '今日'); assert.strictEqual(await p.evaluate(() => document.activeElement && document.activeElement.id === 'f-amount'), false, 'the keyboard does not open by itself');
  { const bx = await p.$eval('.amount-wrap', e => e.getBoundingClientRect().height), border = await p.$eval('.amount-wrap', e => getComputedStyle(e).borderTopWidth); assert.ok(bx > 0 && border !== '0px', 'the amount sits in a bordered box'); }
  await p.fill('#f-amount', '0'); assert.strictEqual(await p.$eval('[data-a=save-exp]', e => e.disabled), true); await p.fill('#f-amount', '1200'); assert.strictEqual(await p.$eval('[data-a=save-exp]', e => e.disabled), false, 'a positive amount enables saving');
  { const gap = await p.evaluate(() => { const i = document.getElementById('f-amount').getBoundingClientRect(), y = document.querySelector('.amount-wrap > span').getBoundingClientRect(); return y.left - i.right; }); assert.ok(gap >= 0 && gap < 14, '円 sits right next to the digits: ' + gap); }
  await p.fill('#f-date', '2026-01-02'); await p.dispatchEvent('#f-date', 'change'); assert.strictEqual(await p.textContent('#f-datetext'), '1/2(金)', 'other days show the date');
  await p.click('[data-a=close-sheet]');
  // several members: selected chips are filled; "全員" and single people exclude each other
  { const c2 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c2.newPage(); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const ms = ['あ', 'い', 'う'].map((x, i) => ({ id: 'm' + i, name: x, pos: i })); const d = new Date(), pad = n => (n < 10 ? '0' : '') + n, today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '三人旅', start: today, end: today, budget: 90000, members: ms, paid: {}, savings: {}, expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.click('.plus'); await q.waitForSelector('#f-amount');
    const on = sel => q.$$eval(sel + '.on', els => els.map(e => e.textContent.trim())), css = sel => q.$eval(sel, e => { const c = getComputedStyle(e); return [c.backgroundColor, c.color]; });
    assert.deepStrictEqual(await on('[data-a=split-all]'), ['全員'], 'starts with 全員 selected'); assert.strictEqual((await on('[data-a=toggle-split]')).length, 0, 'single people are not selected while 全員 is');
    assert.deepStrictEqual(await css('[data-a=split-all].on'), ['rgb(15, 39, 66)', 'rgb(255, 255, 255)'], 'selected: dark background, white text');
    const off = await q.$eval('[data-a=toggle-split][data-v=m1]', e => { const c = getComputedStyle(e); return [c.backgroundColor, c.borderTopWidth]; }); assert.ok(off[0] === 'rgb(255, 255, 255)' && off[1] !== '0px', 'not selected: white background with a border: ' + off);
    await q.click('[data-a=toggle-split][data-v=m1]'); assert.strictEqual((await on('[data-a=split-all]')).length, 0, 'a single person turns 全員 off'); assert.strictEqual((await on('[data-a=toggle-split]')).length, 1);
    await q.click('[data-a=toggle-split][data-v=m2]'); assert.strictEqual((await on('[data-a=toggle-split]')).length, 2);
    await q.click('[data-a=split-all]'); assert.strictEqual((await on('[data-a=toggle-split]')).length, 0, '全員 clears the single selections'); assert.strictEqual((await on('[data-a=split-all]')).length, 1);
    await q.click('[data-a=pick-payer][data-v=m1]'); assert.strictEqual((await on('[data-a=pick-payer]')).length, 1, 'one payer is selected');
    await q.fill('#f-amount', '3000'); await q.click('[data-a=toggle-split][data-v=m0]'); await q.click('[data-a=toggle-split][data-v=m2]'); await q.click('[data-a=save-exp]'); await q.waitForSelector('text=記録しました');
    await q.click('.item[data-a=edit-exp]'); await q.waitForSelector('#f-amount'); assert.strictEqual((await on('[data-a=toggle-split]')).length, 2, 'editing keeps the two people'); assert.strictEqual((await on('[data-a=split-all]')).length, 0); }

  // rounds of settlement: confirm, later receipts form the next round, history, edits/deletes of a closed round add an adjustment to the current one
  { const c3 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c3.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const d = new Date(), pad = n => (n < 10 ? '0' : '') + n, today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), ms = [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }];
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '箱根', start: today, end: today, budget: 100000, members: ms, paid: {}, savings: {},
        expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'a', cat: 'food', date: today, split: ['a', 'b'] }, { id: 'e2', title: '宿', amount: 6000, payer: 'a', cat: 'stay', date: today, split: ['a', 'b'] }] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.click('[data-a=tab][data-t=settle]');
    await see(q, '第1回の精算'); await see(q, '5,000'); const left = () => q.$eval('.t-amount', e => e.textContent);
    assert.strictEqual(await left(), '90,000円', 'budget before');
    // the manual LINE sending is gone (settlement notices are automatic); the paid check and the remaining amount stay
    { await see(q, 'あと1件・残り 5,000円'); assert.strictEqual(await q.locator('.xfer .ask, [data-a=copy-settle], textarea.copybox').count(), 0, 'no manual LINE sending');
      await q.click('.xfer .paidbtn'); await q.waitForSelector('.xfer.done'); await see(q, 'すべて完了'); assert.ok((await q.$eval('.xfer.done .amt', e => getComputedStyle(e).textDecorationLine)).includes('line-through'));
      await q.click('.xfer .paidbtn'); await q.waitForSelector('.xfer:not(.done)'); }
    await q.click('[data-a=settle-ask]'); await see(q, '第1回の精算を完了する'); await see(q, '2件（合計 10,000円）'); await q.click('[data-a=settle-go]'); await see(q, '第1回の精算を完了しました');
    await see(q, '未精算の支出はありません'); await see(q, '精算の履歴'); assert.strictEqual(await q.locator('[data-a=settle-ask]').count(), 0, 'nothing to settle'); assert.strictEqual(await left(), '90,000円', 'budget ignores rounds');
    // a receipt found later -> round 2
    await q.click('.plus'); await q.fill('#f-amount', '600'); await q.click('[data-a=pick-payer][data-v=b]'); await q.click('[data-a=save-exp]'); await q.waitForSelector('text=記録しました');
    await q.click('[data-a=tab][data-t=settle]'); await see(q, '第2回の精算'); await see(q, '300円'); assert.strictEqual(await left(), '89,400円');
    // history: one entry, with the money of round 1; its detail lists the transfer and the expenses
    assert.strictEqual(await q.locator('[data-a=settle-open]').count(), 1); await see(q, '支出 10,000円・送金 1件'); await q.click('[data-a=settle-open]'); await see(q, 'けんた → あおい'.length ? '第1回の精算' : ''); await see(q, '夕食'); await see(q, '宿');
    assert.ok((await q.textContent('.sheet')).includes('5,000円'), 'round 1 transfer'); await q.click('[data-a=close-sheet]');
    // editing a settled expense: warned first, then the difference goes to round 2 and round 1 stays
    await q.click('[data-a=tab][data-t=exp]'); await q.locator('.item[data-a=edit-exp]', { hasText: '第1回で精算済み' }).first().click(); await see(q, '第1回で精算済みです。');
    const priceNow = await q.$eval('#f-amount', e => e.value); await q.fill('#f-amount', priceNow === '6000' ? '8000' : '5000'); await q.click('[data-a=save-exp]'); await see(q, '精算済みの支出を変更します'); await q.click('[data-a=settled-cancel]');
    assert.strictEqual(await q.locator('text=精算済みの支出を変更します').count(), 0, 'cancel closes the warning'); await q.click('[data-a=save-exp]'); await q.click('[data-a=save-exp]'); await q.waitForSelector('text=保存しました');
    await q.click('[data-a=tab][data-t=settle]'); await see(q, '過去の精算の変更による差額'); await q.click('[data-a=settle-open]'); assert.ok((await q.textContent('.sheet')).includes('5,000円'), 'round 1 transfer is unchanged after the edit'); await q.click('[data-a=close-sheet]');
    // deleting a settled expense, then undoing: the adjustment goes away with it
    const adjBefore = await q.locator('text=の削除').count(); await q.click('[data-a=tab][data-t=exp]'); await q.locator('.item[data-a=edit-exp]', { hasText: '宿' }).click(); await q.click('[data-a=ask-del]'); await see(q, '精算済みです。削除すると、差額が第2回の精算に入ります'); await q.click('[data-a=del-exp]'); await see(q, '削除しました');
    await q.click('[data-a=tab][data-t=settle]'); await see(q, '「宿」の削除'); await q.click('[data-a=undo]'); await q.waitForSelector('text=元に戻しました'); assert.strictEqual(await q.locator('text=「宿」の削除').count(), 0, 'undo removes the adjustment');
    // the next round can be closed again and the history grows
    await q.click('[data-a=settle-ask]'); await q.click('[data-a=settle-go]'); await see(q, '第2回の精算を完了しました'); assert.strictEqual(await q.locator('[data-a=settle-open]').count(), 2); assert.deepStrictEqual(qerrs, []); }

  // the search box appears only once there are enough expenses
  for (const [a, t] of [[1000, '朝食'], [2000, '昼食'], [3000, '夕食'], [4000, 'お土産'], [5000, 'ロープウェイ']]) await add(a, t);
  assert.strictEqual(await p.locator('#q-exp').count(), 0, 'no search box for a short list');
  await add(6000, '温泉');
  await p.fill('#q-exp', 'ロープ'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 1);
  await see(p, '1件・合計');
  await p.fill('#q-exp', '３０００'); await see(p, '夕食'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 1, 'full-width digits match the amount');
  await p.fill('#q-exp', 'あおい'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 6, 'the payer is searchable');
  await p.fill('#q-exp', '夕食 あおい'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 1, 'every word must match');
  await p.fill('#q-exp', '夕食 けんた'); await see(p, '見つかりませんでした');
  await p.fill('#q-exp', 'ほげ'); await see(p, '見つかりませんでした');
  await p.fill('#q-exp', ''); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 6);

  // undo after deleting an expense: it comes back to the same place
  const names = () => p.$$eval('.item[data-a=edit-exp] .t', els => els.map(e => e.textContent));
  const before = await names();
  await p.click('.item[data-a=edit-exp] >> text=夕食'); await p.click('[data-a=ask-del]'); await p.click('[data-a=del-exp]');
  await see(p, '削除しました'); assert.ok(!(await names()).includes('夕食'));
  await p.click('[data-a=undo]'); await see(p, '元に戻しました');
  assert.deepStrictEqual(await names(), before, 'restored in the same order');
  assert.strictEqual(await p.locator('[data-a=undo]').count(), 0, 'the undo button is gone after use');

  // CSV import: preview first, bad rows are skipped, duplicates are not added twice, and the whole import can be undone
  const csv = '日付,内容,カテゴリ,金額,払った人,割り勘の対象\n2026-11-02,ラーメン,食事,900,あおい,あおい\n2026-11-02,朝食,食事,1000,あおい,あおい\n2026-11-03,誰か,食事,500,たろう,あおい\n';
  await p.click('[data-a=settings]'); await p.setInputFiles('#csv-file', { name: 'trip.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await see(p, 'CSVを取り込む'); await see(p, '追加する支出：'); await see(p, '2件を取り込む'); await see(p, '4行目'); await see(p, '「たろう」は、この旅行のメンバーにいません');
  await p.click('[data-a=csv-import-go]'); await see(p, '2件を取り込みました'); await see(p, 'ラーメン'); assert.strictEqual((await names()).length, 8);
  await p.click('[data-a=undo]'); await see(p, '取り込みを取り消しました'); assert.deepStrictEqual(await names(), before);

  // undo after deleting a whole trip
  await p.click('[data-a=settings]'); await p.click('[data-a=ask-del-trip]'); await p.click('[data-a=del-trip]');
  await see(p, '旅行を削除しました'); await see(p, '最初の旅行をつくりましょう');
  await p.click('[data-a=undo]'); await see(p, '元に戻しました'); await see(p, '箱根');
  assert.strictEqual(await p.locator('h1').count(), 1, 'the home page has one level-1 heading'); assert.ok(/箱根/.test(await p.textContent('.trip .sr') + await p.textContent('.trip')) && /メンバー：あおい/.test(await p.textContent('.trip .sr')));
  await p.click('.trip'); await see(p, '夕食');

  // LINE login button follows LINE's colour rules: base #06C755 (no tint), white text, divider black 8%, black 30% only while pressed (under the text and logo, no hover shade)
  { const q = await (await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block', viewport: { width: 390, height: 780 } })).newPage();
    await q.route('**/api/me', r => r.fulfill({ json: { login: true, user: null, push: null } }));
    await q.goto('http://localhost:8797/'); await q.waitForSelector('.lineg');
    const st = await q.$eval('.lineg', e => { const c = getComputedStyle(e), a = getComputedStyle(e, '::after'), sp = getComputedStyle(e.querySelector('span')), im = getComputedStyle(e.querySelector('img'));
      return { bg: c.backgroundColor, filter: c.filter, opacity: c.opacity, text: c.color, divider: im.borderRightColor, over: a.opacity, overColor: a.backgroundColor, overZ: a.zIndex, textZ: sp.zIndex, imgZ: im.zIndex }; });
    assert.deepStrictEqual([st.bg, st.filter, st.opacity, st.text, st.divider, st.over, st.overColor], ['rgb(6, 199, 85)', 'none', '1', 'rgb(255, 255, 255)', 'rgba(0, 0, 0, 0.08)', '0', 'rgb(0, 0, 0)'], JSON.stringify(st));
    assert.ok(Number(st.overZ) < Number(st.textZ) && Number(st.overZ) < Number(st.imgZ), 'the overlay sits under the text and logo: ' + JSON.stringify(st));
    const box = await q.$eval('.lineg', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width - 20, y: r.y + r.height / 2 }; });
    await q.mouse.move(box.x, box.y); assert.strictEqual(await q.$eval('.lineg', e => getComputedStyle(e, '::after').opacity), '0', 'no hover shade');
    await q.mouse.down(); await q.waitForTimeout(100); assert.strictEqual(await q.$eval('.lineg', e => getComputedStyle(e, '::after').opacity), '0.3', 'pressed: black 30%'); await q.mouse.up(); }

  // "add to the home screen" guidance: benefit first, then the way that fits the browser
  { const UA = { ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.0.0',
      gsa: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/300.0.598994205 Mobile/15E148 Safari/604.1',
      android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    const open = async (ua, { standalone = false, login = false, ntf = null, init, size = { width: 390, height: 780 } } = {}) => {
      const c = await b.newContext({ userAgent: UA[ua], viewport: size, serviceWorkers: 'block' }), q = await c.newPage();
      await q.route('**/api/me', r => r.fulfill({ json: login ? { login: true, user: { name: 'あおい' }, push: 'B'.repeat(87) } : { login: false, user: null, push: null } }));
      await q.route('**/api/backup', r => r.fulfill({ json: { items: [] } }));
      await q.addInitScript(sa => { if (sa) Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }); }, standalone);
      await q.goto('http://localhost:8797/'); await q.waitForSelector('.home0');
      if (ntf){ await q.waitForFunction(() => typeof lineAcct !== 'undefined' && lineAcct.user); await q.evaluate(v => { ntfState = async () => v; return refreshNtfHome(); }, ntf); }
      if (init) await init(q);
      return q; };
    const benefit = 'ホーム画面に追加すると、すぐ開けて、前日のお知らせも届きます。';
    let q = await open('ios'); await see(q, benefit); await see(q, '共有ボタン'); await see(q, '「ホーム画面に追加」'); assert.strictEqual(await q.locator('[data-a=install]').count(), 0);
    q = await open('desktop'); await see(q, benefit); await see(q, 'アプリをインストール'); assert.strictEqual(await q.locator('[data-a=install]').count(), 0, 'unsupported browser: steps, no button');
    q = await open('android', { init: q2 => q2.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted = true; }; window.dispatchEvent(e); }) });
    await see(q, benefit); await q.click('[data-a=install]'); assert.strictEqual(await q.evaluate(() => window.__prompted), true, 'the button opens the install prompt');
    q = await open('line'); await see(q, 'Safariで開いてください'); await see(q, 'アプリ内ブラウザ'); assert.strictEqual(await q.locator('[data-a=copy-site]').count(), 1); assert.strictEqual(await q.locator('text=' + benefit).count(), 0);
    q = await open('gsa'); await see(q, 'Safariで開いてください'); assert.strictEqual(await q.locator('text=' + benefit).count(), 0, 'the Google app browser is treated like an in-app browser');
    q = await open('ios', { standalone: true }); assert.strictEqual(await q.locator('.install').count(), 0, 'opened from the home screen: no install guidance'); assert.strictEqual(await q.locator('[data-a=ntf-home]').count(), 0, 'not logged in: no notification button');
    q = await open('ios', { standalone: true, login: true, ntf: 'off' }); await see(q, '通知をオンにすると、前日のお知らせが届きます'); assert.strictEqual(await q.locator('[data-a=ntf-home]').count(), 1); assert.strictEqual(await q.locator('text=' + benefit).count(), 0);
    q = await open('ios', { standalone: true, login: true, ntf: 'on' }); assert.strictEqual(await q.locator('.install').count(), 0, 'notifications already on: nothing to show');
    q = await open('ios', { standalone: true, login: true, ntf: 'blocked' }); await see(q, '通知が許可されていません');
    // opened from the home screen: the main group is packed and centred (no stretched gaps), LINE login and the legal links stay at the bottom, and it fits without scrolling even on a small iPhone
    for (const [size, login, ntf] of [[{ width: 390, height: 780 }, false, null], [{ width: 375, height: 667 }, true, 'off'], [{ width: 375, height: 667 }, false, null]]) {
      q = await open('ios', { standalone: true, login, ntf, size });
      const m = await q.evaluate(() => { const t = s => document.querySelector(s).getBoundingClientRect(), h = document.querySelector('.home0'), card = document.querySelector('.home0-mid .install');
        return { fit: h.scrollHeight <= h.clientHeight + 1, joinToSteps: t('.home0-steps').top - t('[data-a=join-paste]').bottom, btnToJoin: t('[data-a=join-paste]').top - t('.home0 [data-a=new]').bottom, stepsToBottom: (document.querySelector('.home0-line') || document.querySelector('.legal')).getBoundingClientRect().top - t('.home0-steps').bottom,
          legalAtBottom: h.getBoundingClientRect().bottom - t('.legal').bottom, cardAbove: card ? t('.home0 [data-a=new]').top - card.getBoundingClientRect().bottom : null, titleBeforeMid: t('.brand').bottom <= t('.home0-mid').top + 1 }; });
      assert.ok(m.fit, 'fits without scrolling: ' + JSON.stringify(m)); assert.ok(m.joinToSteps <= 26 && m.btnToJoin <= 14, 'buttons and steps are packed together: ' + JSON.stringify(m));
      assert.ok(m.legalAtBottom <= 24, 'the legal links stay at the bottom: ' + JSON.stringify(m)); assert.ok(m.titleBeforeMid && m.stepsToBottom >= 0, JSON.stringify(m));
      if (ntf === 'off'){ assert.ok(m.cardAbove > 0, 'the notification card sits above the buttons: ' + JSON.stringify(m)); assert.strictEqual(await q.locator('.install [data-a=ntf-home]').count(), 1); } }
    // the notification card goes away once notifications are on
    q = await open('ios', { standalone: true, login: true, ntf: 'off' }); await q.evaluate(() => { ntfState = async () => 'on'; ntfOn = async () => 'on'; });
    await q.click('[data-a=ntf-home]'); await q.waitForFunction(() => !document.querySelector('[data-a=ntf-home]')); }

  // demo trip: three members, settlement rows with request buttons
  { const c4 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c4.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.goto('http://localhost:8797/'); await q.click('[data-a=new]'); await q.fill('#d-me', 'こうき'); await q.click('[data-a=make-demo]'); await see(q, '第1回の精算');
    assert.ok(await q.locator('.xfer').count() >= 1, 'the demo trip has transfers');
    await q.click('[data-a=tab][data-t=settle]'); assert.strictEqual(await q.locator('.item', { hasText: 'こうき' }).count() >= 1, true); assert.deepStrictEqual(qerrs, []); }

  // home cards: one line that says what to do next, yellow bar, the running trip stands out
  { const c5 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c5.newPage(); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }, ms = [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }];
      const T = (id, name, s, e, ex, extra = {}) => ({ id, name, start: d(s), end: d(e), budget: 30000, members: ms, paid: {}, savings: {}, expenses: ex, ...extra });
      const e1 = { id: 'e1', title: '食事', amount: 6000, payer: 'a', cat: 'food', date: d(-10), split: ['a', 'b'] };
      localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [T('now', '旅行中の旅', -1, 1, []), T('soon', '準備中の旅', 3, 4, [], { savings: { a: 10000 } }), T('open', '精算前の旅', -12, -9, [e1]),
        T('done', '精算済みの旅', -30, -28, [{ ...e1, id: 'e2', settleId: 's1' }], { settlements: [{ id: 's1', n: 1, at: d(-27), total: 6000, transfers: [{ from: 'b', to: 'a', amount: 3000 }] }] })] })); });
    await q.goto('http://localhost:8797/'); await q.waitForSelector('.home1');
    const hint = async name => q.$eval('.trip:has-text("' + name + '") .hint', e => e.textContent).catch(() => null);
    assert.ok(/^今日の目安 30,000円$|^今日の目安 1[0-9],[0-9]{3}円$/.test(await hint('旅行中の旅')), 'running: ' + await hint('旅行中の旅')); assert.strictEqual(await hint('準備中の旅'), 'あと3日で出発');
    assert.strictEqual(await hint('精算前の旅'), '精算があと1件'); assert.strictEqual(await hint('精算済みの旅'), null, 'a settled ended trip is not on home');
    assert.strictEqual(await q.locator('.trip.now').count(), 1, 'only the running trip stands out'); assert.strictEqual(await q.$eval('.trip .bar>i', e => getComputedStyle(e).backgroundColor), 'rgb(255, 200, 61)', 'the bar is the yellow accent');
    // before the trip the cards show the savings: home card, trip card, and the pace on the savings tab
    { const soon = q.locator('.trip', { hasText: '準備中の旅' }); assert.ok((await soon.textContent()).includes('積立（目標 30,000円）') && (await soon.textContent()).includes('10,000円'));
      assert.strictEqual(await soon.locator('.bar>i').evaluate(e => e.style.width), '33%', 'the bar shows the savings'); await soon.click(); await q.waitForSelector('.ticket.m');
      assert.ok((await q.textContent('.ticket.m')).includes('積立 10,000円（33%）') && (await q.textContent('.ticket.m')).includes('30,000円'), 'detail card'); await q.click('[data-a=tab][data-t=save]'); await q.waitForSelector('.ticket.c');
      const sv = await q.textContent('.ticket.c'); assert.ok(sv.includes('出発まで あと3日') && sv.includes('あと 20,000円・1日 約6,667円 ずつで届きます'), sv); await q.click('[data-a=home]'); }
    // trip recap image: offered on a finished trip with expenses (and in the trip settings), made on the device as a 1080x1350 PNG
    await q.locator('.trip', { hasText: '旅行中の旅' }).click(); await q.waitForSelector('[data-a=add-exp]'); assert.strictEqual(await q.locator('[data-a=recap]').count(), 0, 'nothing recorded: no recap'); await q.click('[data-a=home]');
    await q.locator('.trip', { hasText: '精算前の旅' }).click(); await q.waitForSelector('[data-a=recap]'); await q.click('.install [data-a=recap]'); await q.waitForSelector('.recap-img');
    const dim = await q.$eval('.recap-img', im => im.decode().then(() => [im.naturalWidth, im.naturalHeight])); assert.deepStrictEqual(dim, [1080, 1920], 'recap image size');
    assert.ok(await q.locator('a[download="tabiwari-recap.png"], [data-a=recap-share]').count() >= 1, 'a way to save or share it'); await q.click('[data-a=close-sheet]');
    await q.click('[data-a=settings]'); assert.strictEqual(await q.locator('.sheet [data-a=recap]').count(), 1, 'also from the trip settings'); await q.click('[data-a=close-sheet]'); await c5.close(); }

  // service worker: cache first. The app opens from the saved copy even when the server is slow; /api/ is never saved; the cache is named after the version
  { const c6 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'allow' }), q = await c6.newPage(); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.goto('http://localhost:8797/'); await q.evaluate(() => navigator.serviceWorker.ready); await q.waitForFunction(() => navigator.serviceWorker.controller || true);
    await q.reload(); await q.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 5000 });
    slow = 3000; const t0 = Date.now(); await q.reload(); await q.waitForSelector('.home0, .home1', { timeout: 6000 }); const took = Date.now() - t0; slow = 0;
    assert.ok(took < 2000, 'opened from the cache while the server needed 3 s: ' + took + ' ms');
    // the terms and privacy pages: the host redirects x.html to /x, and a saved copy that came through a redirect must still open as a page
    await q.goto('http://localhost:8797/terms.html'); await see(q, '利用規約'); await q.goto('http://localhost:8797/privacy.html'); await see(q, 'プライバシーポリシー'); await q.goto('http://localhost:8797/');
    const names = await q.evaluate(async () => { const ks = await caches.keys(); const out = []; for (const k of ks) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return { ks, out }; });
    assert.ok(names.ks.some(k => /^tabiwari-v\d+$/.test(k)) && names.out.includes('/') && !names.out.some(x => x.startsWith('/api/')), JSON.stringify(names)); await c6.close(); }

  // ひとことで記録: "夕食 2000円" is recorded at once (me paid, split among everyone, today), the toast can undo it, a line without an amount says what to write
  { const c7 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c7.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }], paid: {}, savings: {}, expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('#q-quick');
    await q.fill('#q-quick', '夕食'); await q.press('#q-quick', 'Enter'); await see(q, '金額が見つかりませんでした'); assert.strictEqual(await q.locator('.item[data-a=edit-exp]').count(), 0, 'nothing recorded');
    await q.fill('#q-quick', '夕食 2000円'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 2,000円を記録しました');
    assert.strictEqual(await q.locator('.item[data-a=edit-exp]').count(), 1); assert.strictEqual(await q.inputValue('#q-quick'), '', 'the field is emptied');
    assert.ok((await q.textContent('.item[data-a=edit-exp]')).includes('あおいが払った・全員で割り勘') && (await q.textContent('.item[data-a=edit-exp]')).includes('2,000円'));
    await q.fill('#q-quick', 'タクシー 1,200'); await q.click('.quick .btn'); await see(q, 'タクシー 1,200円を記録しました'); assert.strictEqual(await q.locator('.item[data-a=edit-exp]').count(), 2, 'the button works too');
    await q.click('[data-a=undo]'); await q.waitForFunction(() => document.querySelectorAll('.item[data-a=edit-exp]').length === 1);
    await q.fill('#q-quick', '夕食 3000円 けんたは半分'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 3,000円（けんた 0.5倍）を記録しました');
    assert.deepStrictEqual(await q.evaluate(() => state.trips[0].expenses.find(e => e.amount === 3000).parts), { a: 2, b: 1 }, 'the weight written after the name is kept'); assert.ok((await q.textContent('#exp-list')).includes('割合を指定して割り勘'));
    await q.fill('#q-quick', '夕食 3000円 けんたは4倍'); await q.press('#q-quick', 'Enter'); await see(q, '割合は、0.5倍から3倍まで'); assert.strictEqual(await q.evaluate(() => state.trips[0].expenses.length), 2, 'nothing recorded for a bad weight');
    // leaving a person out
    await q.fill('#q-quick', '夕食 2000円 けんたなし'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 2,000円（けんたなし）を記録しました');
    assert.deepStrictEqual(await q.evaluate(() => state.trips[0].expenses.filter(e => e.amount === 2000).pop().split), ['a'], 'only あおい shares it (the newest 2,000 yen one)'); assert.ok((await q.textContent('#exp-list')).includes('あおいの分'));
    await q.fill('#q-quick', '夕食 2000円 あおいなし けんた抜き'); await q.press('#q-quick', 'Enter'); await see(q, '全員を外すことは、できません'); assert.strictEqual(await q.evaluate(() => state.trips[0].expenses.length), 3, 'nothing recorded when everybody is left out');
    assert.deepStrictEqual(qerrs, []); await c7.close(); }

  // 割合を変える: a weight per person in the record sheet (0.5x to 3x), shown in the hint and the list, used by the settlement; taking it away goes back to equal
  { const c8 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c8.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'こども', pos: 1 }], paid: {}, savings: {}, expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.click('nav [data-a=add-exp]'); await q.waitForSelector('#f-amount');
    await q.fill('#f-amount', '3000'); assert.ok((await q.textContent('#f-hint')).includes('1人あたり 1,500円'), await q.textContent('#f-hint'));
    await q.click('[data-a=parts-toggle]'); await q.waitForSelector('.prow'); assert.strictEqual(await q.locator('.prow').count(), 2); assert.deepStrictEqual(await q.locator('.pval').allTextContents(), ['1倍', '1倍']);
    await q.locator('[data-a=part-dec]').nth(1).click(); assert.deepStrictEqual(await q.locator('.pval').allTextContents(), ['1倍', '0.5倍']); assert.deepStrictEqual(await q.locator('.pamt').allTextContents(), ['2,000円', '1,000円']);
    assert.ok((await q.textContent('#f-hint')).includes('割合あり'), await q.textContent('#f-hint')); await q.fill('#f-amount', '4500'); assert.deepStrictEqual(await q.locator('.pamt').allTextContents(), ['3,000円', '1,500円'], 'the amounts follow the amount while typing'); await q.fill('#f-amount', '3000');
    await q.click('[data-a=save-exp]'); await see(q, '割合を指定して割り勘'); assert.deepStrictEqual(await q.evaluate(() => state.trips[0].expenses[0].parts), { a: 2, b: 1 });
    await q.click('[data-a=tab][data-t=settle]'); await see(q, 'こども → あおい'); assert.ok((await q.textContent('.xfer')).includes('1,000円'), 'the child owes 1,000 yen (not 1,500)');
    await q.click('[data-a=tab][data-t=exp]'); await q.click('.item[data-a=edit-exp]'); await q.waitForSelector('.prow'); assert.deepStrictEqual(await q.locator('.pval').allTextContents(), ['1倍', '0.5倍'], 'the weights come back when editing');
    await q.locator('[data-a=part-inc]').nth(1).click(); await q.click('[data-a=save-exp]'); await see(q, '全員で割り勘'); assert.strictEqual(await q.evaluate(() => state.trips[0].expenses[0].parts), undefined, 'equal again: no weights kept'); assert.deepStrictEqual(qerrs, []); await c8.close(); }

  // 同じメンバーで次の旅行: only an ended trip with friends gets the button; it fills the form from that trip, and opens the invite after making it
  { const c9 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c9.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { localStorage.setItem('tabiwari.noinstall', '1');
      const m = [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }, { id: 'c', name: 'けんた', pos: 2 }], base = { paid: {}, savings: {}, expenses: [] };
      localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ ...base, id: 'old', name: '箱根', start: '2020-10-10', end: '2020-10-12', budget: 60000, members: m },
        { ...base, id: 'solo', name: 'ひとり旅', start: '2020-05-01', end: '2020-05-02', budget: 20000, members: [m[0]] }] })); });
    await q.goto('http://localhost:8797/'); await q.waitForSelector('[data-a=past]'); await q.click('[data-a=past]'); await q.waitForSelector('.trip'); assert.strictEqual(await q.locator('[data-a=next-trip]').count(), 1, 'only the ended trip with friends has the button');
    await q.evaluate(() => { window.__inv = 0; document.addEventListener('click', e => { if (e.target.closest('[data-a=invite]')) window.__inv++; }, true); });
    await q.click('[data-a=next-trip]'); await q.waitForSelector('#d-name');
    assert.strictEqual(await q.inputValue('#d-name'), '箱根（次の旅行）'); assert.strictEqual(await q.inputValue('#d-budget'), '60000'); assert.strictEqual(await q.inputValue('#d-me'), 'こうき');
    const [s0, e0] = [await q.inputValue('#d-start'), await q.inputValue('#d-end')]; assert.strictEqual((Date.parse(e0) - Date.parse(s0)) / 864e5, 2, 'same length as the old trip (3 days)');
    assert.ok((await q.textContent('.scroll')).includes('あおい、けんた'), 'the old friends are named'); assert.ok(!(await q.textContent('.scroll')).includes('あおい、けんた、こうき'), 'my own name is not listed');
    await q.click('[data-a=save-trip]'); await q.waitForSelector('.ticket');
    assert.deepStrictEqual(await q.evaluate(() => [state.trips.length, state.trips[2].name, state.trips[2].members.map(m => m.name), state.trips[2].expenses.length, state.trips[0].members.length]), [3, '箱根（次の旅行）', ['こうき'], 0, 3], 'a new trip with only me; the old one is untouched');
    await q.waitForFunction(() => window.__inv === 1); assert.strictEqual(await q.evaluate(() => window.__inv), 1, 'the invite opens right after making it');
    // a plain new trip does not open the invite
    await q.click('[data-a=home]'); await q.click('[data-a=new]'); await q.waitForSelector('#d-name'); assert.strictEqual(await q.locator('.panel').count(), 0, 'no hint on a plain new trip');
    assert.deepStrictEqual(qerrs, []); await c9.close(); }

  // 終了した旅行のページ: ended and settled trips leave the home screen; an ended trip with money left to settle stays
  { const c10 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c10.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { localStorage.setItem('tabiwari.noinstall', '1');
      const m = [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }], base = { paid: {}, savings: {}, settlements: [], adjustments: [], members: m },
        far = (id, name, start, end) => ({ ...base, id, name, start, end, budget: 50000, expenses: [] });
      localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [far('p1', '古い旅', '2020-01-01', '2020-01-02'), far('p2', '新しい旅', '2021-01-01', '2021-01-02'), far('fut', '先の旅', '2099-01-01', '2099-01-02'),
        { ...base, id: 'open', name: '精算待ちの旅', start: '2020-06-01', end: '2020-06-02', budget: 50000, expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'a', cat: 'food', date: '2020-06-01', split: ['a', 'b'] }] }] })); });
    await q.goto('http://localhost:8797/'); await q.waitForSelector('.trip');
    assert.deepStrictEqual(await q.locator('.trip .trip-name').allTextContents(), ['先の旅', '精算待ちの旅'], 'home: the upcoming trip and the ended trip that still needs settling');
    assert.ok((await q.textContent('[data-a=past]')).includes('2件'), 'a row for the 2 settled ones'); assert.strictEqual(await q.locator('[data-a=new]').count(), 1);
    await q.click('[data-a=past]'); await q.waitForSelector('h1'); assert.strictEqual(await q.textContent('h1'), '終了した旅行');
    assert.deepStrictEqual(await q.locator('.trip .trip-name').allTextContents(), ['新しい旅', '古い旅'], 'newest first, and only the settled ones');
    await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.click('[data-a=home]'); await q.waitForSelector('h1:has-text("終了した旅行")');   // back goes to the page it came from
    await q.click('[data-a=home]'); await q.waitForSelector('[data-a=past]'); assert.deepStrictEqual(await q.locator('.trip .trip-name').allTextContents(), ['先の旅', '精算待ちの旅']);
    await q.click('.trip >> nth=1'); await q.waitForSelector('[data-a=add-exp]'); await q.click('[data-a=home]'); await q.waitForSelector('[data-a=past]');   // opened from home: back goes home
    assert.deepStrictEqual(qerrs, []); await c10.close(); }

  // 受け取り方のメモ: written in the settlement tab, shown under the transfer to the receiver (with a copy button), carried to the next trip, never autofocused
  { const c11 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] }), q = await c11.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, paid: {}, savings: {}, settlements: [], adjustments: [],
        members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1, note: '現金でOK' }],
        expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'b', cat: 'food', date: t, split: ['a', 'b'] }] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.click('[data-a=tab][data-t=settle]'); await q.waitForSelector('.noteRow');
    assert.ok((await q.textContent('.noteRow')).includes('書いておくと'), 'asks to write one'); assert.ok((await q.textContent('.xnote')).includes('あおいさんの受け取り方：現金でOK'), "the receiver's memo is under the transfer");
    await q.click('[data-a=copy-note]'); assert.strictEqual(await q.evaluate(() => navigator.clipboard.readText()), '現金でOK', 'the copy button copies only the memo');
    await q.click('.noteRow'); await q.waitForSelector('#f-note'); assert.strictEqual(await q.evaluate(() => document.activeElement && document.activeElement.id === 'f-note'), false, 'the keyboard does not open by itself');
    await q.click('[data-a=note-chip][data-v="PayPay："]'); assert.strictEqual(await q.inputValue('#f-note'), 'PayPay：'); await q.fill('#f-note', 'PayPay：kouki-0101'); await q.click('[data-a=note-save]');
    await q.waitForSelector('.noteRow'); assert.ok((await q.textContent('.noteRow')).includes('PayPay：kouki-0101'));
    assert.deepStrictEqual(await q.evaluate(() => [state.trips[0].members[0].note, state.payNote]), ['PayPay：kouki-0101', 'PayPay：kouki-0101']);
    assert.strictEqual(await q.evaluate(() => sanitizeTrip(JSON.parse(JSON.stringify(state.trips[0])), 'n').members.map(m => m.note).join('|')), 'PayPay：kouki-0101|現金でOK', 'a restored or imported trip keeps the memos');
    // the next trip starts with the same memo
    await q.click('[data-a=home]'); await q.click('[data-a=new]'); await q.fill('#d-name', '次'); await q.fill('#d-budget', '10000'); await q.fill('#d-me', 'こうき'); await q.click('[data-a=save-trip]'); await q.waitForSelector('.ticket');
    assert.strictEqual(await q.evaluate(() => state.trips[1].members[0].note), 'PayPay：kouki-0101');
    await q.click('[data-a=tab][data-t=settle]'); await q.click('.noteRow'); await q.click('[data-a=note-clear]'); await q.waitForSelector('.noteRow');
    assert.deepStrictEqual(await q.evaluate(() => [state.trips[1].members[0].note, state.payNote]), [undefined, undefined], 'clearing takes the memo away');
    assert.deepStrictEqual(qerrs, []); await c11.close(); }

  // 金額の指定: tap a person's amount, type the amount they pay; the rest goes to the others; errors are explained; the keyboard stays closed
  { const c12 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c12.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'こども', pos: 1 }, { id: 'c', name: 'けんた', pos: 2 }], paid: {}, savings: {}, expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.click('nav [data-a=add-exp]'); await q.waitForSelector('#f-amount');
    await q.fill('#f-amount', '5000'); await q.click('[data-a=parts-toggle]'); await q.waitForSelector('.prow');
    assert.ok((await q.textContent('.fxnote')).includes('金額を押すと'), 'the panel explains how'); assert.deepStrictEqual(await q.locator('[data-pamt]').allTextContents(), ['1,666円', '1,667円', '1,667円']);
    await q.click('[data-a=fx-on][data-pamt="c"]'); await q.waitForSelector('.fxin'); assert.strictEqual(await q.inputValue('.fxin'), '1667', 'it starts at what the person pays now');
    assert.strictEqual(await q.evaluate(() => document.activeElement && document.activeElement.classList.contains('fxin')), false, 'the keyboard does not open by itself');
    await q.fill('.fxin', '1000'); assert.deepStrictEqual(await q.locator('[data-pamt]').allTextContents(), ['2,000円', '2,000円'], 'the others share the rest'); assert.ok((await q.textContent('.fxnote')).includes('けんたの1,000円を引いた 4,000円 を、ほかの2人で分けます。'), await q.textContent('.fxnote'));
    assert.ok((await q.textContent('#f-hint')).includes('金額指定あり'), await q.textContent('#f-hint'));
    await q.fill('.fxin', '9000'); assert.ok((await q.textContent('.fxnote')).includes('超えています')); await q.click('[data-a=save-exp]'); await see(q, '指定の合計が、金額を超えています。'); assert.strictEqual(await q.evaluate(() => state.trips[0].expenses.length), 0, 'nothing recorded');
    await q.fill('.fxin', '1000'); await q.locator('[data-a=part-dec]').first().click(); assert.deepStrictEqual(await q.locator('[data-pamt]').allTextContents(), ['1,333円', '2,667円'], 'weights still apply to the others (あおい 0.5x of 4,000)'); await q.locator('[data-a=part-inc]').first().click();
    await q.click('[data-a=save-exp]'); await see(q, '金額を指定して割り勘'); assert.deepStrictEqual(await q.evaluate(() => state.trips[0].expenses[0].fixed), { c: 1000 });
    await q.click('[data-a=tab][data-t=settle]'); await see(q, 'けんた'); assert.deepStrictEqual(await q.evaluate(() => calcBalances(state.trips[0]).owed), { a: 2000, b: 2000, c: 1000 });
    await q.click('[data-a=tab][data-t=exp]'); await q.click('.item[data-a=edit-exp]'); await q.waitForSelector('.fxin'); assert.strictEqual(await q.inputValue('.fxin'), '1000', 'it comes back when editing');
    await q.click('[data-a=fx-off]'); await q.waitForFunction(() => !document.querySelector('.fxin')); await q.click('[data-a=save-exp]'); await see(q, '全員で割り勘'); assert.strictEqual(await q.evaluate(() => state.trips[0].expenses[0].fixed), undefined, 'equal again: no fixed amounts kept');
    assert.deepStrictEqual(qerrs, []); await c12.close(); }

  // ひとことで記録: 金額の指定 (「けんたは1000円だけ」)
  { const c13 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c13.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }, { id: 'c', name: 'みく', pos: 2 }], paid: {}, savings: {}, expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('#q-quick');
    await q.fill('#q-quick', '夕食 5000円 けんたは1000円だけ'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 5,000円（けんた 1,000円だけ）を記録しました');
    assert.deepStrictEqual(await q.evaluate(() => { const e = state.trips[0].expenses[0]; return [e.amount, e.fixed, e.split]; }), [5000, { b: 1000 }, ['a', 'b', 'c']]);
    assert.deepStrictEqual(await q.evaluate(() => calcBalances(state.trips[0]).owed), { a: 2000, b: 1000, c: 2000 }); assert.ok((await q.textContent('#exp-list')).includes('金額を指定して割り勘'));
    await q.fill('#q-quick', '夕食 5000円 けんたは9000円だけ'); await q.press('#q-quick', 'Enter'); await see(q, '指定の合計が、金額を超えています。'); assert.strictEqual(await q.evaluate(() => state.trips[0].expenses.length), 1, 'nothing recorded');
    await q.fill('#q-quick', '夕食 5000円 あおいは1000円だけ けんたは1000円だけ みくは1000円だけ'); await q.press('#q-quick', 'Enter'); await see(q, '全員を指定するときは、合計を金額と同じにしてください。');
    await q.fill('#q-quick', '夕食 5000円 みくなし あおいは1000円だけ'); await q.press('#q-quick', 'Enter'); await see(q, 'あおい 1,000円だけ'); assert.deepStrictEqual(await q.evaluate(() => { const e = state.trips[0].expenses[1]; return [e.split, e.fixed]; }), [['a', 'b'], { a: 1000 }], 'a person left out and a fixed amount together');
    assert.deepStrictEqual(qerrs, []); await c13.close(); }

  // カテゴリごとの上限: set from the card of the record tab; "used／limit" in red when over; a one-time notice when an expense crosses it
  { const c14 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c14.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }], paid: {}, savings: {}, expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('#q-quick');
    assert.ok((await q.textContent('.usage.thin')).includes('カテゴリごとの上限を決める'), 'a thin row before anything is recorded');
    await q.click('.usage'); await q.waitForSelector('[data-cap]'); assert.strictEqual(await q.locator('[data-cap]').count(), 6); assert.strictEqual(await q.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-cap')), false, 'the keyboard does not open by itself');
    await q.fill('[data-cap=food]', '1x'); await q.click('[data-a=caps-save]'); await see(q, '上限は、1以上の数字で入力してください'); assert.strictEqual(await q.evaluate(() => state.trips[0].caps), undefined);
    await q.fill('[data-cap=food]', '5,000'); await q.fill('[data-cap=gift]', '3000'); await q.click('[data-a=caps-save]'); await see(q, '上限を保存しました'); assert.deepStrictEqual(await q.evaluate(() => state.trips[0].caps), { food: 5000, gift: 3000 });
    assert.ok((await q.textContent('.legend2')).includes('食事 0／5,000') && (await q.textContent('.legend2')).includes('お土産 0／3,000'), 'the categories with a limit show even when unused');
    await q.fill('#q-quick', '夕食 4000円'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 4,000円を記録しました'); assert.ok(!(await q.textContent('.toast, [role=status]').catch(() => '')).includes('超えました'));
    await q.fill('#q-quick', '夕食 2000円'); await q.press('#q-quick', 'Enter'); await see(q, '食事が、上限を 1,000円 超えました。');
    assert.ok((await q.textContent('.legend2 .over')).includes('食事 6,000／5,000（1,000円超え）'), await q.textContent('.legend2')); assert.strictEqual(await q.evaluate(() => getComputedStyle(document.querySelector('.legend2 .over')).color), 'rgb(194, 51, 45)');
    await q.fill('#q-quick', '夕食 500円'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 500円を記録しました'); assert.ok(!(await q.innerText('body')).includes('上限を 1,500円 超えました'), 'only the crossing is announced, not every expense after it');
    await q.click('.usage'); await q.waitForSelector('[data-cap]'); await q.fill('[data-cap=food]', ''); await q.fill('[data-cap=gift]', ''); await q.click('[data-a=caps-save]'); await see(q, '上限を外しました'); assert.strictEqual(await q.evaluate(() => state.trips[0].caps), undefined);
    assert.deepStrictEqual(qerrs, []); await c14.close(); }

  // たびまる: the buttons show only when the server has it on; login is needed; a proposal is confirmed before anything is recorded; limits and errors are explained
  { const c15 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c15.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message));
    let status = { enabled: false, login: false, remaining: null }, parse = null; const sent = [];
    await q.route('**/api/**', r => { const u = r.request().url();
      if (u.endsWith('/api/ai/status')) return r.fulfill({ status: 200, json: status });
      if (u.endsWith('/api/ai/parse')) { sent.push(JSON.parse(r.request().postData())); return setTimeout(() => r.fulfill(parse), 250); }
      return r.fulfill({ status: 404, json: {} }); });
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }, { id: 'c', name: 'みく', pos: 2 }], paid: {}, savings: {}, expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('#q-quick'); await q.waitForTimeout(300);
    assert.strictEqual(await q.locator('.aibtn').count(), 0, 'off on the server: no buttons');
    status = { enabled: true, login: false, remaining: null }; await q.evaluate(() => refreshAi()); await q.waitForSelector('.aibtn'); assert.strictEqual(await q.locator('.aibtn').count(), 2);
    await q.fill('#q-quick', '昨日の夕食、けんたが立て替えて3人で割った 6000円'); await q.click('[data-a=ai-text]'); await see(q, 'LINEでログインすると、たびまるに頼めます。'); assert.strictEqual(sent.length, 0, 'not logged in: nothing is sent');
    status = { enabled: true, login: true, remaining: 5 }; await q.evaluate(() => refreshAi()); await q.waitForFunction(() => ui.ai.login);
    await q.fill('#q-quick', ''); await q.click('[data-a=ai-text]'); await see(q, '文章を、入力欄に書いてください'); assert.strictEqual(sent.length, 0, 'an empty box: nothing is sent');
    const today = await q.evaluate(() => todayStr()); parse = { status: 200, json: { ok: true, remaining: 4, result: { ok: true, title: '夕食', amount: 6000, category: 'food', date: today, payer: 'けんた', split: 'all', fixed: { みく: 1000 }, comment: '夕食 6,000円ですね。けんたさんが払って、3人で割ります。' } } };
    await q.fill('#q-quick', '昨日の夕食、けんたが立て替えて3人で割った 6000円'); await q.click('[data-a=ai-text]'); await see(q, '少し待ってください'); await see(q, '夕食 6,000円ですね。けんたさんが払って、3人で割ります。');
    assert.deepStrictEqual([sent[0].text, sent[0].names, sent[0].me, sent[0].today], ['昨日の夕食、けんたが立て替えて3人で割った 6000円', ['あおい', 'けんた', 'みく'], 'あおい', today]); assert.strictEqual(sent[0].image, undefined);
    const sheet = await q.textContent('.sheet'); assert.ok(sheet.includes('けんた') && sheet.includes('6,000円') && sheet.includes('みく 1,000円') && sheet.includes('まだ記録していません') && sheet.includes('あと4回'), sheet);
    assert.strictEqual(await q.evaluate(() => state.trips[0].expenses.length), 0, 'a proposal is not a record');
    await q.click('[data-a=ai-edit]'); await q.waitForSelector('#f-amount'); assert.strictEqual(await q.inputValue('#f-amount'), '6,000'); assert.strictEqual(await q.evaluate(() => ui.sheet.data.payer), 'b'); assert.strictEqual(await q.evaluate(() => ui.sheet.data.fixed.c), '1000'); assert.strictEqual(await q.evaluate(() => state.trips[0].expenses.length), 0); await q.click('[data-a=close-sheet]');
    await q.fill('#q-quick', '夕食 6000円 けんたが払って みくは1000円'); await q.click('[data-a=ai-text]'); await see(q, 'まだ記録していません'); await q.click('[data-a=ai-record]'); await see(q, '夕食 6,000円を記録しました');
    assert.deepStrictEqual(await q.evaluate(() => { const e = state.trips[0].expenses[0]; return [e.amount, e.payer, e.split, e.fixed, e.cat]; }), [6000, 'b', ['a', 'b', 'c'], { c: 1000 }, 'food']);
    // a photo of a receipt: made small on the device and sent as a jpeg, with the same confirmation
    parse = { status: 200, json: { ok: true, remaining: 3, result: { ok: true, title: 'ローソン', amount: 540, category: 'other', date: null, payer: null, split: 'all', fixed: {}, comment: 'ローソン 540円ですね。みんなで割ります。' } } };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await q.setInputFiles('#ai-file', { name: 'r.png', mimeType: 'image/png', buffer: png }); await see(q, 'ローソン 540円ですね。'); assert.ok(sent[sent.length - 1].image.startsWith('data:image/jpeg;base64,'), 'sent as a jpeg'); await q.click('[data-a=ai-record]'); await see(q, 'ローソン 540円を記録しました');
    assert.strictEqual(await q.evaluate(() => state.trips[0].expenses.find(e => e.title === 'ローソン').payer), 'a', 'no payer written: me');
    // errors are said gently; a used-up day stops the next ask before it is sent
    parse = { status: 422, json: { error: 'unreadable', remaining: 2 } }; await q.fill('#q-quick', 'こんにちは'); await q.click('[data-a=ai-text]'); await see(q, 'うまく読み取れませんでした'); await q.click('[data-a=close-sheet]');
    parse = { status: 502, json: { error: 'upstream' } }; await q.click('[data-a=ai-text]'); await see(q, '回数は、減っていません'); await q.click('[data-a=close-sheet]');
    parse = { status: 429, json: { error: 'limit', remaining: 0 } }; await q.click('[data-a=ai-text]'); await see(q, '今日は、たびまるに頼める回数を使い切りました'); await q.click('[data-a=close-sheet]'); const n = sent.length;
    await q.click('[data-a=ai-text]'); await see(q, '使い切りました'); assert.strictEqual(sent.length, n, 'no more asks today: nothing is sent'); assert.ok(!(await q.innerText('body')).includes('！'), 'no "！" in the words');
    assert.deepStrictEqual(qerrs, []); await c15.close(); }

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('ui e2e passed');
} finally { await b.close(); srv.close(); }
