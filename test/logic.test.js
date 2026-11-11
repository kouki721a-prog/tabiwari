const fs = require('fs'), assert = require('assert'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/LOGIC_START[^\n]*\n([\s\S]*?)\/\* ===== LOGIC_END/);
const L = new Function(m[1] + '; return {splitShares, matchExpense, parseCsv, importCsv, calcBalances, roundBalances, confirmRound, expenseAdjustment, openItems, isSettled, roundNo, settle, dayDiff, parseYen, tripCsv, csvCell, isUntouchedSample, sanitizeTrip, payRequestText};')();

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
assert.strictEqual(csv[0], '日付,内容,カテゴリ,金額,払った人,割り勘の対象,精算');
assert.strictEqual(csv[1], '2026-11-09,"\'=HYPERLINK(""x"")",お土産,1000,あおい,あおい,未精算');
assert.strictEqual(csv[2], '2026-11-10,"夕食, 2軒目",食事,3000,けんた,あおい・けんた,未精算');
assert.strictEqual(csv[3], ''); assert.strictEqual(csv[4], '精算（いまの回）,払う人,受け取る人,金額'); assert.strictEqual(csv[5], ',あおい,けんた,1500');
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
assert.strictEqual(r.id, 'new-id'); assert.deepStrictEqual(Object.keys(r).sort(), ['adjustments', 'budget', 'end', 'expenses', 'id', 'members', 'name', 'paid', 'savings', 'settlements', 'start']);
assert.deepStrictEqual(r.expenses[0].split, ['a', 'b'], 'unknown members are dropped from splits'); assert.strictEqual(r.expenses[0].extra, undefined);
assert.deepStrictEqual(r.paid, { 'b-a-900': true }); assert.deepStrictEqual(r.savings, { a: 5000 }); assert.strictEqual(r.members[0].userId, undefined);
for (const f of [t => { t.name = '  '; }, t => { t.budget = 0; }, t => { t.end = '2026-08-01'; }, t => { t.members = []; }, t => { t.start = 'soon'; }]) { const t = raw(); f(t); assert.strictEqual(L.sanitizeTrip(t, 'x'), null); }
{ const t = raw(); t.expenses.push({ id: 'e2', amount: 5, payer: 'nobody', cat: 'food', date: '2026-08-13', split: ['a'] }, { id: 'e3', amount: 5, payer: 'a', cat: 'weapons', date: '2026-08-13', split: ['a'] }, { id: 'e4', amount: 5, payer: 'a', cat: 'food', date: '2026-08-13', split: ['ghost'] });
  assert.strictEqual(L.sanitizeTrip(t, 'x').expenses.length, 1, 'rows that cannot be valid are dropped'); }
assert.strictEqual(L.sanitizeTrip(null, 'x'), null); assert.strictEqual(L.sanitizeTrip('str', 'x'), null);
console.log('logic tests passed');

// search: every word must match; full-width characters are normalised
const ex = { title: '箱根ロープウェイ', amount: 3200, date: '2026-11-10' }, lb = { cat: '交通', payer: 'あおい', split: ['あおい', 'けんた'] };
assert.ok(L.matchExpense(ex, '', lb), 'empty query matches everything');
assert.ok(L.matchExpense(ex, 'ロープ', lb) && L.matchExpense(ex, '交通 けんた', lb) && L.matchExpense(ex, '３２００', lb) && L.matchExpense(ex, '2026-11', lb));
assert.ok(!L.matchExpense(ex, 'ロープ 宿泊', lb) && !L.matchExpense(ex, '9999', lb));
console.log('search tests passed');

