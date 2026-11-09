const fs = require('fs'), assert = require('assert'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/LOGIC_START[^\n]*\n([\s\S]*?)\/\* ===== LOGIC_END/);
const L = new Function(m[1] + '; return {splitShares, calcBalances, settle, dayDiff, parseYen, tripCsv, csvCell};')();

assert.deepStrictEqual(L.splitShares(100, ['a','b','c']).map(x => x[1]), [34,33,33]);
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
    assert.strictEqual(L.splitShares(amount, split).reduce((s, x) => s + x[1], 0), amount);
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
console.log('logic tests passed');
