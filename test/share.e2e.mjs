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
  await A.p.goto(base + '/'); await see(A.p, '旅のお金を、片づけます');
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
  await Bp.p.goto(link); await see(Bp.p, 'に招待されました'); await see(Bp.p, '共有テスト');
  assert.ok(!Bp.p.url().includes('#t='), 'token is removed from the address bar after it is read');
  await Bp.p.click('[data-a=join-share-go]'); await see(Bp.p, '名前を入力するか');             // nothing entered yet -> asked
  await Bp.p.fill('#j-name', 'けんた'); await Bp.p.click('[data-a=join-share-go]');
  await see(Bp.p, '参加しました'); await see(Bp.p, '夕食'); await see(Bp.p, '3,000円');
  // a person who has just joined sees a short guide once; "わかった" dismisses it for good
  await see(Bp.p, '支出は、下の［＋］か、ひとことで記録できます'); await Bp.p.click('[data-a=welcome-ok]'); assert.strictEqual(await Bp.p.locator('[data-a=welcome-ok]').count(), 0, 'the guide goes away');
  await refresh(Bp.p); assert.strictEqual(await Bp.p.locator('[data-a=welcome-ok]').count(), 0, 'and does not come back');

  // ---------- B records; A sees it; A edits; B sees it; both compute the same settlement
  await addExpense(Bp.p, 1200, 'コーヒー');
  await refresh(A.p); await see(A.p, 'コーヒー');
  await A.p.locator('[data-a=edit-exp]', { hasText: '夕食' }).click(); await A.p.fill('#f-amount', '3600'); await A.p.click('[data-a=save-exp]'); await see(A.p, '保存しました');
  await refresh(Bp.p); await see(Bp.p, '3,600円');
  for (const [i, x] of [A, Bp].entries()) { await x.p.click('[data-a=tab][data-t=settle]'); try { await see(x.p, 'あおい → けんた'); } catch (e) { console.log('DEBUG person', i, (await x.p.locator('.scroll').innerText()).replace(/\n+/g, ' | ')); throw e; } await see(x.p, '600円'); await x.p.click('[data-a=tab][data-t=exp]'); }
  // B is "けんた": default payer on the form is B's own member
  await Bp.p.click('[data-a=add-exp]'); assert.ok(await Bp.p.locator('.chip.on', { hasText: 'けんた' }).count() >= 1); await Bp.p.click('[data-a=close-sheet]');

  // ---------- rounds of settlement are shared: A closes round 1, B sees it; B's later receipt is round 2 for both; B edits a closed expense -> the adjustment reaches A
  await A.p.click('[data-a=tab][data-t=settle]'); await A.p.click('[data-a=settle-ask]'); await A.p.click('[data-a=settle-go]'); await see(A.p, '第1回の精算を確定しました');
  await refresh(Bp.p); await Bp.p.click('[data-a=tab][data-t=settle]'); await see(Bp.p, '未精算の支出はありません'); await see(Bp.p, '精算の履歴'); assert.strictEqual(await Bp.p.locator('[data-a=settle-open]').count(), 1, 'B sees round 1 in the history');
  await Bp.p.click('[data-a=tab][data-t=exp]'); await see(Bp.p, '第1回で精算済み');
  await addExpense(Bp.p, 700, 'おみやげ代'); await refresh(A.p); await A.p.click('[data-a=tab][data-t=settle]'); await see(A.p, '第2回の精算');
  await A.p.click('[data-a=tab][data-t=exp]'); await see(A.p, 'おみやげ代');
  // 変更履歴: B recorded it, so A sees who recorded it (through the shared server)
  await A.p.locator('[data-a=edit-exp]', { hasText: 'おみやげ代' }).click(); await A.p.waitForSelector('.elog'); { const t = await A.p.innerText('.elog'); assert.ok(t.includes('けんたが') && t.includes('記録'), 'A sees who recorded it: ' + t); } await A.p.click('[data-a=close-sheet]');
  // pull down at the top of the list: the arrow shows, and the other person's new record comes in
  await addExpense(Bp.p, 300, 'ひっぱり代');
  { const shown = await A.p.evaluate(() => { const el = document.querySelector('.scroll .item') || document.querySelector('.scroll'), mk = y => new Touch({ identifier: 4, target: el, clientX: 200, clientY: y }), fire = (type, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(y)], changedTouches: [mk(y)] })); fire('touchstart', 200); fire('touchmove', 230); fire('touchmove', 300); const s = !!document.getElementById('ptr'); fire('touchend', 300); return s; });
    assert.ok(shown, 'the pull arrow shows'); await see(A.p, 'ひっぱり代'); await A.p.waitForFunction(() => !document.getElementById('ptr'), null, { timeout: 4000 }); }
  await Bp.p.click('[data-a=toggle-round]');   // settled expenses are folded by round
  await Bp.p.locator('[data-a=edit-exp]', { hasText: 'コーヒー' }).click(); await Bp.p.fill('#f-amount', '2000'); await Bp.p.click('[data-a=save-exp]'); await Bp.p.click('[data-a=save-exp]'); await see(Bp.p, '保存しました');
  await refresh(A.p); await A.p.click('[data-a=tab][data-t=settle]'); await see(A.p, '過去の精算の変更による差額');
  // 受け取り方のメモ: B writes one in the settlement tab; A sees it under the transfer to B after a refresh, and can copy it
  await Bp.p.click('[data-a=tab][data-t=settle]'); await Bp.p.click('.noteRow'); await Bp.p.fill('#f-note', '現金でOK'); await Bp.p.click('[data-a=note-save]'); await see(Bp.p, '受け取り方を書きました');
  await Bp.p.waitForFunction(() => document.body.innerText.indexOf('同期待ち') < 0, null, { timeout: 12000 });
  await refresh(A.p); await A.p.click('[data-a=tab][data-t=settle]'); await see(A.p, 'さんの受け取り方：現金でOK');
  // 受け取りの確認: whoever owes marks it paid; the receiver sees "言っています" and confirms; the payer then sees it confirmed (through the shared server)
  { await A.p.click('[data-a=tab][data-t=settle]'); await Bp.p.click('[data-a=tab][data-t=settle]'); await A.p.waitForSelector('[data-a=toggle-paid]');
    const key = await A.p.getAttribute('[data-a=toggle-paid]', 'data-k'), ma = await A.p.evaluate(() => meId(trip())), payer = key.replace(/^\d+:/, '').startsWith(ma + '-') ? A : Bp, receiver = payer === A ? Bp : A;
    await payer.p.click('[data-a=toggle-paid][data-k="' + key + '"]'); await payer.p.waitForFunction(() => document.body.innerText.indexOf('同期待ち') < 0, null, { timeout: 12000 });
    await refresh(receiver.p); await receiver.p.click('[data-a=tab][data-t=settle]'); try { await receiver.p.waitForSelector('.rline .rbtn', { timeout: 5000 }); } catch (e) { console.log('DEBUG', key, ma, payer === A ? 'A pays' : 'B pays', await receiver.p.evaluate(() => JSON.stringify({ me: meId(trip()), paid: trip().paid, rl: [...document.querySelectorAll('.rline')].map(x => x.innerText), xf: [...document.querySelectorAll('.xfer')].map(x => x.innerText.replace(/\n+/g, '|')) }))); throw e; } assert.ok((await receiver.p.innerText('.rline')).includes('払ったと言っています'));
    await receiver.p.click('.rline .rbtn'); await receiver.p.waitForFunction(() => document.body.innerText.indexOf('同期待ち') < 0, null, { timeout: 12000 });
    await refresh(payer.p); await payer.p.click('[data-a=tab][data-t=settle]'); await see(payer.p, '受け取り確認済み'); assert.strictEqual(await payer.p.locator('[data-a=toggle-recv]').count(), 0, 'the payer cannot confirm for the receiver');
    await payer.p.click('[data-a=toggle-paid][data-k="' + key + '"]'); await payer.p.waitForFunction(() => document.body.innerText.indexOf('同期待ち') < 0, null, { timeout: 12000 });   // back to the start for the rest of the test
    await refresh(receiver.p); await receiver.p.click('[data-a=tab][data-t=settle]'); await receiver.p.waitForFunction(() => !document.querySelector('.rline'), null, { timeout: 8000 }); }
  await A.p.click('[data-a=tab][data-t=exp]'); await Bp.p.click('[data-a=tab][data-t=exp]');

  // ---------- offline edits wait, then go out when the connection returns
  await Bp.ctx.setOffline(true); await addExpense(Bp.p, 500, 'ガム'); await see(Bp.p, '同期待ち');
  await Bp.ctx.setOffline(false); await Bp.p.evaluate(() => window.dispatchEvent(new Event('online')));
  await refresh(A.p); await see(A.p, 'ガム'); await Bp.p.waitForFunction(() => document.body.innerText.indexOf('同期待ち') < 0);

  // ---------- C joins by pasting a message that contains the link (the home-screen-app route), as a new name
  const C = await person();
  await C.p.goto(base + '/'); await C.p.click('[data-a=join-paste]'); await C.p.fill('#p-link', 'https://example.invalid/#t=short');
  await C.p.click('[data-a=join-paste-go]'); await see(C.p, 'リンクの形式を確認してください');
  await C.p.fill('#p-link', '「共有テスト」の割り勘に参加してね。\n' + link + '\n'); await C.p.click('[data-a=join-paste-go]'); await see(C.p, 'に招待されました');
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

  // ---------- 積立の履歴 on a shared trip: A deposits (an entry), B joins and sees it, B edits it, A sees the edit; A deletes it, B sees the total fall back to an "unlogged" line
  { const P1 = await person(); await P1.p.goto(base + '/'); await see(P1.p, '旅のお金を、片づけます');
    await P1.p.click('[data-a=new]'); await P1.p.fill('#d-name', '積立共有'); await P1.p.fill('#d-budget', '60000'); await P1.p.fill('#d-me', 'あおい');
    await P1.p.evaluate(() => { const s = addDays(todayStr(), 30); ui.draft.start = s; ui.draft.end = addDays(s, 1); render(); }); await P1.p.click('[data-a=save-trip]'); await P1.p.waitForSelector('.stn');
    await P1.p.click('[data-a=add-save]'); await P1.p.waitForSelector('#f-save'); await P1.p.fill('#f-save', '20000'); await P1.p.click('[data-a=save-saving]'); await P1.p.waitForFunction(() => !document.querySelector('.sheet-bg'));
    await P1.p.click('[data-a=settings]'); await see(P1.p, '友だちと共有'); await P1.p.click('[data-a=share-start]'); await P1.p.waitForSelector('#s-sharelink', { timeout: 9000 }); const lk = await P1.p.inputValue('#s-sharelink'); await P1.p.click('[data-a=close-sheet]'); await see(P1.p, '共有中');
    const P2 = await person(); await P2.p.goto(lk); await see(P2.p, 'に招待されました'); await P2.p.fill('#j-name', 'けんた'); await P2.p.click('[data-a=join-share-go]'); await see(P2.p, '参加しました');
    await P2.p.click('[data-a=tab][data-t=save]'); await see(P2.p, '+20,000円'); assert.strictEqual(await P2.p.locator('#app .slog-rest').count(), 0, 'the entry came over; nothing is "unlogged"'); assert.ok((await P2.p.innerText('#app .scroll')).includes('あおい・'), 'whose saving it is is shown (there are two people now)');
    await P2.p.click('#app [data-a=sl-edit]'); await P2.p.waitForSelector('#f-sl-a'); await P2.p.fill('#f-sl-a', '15000'); await P2.p.click('[data-a=sl-save]'); await see(P2.p, '+15,000円'); await P2.p.waitForTimeout(1500);
    await refresh(P1.p); await P1.p.waitForTimeout(1500); await P1.p.click('[data-a=tab][data-t=save]').catch(() => {}); await see(P1.p, '+15,000円');
    await P1.p.click('#app [data-a=sl-edit]'); await P1.p.waitForSelector('[data-a=sl-del]'); await P1.p.click('[data-a=sl-del]'); await P1.p.waitForFunction(() => !document.querySelector('.sheet-bg') && !document.querySelector('#app [data-a=sl-edit]')); await P1.p.waitForFunction(() => { const x = state.trips.find(y => y.name === '積立共有'); return x && !x.share.dirty; }, null, { timeout: 9000 }); await P1.p.waitForTimeout(500);
    await refresh(P2.p); await P2.p.waitForFunction(() => { const x = state.trips.find(y => y.name === '積立共有'); return x && Object.values(x.savings).reduce((s, v) => s + v, 0) === 0; }, null, { timeout: 9000 }).catch(() => {}); assert.ok((await P2.p.innerText('.ticket.c, .sheet')).includes('0円'), 'B sees the deletion'); assert.strictEqual(await P2.p.evaluate(() => { const t = state.trips.find(x => x.name === '積立共有'); return Object.values(t.savings).reduce((a, v) => a + v, 0); }), 0, 'the total is 0 on B too');
    await P1.ctx.close(); await P2.ctx.close(); }

  console.log('errors:', errs); assert.deepStrictEqual(errs, []);
  console.log('share e2e passed');
} finally { await b.close(); srv.stop(); }