// CSV import: what tripCsv writes comes back; the settlement block is ignored; unknown names and bad rows are skipped, not guessed
{
  const catBy = { '食事': 'food', 'お土産': 'gift', '交通': 'transport' }, catName = c => ({ food: '食事', gift: 'お土産', transport: '交通' })[c] || 'その他';
  const members = [{ id: 'a', name: 'あおい' }, { id: 'b', name: 'けんた' }];
  const src = { members, expenses: [
    { id: '1', title: '夕食, 2軒目', amount: 3000, payer: 'b', cat: 'food', date: '2026-11-10', split: ['a', 'b'] },
    { id: '2', title: '=HYPERLINK("x")', amount: 1000, payer: 'a', cat: 'gift', date: '2026-11-09', split: ['a'] },
    { id: '3', title: '"引用"と\n改行', amount: 500, payer: 'a', cat: 'transport', date: '2026-11-09', split: ['b', 'a'] }] };
  const csv = L.tripCsv(src, catName);
  assert.deepStrictEqual(L.parseCsv('a,"b,c"\r\n"d""e",f\n').map(r => r.join('|')), ['a|b,c', 'd"e|f']);
  let n = 0; const empty = { members, expenses: [] }, res = L.importCsv(empty, '\ufeff' + csv, () => 'n' + (++n), catBy);
  assert.strictEqual(res.skipped.length, 0, JSON.stringify(res.skipped)); assert.strictEqual(res.add.length, 3);
  const by = t => res.add.find(e => e.title === t);
  assert.deepStrictEqual([by('夕食, 2軒目').amount, by('夕食, 2軒目').payer, by('夕食, 2軒目').split, by('夕食, 2軒目').cat, by('夕食, 2軒目').date], [3000, 'b', ['a', 'b'], 'food', '2026-11-10']);
  assert.ok(by('=HYPERLINK("x")'), 'the leading quote added against formulas is removed'); assert.strictEqual(by('=HYPERLINK("x")').cat, 'gift');
  assert.ok(by('"引用"と\n改行'));
  // importing the same file again adds nothing; a partly matching trip skips only the bad rows
  const again = L.importCsv({ members, expenses: res.add }, csv, () => 'x', catBy); assert.strictEqual(again.add.length, 0); assert.strictEqual(again.dup, 3);
  const mixed = L.importCsv(empty, '日付,内容,カテゴリ,金額,払った人,割り勘の対象\n2026/11/3,朝食,食事,１，２００円,あおい,あおい・けんた\n2026-11-04,x,食事,100,たろう,あおい\n2026-11-05,y,食事,abc,あおい,あおい\nbad,z,食事,100,あおい,あおい\n2026-11-06,w,食事,100,あおい,あおい・たろう\n2026-11-07,q,不明,100,あおい,\n\n精算,払う人,受け取る人,金額\n,あおい,けんた,1500', () => 'm', catBy);
  assert.deepStrictEqual(mixed.add.map(e => [e.date, e.amount, e.cat]), [['2026-11-03', 1200, 'food']]);
  assert.strictEqual(mixed.skipped.length, 5, JSON.stringify(mixed.skipped)); assert.deepStrictEqual(mixed.skipped.map(x => x.line), [3, 4, 5, 6, 7]);
}
console.log('csv import tests passed');

