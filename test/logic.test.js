const fs = require('fs'), assert = require('assert'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/LOGIC_START[^\n]*\n([\s\S]*?)\/\* ===== LOGIC_END/);
const L = new Function(m[1] + '; return {splitShares, calcBalances, settle, dayDiff, parseYen};')();

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
console.log('logic tests passed');
