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
  await p.goto('http://localhost:8797/'); await see(p, '最初の旅行をつくりましょう');
  await p.click('[data-a=new]'); await p.fill('#d-name', '箱根'); await p.fill('#d-budget', '100000'); await p.fill('#d-me', 'あおい'); await p.click('[data-a=save-trip]');
  const add = async (amount, title) => { await p.click('[data-a=add-exp]'); await p.fill('#f-amount', String(amount)); await p.fill('#f-title', title); await p.click('[data-a=save-exp]'); await see(p, title); };

  // screen-reader basics: one main landmark, a level-1 heading, a named dialog that takes focus, the current tab marked, decorative letters hidden
  assert.strictEqual(await p.locator('main#app').count(), 1);
  await p.click('[data-a=add-exp]'); await p.waitForSelector('.sheet');
  assert.strictEqual(await p.getAttribute('.sheet', 'aria-labelledby'), 'sheet-title'); assert.ok((await p.textContent('#sheet-title')).length > 0);
  assert.strictEqual(await p.evaluate(() => document.activeElement && document.activeElement.className), 'sheet', 'the dialog gets focus when it opens (without opening the keyboard)');
  await p.click('[data-a=close-sheet]');
  assert.strictEqual(await p.getAttribute('.tab.on', 'aria-current'), 'page');

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

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('ui e2e passed');
} finally { await b.close(); srv.close(); }