// ---- rounds of settlement
{
  const mk = () => ({ members: ['a', 'b', 'c'].map(id => ({ id })), expenses: [], settlements: [], adjustments: [] });
  const sumNets = n => Object.values(n).reduce((x, y) => x + y, 0);
  // old data (no settlements, no settleId) is "round 1, not settled": same numbers as before
  const old = { members: [{ id: 'a' }, { id: 'b' }], expenses: [{ id: 'e1', amount: 3000, payer: 'a', split: ['a', 'b'] }], paid: {}, savings: {} };
  assert.deepStrictEqual(L.roundBalances(old).net, L.calcBalances(old).net); assert.strictEqual(L.openItems(old).expenses.length, 1);
  // confirm round 1, add a receipt later -> round 2 holds only the new one
  const t = mk(); t.expenses.push({ id: 'e1', amount: 3000, payer: 'a', split: ['a', 'b', 'c'] }, { id: 'e2', amount: 1000, payer: 'b', split: ['a', 'b'] });
  const s1 = L.confirmRound(t, 'r1', '2026-11-10');
  assert.deepStrictEqual([s1.n, s1.total, t.settlements.length, t.expenses.every(e => e.settleId === 'r1')], [1, 4000, 1, true]);
  assert.ok(sumNets(Object.fromEntries(s1.transfers.map((p, i) => [i, 0]))) === 0 && L.roundBalances(t).net.a === 0, 'nothing open right after confirming');
  t.expenses.push({ id: 'e3', amount: 600, payer: 'c', split: ['a', 'b', 'c'] });
  assert.deepStrictEqual(L.roundBalances(t).net, { a: -200, b: -200, c: 400 }, 'round 2 only counts the new expense');
  const budgetTotal = t.expenses.reduce((x, e) => x + e.amount, 0); assert.strictEqual(budgetTotal, 4600, 'the budget uses every expense, whatever the round');
  // editing a settled expense: round 1 stays as it was, the difference lands in round 2; deleting too
  const e2 = t.expenses.find(e => e.id === 'e2'), before = JSON.parse(JSON.stringify(e2)); e2.amount = 1500;
  const adj = L.expenseAdjustment(t, before, e2, 'j1', '「e2」の変更', '2026-11-11'); t.adjustments.push(adj);
  assert.ok(adj && sumNets(adj.nets) === 0 && adj.settleId === null);
  assert.strictEqual(L.expenseAdjustment(t, { ...before }, { ...before }, 'x', '', '2026-11-11'), null, 'nothing changed: no adjustment');
  assert.strictEqual(L.expenseAdjustment(t, t.expenses.find(e => e.id === 'e3'), null, 'x', '', '2026-11-11'), null, 'an unsettled expense never needs one');
  assert.strictEqual(sumNets(L.roundBalances(t).net), 0);
  // the second round, once confirmed, takes the adjustment with it and later rounds do not repeat it
  const before2 = L.roundBalances(t).net; const s2 = L.confirmRound(t, 'r2', '2026-11-12');
  assert.ok(t.adjustments.every(a => a.settleId === 'r2') && L.roundNo(t, 'r2') === 2);
  assert.deepStrictEqual(L.roundBalances(t).net, { a: 0, b: 0, c: 0 }, 'the adjustment is not counted again');
  // random: edits and deletes of settled expenses across several rounds; every round's money adds up to the final state
  let seed2 = 7; const r2 = () => (seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 600; k++){
    const n = 2 + Math.floor(r2() * 4), ids = Array.from({ length: n }, (_, i) => 'm' + i), tt = { members: ids.map(id => ({ id })), expenses: [], settlements: [], adjustments: [] };
    const pick = () => { const sp = ids.filter(() => r2() < .6); return sp.length ? sp : [ids[0]]; };
    const balanceSum = {}; ids.forEach(id => { balanceSum[id] = 0; });
    let nextId = 0, adjN = 0;
    for (let step = 0, steps = 3 + Math.floor(r2() * 25); step < steps; step++){
      const r = r2();
      if (r < .45 || !tt.expenses.length) tt.expenses.push({ id: 'e' + (nextId++), amount: 1 + Math.floor(r2() * 30000), payer: ids[Math.floor(r2() * n)], split: pick() });
      else if (r < .65){ const e = tt.expenses[Math.floor(r2() * tt.expenses.length)], old = JSON.parse(JSON.stringify(e)); e.amount = 1 + Math.floor(r2() * 30000); e.payer = ids[Math.floor(r2() * n)]; e.split = pick();
        const a = L.expenseAdjustment(tt, old, e, 'j' + (adjN++), '', '2026-11-10'); if (a) tt.adjustments.push(a); }
      else if (r < .8){ const i = Math.floor(r2() * tt.expenses.length), old = tt.expenses[i]; const a = L.expenseAdjustment(tt, old, null, 'j' + (adjN++), '', '2026-11-10'); if (a) tt.adjustments.push(a); tt.expenses.splice(i, 1); }
      else if (L.openItems(tt).expenses.length || L.openItems(tt).adjustments.length){
        const bal = L.roundBalances(tt).net; assert.strictEqual(sumNets(bal), 0);
        const st = L.confirmRound(tt, 'r' + tt.settlements.length, '2026-11-10');
        const after = {}; ids.forEach(id => { after[id] = bal[id]; }); st.transfers.forEach(p => { after[p.from] += p.amount; after[p.to] -= p.amount; });   // paying the transfers settles the round
        ids.forEach(id => assert.strictEqual(after[id], 0)); assert.ok(st.transfers.length <= n - 1);
        ids.forEach(id => { balanceSum[id] += bal[id]; });
      }
    }
    const cur = L.roundBalances(tt).net, all = L.calcBalances(tt).net;
    ids.forEach(id => assert.strictEqual(balanceSum[id] + cur[id], all[id], 'all rounds together equal the whole trip (seed ' + k + ')'));
    assert.strictEqual(sumNets(cur), 0);
  }
}
// sanitizeTrip keeps valid rounds (backup restore) and drops what refers to nothing
{
  const raw = { id: 'x1', name: '箱根', start: '2026-11-09', end: '2026-11-11', budget: 50000, members: [{ id: 'a', name: 'あ' }, { id: 'b', name: 'い' }],
    settlements: [{ id: 'r1', n: 1, at: '2026-11-10', total: 100, transfers: [{ from: 'a', to: 'b', amount: 50 }, { from: 'zz', to: 'b', amount: 5 }] }, { id: 'bad id', at: '2026-11-10' }],
    expenses: [{ id: 'e1', amount: 100, payer: 'a', cat: 'food', date: '2026-11-10', split: ['a', 'b'], settleId: 'r1' }, { id: 'e2', amount: 100, payer: 'a', cat: 'food', date: '2026-11-10', split: ['a'], settleId: 'nope' }],
    adjustments: [{ id: 'j1', settleId: 'r1', nets: { a: 5, b: -5 }, note: 'n', at: '2026-11-10' }, { id: 'j2', settleId: null, nets: { zz: 5 }, at: '2026-11-10' }, { id: 'j3', settleId: 'gone', nets: { a: 1, b: -1 }, at: '2026-11-10' }] };
  const t = L.sanitizeTrip(raw, 'new');
  assert.deepStrictEqual(t.settlements.map(x => [x.id, x.transfers.length]), [['r1', 1]], 'bad rounds and transfers of unknown members are dropped');
  assert.deepStrictEqual(t.expenses.map(e => e.settleId), ['r1', undefined], 'a settleId that points at nothing means "not settled"');
  assert.deepStrictEqual(t.adjustments.map(a => [a.id, a.settleId]), [['j1', 'r1'], ['j3', null]], 'adjustments of unknown members are dropped; a missing round means "open"');
}
console.log('settlement round tests passed');
{
  const f = L.payRequestText;
  assert.strictEqual(f('箱根 紅葉旅行', 2, 'けんた', 'あおい', 3200, 'https://x/#t=abc'),
    'けんたさんへ。「箱根 紅葉旅行」の精算（第2回）です。\nあおいさんに 3,200円 を送ってもらえますか。\n内訳はこちらで見られます → https://x/#t=abc');
  assert.strictEqual(f('箱根', 1, 'けんた', 'あおい', 300, ''), 'けんたさんへ。「箱根」の精算です。\nあおいさんに 300円 を送ってもらえますか。', 'round 1 has no 第N回; no link line when not shared');
  ['催促', '至急', '！', 'お願いします'].forEach(w => assert.ok(!f('旅', 3, 'a', 'b', 1, 'u').includes(w), w));
  console.log('pay request text tests passed');
}
