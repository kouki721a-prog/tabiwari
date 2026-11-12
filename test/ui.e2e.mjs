/* Browser test for device-only features: undo after delete, expense search.  Needs playwright and a built dist/.   node test/ui.e2e.mjs */
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dist = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css' };
const srv = http.createServer((q, r) => { const f = path.join(dist, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end('{}'); } else { r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' }); r.end(d); } }); }).listen(8797);
const b = await chromium.launch(), errs = [];
const see = (p, t, ms = 5000) => p.waitForSelector('text=' + t, { timeout: ms });
try {
  const ctx = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.setViewportSize({ width: 390, height: 780 });
  await p.goto('http://localhost:8797/'); await see(p, '最初の旅行をつくりましょう');
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
      await q.click('.xfer .chk'); await q.waitForSelector('.xfer.done'); await see(q, 'すべて完了'); assert.ok((await q.$eval('.xfer.done .amt', e => getComputedStyle(e).textDecorationLine)).includes('line-through'));
      await q.click('.xfer .chk'); await q.waitForSelector('.xfer:not(.done)'); }
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

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('ui e2e passed');
} finally { await b.close(); srv.close(); }
