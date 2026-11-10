const fs = require('fs'), assert = require('assert'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/LOGIC_START[^\n]*\n([\s\S]*?)\/\* ===== LOGIC_END/);
const L = new Function(m[1] + '; return {splitShares, calcBalances, settle, dayDiff, parseYen, tripCsv, csvCell, isUntouchedSample, sanitizeTrip};')();

// leftover yen: total is exact, nobody is off by more than 1 yen, same input -> same output, and the extra yen rotate between expenses
const ids3 = ['a','b','c'], sum3 = r => r.reduce((t, x) => t + x[1], 0);
assert.deepStrictEqual(L.splitShares(100, ids3, 'e1'), L.splitShares(100, ids3, 'e1'));
assert.deepStrictEqual(L.splitShares(100, ['c','a','b'], 'e1').sort(), L.splitShares(100, ids3, 'e1').sort(), 'selection order does not matter');
assert.deepStrictEqual(L.splitShares(99, ids3, 'x').map(x => x[1]), [33,33,33]);
const extraCount = { a: 0, b: 0, c: 0 };
for (let k = 0; k < 3000; k++){ const r = L.splitShares(100, ids3, 'exp' + k); assert.strictEqual(sum3(r), 100); r.forEach(x => { assert.ok(x[1] === 33 || x[1] === 34); if (x[1] === 34) extraCount[x[0]]++; }); }
Object.values(extraCount).forEach(c => assert.ok(c > 800 && c < 1200, 'the extra yen are spread evenly: ' + JSON.stringify(extraCount)));
assert.strictEqual(L.splitShares(10, ['a'], 'z')[0][1], 10);
assert.strictEqual(L.dayDiff('2026-03-28', '2026-03-30'), 2);
assert.strictEqual(L.dayDiff('2026-11-01', '2026-11-01'), 0);
assert.strictEqual(L.parseYen('１，２３４円'), 1234);
assert.strictEqual(L.parseYen(' ¥5,000 '), 5000);
assert.ok(isNaN(L.parseYen('12.5'))); assert.ok(isNaN(L.parseYen('abc'))); assert.ok(isNaN(L.parseYen('')));

let seed = 1; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let k = 0; k < 2000; k++){
  const n = 2 + Math.floor(rnd() * 7), ids = Array.from({length: n}, (_, i) => 'm' + i);
  const t = { members: ids.map(id => ({id})), expenses: [] };
  for (let e = 0, c = 1 + Math.floor(rnd() * 12); e < c; e++){
    const split = ids.filter(() => rnd() < .6); if (!split.length) split.push(ids[0]);
    const amount = 1 + Math.floor(rnd() * 50000);
    assert.strictEqual(L.splitShares(amount, split, 'e' + e).reduce((s, x) => s + x[1], 0), amount);
    t.expenses.push({ amount, payer: ids[Math.floor(rnd() * n)], split });
  }
  const net = L.calcBalances(t).net, sum = Object.values(net).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, 0);
  const pays = L.settle(net); assert.ok(pays.length <= n - 1);
  const after = Object.assign({}, net); pays.forEach(p => { after[p.from] += p.amount; after[p.to] -= p.amount; });
  Object.values(after).forEach(v => assert.strictEqual(v, 0));
}

// CSV: header, one row per expense (by date), settlement block; quotes/commas escaped; formula-looking text neutralised
const csvTrip = { members: [{id:'a',name:'あおい'},{id:'b',name:'けんた'}], expenses: [
  {id:'1', title:'夕食, 2軒目', amount:3000, payer:'b', cat:'food', date:'2026-11-10', split:['a','b']},
  {id:'2', title:'=HYPERLINK("x")', amount:1000, payer:'a', cat:'gift', date:'2026-11-09', split:['a']}]};
const csv = L.tripCsv(csvTrip, c => ({food:'食事', gift:'お土産'})[c]).split('\r\n');
assert.strictEqual(csv[0], '日付,内容,カテゴリ,金額,払った人,割り勘の対象');
assert.strictEqual(csv[1], '2026-11-09,"\'=HYPERLINK(""x"")",お土産,1000,あおい,あおい');
assert.strictEqual(csv[2], '2026-11-10,"夕食, 2軒目",食事,3000,けんた,あおい・けんた');
assert.strictEqual(csv[3], ''); assert.strictEqual(csv[4], '精算,払う人,受け取る人,金額'); assert.strictEqual(csv[5], ',あおい,けんた,1500');
assert.strictEqual(L.csvCell(-5), '-5');

