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
const openRounds = async q => { for (const n of await q.$$eval('[data-a=toggle-round][aria-expanded=false]', es => es.map(e => e.getAttribute('data-v')))) await q.click('[data-a=toggle-round][data-v="' + n + '"]'); };   // settled expenses are folded by round
try {
  const ctx = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.setViewportSize({ width: 390, height: 780 });
  await p.goto('http://localhost:8797/'); await see(p, '旅行のお金の不安を、なくす');
  // the splash is plain HTML that is there before any script runs, and it is gone once the first screen is drawn
  assert.ok((await (await fetch('http://localhost:8797/')).text()).includes('<div id="splash"'), 'the splash is in the page itself'); await p.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 3000 });
  // the first screen: one screen without scrolling; main button right under the intro, then "join by link", the 3 steps, and the legal links at the very bottom
  { const y = sel => p.$eval(sel, e => e.getBoundingClientRect().top);
    const m = await p.$eval('.home0', e => ({ s: e.scrollHeight, c: e.clientHeight }));
    assert.ok(m.s <= m.c + 1, 'the first screen needs no scrolling: ' + JSON.stringify(m));
    const [intro, make, join, steps, legal] = [await y('.home0-intro'), await y('.home0 [data-a=new]'), await y('.home0 [data-a=join-paste]'), await y('.home0-steps'), await y('.home0 .legal')];
    assert.ok(intro < make && make < join && join < steps && steps < legal, JSON.stringify({ intro, make, join, steps, legal }));
    assert.ok(await p.$eval('.home0-intro', e => e.textContent.includes('貯める、使いすぎない、払う。1つのアプリで。') && e.scrollWidth <= e.clientWidth), 'the intro sentence fits on one line');
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
  await p.click('[data-a=home]'); await p.waitForSelector('.home1'); await p.waitForTimeout(350);   // the slide between screens has ended
  { const m = await p.evaluate(() => { const b = document.querySelector('[data-a=app-settings]').getBoundingClientRect(), h = document.querySelector('.brand').getBoundingClientRect(), fab = document.querySelector('.fab').getBoundingClientRect(); return { right: innerWidth - b.right, sameRow: Math.abs((b.top + b.bottom) / 2 - (h.top + h.bottom) / 2) < 14, scrolls: document.documentElement.scrollHeight - innerHeight, links: document.querySelectorAll('.home1 .legal, .foot1').length, fabBottom: innerHeight - fab.bottom }; });
    assert.ok(m.right < 40 && m.sameRow && m.scrolls <= 1 && m.links === 0, 'settings button at the top right, no footer links: ' + JSON.stringify(m)); }
  await p.click('[data-a=app-settings]'); await see(p, '規約'); await see(p, '利用規約'); await see(p, 'プライバシーポリシー'); await see(p, 'このアプリについて');
  assert.strictEqual(await p.locator('.sheet [data-a=line-login]').count(), 0, 'no LINE login without the server');
  { // dragging a sheet down: a short pull springs back, a long pull closes it like the close button; and the press effect exists in the style sheet
    const drag = dy => p.evaluate(async d => { const el = document.querySelector('.sheet h2'), mk = y => new Touch({ identifier: 2, target: el, clientX: 200, clientY: y }), fire = (type, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(y)], changedTouches: [mk(y)] })); fire('touchstart', 300); fire('touchmove', 300 + d / 2); fire('touchmove', 300 + d); fire('touchend', 300 + d); }, dy);
    await drag(40); await p.waitForTimeout(400); assert.strictEqual(await p.locator('.sheet').count(), 1, 'a short pull keeps the sheet'); assert.strictEqual(await p.$eval('.sheet', e => e.style.transform), '', 'and it springs back');
    await drag(220); await p.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 3000 });
    await p.click('[data-a=app-settings]'); await see(p, '利用規約');
    assert.strictEqual(await p.evaluate(() => { document.querySelector('.sheet [data-a=close-sheet]').click(); return !!document.querySelector('.sheet-bg.ghost') && !document.querySelector('.sheet-bg:not(.ghost)'); }), true, 'a closing sheet leaves a copy that slides down');
    await p.waitForFunction(() => !document.querySelector('.ghost'), null, { timeout: 2000 });
    assert.ok(await p.evaluate(() => [...document.styleSheets].some(s => [...s.cssRules].some(r => (r.cssRules ? [...r.cssRules] : [r]).some(x => x.selectorText && x.selectorText.includes('.btn:active') && /scale/.test(x.style.transform))))), 'pressed buttons sink a little'); await p.click('[data-a=app-settings]'); await see(p, '利用規約'); }
  await p.click('[data-a=close-sheet]');
  await p.locator('.trip').first().click(); await p.waitForSelector('[data-a=add-exp]');

  // trip screen, no expenses yet: short guidance without an orphaned "す。", a button that opens the same sheet as the + button, members row with an invite button, "残りN日" label
  await see(p, '最初の支出を記録しましょう'); await see(p, '＋ボタンから入力できます');
  { const m = await p.evaluate(() => { const e = document.querySelector('.exp0'), lines = Array.from(e.querySelectorAll('b,span')).map(x => { const r = document.createRange(); r.selectNodeContents(x); return r.getClientRects().length; });
      const lab = Array.from(document.querySelectorAll('.ticket .t-top .t-label')).map(x => x.textContent); return { lines, lab, hasBtn: !!e.querySelector('[data-a=add-exp]'), mem: !!document.querySelector('.mem-row [data-a=invite]'), avs: document.querySelectorAll('.mem-row .av').length }; });
    assert.deepStrictEqual(m.lines, [1, 1], 'each guidance line stays on one line: ' + JSON.stringify(m)); assert.ok(m.hasBtn && m.mem && m.avs === 1, JSON.stringify(m));
    assert.ok(/^今日の目安（残り\d+日）$/.test(m.lab[0]), 'label: ' + m.lab[0]); assert.ok(!(await p.textContent('.ticket')).includes('今日からの1日目安')); }
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
      await q.click('.xfer .paidbtn'); await q.waitForSelector('.xfer.done'); await see(q, 'すべて完了'); assert.ok(await q.locator('.xfer.pop').count() === 1 && await q.locator('.alldone').count() === 1, 'the row just marked as paid, and "すべて完了", have a small celebration'); assert.ok((await q.$eval('.xfer.done .amt', e => getComputedStyle(e).textDecorationLine)).includes('line-through'));
      await q.click('.xfer .paidbtn'); await q.waitForSelector('.xfer:not(.done)'); assert.strictEqual(await q.locator('.xfer.pop').count(), 0, 'taking the mark back has none'); }
    await q.click('[data-a=settle-ask]'); await see(q, '第1回の精算を確定する'); await see(q, '2件（合計 10,000円）'); await q.click('[data-a=settle-go]'); await see(q, '第1回の精算を確定しました');
    await see(q, '未精算の支出はありません'); await see(q, '精算の履歴'); assert.strictEqual(await q.locator('[data-a=settle-ask]').count(), 0, 'nothing to settle'); assert.strictEqual(await left(), '90,000円', 'budget ignores rounds');
    // a receipt found later -> round 2
    await q.click('.plus'); await q.fill('#f-amount', '600'); await q.click('[data-a=pick-payer][data-v=b]'); await q.click('[data-a=save-exp]'); await q.waitForSelector('text=記録しました');
    await q.click('[data-a=tab][data-t=settle]'); await see(q, '第2回の精算'); await see(q, '300円'); assert.strictEqual(await left(), '89,400円');
    // history: one entry, with the money of round 1; its detail lists the transfer and the expenses
    assert.strictEqual(await q.locator('[data-a=settle-open]').count(), 1); await see(q, '支出 10,000円・送金 1件'); await q.click('[data-a=settle-open]'); await see(q, 'けんた → あおい'.length ? '第1回の精算' : ''); await see(q, '夕食'); await see(q, '宿');
    assert.ok((await q.textContent('.sheet')).includes('5,000円'), 'round 1 transfer'); await q.click('[data-a=close-sheet]');
    // editing a settled expense: warned first, then the difference goes to round 2 and round 1 stays
    await q.click('[data-a=tab][data-t=exp]'); await openRounds(q); await q.locator('.rnd:has([data-v="1"]) .item[data-a=edit-exp]').first().click(); await see(q, '第1回で精算済みです。');
    const priceNow = await q.$eval('#f-amount', e => e.value); await q.fill('#f-amount', priceNow === '6000' ? '8000' : '5000'); await q.click('[data-a=save-exp]'); await see(q, '精算済みの支出を変更します'); await q.click('[data-a=settled-cancel]');
    assert.strictEqual(await q.locator('text=精算済みの支出を変更します').count(), 0, 'cancel closes the warning'); await q.click('[data-a=save-exp]'); await q.click('[data-a=save-exp]'); await q.waitForSelector('text=保存しました');
    await q.click('[data-a=tab][data-t=settle]'); await see(q, '過去の精算の変更による差額'); await q.click('[data-a=settle-open]'); assert.ok((await q.textContent('.sheet')).includes('5,000円'), 'round 1 transfer is unchanged after the edit'); await q.click('[data-a=close-sheet]');
    // deleting a settled expense, then undoing: the adjustment goes away with it
    const adjBefore = await q.locator('text=の削除').count(); await q.click('[data-a=tab][data-t=exp]'); await openRounds(q); await q.locator('.item[data-a=edit-exp]', { hasText: '宿' }).click(); await q.click('[data-a=ask-del]'); await see(q, '精算済みです。削除すると、差額が第2回の精算に入ります'); await q.click('[data-a=del-exp]'); await see(q, '削除しました');
    await q.click('[data-a=tab][data-t=settle]'); await see(q, '「宿」の削除'); await q.click('[data-a=undo]'); await q.waitForSelector('text=元に戻しました'); assert.strictEqual(await q.locator('text=「宿」の削除').count(), 0, 'undo removes the adjustment');
    // the next round can be closed again and the history grows
    await q.click('[data-a=settle-ask]'); await q.click('[data-a=settle-go]'); await see(q, '第2回の精算を確定しました'); await q.click('[data-a=tab][data-t=exp]'); assert.ok((await q.textContent('#exp-list')).includes('未精算の支出はありません'), 'all settled: the list says so'); await q.click('[data-a=tab][data-t=settle]'); assert.strictEqual(await q.locator('[data-a=settle-open]').count(), 2); assert.deepStrictEqual(qerrs, []); }

  // the search box appears only once there are enough expenses
  for (const [a, t] of [[1000, '朝食'], [2000, '昼食'], [3000, '夕食'], [4000, 'お土産'], [5000, 'ロープウェイ']]) await add(a, t);
  assert.strictEqual(await p.locator('[data-a=find-toggle]').count(), 0, 'no magnifier for a short list');
  await p.click('[data-a=add-exp]'); await p.fill('#f-amount', '6000'); await p.fill('#f-title', '温泉'); await p.click('[data-a=save-exp]'); await p.waitForSelector('.item.fresh', { timeout: 2000 }); assert.strictEqual(await p.locator('.item.fresh').count(), 1, 'the row just recorded comes in with a mark');
  await p.waitForFunction(() => !document.querySelector('.item.fresh'), null, { timeout: 3000 }); await see(p, '温泉');   // and the mark goes away
  assert.strictEqual(await p.locator('#q-exp').count(), 0, 'the search box is closed until the magnifier is pressed');
  await p.click('[data-a=find-toggle]'); await p.waitForSelector('#q-exp'); assert.strictEqual(await p.evaluate(() => document.activeElement && document.activeElement.id === 'q-exp'), false, 'the keyboard does not open by itself');
  await p.fill('#q-exp', 'ロープ'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 1);
  await see(p, '1件・合計');
  await p.fill('#q-exp', '３０００'); await see(p, '夕食'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 1, 'full-width digits match the amount');
  await p.fill('#q-exp', 'あおい'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 6, 'the payer is searchable');
  await p.fill('#q-exp', '夕食 あおい'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 1, 'every word must match');
  await p.fill('#q-exp', '夕食 けんた'); await see(p, '見つかりませんでした');
  await p.fill('#q-exp', 'ほげ'); await see(p, '見つかりませんでした');
  await p.fill('#q-exp', ''); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), 6);
  { // swipe a row left: the red 削除 shows (a short move does not); tapping it deletes, and 元に戻す brings it back
    const rowSwipe = d => p.evaluate(dd => { const el = document.querySelector('.swp .item'), r = el.getBoundingClientRect(), y = r.top + r.height / 2, mk = x => new Touch({ identifier: 6, target: el, clientX: x, clientY: y }), fire = (type, x) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x)], changedTouches: [mk(x)] })); fire('touchstart', 300); fire('touchmove', 300 + dd / 2); fire('touchmove', 300 + dd); fire('touchend', 300 + dd); }, d);
    const n0 = await p.locator('.item[data-a=edit-exp]').count();
    await rowSwipe(-30); assert.strictEqual(await p.locator('.swp.open').count(), 0, 'a short move does not open it');
    await rowSwipe(-150); assert.strictEqual(await p.locator('.swp.open').count(), 1, 'a long move opens it');
    await p.waitForTimeout(450); await p.click('.swp.open [data-a=swipe-del]'); await see(p, '削除しました'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), n0 - 1, 'the row is deleted');
    await p.click('[data-a=undo]'); await see(p, '元に戻しました'); assert.strictEqual(await p.locator('.item[data-a=edit-exp]').count(), n0, 'and comes back'); }

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
  await see(p, '旅行を削除しました'); await see(p, '旅行のお金の不安を、なくす');
  await p.click('[data-a=undo]'); await see(p, '元に戻しました'); await see(p, '箱根');
  assert.strictEqual(await p.locator('h1').count(), 1, 'the home page has one level-1 heading'); assert.ok(/箱根/.test(await p.textContent('.trip .sr') + await p.textContent('.trip')) && /メンバー：あおい/.test(await p.textContent('.trip .sr')));
  await p.click('.trip'); await see(p, '夕食');

  // LINE login button follows LINE's colour rules: base #06C755 (no tint), white text, divider black 8%, black 30% only while pressed (under the text and logo, no hover shade)
  { // the 旅行をつくる screen: a long swipe right goes back to the home screen (following the finger); a short one springs back
    const c = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c.newPage(); await q.addInitScript(() => { localStorage.setItem('tabiwari.noinstall', '1'); });
    await q.goto('http://localhost:8797/'); await q.click('.home0 [data-a=new]'); await q.waitForSelector('#d-name'); await q.waitForTimeout(450);
    const drag = (to, end) => q.evaluate(async ([to, end]) => { const el = document.querySelector('.top h1'), mk = x => new Touch({ identifier: 11, target: el, clientX: x, clientY: 300 }), fire = (type, x) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x)], changedTouches: [mk(x)] })), nap = ms => new Promise(r => setTimeout(r, ms)); fire('touchstart', 100); fire('touchmove', 120); await nap(100); fire('touchmove', (100 + to) / 2); await nap(100); fire('touchmove', to); const r = { tr: document.getElementById('app').style.transform, peek: !!document.querySelector('.peek') }; if (end) fire('touchend', to); return r; }, [to, end]);
    const mid = await drag(180, true); assert.ok(mid.peek && /translateX\(/.test(mid.tr), 'the screen follows the finger, the home screen is behind it: ' + JSON.stringify(mid));
    await q.waitForFunction(() => !document.querySelector('.peek'), null, { timeout: 2000 }); assert.strictEqual(await q.locator('#d-name').count(), 1, 'a short drag springs back'); await q.waitForTimeout(450);
    await drag(330, true); await q.waitForFunction(() => !document.querySelector('#d-name') && document.querySelector('#app .home0'), null, { timeout: 3000 }); assert.strictEqual(await q.locator('#d-name').count(), 0, 'a long swipe goes back to the home screen'); await c.close(); }
  { // (own page) signed in with LINE: the name field gives way to a row with the LINE name; "変える" opens the field (filled with it); saving needs no typing
    const c = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await c.newPage(); await p.addInitScript(() => { localStorage.setItem('tabiwari.noinstall', '1'); }); await p.goto('http://localhost:8797/'); await p.waitForSelector('[data-a=new]'); await p.click('[data-a=new]'); await p.waitForSelector('#d-name');
    await p.evaluate(() => { lineAcct.user = { name: 'テスト太郎ですよろしくお願いします長い名前の人', picture: '', pic: true }; render(); });
    assert.strictEqual(await p.locator('#d-me').count(), 0, 'no name field when signed in'); assert.strictEqual((await p.textContent('.melink')).includes('テスト太郎ですよろしくお願いします長い名'), true, 'the LINE name is shown (at most 20 characters)'); assert.strictEqual((await p.textContent('.melink')).includes('前の人'), false);
    await p.click('[data-a=draft-me-edit]'); assert.strictEqual(await p.inputValue('#d-me'), 'テスト太郎ですよろしくお願いします長い名', 'the field opens filled with it');
    await p.evaluate(() => { ui.draft.editMe = false; ui.draft.me = ''; render(); });
    await p.fill('#d-name', 'LINE名の旅'); await p.fill('#d-budget', '10000'); await p.click('[data-a=save-trip]'); await p.waitForSelector('[data-a=add-exp]');
    assert.strictEqual(await p.evaluate(() => state.trips[state.trips.length - 1].members[0].name), 'テスト太郎ですよろしくお願いします長い名', 'the trip is made with the LINE name as your name');
    await c.close(); }
  { // (own page) 設定 ⇄ アカウント: the sheet stays (one sheet, one dark background); only its page slides sideways, the old page sliding out beside the new one
    const c = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await c.newPage(); await p.addInitScript(() => { localStorage.setItem('tabiwari.noinstall', '1'); }); await p.goto('http://localhost:8797/'); await p.waitForSelector('[data-a=app-settings]');
    await p.evaluate(() => { lineAcct.login = true; lineAcct.user = { name: 'こうき', picture: '', pic: true, settle: true, over: true }; render(); });
    await p.click('[data-a=app-settings]'); await p.waitForSelector('[data-a=line-account]'); await p.waitForTimeout(450);
    const open = await p.evaluate(() => { const bg0 = document.querySelector('.sheet-bg'); document.querySelector('.sheet [data-a=line-account]').click(); return { ov: !!document.querySelector('.sheet .sheet-ov'), bgs: document.querySelectorAll('.sheet-bg').length, ghosts: document.querySelectorAll('.ghost').length, title: document.querySelector('.sheet > .row h2, .sheet h2').textContent, anim: getComputedStyle(document.querySelector('.sheet')).animationName }; });
    assert.ok(open.ov && open.bgs === 1 && open.ghosts === 0 && open.title === 'LINEアカウント' && open.anim === 'none', 'opening: the page slides inside the same sheet: ' + JSON.stringify(open)); await p.waitForSelector('.sheet [data-a=pic-toggle]'); await p.waitForFunction(() => !document.querySelector('.sheet-ov'), null, { timeout: 2000 }); await p.waitForTimeout(100);
    const r = await p.evaluate(() => { document.querySelector('.sheet [data-a=close-sheet]').click(); return { ov: !!document.querySelector('.sheet .sheet-ov'), bgs: document.querySelectorAll('.sheet-bg').length, ghosts: document.querySelectorAll('.ghost').length, title: document.querySelector('.sheet h2').textContent }; });
    assert.ok(r.ov && r.bgs === 1 && r.ghosts === 0 && r.title === '設定', 'going back: the same: ' + JSON.stringify(r)); await p.waitForFunction(() => !document.querySelector('.sheet-ov'), null, { timeout: 2000 });
    // a swipe right on the アカウント page follows the finger (設定 waiting beside it); short: springs back, long: goes back, with no second slide
    await p.click('.sheet [data-a=line-account]'); await p.waitForSelector('.sheet [data-a=pic-toggle]'); await p.waitForFunction(() => !document.querySelector('.sheet-ov'), null, { timeout: 2000 }); await p.waitForTimeout(150);
    const sw = to => p.evaluate(async to => { const el = document.querySelector('.sheet h2'), mk = x => new Touch({ identifier: 12, target: el, clientX: x, clientY: 300 }), fire = (type, x) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x)], changedTouches: [mk(x)] })), nap = ms => new Promise(r => setTimeout(r, ms)); fire('touchstart', 60); fire('touchmove', 80); await nap(60); fire('touchmove', (60 + to) / 2); await nap(60); fire('touchmove', to); const mid = { under: !!document.querySelector('.sheet .sheet-ov'), tr: document.querySelector('.sheet > *').style.transform }; const el0 = document.querySelector('.sheet'); render(); mid.kept = el0 === document.querySelector('.sheet'); if (to < 200) await nap(400); fire('touchend', to); return mid; }, to);   // a slow, short swipe is not a flick
    const m1 = await sw(130); assert.ok(m1.under && /translateX\(/.test(m1.tr) && m1.kept, 'the page follows the finger, a redraw waits: ' + JSON.stringify(m1)); await p.waitForFunction(() => !document.querySelector('.sheet-ov'), null, { timeout: 2000 }); assert.strictEqual(await p.evaluate(() => document.querySelector('.sheet h2').textContent), 'LINEアカウント', 'a short swipe springs back');
    await p.waitForTimeout(150); await sw(340); await p.waitForFunction(() => document.querySelector('.sheet h2') && document.querySelector('.sheet h2').textContent === '設定' && !document.querySelector('.sheet-ov'), null, { timeout: 3000 });
    assert.strictEqual(await p.evaluate(() => [...document.querySelectorAll('.sheet > *')].every(k => !k.style.position && !k.style.transform)), true, 'nothing is left over after the swipe back'); await p.waitForFunction(() => !document.querySelector('.sheet-ov'), null, { timeout: 2000 }); assert.strictEqual(await p.evaluate(() => [...document.querySelectorAll('.sheet > *')].every(k => !k.style.position && !k.style.background)), true, 'nothing is left over on the page'); await c.close(); }
  { // (own page) the payer and the people last chosen come first the next time (per trip, on this device); a person who left the trip is skipped
    const c = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await c.newPage(); await p.addInitScript(() => { const x = new Date(), d = n => { const y = new Date(x.getTime() + n * 864e5); return y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0'); };
      localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '三人旅', start: d(0), end: d(1), budget: 90000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }, { id: 'c', name: 'みく', pos: 2 }], paid: {}, savings: {}, expenses: [] }] })); });
    await p.goto('http://localhost:8797/'); await p.click('.trip'); await p.waitForSelector('[data-a=add-exp]');
    const who = () => p.evaluate(() => ({ payer: ui.sheet.data.payer, all: ui.sheet.data.all, split: ui.sheet.data.split.join(',') }));
    await p.click('[data-a=add-exp]'); await p.waitForSelector('#f-amount'); assert.deepStrictEqual(await who(), { payer: 'a', all: true, split: 'a,b,c' }, 'the first time: you paid, everyone');
    await p.click('[data-a=pick-payer][data-v=b]'); await p.click('[data-a=toggle-split][data-v=c]'); await p.fill('#f-amount', '3000'); await p.click('[data-a=save-exp]'); await p.waitForSelector('.item.fresh, .swp');
    await p.waitForTimeout(700); await p.click('[data-a=add-exp]'); await p.waitForSelector('#f-amount'); const w2 = await who(); assert.strictEqual(w2.payer, 'b', 'the last payer comes first'); assert.strictEqual(w2.all, false); assert.strictEqual(w2.split, 'c', 'and the people last chosen (tapping one person from "everyone" picks just that person): ' + JSON.stringify(w2));
    await p.click('[data-a=close-sheet]'); await p.evaluate(() => { const t = state.trips[0]; t.members = t.members.filter(m => m.id !== 'b'); save(); render(); }); await p.waitForTimeout(400); await p.click('[data-a=add-exp]'); await p.waitForSelector('#f-amount'); assert.strictEqual((await who()).payer, 'a', 'a payer who is no longer in the trip is not offered'); await c.close(); }
  { // (own page) the date heading of a long list stays at the top while that day's expenses scroll under it
    const c = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), p = await c.newPage();
    await p.addInitScript(() => { const x = new Date(), d = n => { const y = new Date(x.getTime() - n * 864e5); return y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0'); }; const ms = [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }];
      localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '長い旅', start: d(3), end: d(-1), budget: 90000, members: ms, paid: {}, savings: {}, expenses: Array.from({ length: 16 }, (_, i) => ({ id: 'e' + i, title: '支出' + i, amount: 1000 + i, payer: 'a', cat: 'food', date: i < 8 ? d(0) : d(1), split: ['a', 'b'] })) }] })); });
    await p.goto('http://localhost:8797/'); await p.click('.trip'); await p.waitForSelector('#exp-list .sec h2');
    const r = await p.evaluate(async () => { const sc = document.querySelector('#app.fit>.scroll'), hs = [...document.querySelectorAll('#exp-list .sec>h2')]; sc.scrollTop = 520; await new Promise(r => setTimeout(r, 150)); return { top: sc.getBoundingClientRect().top, hs: hs.map(h => Math.round(h.getBoundingClientRect().top - sc.getBoundingClientRect().top)), st: sc.scrollTop }; });
    assert.ok(r.st > 300 && r.hs.some(v => v >= -1 && v <= 2), 'a date heading sits at the top of the scrolling list: ' + JSON.stringify(r)); await c.close(); }
  { // the first screen fits on one page with the "add to the home screen" banner above it too, whatever the height (it gives things up in turn)
    for (const [w, h] of [[390, 844], [390, 730], [390, 664], [375, 667], [360, 640], [320, 568]]){
      const c = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block', viewport: { width: w, height: h } }), q = await c.newPage(); await q.goto('http://localhost:8797/'); await q.waitForSelector('.home0');
      const r = await q.evaluate(() => { const e = document.querySelector('.home0'); return { fit: e.scrollHeight <= e.clientHeight + 1, banner: !!document.querySelector('.install'), cls: e.className }; });
      assert.ok(r.fit && r.banner, 'the first screen with the banner fits at ' + w + 'x' + h + ': ' + JSON.stringify(r)); await c.close();
    } }
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
      { const tm = await q.innerText('.ticket.m'); assert.ok(tm.includes('積立') && tm.includes('10,000円') && tm.includes('33%') && tm.includes('予算') && tm.includes('30,000円'), 'detail card: ' + tm); } await q.click('[data-a=tab][data-t=save]'); await q.waitForSelector('.ticket.c');
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
    { // the usual contents are chips under the box: a tap puts the content in and opens the keyboard; the most used of this trip come first
      assert.ok(await q.locator('.qchips [data-a=quick-chip]').count() >= 5, 'usual contents are offered'); assert.strictEqual(await q.evaluate(() => document.activeElement && document.activeElement.id === 'q-quick'), false, 'the keyboard does not open by itself');
      await q.click('.qchips [data-a=quick-chip][data-v="タクシー"]'); assert.strictEqual(await q.inputValue('#q-quick'), 'タクシー ', 'the content is in the box'); assert.strictEqual(await q.evaluate(() => document.activeElement && document.activeElement.id === 'q-quick' && document.activeElement.getAttribute('inputmode') === 'numeric'), true, 'tapping a chip opens the number keyboard');
      await q.keyboard.type('1500'); await q.press('#q-quick', 'Enter'); await see(q, 'タクシー 1,500円を記録しました'); await q.waitForTimeout(300);
      assert.strictEqual(await q.locator('.qchips .qchip').first().getAttribute('data-v'), 'タクシー', 'what was just used moves to the front');
      await q.click('[data-a=undo]').catch(() => {}); await q.waitForTimeout(200); }
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
    await q.goto('http://localhost:8797/'); await q.waitForSelector('[data-a=home-tab][data-v=past]'); await q.click('[data-a=home-tab][data-v=past]'); await q.waitForSelector('.trip'); assert.strictEqual(await q.locator('[data-a=next-trip]').count(), 1, 'only the ended trip with friends has the button');
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

  // ホームの上のタブ: 「これから・旅行中」と「終了した旅行」。精算が残る終了済みの旅行は、前のタブに残る。タブは、いつも出る。見ていたタブは、旅行から戻っても、そのまま
  { const c10 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c10.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { localStorage.setItem('tabiwari.noinstall', '1');
      const m = [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }], base = { paid: {}, savings: {}, settlements: [], adjustments: [], members: m },
        far = (id, name, start, end) => ({ ...base, id, name, start, end, budget: 50000, expenses: [] }), only = location.search === '?only';
      const trips = [far('p1', '古い旅', '2020-01-01', '2020-01-02'), far('p2', '新しい旅', '2021-01-01', '2021-01-02')];
      if (!only) trips.push(far('fut', '先の旅', '2099-01-01', '2099-01-02'), { ...base, id: 'open', name: '精算待ちの旅', start: '2020-06-01', end: '2020-06-02', budget: 50000, expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'a', cat: 'food', date: '2020-06-01', split: ['a', 'b'] }] });
      localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips })); });
    const names = () => q.locator('.trip .trip-name').allTextContents(), tabs = () => q.locator('.ut button').allTextContents();
    await q.goto('http://localhost:8797/'); await q.waitForSelector('.trip');
    assert.deepStrictEqual((await tabs()).map(x => x.replace(/\s+/g, ' ').trim()), ['これから・旅行中 2', '終了した旅行 2'], 'two tabs, with the counts'); assert.strictEqual(await q.getAttribute('.ut button >> nth=0', 'aria-selected'), 'true');
    assert.deepStrictEqual(await names(), ['先の旅', '精算待ちの旅'], 'the upcoming trip and the ended trip that still needs settling'); assert.strictEqual(await q.locator('[data-a=join-paste]').count(), 1); assert.strictEqual(await q.locator('[data-a=new]').count(), 1);
    await q.click('[data-a=home-tab][data-v=past]'); await q.waitForFunction(() => document.querySelector('.ut button.on').dataset.v === 'past');
    assert.deepStrictEqual(await names(), ['新しい旅', '古い旅'], 'newest first, and only the settled ones'); assert.strictEqual(await q.locator('h1').count() > 0, true);
    await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.click('[data-a=home]'); await q.waitForSelector('.ut'); assert.deepStrictEqual(await names(), ['新しい旅', '古い旅'], 'back from a trip: the tab you were on');
    await q.click('[data-a=home-tab][data-v=now]'); await q.waitForFunction(() => document.querySelector('.ut button.on').dataset.v === 'now'); assert.deepStrictEqual(await names(), ['先の旅', '精算待ちの旅']);
    // swiping left / right on the home list switches the tabs (not from the edges; a short or mostly-vertical move does nothing)
    { const swipe = (x0, y0, x1, y1) => q.evaluate(([a, b, c, d]) => { const el = document.querySelector('.home1') || document.body, mk = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y }), fire = (type, x, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x, y)], changedTouches: [mk(x, y)] })); fire('touchstart', a, b); fire('touchmove', c, d); fire('touchend', c, d); }, [x0, y0, x1, y1]), on = () => q.$eval('.ut button.on', e => e.dataset.v);
      await swipe(200, 300, 190, 300); assert.strictEqual(await on(), 'now', 'a short move does nothing'); await swipe(300, 300, 150, 420); assert.strictEqual(await on(), 'now', 'a mostly vertical move does nothing'); await swipe(10, 300, -140, 300).catch(() => {}); assert.strictEqual(await on(), 'now', 'a swipe from the edge does nothing');
      await swipe(300, 300, 120, 310); await q.waitForFunction(() => document.querySelector('.ut button.on').dataset.v === 'past'); assert.strictEqual(await q.locator('.pg-old').count(), 1, 'the page that leaves is a copy sliding away (the real one slides in)');
      await swipe(300, 300, 120, 310); assert.strictEqual(await on(), 'past', 'swiping on the last tab does nothing more'); await swipe(100, 300, 280, 310); await q.waitForFunction(() => document.querySelector('.ut button.on').dataset.v === 'now');
      await q.waitForTimeout(450);   // while the finger is still down the page follows it, with its neighbour beside it; letting go early puts it back
      const mid = await q.evaluate(async () => { const nap = ms => new Promise(r => setTimeout(r, ms)); const el = document.querySelector('.hlist'), mk = x => new Touch({ identifier: 8, target: el, clientX: x, clientY: 300 }), fire = (type, x) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x)], changedTouches: [mk(x)] })); fire('touchstart', 300); fire('touchmove', 280); await nap(120); fire('touchmove', 230); await nap(120); fire('touchmove', 200); await nap(120); const r = { peek: !!document.querySelector('.peek'), tr: document.querySelector('.hlist').style.transform }; const el0 = document.querySelector('.hlist'); render(); r.kept = el0 === document.querySelector('.hlist') && document.body.contains(el0); fire('touchend', 200); return r; });
      assert.ok(mid.peek && /translateX\(-/.test(mid.tr), 'the page follows the finger: ' + JSON.stringify(mid)); assert.strictEqual(mid.kept, true, 'a redraw while the finger is down waits (the element under the finger is not removed)'); await q.waitForFunction(() => !document.querySelector('.peek'), null, { timeout: 2000 }); assert.strictEqual(await on(), 'now', 'a short drag goes back');
      assert.strictEqual(await q.evaluate(() => { const x = document.createElement('div'); x.className = 'peek'; x.dataset.t = '0'; document.body.appendChild(x); render(); return !!document.querySelector('.peek'); }), false, 'a copy left behind is swept away at the next redraw'); }
    // screens slide (forward in from the right, back from the left); inside a trip, swiping switches 記録 / 精算 / 積立
    { const swipe = (x0, x1) => q.evaluate(([a, c]) => { const el = document.querySelector('.scroll') || document.body, mk = x => new Touch({ identifier: 3, target: el, clientX: x, clientY: 300 }), fire = (type, x) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x)], changedTouches: [mk(x)] })); fire('touchstart', a); fire('touchmove', c); fire('touchend', c); }, [x0, x1]), cur = () => q.$eval('.nav .tab[aria-current=page]', e => e.dataset.t);
      await q.waitForTimeout(450);   // a tap right after a swipe is ignored (the finger lifting)
      await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); assert.ok(await q.$eval('#app', e => e.classList.contains('go-f')), 'opening a trip slides in from the right'); assert.strictEqual(await cur(), 'exp');
      await swipe(300, 120); assert.strictEqual(await cur(), 'settle', 'swipe left: the next tab'); assert.strictEqual(await q.locator('.pg-old').count() >= 1, true, 'the list slides: the old page is a copy sliding away');
      await swipe(300, 120); assert.strictEqual(await cur(), 'save'); await swipe(300, 120); assert.strictEqual(await cur(), 'save', 'nothing after the last tab');
      await swipe(100, 280); assert.strictEqual(await cur(), 'settle', 'swipe right: the previous tab'); await swipe(100, 280); assert.strictEqual(await cur(), 'exp'); assert.strictEqual(await q.evaluate(() => { const el = document.querySelector('.scroll'), mk = y => new Touch({ identifier: 5, target: el, clientX: 200, clientY: y }), fire = (type, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(y)], changedTouches: [mk(y)] })); fire('touchstart', 200); fire('touchmove', 300); const s = !!document.getElementById('ptr'); fire('touchend', 300); return s; }), false, 'pulling down in a trip that is not shared does nothing');
      // a swipe right on the first tab goes back to the home screen (the screen follows the finger; the home screen is behind it)
      await q.waitForTimeout(450); await swipe(100, 330); await q.waitForFunction(() => document.querySelector('#app .ut') && !document.querySelector('#app [data-a=add-exp]'), null, { timeout: 3000 });
      await q.waitForTimeout(450); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.waitForTimeout(400);
      await q.click('[data-a=home]'); await q.waitForSelector('#app .ut'); assert.ok(await q.$eval('#app', e => e.classList.contains('go-b')), 'going back slides in from the left'); }
    // only ended trips: the second tab opens by itself; no ended trip at all: the tabs are there, the second one says it is empty
    const seed = trips => async () => { const x = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), y = await x.newPage(); await y.route('**/api/**', z => z.fulfill({ status: 404, json: {} }));
      await y.addInitScript(tr => { localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: tr })); }, trips); await y.goto('http://localhost:8797/'); await y.waitForSelector('.trip'); return [x, y]; };
    const T = (id, name, start, end) => ({ id, name, start, end, budget: 1000, members: [{ id: 'a', name: 'こうき', pos: 0 }], paid: {}, savings: {}, settlements: [], adjustments: [], expenses: [] });
    { const [x, y] = await seed([T('p1', '古い旅', '2020-01-01', '2020-01-02'), T('p2', '新しい旅', '2021-01-01', '2021-01-02')])(); assert.deepStrictEqual(await y.locator('.trip .trip-name').allTextContents(), ['新しい旅', '古い旅'], 'nothing in the first tab: the ended trips are shown at once'); assert.strictEqual(await y.locator('.ut').count(), 1); await x.close(); }
    { const [x, y] = await seed([T('n', '先の旅', '2099-01-01', '2099-01-02')])(); assert.strictEqual(await y.locator('.ut').count(), 1, 'the tabs are always there'); assert.deepStrictEqual((await y.locator('.ut button').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim()), ['これから・旅行中 1', '終了した旅行 0']); await y.click('[data-a=home-tab][data-v=past]'); await y.waitForSelector('text=終了した旅行は、まだありません'); assert.strictEqual(await y.locator('.trip').count(), 0, 'an empty tab says so'); await y.click('[data-a=home-tab][data-v=now]'); await y.waitForSelector('.trip'); await x.close(); }
    assert.deepStrictEqual(qerrs, []); await c10.close(); }

  // 支出ごとの変更履歴（B）: 記録した人・日時、最後に変えた人・日時、直前の値（金額・払った人・割る人）。一覧に「変更あり」の印。何も変えずに保存したら、増えない
  { const c18 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c18.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.hint.swipe', '1');
      if (!localStorage.getItem('tabiwari.v1')) localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, paid: {}, savings: {}, settlements: [], adjustments: [],
        members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }], expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]');
    await q.click('.fab, [data-a=add-exp]'); await q.waitForSelector('#f-amount'); await q.fill('#f-amount', '3000'); await q.click('[data-a=save-exp]'); await q.waitForSelector('.item[data-a=edit-exp]');
    const ex = () => q.evaluate(() => JSON.parse(JSON.stringify(state.trips[0].expenses[0])));
    let e = await ex(); assert.strictEqual(e.author, 'a', 'recorded by the member of this device'); assert.ok(e.madeAt > 1e12 && e.madeAt <= Date.now(), 'and when'); assert.strictEqual(e.editor, undefined); assert.strictEqual(await q.locator('.chgtag').count(), 0, 'no mark yet');
    await q.click('.item[data-a=edit-exp]'); await q.waitForSelector('.elog'); { const t = await q.innerText('.elog'); assert.ok(t.includes('こうきが') && t.includes('記録') && !t.includes('変更'), 'the sheet tells who recorded it: ' + t); }
    await q.click('[data-a=save-exp]'); await q.waitForTimeout(200); e = await ex(); assert.strictEqual(e.editor, undefined, 'saving without a change adds nothing');
    await q.click('.item[data-a=edit-exp]'); await q.waitForSelector('#f-amount'); await q.fill('#f-amount', '3500'); await q.click('[data-a=save-exp]'); await q.waitForTimeout(200);
    e = await ex(); assert.deepStrictEqual([e.editor, e.prev], ['a', { amount: 3000, payer: 'a', split: ['a', 'b'] }]); assert.ok(e.editedAt >= e.madeAt);
    assert.strictEqual(await q.locator('.item[data-a=edit-exp] .chgtag').count(), 1, 'the row carries a small 変更あり mark');
    await q.click('.item[data-a=edit-exp]'); await q.waitForSelector('.elog'); { const t = await q.innerText('.elog'); assert.ok(t.includes('こうきが') && t.includes('記録') && t.includes('変更') && t.includes('前：3,000円'), 'the sheet shows the change: ' + t); }
    await q.fill('#f-title', '夕食です'); await q.click('[data-a=save-exp]'); await q.waitForTimeout(200); e = await ex(); assert.deepStrictEqual(e.prev, { amount: 3500, payer: 'a', split: ['a', 'b'] }, 'only the last change is remembered');
    await q.click('.item[data-a=edit-exp]'); await q.waitForSelector('.elog'); assert.ok(!(await q.innerText('.elog')).includes('前：'), 'a change that did not touch the money side shows no "前"');
    await q.click('[data-a=close-sheet]');
    // somebody else changed who paid (as a synced trip would bring it)
    await q.evaluate(() => { const x = state.trips[0].expenses[0]; x.editor = 'b'; x.editedAt = Date.now(); x.payer = 'b'; x.prev = { amount: 3500, payer: 'a', split: ['a'] }; render(); }); await q.waitForSelector('.item[data-a=edit-exp]');
    await q.click('.item[data-a=edit-exp]'); await q.waitForSelector('.elog'); { const t = await q.innerText('.elog'); assert.ok(t.includes('あおいが') && t.includes('払った人 こうき') && t.includes('割る人 こうき'), 'who / what: ' + t); }
    assert.strictEqual(await q.evaluate(() => sanitizeTrip(JSON.parse(JSON.stringify(state.trips[0])), 'n').expenses[0].prev.payer), 'a', 'a backup / restore keeps the history');
    assert.strictEqual(await q.evaluate(() => { const t = JSON.parse(JSON.stringify(state.trips[0])); t.expenses[0].author = 'zzz'; t.expenses[0].prev = { amount: 0, payer: 'a', split: ['a'] }; const r = sanitizeTrip(t, 'n').expenses[0]; return JSON.stringify([r.author, r.prev]); }), '[null,null]', 'garbage in the history is dropped');
    assert.deepStrictEqual(qerrs, []); await c18.close(); }
  // 記録タブの予算カード: 主役は1つ（旅行中=今日の目安／準備中=積立／終了=使った合計）、バーは1本、カテゴリの内訳は1行にたたむ（押すとバーとチップが開く。絞り込み中は開いたまま）
  { const c17 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c17.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.hint.swipe', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: '2026-01-01', end: '2026-01-02', budget: 50000, paid: {}, savings: { a: 12000, b: 5000 }, settlements: [], adjustments: [],
        members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }], expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('.ticket.m');
    const day = n => q.evaluate(n => { const x = new Date(); x.setDate(x.getDate() + n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }, n);
    const setTrip = async (dStart, dEnd, budget, exps) => { const [st, en, d0, d1] = [await day(dStart), await day(dEnd), await day(-1), await day(0)]; await q.evaluate(([st, en, budget, exps, d0, d1]) => { const t = state.trips[0]; t.start = st; t.end = en; t.budget = budget; t.expenses = exps.map((e, i) => ({ id: 'e' + i, title: e[0], amount: e[1], payer: 'a', cat: e[2], date: e[3] === 0 ? d0 : d1, split: ['a', 'b'] })); ui.catF = null; ui.usageOpen = false; render(); }, [st, en, budget, exps, d0, d1]); await q.waitForSelector('.ticket.m'); };
    const card = () => q.innerText('.ticket.m');
    await setTrip(10, 12, 50000, []); { const c = await card(); assert.ok(c.includes('積立') && c.includes('17,000円') && c.includes('34%') && c.includes('予算') && c.includes('50,000円'), 'before the trip: the savings are the star: ' + c); assert.strictEqual(await q.locator('.ticket.m .t-bar').count(), 1, 'one bar'); }
    await setTrip(-1, 1, 50000, [['夕食', 4000, 'food', 0], ['電車', 1200, 'transport', 1], ['昼食', 900, 'food', 1]]);
    { const c = await card(); assert.ok(c.includes('今日の目安（残り2日）') && c.includes('21,950円') && c.includes('今日使った額') && c.includes('2,100円') && c.includes('予算の残り') && c.includes('43,900円') && c.includes('50,000円'), 'travelling: ' + c);
      assert.ok(!c.includes('1日あたりの目安'), 'the old label is gone'); assert.strictEqual(await q.locator('.ticket.m .t-bar').count(), 1, 'one bar'); assert.strictEqual(await q.locator('.legend2').count(), 0, 'the split is folded'); assert.ok((await q.innerText('.ufold')).includes('内訳：食事 4,900・交通 1,200'), 'the fold line names the biggest categories'); assert.strictEqual(await q.getAttribute('.ufold', 'aria-expanded'), 'false'); }
    await q.click('.ufold'); await q.waitForSelector('.legend2'); assert.strictEqual(await q.getAttribute('.ufold', 'aria-expanded'), 'true'); assert.ok((await q.innerText('.ufold')).includes('内訳を閉じる'));
    await q.click('.lc[data-v=food]'); await q.waitForSelector('.fline'); assert.strictEqual(await q.getAttribute('.lc[data-v=food]', 'aria-pressed'), 'true', 'the category chips still filter the list');
    await q.evaluate(() => { ui.usageOpen = false; render(); }); await q.waitForSelector('.ticket.m'); assert.strictEqual(await q.locator('.legend2').count(), 1, 'while a filter is on, the chips stay (so it can be cleared)');
    await q.click('.ufold'); await q.waitForTimeout(150); assert.strictEqual(await q.locator('.legend2').count(), 0, 'closing the fold clears the filter too'); assert.strictEqual(await q.evaluate(() => ui.catF), null);
    await setTrip(-1, 1, 5000, [['宿', 6000, 'stay', 0], ['夕食', 900, 'food', 1]]);
    { const c = await card(); assert.ok(c.includes('予算オーバー') && c.includes('1,900円') && c.includes('今日の目安') && c.includes('0円'), 'over budget: ' + c); assert.ok(await q.$eval('.ticket.m .t-amount', e => e.classList.contains('neg')), 'the overage is in red'); assert.ok(await q.$eval('.ticket.m .t-bar', e => e.classList.contains('over'))); }
    await setTrip(-5, -3, 50000, [['夕食', 4000, 'food', 0], ['宿', 6000, 'stay', 0]]); { const c = await card(); assert.ok(c.includes('使った合計') && c.includes('10,000円') && c.includes('1人あたり') && c.includes('5,000円') && c.includes('予算の残り') && c.includes('40,000円'), 'after the trip: ' + c); }
    assert.ok(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll'); assert.deepStrictEqual(qerrs, []); await c17.close(); }
  // 受け取りの確認（任意）: 「払った」のあとに、受け取る人だけが「受け取った」を押せる。数え方（あと◯件）は、「払った」のまま
  { const c16 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c16.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.hint.swipe', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, paid: {}, savings: {}, settlements: [], adjustments: [],
        members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }], expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'a', cat: 'food', date: t, split: ['a', 'b'] }] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.click('[data-a=tab][data-t=settle]'); await q.waitForSelector('[data-a=toggle-paid]');   // あおい owes こうき (me) 2,000
    assert.strictEqual(await q.locator('.rline').count(), 0, 'not paid yet: no confirmation line');
    await q.click('[data-a=toggle-paid]'); await q.waitForSelector('.rline'); assert.ok((await q.innerText('.rline')).includes('あおいさんが払ったと言っています'), 'the receiver (me) is told who says they paid'); assert.strictEqual(await q.locator('.rline [data-a=toggle-recv]').count(), 1, 'and can confirm');
    await q.click('.rline [data-a=toggle-recv]'); await q.waitForSelector('.rline .link');
    assert.ok((await q.innerText('.rline')).includes('受け取り確認済み')); assert.deepStrictEqual(await q.evaluate(() => Object.keys(state.trips[0].received)), ['b-a-2000'], 'the confirmation is kept with the trip');
    assert.deepStrictEqual(await q.evaluate(() => Object.keys(sanitizeTrip(JSON.parse(JSON.stringify(state.trips[0])), 'n').received)), ['b-a-2000'], 'a backup / restore keeps it');
    await q.click('.rline .link'); await q.waitForSelector('.rline .rbtn'); assert.deepStrictEqual(await q.evaluate(() => Object.keys(state.trips[0].received)), [], 'taken back');
    await q.click('.rline .rbtn'); await q.waitForSelector('.rline .link'); await q.click('[data-a=toggle-paid]'); await q.waitForTimeout(150); assert.deepStrictEqual(await q.evaluate(() => [Object.keys(state.trips[0].paid), Object.keys(state.trips[0].received)]), [[], []], 'un-checking 済み also clears the confirmation');
    // the payer's own view: waiting, and no button
    await q.evaluate(() => { const t = state.trips[0]; t.expenses = [{ id: 'e2', title: '宿', amount: 6000, payer: 'b', cat: 'stay', date: t.start, split: ['a', 'b'] }]; render(); }); await q.waitForSelector('[data-a=toggle-paid]'); await q.click('[data-a=toggle-paid]'); await q.waitForSelector('.rline');
    assert.ok((await q.innerText('.rline')).includes('払った・受け取り待ち')); assert.strictEqual(await q.locator('[data-a=toggle-recv]').count(), 0, 'the payer has no confirm button');
    assert.ok(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll'); assert.deepStrictEqual(qerrs, []); await c16.close(); }
  // 文字の大きさ（設定）: 標準／少し大きく／大きく。選んだ大きさは残り、文字だけが大きくなって、画面は横にあふれず、指に付いてくる動きは、そのまま（指と同じだけ動く）
  { const c15 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block', hasTouch: true }), q = await c15.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.hint.swipe', '1');
      if (!localStorage.getItem('tabiwari.v1')) localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, paid: {}, savings: {}, settlements: [], adjustments: [],
        members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }], expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'b', cat: 'food', date: t, split: ['a', 'b'] }, { id: 'e2', title: '電車', amount: 1200, payer: 'a', cat: 'transport', date: t, split: ['a', 'b'] }] }] })); });
    const ts = () => q.evaluate(() => document.documentElement.style.getPropertyValue('--ts')), fs = sel => q.$eval(sel, e => parseFloat(getComputedStyle(e).fontSize));
    await q.goto('http://localhost:8797/'); await q.waitForSelector('.trip'); assert.strictEqual(await ts(), '1', 'standard: nothing is enlarged'); const f1 = await fs('.trip .nm, .trip b, .trip');
    await q.click('[data-a=app-settings]'); await q.click('[data-a=text-size][data-v="3"]'); assert.strictEqual(await ts(), '1.25'); assert.strictEqual(await q.getAttribute('[data-a=text-size][data-v="3"]', 'aria-pressed'), 'true');
    await q.click('[data-a=text-size][data-v="2"]'); assert.strictEqual(await ts(), '1.12'); await q.click('[data-a=text-size][data-v="3"]');
    await q.reload(); await q.waitForSelector('.trip'); assert.strictEqual(await ts(), '1.25', 'the choice is kept');
    const f3 = await q.$eval('.ut button', e => parseFloat(getComputedStyle(e).fontSize)); assert.ok(Math.abs(f3 - 14 * 1.25) < 0.1, 'the text is 25% larger: ' + f3);
    await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.click('[data-a=tab][data-t=settle]'); await q.waitForSelector('.noteRow'); await q.click('[data-a=tab][data-t=exp]'); await q.waitForSelector('.swp');
    assert.ok(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll when enlarged');
    { const cdp = await c15.newCDPSession(q), box = await q.locator('.swp .item').first().boundingBox(), y = box.y + box.height / 2, x0 = box.x + box.width - 40, shift = () => q.locator('.swp .item').first().boundingBox().then(r => r.x - box.x);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 - i * 15, y }] });
      await q.waitForTimeout(80); const moved = await shift(); assert.ok(moved < -75 && moved > -95, 'the row follows the finger (about 90px) when the text is enlarged: ' + moved);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await q.waitForTimeout(500); assert.strictEqual(await q.locator('.swp.open').count(), 1, 'and a long swipe still opens the delete button'); }
    assert.deepStrictEqual(qerrs, []); await c15.close(); }
  // はじめての人への小さな案内: ひとこと（支出が3件になるまで）と、左スワイプ（［わかった］・スワイプで見つけたら消える・精算済みだけなら出ない）
  { const c14 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c14.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      if (!localStorage.getItem('tabiwari.v1')) localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, paid: {}, savings: {}, settlements: [], adjustments: [],
        members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }], expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'b', cat: 'food', date: t, split: ['a', 'b'] }, { id: 'e2', title: '電車', amount: 1200, payer: 'a', cat: 'transport', date: t, split: ['a', 'b'] }] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]');
    assert.ok((await q.innerText('body')).includes('「夕食 2000円」のように書いて［記録］'), 'the one-line entry is explained while there are few expenses'); assert.strictEqual(await q.locator('.swiphint').count(), 1, 'and the swipe is explained once');
    assert.ok(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
    await q.click('[data-a=hint-swipe-no]'); await q.waitForTimeout(150); assert.strictEqual(await q.locator('.swiphint').count(), 0, '［わかった］ closes it'); assert.strictEqual(await q.evaluate(() => localStorage.getItem('tabiwari.hint.swipe')), '1');
    await q.reload(); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); assert.strictEqual(await q.locator('.swiphint').count(), 0, 'and it stays closed');
    await q.evaluate(() => { localStorage.removeItem('tabiwari.hint.swipe'); state.trips[0].expenses.push({ id: 'e3', title: '昼食', amount: 900, payer: 'a', cat: 'food', date: state.trips[0].start, split: ['a', 'b'] }); render(); }); await q.waitForTimeout(150);
    assert.ok(!(await q.innerText('body')).includes('「夕食 2000円」のように書いて［記録］'), 'three expenses: the one-line entry hint is gone'); assert.strictEqual(await q.locator('.swiphint').count(), 1);
    await q.evaluate(() => { state.trips[0].expenses.forEach(e => { e.settleId = 's1'; }); state.trips[0].settlements = [{ id: 's1', n: 1, at: '2026-01-01', total: 6100, transfers: [] }]; render(); }); await q.waitForTimeout(150);
    assert.strictEqual(await q.locator('.swiphint').count(), 0, 'only settled expenses: nothing to swipe, no hint');
    assert.deepStrictEqual(qerrs, []); await c14.close(); }
  // 共有していない旅行の精算タブ: 「共有すると、精算のお知らせが、LINEに届きます」の1行（共有していて・2人以上で・終わっていない旅行だけ）
  { const c13 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c13.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, paid: {}, savings: {}, settlements: [], adjustments: [],
        members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }], expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'b', cat: 'food', date: t, split: ['a', 'b'] }] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.click('[data-a=tab][data-t=settle]'); await q.waitForSelector('.noteRow');
    assert.ok((await q.innerText('body')).includes('共有すると、精算のお知らせが、LINEに届きます'), 'an unshared trip with friends is told how to get the notices');
    // (the share server is not there in this test, so a "shared" trip would be dropped by a render: ask the function directly)
    const hint = patch => q.evaluate(p => shareHint({ ...JSON.parse(JSON.stringify(state.trips[0])), ...p }), patch);
    assert.ok((await hint({})).includes('共有すると、精算のお知らせ'), 'the function gives the line for an unshared trip');
    assert.strictEqual(await hint({ share: { token: 'T'.repeat(40) } }), '', 'a shared trip: no hint');
    assert.strictEqual(await hint({ members: [{ id: 'a', name: 'こうき', pos: 0 }] }), '', 'alone: no hint');
    assert.strictEqual(await hint({ start: '2026-01-10', end: '2026-01-10' }), '', 'a finished trip: no hint');
    assert.deepStrictEqual(qerrs, []); await c13.close(); }
  // 精算がぜんぶ済んだ旅行: まとめ画像のすすめ（旅行が終わっていて、全部の送金が済みのときだけ。「あとで」で、その旅行は静かになる）
  { const c12 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c12.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    const mk = (end, paid) => `localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: '${end}', end: '${end}', budget: 50000, paid: ${paid}, savings: {}, adjustments: [],
      settlements: [{ id: 's1', n: 1, at: '${end}', total: 6000, transfers: [{ from: 'a', to: 'b', amount: 2000 }] }], members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1 }, { id: 'c', name: 'けんた', pos: 2 }],
      expenses: [{ id: 'e1', title: '夕食', amount: 6000, payer: 'b', cat: 'food', date: '${end}', split: ['a', 'b', 'c'], settleId: 's1' }] }] }))`;
    const open = async (end, paid) => { await q.evaluate(() => localStorage.clear()); await q.addInitScript(mk(end, paid)); await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.click('[data-a=tab][data-t=settle]'); await q.waitForSelector('.noteRow'); };
    await q.goto('http://localhost:8797/'); await open('2026-01-10', "{ 'a-b-2000': true }");
    assert.strictEqual(await q.locator('.recapnudge').count(), 1, 'ended and everything paid: the picture is suggested');
    await q.click('[data-a=recap-nudge-no]'); await q.waitForTimeout(200); assert.strictEqual(await q.locator('.recapnudge').count(), 0, '「あとで」: quiet for this trip');
    await q.reload(); await q.click('.trip'); await q.click('[data-a=tab][data-t=settle]'); await q.waitForSelector('.noteRow'); assert.strictEqual(await q.locator('.recapnudge').count(), 0, 'and it stays quiet after a reload');
    await q.evaluate(() => { localStorage.removeItem('tabiwari.recapnudge'); state.trips[0].paid = {}; render(); }); await q.waitForTimeout(200); assert.strictEqual(await q.locator('.recapnudge').count(), 0, 'a transfer is still unpaid: nothing yet');
    await q.evaluate(() => { state.trips[0].paid = { 'a-b-2000': true }; state.trips[0].start = state.trips[0].end = '2999-01-10'; render(); }); await q.waitForTimeout(200); assert.strictEqual(await q.locator('.recapnudge').count(), 0, 'the trip is not over yet: nothing');
    await q.evaluate(() => { state.trips[0].start = state.trips[0].end = '2026-01-10'; render(); }); await q.waitForTimeout(200); await q.click('.recapnudge [data-a=recap]'); await q.waitForSelector('.recap-img');
    const px = await q.evaluate(async () => { const im = document.querySelector('.recap-img'); await im.decode(); return [im.naturalWidth, im.naturalHeight]; }); assert.deepStrictEqual(px, [1080, 1920], 'the picture is still a full story screen');
    assert.deepStrictEqual(qerrs, []); await c12.close(); }
  // 受け取り方のメモ: written in the settlement tab, shown under the transfer to the receiver (with a copy button), carried to the next trip, never autofocused
  { const c11 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] }), q = await c11.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ me: 'こうき', trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, paid: {}, savings: {}, settlements: [], adjustments: [],
        members: [{ id: 'a', name: 'こうき', pos: 0 }, { id: 'b', name: 'あおい', pos: 1, note: '現金でOK' }],
        expenses: [{ id: 'e1', title: '夕食', amount: 4000, payer: 'b', cat: 'food', date: t, split: ['a', 'b'] }] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('[data-a=add-exp]'); await q.click('[data-a=tab][data-t=settle]'); await q.waitForSelector('.noteRow');
    assert.ok((await q.textContent('.noteRow')).includes('受け取り方を書く'), 'asks to write one'); assert.ok((await q.textContent('.xnote')).includes('あおいさんの受け取り方：現金でOK'), "the receiver's memo is under the transfer");
    await q.click('[data-a=copy-note]'); assert.strictEqual(await q.evaluate(() => navigator.clipboard.readText()), '現金でOK', 'the copy button copies only the memo');
    assert.strictEqual(await q.locator('.xnote a').count(), 0, 'a memo without a link has no link button');
    // a memo with an https link: a tappable button (new tab, no referrer / opener); http:, javascript: and the like are never links
    for (const [note, want] of [['PayPay：https://pay.paypay.ne.jp/AbCd123', 'https://pay.paypay.ne.jp/AbCd123'], ['http://example.com/x', null], ['javascript:alert(1)', null], ['https://user:pw@example.com/', null]]) {
      await q.evaluate(n => { state.trips[0].members[1].note = n; render(); }, note); await q.waitForSelector('.xnote');
      const links = await q.locator('.xnote a').count(); assert.strictEqual(links, want ? 1 : 0, 'link for: ' + note);
      if (want) { assert.deepStrictEqual(await q.evaluate(() => { const a = document.querySelector('.xnote a'); return [a.getAttribute('href'), a.target, a.rel]; }), [want, '_blank', 'noopener noreferrer']); assert.ok(await q.locator('.xnote [data-a=copy-note]').count() === 1, 'the copy button stays'); }
    }
    await q.evaluate(() => { state.trips[0].members[1].note = '現金でOK'; render(); }); await q.waitForSelector('.xnote');
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
    await q.click('[data-a=caps-edit]'); await q.waitForSelector('[data-cap]'); assert.strictEqual(await q.locator('[data-cap]').count(), 6); assert.strictEqual(await q.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-cap')), false, 'the keyboard does not open by itself');
    await q.fill('[data-cap=food]', '1x'); await q.click('[data-a=caps-save]'); await see(q, '上限は、1以上の数字で入力してください'); assert.strictEqual(await q.evaluate(() => state.trips[0].caps), undefined);
    await q.fill('[data-cap=food]', '5,000'); await q.fill('[data-cap=gift]', '3000'); await q.click('[data-a=caps-save]'); await see(q, '上限を保存しました'); assert.deepStrictEqual(await q.evaluate(() => state.trips[0].caps), { food: 5000, gift: 3000 });
    assert.strictEqual(await q.locator('.legend2').count(), 0, 'the category split is folded into one line'); assert.ok((await q.textContent('.ufold')).includes('内訳'), 'with a limit but nothing recorded: the fold line'); await q.click('[data-a=usage-toggle]'); await q.waitForSelector('.legend2');
    assert.ok((await q.textContent('.legend2')).includes('食事 0／5,000') && (await q.textContent('.legend2')).includes('お土産 0／3,000'), 'the categories with a limit show even when unused');
    await q.fill('#q-quick', '夕食 4000円'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 4,000円を記録しました'); assert.ok(!(await q.textContent('.toast, [role=status]').catch(() => '')).includes('超えました'));
    await q.fill('#q-quick', '夕食 2000円'); await q.press('#q-quick', 'Enter'); await see(q, '食事が、上限を 1,000円 超えました。');
    assert.ok((await q.textContent('.legend2 .over')).includes('食事 6,000／5,000（1,000円超え）'), await q.textContent('.legend2')); assert.strictEqual(await q.evaluate(() => getComputedStyle(document.querySelector('.legend2 .over')).color), 'rgb(255, 154, 146)');
    { // tap a category in the card: only its expenses are listed (settled rounds too); the bar still opens the limits; all shown again by the link or the same chip
      await q.click('.lc[data-v=food]'); await q.waitForFunction(() => document.querySelector('.fline')); assert.ok((await q.textContent('.fline')).includes('食事だけ'), 'the filter line says what is shown'); assert.strictEqual(await q.getAttribute('.lc[data-v=food]', 'aria-pressed'), 'true');
      assert.ok(await q.locator('.item[data-a=edit-exp], .swp .item').count() >= 1, 'the filtered expenses are listed');
      await q.click('.fline [data-a=cat-filter]'); await q.waitForFunction(() => !document.querySelector('.fline')); assert.strictEqual(await q.getAttribute('.lc[data-v=food]', 'aria-pressed'), 'false', 'すべて表示 clears it');
      await q.click('.lc[data-v=food]'); await q.click('.lc[data-v=food]'); await q.waitForFunction(() => !document.querySelector('.fline')); }
    await q.fill('#q-quick', '夕食 500円'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 500円を記録しました'); assert.ok(!(await q.innerText('body')).includes('上限を 1,500円 超えました'), 'only the crossing is announced, not every expense after it');
    await q.click('[data-a=caps-edit]'); await q.waitForSelector('[data-cap]'); await q.fill('[data-cap=food]', ''); await q.fill('[data-cap=gift]', ''); await q.click('[data-a=caps-save]'); await see(q, '上限を外しました'); assert.strictEqual(await q.evaluate(() => state.trips[0].caps), undefined);
    assert.deepStrictEqual(qerrs, []); await c14.close(); }

  // たびまる: one entrance (the box). Simple sentences are recorded at once (no AI); what the quick record cannot read (who paid, who shares, several expenses) goes to たびまる by itself;
  // a photo goes through the camera button; a proposal is confirmed (and can be picked item by item) before anything is recorded; limits and errors are explained
  { const c15 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c15.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message));
    let status = { enabled: false, login: false, remaining: null }, parse = null; const sent = [];
    await q.route('**/api/**', r => { const u = r.request().url();
      if (u.endsWith('/api/ai/status')) return r.fulfill({ status: 200, json: status });
      if (u.endsWith('/api/ai/parse')) { sent.push(JSON.parse(r.request().postData())); return setTimeout(() => r.fulfill(parse), 250); }
      return r.fulfill({ status: 404, json: {} }); });
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ id: 't0', name: '箱根', start: t, end: t, budget: 50000, members: [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }, { id: 'c', name: 'みく', pos: 2 }], paid: {}, savings: {}, expenses: [] }] })); });
    await q.goto('http://localhost:8797/'); await q.click('.trip'); await q.waitForSelector('#q-quick'); await q.waitForTimeout(300);
    const SENTENCE = '昨日の夕食、けんたが立て替えて3人で割った 6000円', len = () => q.evaluate(() => state.trips[0].expenses.length);
    assert.strictEqual(await q.locator('.aibtn').count(), 0, 'off on the server: no camera'); assert.strictEqual(await q.locator('[data-a=ai-text]').count(), 0, 'there is no separate たびまる button');
    // off: a simple sentence is recorded; one the quick record cannot read is NOT recorded wrongly
    await q.fill('#q-quick', '夕食 2000円'); await q.press('#q-quick', 'Enter'); await see(q, '夕食 2,000円を記録しました'); assert.strictEqual(await len(), 1);
    await q.fill('#q-quick', SENTENCE); await q.press('#q-quick', 'Enter'); await see(q, '払った人が書いてあるようです'); assert.strictEqual(await len(), 1, 'nothing wrong is recorded'); assert.strictEqual(sent.length, 0);
    status = { enabled: true, login: false, remaining: null }; await q.evaluate(() => refreshAi()); await q.waitForSelector('.aibtn'); assert.strictEqual(await q.locator('.aibtn').count(), 1, 'only the camera');
    await q.fill('#q-quick', SENTENCE); await q.press('#q-quick', 'Enter'); await see(q, 'LINEにログインすると、たびまるが読み取ります'); assert.strictEqual(await len(), 1); assert.strictEqual(sent.length, 0, 'not logged in: nothing is sent');
    await q.click('[data-a=ai-photo]'); await see(q, 'LINEでログインすると、たびまるに頼めます。');
    status = { enabled: true, login: true, remaining: 5 }; await q.evaluate(() => refreshAi()); await q.waitForFunction(() => ui.ai.login);
    // logged in: the simple sentence still goes straight in (no AI call); the hard one goes to たびまる by itself
    await q.fill('#q-quick', 'タクシー 1,200円'); await q.press('#q-quick', 'Enter'); await see(q, 'タクシー 1,200円を記録しました'); assert.strictEqual(sent.length, 0, 'a simple sentence does not use たびまる'); assert.strictEqual(await len(), 2);
    const today = await q.evaluate(() => todayStr()), item = { ok: true, title: '夕食', amount: 6000, category: 'food', date: today, payer: 'けんた', split: 'all', fixed: { みく: 1000 } };
    parse = { status: 200, json: { ok: true, remaining: 4, result: { comment: '夕食 6,000円ですね。けんたさんが払って、3人で割ります。', items: [item] } } };
    await q.fill('#q-quick', SENTENCE); await q.press('#q-quick', 'Enter'); await see(q, '少し待ってください'); await see(q, '夕食 6,000円ですね。けんたさんが払って、3人で割ります。');
    assert.deepStrictEqual([sent[0].text, sent[0].names, sent[0].me, sent[0].today], [SENTENCE, ['あおい', 'けんた', 'みく'], 'あおい', today]); assert.strictEqual(sent[0].image, undefined);
    const sheet = await q.textContent('.sheet'); assert.ok(sheet.includes('けんた') && sheet.includes('6,000円') && sheet.includes('みく 1,000円') && sheet.includes('まだ記録していません') && sheet.includes('あと4回'), sheet);
    assert.strictEqual(await len(), 2, 'a proposal is not a record');
    await q.click('[data-a=ai-edit]'); await q.waitForSelector('#f-amount'); assert.strictEqual(await q.inputValue('#f-amount'), '6,000'); assert.strictEqual(await q.evaluate(() => ui.sheet.data.payer), 'b'); assert.strictEqual(await q.evaluate(() => ui.sheet.data.fixed.c), '1000'); assert.strictEqual(await len(), 2); await q.click('[data-a=close-sheet]');
    await q.fill('#q-quick', '夕食 6000円 けんたが払って みくは1000円だけ'); await q.press('#q-quick', 'Enter'); await see(q, 'まだ記録していません'); await q.click('[data-a=ai-record]'); await see(q, '夕食 6,000円を記録しました');
    assert.deepStrictEqual(await q.evaluate(() => { const e = state.trips[0].expenses[2]; return [e.amount, e.payer, e.split, e.fixed, e.cat]; }), [6000, 'b', ['a', 'b', 'c'], { c: 1000 }, 'food']);
    // several expenses in one sentence: a checklist, item by item; the undo takes all of them away
    const it = (t, a, extra = {}) => ({ ok: true, title: t, amount: a, category: 'food', date: today, payer: null, split: 'all', fixed: {}, ...extra });
    parse = { status: 200, json: { ok: true, remaining: 3, result: { comment: '3件、読み取りました。', items: [it('昼', 1200), it('夜', 3000), it('タクシー', 1500, { category: 'transport', payer: 'あおい', split: ['あおい', 'けんた'] })] } } };
    await q.fill('#q-quick', '昼 1200、夜 3000、タクシー 1500はあおいが払った'); await q.press('#q-quick', 'Enter'); await see(q, '3件、読み取りました。'); assert.strictEqual(await q.locator('.aichk').count(), 3);
    assert.ok((await q.textContent('[data-a=ai-record]')).includes('3件を記録する')); assert.strictEqual(await q.locator('[data-a=ai-edit]').count(), 0, 'no "fix in the record screen" for several');
    await q.click('.aichk >> nth=1'); assert.ok((await q.textContent('[data-a=ai-record]')).includes('2件を記録する')); assert.ok((await q.textContent('.sheet')).includes('チェックを入れた2件が、記録されます')); assert.strictEqual(await q.getAttribute('.aichk >> nth=1', 'aria-checked'), 'false');
    const n0 = await len(); await q.click('[data-a=ai-record]'); await see(q, '2件（合わせて 2,700円）を記録しました'); assert.strictEqual(await len(), n0 + 2, 'only the checked ones');
    assert.deepStrictEqual(await q.evaluate(() => state.trips[0].expenses.slice(-2).map(e => [e.title, e.amount])), [['昼', 1200], ['タクシー', 1500]]); await q.click('[data-a=undo]'); await q.waitForFunction(n => state.trips[0].expenses.length === n, n0);
    await q.fill('#q-quick', '昼 1200、夜 3000、タクシー 1500'); await q.press('#q-quick', 'Enter'); await see(q, '3件、読み取りました。'); await q.click('.aichk >> nth=0'); await q.click('.aichk >> nth=1'); await q.click('.aichk >> nth=2'); assert.strictEqual(await q.isDisabled('[data-a=ai-record]'), true, 'nothing checked: nothing to record'); await q.click('[data-a=close-sheet]');
    // a photo of a receipt: made small on the device and sent as a jpeg, with the same confirmation
    parse = { status: 200, json: { ok: true, remaining: 2, result: { comment: 'ローソン 540円ですね。みんなで割ります。', items: [it('ローソン', 540, { category: 'other' })] } } };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await q.setInputFiles('#ai-file', { name: 'r.png', mimeType: 'image/png', buffer: png }); await see(q, 'ローソン 540円ですね。'); assert.ok(sent[sent.length - 1].image.startsWith('data:image/jpeg;base64,'), 'sent as a jpeg'); await q.click('[data-a=ai-record]'); await see(q, 'ローソン 540円を記録しました');
    assert.strictEqual(await q.evaluate(() => state.trips[0].expenses.find(e => e.title === 'ローソン').payer), 'a', 'no payer written: me');
    // errors are said gently; a used-up day stops the next ask before it is sent
    parse = { status: 422, json: { error: 'unreadable', remaining: 2 } }; await q.fill('#q-quick', 'こんにちは、けんたが払った 1円'); await q.press('#q-quick', 'Enter'); await see(q, 'うまく読み取れませんでした'); await q.click('[data-a=close-sheet]');
    parse = { status: 502, json: { error: 'upstream', detail: '[model] boom / boom' } }; await q.press('#q-quick', 'Enter'); await see(q, '回数は、減っていません'); await see(q, 'くわしい内容（開発者向け）：[model] boom / boom'); await q.click('[data-a=close-sheet]');
    parse = { status: 429, json: { error: 'busy' } }; await q.press('#q-quick', 'Enter'); await see(q, 'たくさん読み取って、おやすみです'); await q.click('[data-a=close-sheet]');
    parse = { status: 429, json: { error: 'limit', remaining: 0 } }; await q.press('#q-quick', 'Enter'); await see(q, '今日は、たびまるに頼める回数を使い切りました'); await q.click('[data-a=close-sheet]'); const n = sent.length;
    await q.press('#q-quick', 'Enter'); await see(q, '使い切りました'); assert.strictEqual(sent.length, n, 'no more asks today: nothing is sent'); assert.ok((await q.textContent('.err')).includes('記録の画面（＋）で入力してください'), 'and the way out is told'); assert.ok(!(await q.innerText('body')).includes('！'), 'no "！" in the words');
    assert.deepStrictEqual(qerrs, []); await c15.close(); }

  // 旅行の設定: the data actions are tiles (書き出し・取り込み、支出があればまとめ画像), and the delete is a separate red row that asks again
  { const c16 = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }), q = await c16.newPage(); const qerrs = []; q.on('pageerror', e => qerrs.push(e.message)); await q.route('**/api/**', r => r.fulfill({ status: 404, json: {} }));
    await q.addInitScript(() => { const x = new Date(), t = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); localStorage.setItem('tabiwari.noinstall', '1');
      const base = { start: t, end: t, budget: 50000, members: [{ id: 'a', name: 'あおい', pos: 0 }], paid: {}, savings: {}, settlements: [], adjustments: [] };
      localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [{ ...base, id: 't0', name: '支出なし', expenses: [] }, { ...base, id: 't1', name: '支出あり', expenses: [{ id: 'e', title: '食事', amount: 900, payer: 'a', cat: 'food', date: t, split: ['a'] }] }] })); });
    await q.goto('http://localhost:8797/'); await q.locator('.trip', { hasText: '支出なし' }).click(); await q.waitForSelector('[data-a=settings]'); await q.click('[data-a=settings]'); await q.waitForSelector('.tiles');
    assert.deepStrictEqual((await q.locator('.tile').allTextContents()).map(t => t.trim()), ['CSV書き出し', 'CSV取り込み'], 'no expenses: no recap tile'); assert.strictEqual(await q.locator('.tile svg').count(), 2, 'with icons');
    assert.strictEqual(await q.locator('.delrow').count(), 1); assert.strictEqual(await q.evaluate(() => getComputedStyle(document.querySelector('.delrow')).color), 'rgb(194, 51, 45)', 'the delete is red');
    assert.ok(await q.evaluate(() => document.querySelector('.delrow').getBoundingClientRect().top - document.querySelector('.tiles').getBoundingClientRect().bottom > 1), 'and apart from the tiles (its own row)');
    await q.click('[data-a=close-sheet]'); await q.click('[data-a=home]'); await q.locator('.trip', { hasText: '支出あり' }).click(); await q.waitForSelector('[data-a=settings]'); await q.click('[data-a=settings]'); await q.waitForSelector('.tiles');
    assert.deepStrictEqual((await q.locator('.tile').allTextContents()).map(t => t.trim()), ['CSV書き出し', 'CSV取り込み', 'まとめ画像']);
    await q.click('[data-a=ask-del-trip]'); await q.waitForSelector('[data-a=del-trip]'); await q.waitForTimeout(500); assert.strictEqual(await q.locator('.delrow').count(), 0, 'asking again: the red row gives way to the confirm button'); assert.strictEqual(await q.evaluate(() => state.trips.length), 2, 'nothing deleted yet'); { const f = await q.evaluate(() => { const b = document.querySelector('.sheet-body'), d = document.querySelector('[data-a=del-trip]').getBoundingClientRect(); return { fit: b.scrollHeight <= b.clientHeight + 1, sc: b.scrollHeight, cl: b.clientHeight, vh: innerHeight, bt: d.bottom, tp: d.top, inView: d.bottom <= innerHeight && d.top >= 0 }; }); assert.ok(f.fit && f.inView, 'the delete confirm fits one screen and its button is on screen: ' + JSON.stringify(f)); await q.click('[data-a=del-trip-cancel]'); await q.waitForSelector('[data-a=ask-del-trip]'); await q.click('[data-a=ask-del-trip]'); await q.waitForSelector('[data-a=del-trip]'); }
    assert.deepStrictEqual(qerrs, []); await c16.close(); }

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('ui e2e passed');
} finally { await b.close(); srv.close(); }
