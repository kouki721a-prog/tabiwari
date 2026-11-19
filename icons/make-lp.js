/* Makes the three screen pictures on the first page (icons/lp/*.png) from the app itself with sample data.   node icons/make-lp.js   (needs playwright and a served dist/ on :8797) */
const { chromium, devices } = require('playwright'), path = require('path');
(async () => {
  const b = await chromium.launch();
  const ms = [{ id: 'a', name: 'あおい', pos: 0 }, { id: 'b', name: 'けんた', pos: 1 }, { id: 'c', name: 'みく', pos: 2 }];
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const ex = (i, t, a, p, c, dt, sp) => ({ id: 'e' + i, title: t, amount: a, payer: p, cat: c, date: d(dt), split: sp || ['a', 'b', 'c'] });
  const trip = { id: 'now', name: '箱根 1泊2日', start: d(-1), end: d(0), budget: 80000, members: ms, paid: {}, savings: { a: 10000, b: 6000 }, expenses: [ex(1, '新幹線', 9800, 'a', 'transport', -1), ex(2, 'ランチ', 4200, 'b', 'food', -1), ex(3, '旅館', 36000, 'c', 'stay', -1), ex(4, 'お土産', 5400, 'a', 'other', 0, ['a', 'b']), ex(5, '夕食', 12600, 'b', 'food', 0)] };
  const c = await b.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, serviceWorkers: 'block', colorScheme: 'light' }), p = await c.newPage();
  await p.route('**/api/**', r => r.fulfill({ json: { login: false, user: null, push: null, items: [] } }));
  await p.addInitScript(t => { localStorage.setItem('tabiwari.noinstall', '1'); localStorage.setItem('tabiwari.v1', JSON.stringify({ trips: [t] })); }, trip);
  await p.goto('http://localhost:8797/'); await p.waitForSelector('[data-a=open]'); await p.click('[data-a=open]'); await p.waitForTimeout(900);
  const shot = async (name, y0, y1) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(__dirname, 'lp', name + '.png'), clip: { x: 12, y: y0, width: 366, height: y1 - y0 } }); };
  await p.click('[data-a=tab][data-t=save]'); await shot('save', 96, 318);
  await p.click('[data-a=tab][data-t=exp]'); await shot('exp', 80, 346);
  await p.click('[data-a=tab][data-t=settle]'); await shot('settle', 296, 520);
  await b.close();
})();