// the old demo trip: removed only while untouched
const sample = () => ({ sample: true, budget: 80000, paid: {}, savings: {a: 20000, b: 15000}, members: [{id:'a'},{id:'b'},{id:'c'}], expenses: [
  ['新幹線',9600,'transport',3],['旅館 1泊',30000,'stay',3],['夕食',8700,'food',3],['ロープウェイ',2400,'sight',2],['朝食ビュッフェ',4300,'food',3]]
  .map((x, i) => ({ id: 'e' + i, title: x[0], amount: x[1], cat: x[2], split: Array(x[3]).fill('a') })) });
assert.strictEqual(L.isUntouchedSample(sample()), true);
let sm = sample(); sm.expenses.push({ id: 'n', title: 'コーヒー', amount: 500, cat: 'food', split: ['a'] }); assert.strictEqual(L.isUntouchedSample(sm), false, 'added expense');
sm = sample(); sm.expenses[0].amount = 9700; assert.strictEqual(L.isUntouchedSample(sm), false, 'edited expense');
sm = sample(); sm.paid = { k: true }; assert.strictEqual(L.isUntouchedSample(sm), false, 'marked paid');
sm = sample(); sm.savings.a = 25000; assert.strictEqual(L.isUntouchedSample(sm), false, 'changed savings');
sm = sample(); sm.sample = false; assert.strictEqual(L.isUntouchedSample(sm), false, 'a real trip with the same numbers');

// restoring from a backup rebuilds the trip field by field
const raw = () => ({ id: 't1', name: 'お盆', start: '2026-08-13', end: '2026-08-15', budget: 40000, evil: '<script>', share: { token: 'x' },
  members: [{ id: 'a', name: 'あおい', pos: 0, userId: 'U9' }, { id: 'b', name: 'けんた', pos: 1 }],
  expenses: [{ id: 'e1', title: '昼食', amount: 1800, payer: 'a', cat: 'food', date: '2026-08-13', split: ['a', 'b', 'ghost'], extra: 1 }],
  paid: { 'b-a-900': true, bad: 'yes' }, savings: { a: 5000, ghost: 9, b: -1 } });
let r = L.sanitizeTrip(raw(), 'new-id');
assert.strictEqual(r.id, 'new-id'); assert.deepStrictEqual(Object.keys(r).sort(), ['budget', 'end', 'expenses', 'id', 'members', 'name', 'paid', 'savings', 'start']);
assert.deepStrictEqual(r.expenses[0].split, ['a', 'b'], 'unknown members are dropped from splits'); assert.strictEqual(r.expenses[0].extra, undefined);
assert.deepStrictEqual(r.paid, { 'b-a-900': true }); assert.deepStrictEqual(r.savings, { a: 5000 }); assert.strictEqual(r.members[0].userId, undefined);
for (const f of [t => { t.name = '  '; }, t => { t.budget = 0; }, t => { t.end = '2026-08-01'; }, t => { t.members = []; }, t => { t.start = 'soon'; }]) { const t = raw(); f(t); assert.strictEqual(L.sanitizeTrip(t, 'x'), null); }
{ const t = raw(); t.expenses.push({ id: 'e2', amount: 5, payer: 'nobody', cat: 'food', date: '2026-08-13', split: ['a'] }, { id: 'e3', amount: 5, payer: 'a', cat: 'weapons', date: '2026-08-13', split: ['a'] }, { id: 'e4', amount: 5, payer: 'a', cat: 'food', date: '2026-08-13', split: ['ghost'] });
  assert.strictEqual(L.sanitizeTrip(t, 'x').expenses.length, 1, 'rows that cannot be valid are dropped'); }
assert.strictEqual(L.sanitizeTrip(null, 'x'), null); assert.strictEqual(L.sanitizeTrip('str', 'x'), null);
console.log('logic tests passed');
