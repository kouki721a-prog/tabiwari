const fs = require('fs'), assert = require('assert'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/LOGIC_START[^\n]*\n([\s\S]*?)\/\* ===== LOGIC_END/);
const L = new Function(m[1] + '; return {noteUrl, splitShares, matchExpense, parseCsv, importCsv, calcBalances, roundBalances, confirmRound, expenseAdjustment, openItems, isSettled, roundNo, settle, dayDiff, parseYen, tripCsv, csvCell, isUntouchedSample, sanitizeTrip, recapData, parseQuick, needsTabimaru, cleanParts, cleanFixed};')();

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
assert.strictEqual(r.id, 'new-id'); assert.deepStrictEqual(Object.keys(r).sort(), ['adjustments', 'budget', 'end', 'expenses', 'id', 'members', 'name', 'paid', 'received', 'savings', 'settlements', 'start']);
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
  const t = { name: '箱根', start: '2026-11-10', end: '2026-11-11', budget: 80000, members: [{ id: 'a', name: 'あおい' }, { id: 'b', name: 'けんた' }, { id: 'c', name: 'みく' }], expenses: [
    { id: '1', title: '新幹線', amount: 9600, payer: 'a', cat: 'transport', date: '2026-11-10', split: ['a', 'b', 'c'] }, { id: '2', title: '旅館', amount: 30000, payer: 'b', cat: 'stay', date: '2026-11-10', split: ['a', 'b', 'c'] },
    { id: '3', title: '夕食', amount: 8700, payer: 'c', cat: 'food', date: '2026-11-11', split: ['a', 'b', 'c'] }, { id: '4', title: '朝食', amount: 4300, payer: 'c', cat: 'food', date: '2026-11-11', split: ['a', 'b'] }] };
  const r = L.recapData(t);
  assert.strictEqual(L.recapData({ ...t, expenses: [] }), null, 'nothing recorded: no recap');
  assert.deepStrictEqual([r.total, r.per, r.count, r.days, r.diff], [52600, 17533, 4, 2, 27400]);
  assert.deepStrictEqual(r.cats.map(c => [c.id, c.amount, c.pct]), [['stay', 30000, 57], ['food', 13000, 25], ['transport', 9600, 18]], 'largest first, percentages of the total');
  assert.deepStrictEqual([r.top.title, r.top.amount, r.topDay.date, r.topDay.amount], ['旅館', 30000, '2026-11-10', 39600]);
  assert.deepStrictEqual(r.members, ['あおい', 'けんた', 'みく']);
  assert.strictEqual(L.recapData({ ...t, budget: 50000 }).diff, -2600, 'over budget is a negative difference');
  console.log('recap data tests passed');
}
{
  const q = L.parseQuick, pick = s => { const r = q(s); return r && [r.title, r.amount, r.cat, r.offset]; };
  assert.deepStrictEqual(pick('夕食 2000円'), ['夕食', 2000, 'food', 0]);
  assert.deepStrictEqual(pick('夕食2000'), ['夕食', 2000, 'food', 0]);
  assert.deepStrictEqual(pick('2000 夕食'), ['夕食', 2000, 'food', 0]);
  assert.deepStrictEqual(pick('夕食を2,000円'), ['夕食', 2000, 'food', 0], 'particles next to the amount are dropped');
  assert.deepStrictEqual(pick('ランチ 1,500円だった'), ['ランチ', 1500, 'food', 0]);
  assert.deepStrictEqual(pick('タクシー ¥1,200'), ['タクシー', 1200, 'transport', 0]);
  assert.deepStrictEqual(pick('昨日 お土産 3千円'), ['お土産', 3000, 'gift', -1]);
  assert.deepStrictEqual(pick('一昨日 ホテル 1.5万円'), ['ホテル', 15000, 'stay', -2]);
  assert.deepStrictEqual(pick('ロープウェイ 2400円'), ['ロープウェイ', 2400, 'sight', 0]);
  assert.deepStrictEqual(pick('夕食 ２０００円'), ['夕食', 2000, 'food', 0], 'full-width digits');
  assert.deepStrictEqual(pick('夕食 3人で6000円'), ['夕食 3人', 6000, 'food', 0], 'the number with 円 wins');
  assert.deepStrictEqual(pick('2/3 ガソリン 5000'), ['2/3 ガソリン', 5000, 'transport', 0], 'without 円 the biggest number wins');
  assert.deepStrictEqual(pick('なんだっけ 800円'), ['なんだっけ', 800, 'other', 0]);
  assert.deepStrictEqual(pick('1000円'), ['', 1000, 'other', 0], 'no title is fine');
  assert.strictEqual(q('夕食'), null, 'no amount');
  assert.strictEqual(q(''), null); assert.strictEqual(q('0円'), null, 'zero is not an amount'); assert.strictEqual(q('夕食 1.5円'), null, 'fractions of a yen are not');
  assert.strictEqual(q('夕食 99999999999円'), null, 'too big');
  console.log('quick input tests passed');
}
{
  // weights: 2 = 1x, 1 = 0.5x ... 6 = 3x. Equal weights give exactly the old result; weighted shares always add up to the amount.
  const old = (amount, ids, seed) => { const n = ids.length, base = Math.floor(amount / n), rem = amount - base * n, order = ids.slice().sort(); let h = 2166136261; String(seed || '').split('').forEach(c => { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; });
    const start = (h >>> 0) % n, extra = {}; for (let k = 0; k < rem; k++) extra[order[(start + k) % n]] = 1; return ids.map(id => [id, base + (extra[id] ? 1 : 0)]); };
  for (let k = 0; k < 3000; k++){ const n = 1 + (k % 7), ids = Array.from({ length: n }, (_, i) => 'm' + i), amt = 1 + Math.floor(Math.random() * 100000);
    assert.deepStrictEqual(L.splitShares(amt, ids, 'e' + k), old(amt, ids, 'e' + k), 'no weights: the same as before');
    const same = {}; ids.forEach(id => { same[id] = 4; }); assert.deepStrictEqual(L.splitShares(amt, ids, 'e' + k, same), old(amt, ids, 'e' + k), 'equal weights of any size: the same as before');
    const parts = {}; ids.forEach(id => { parts[id] = 1 + Math.floor(Math.random() * 6); }); const r = L.splitShares(amt, ids, 'e' + k, parts), tot = r.reduce((s, x) => s + x[1], 0), W = ids.reduce((s, id) => s + parts[id], 0);
    assert.strictEqual(tot, amt, 'weighted shares add up'); r.forEach(x => { const exact = amt * parts[x[0]] / W; assert.ok(Math.abs(x[1] - exact) < 1, 'within 1 yen of the exact share: ' + x + ' ' + exact); });
    assert.deepStrictEqual(L.splitShares(amt, ids.slice().reverse(), 'e' + k, parts).sort(), r.slice().sort(), 'the order of selection does not matter'); }
  assert.deepStrictEqual(L.splitShares(3000, ['a', 'b'], 'x', { a: 2, b: 1 }), [['a', 2000], ['b', 1000]], 'a child pays half');
  assert.deepStrictEqual(L.splitShares(1000, ['a', 'b', 'c'], 'x', { a: 2, b: 2, c: 1 }).map(x => x[1]), [400, 400, 200]);
  assert.deepStrictEqual(L.cleanParts({ a: 2, b: 2 }, ['a', 'b']), null, 'all equal: nothing to keep'); assert.deepStrictEqual(L.cleanParts({ a: 3, b: 3 }, ['a', 'b']), null);
  assert.deepStrictEqual(L.cleanParts({ a: 2, b: 1, z: 6 }, ['a', 'b']), { a: 2, b: 1 }, 'only the people who share it'); assert.deepStrictEqual(L.cleanParts({ a: 2, b: 9 }, ['a', 'b']), null, 'out of range = 1x, so equal');
  assert.deepStrictEqual(L.cleanParts({ a: 3 }, ['a', 'b']), { a: 3, b: 2 }, 'missing = 1x'); assert.strictEqual(L.cleanParts(null, ['a']), null);
  // balances, settlement and adjustments use the weights
  const t = { members: [{ id: 'a', name: 'あおい' }, { id: 'b', name: 'こども' }], budget: 1, expenses: [{ id: 'e1', title: '夕食', amount: 3000, payer: 'a', cat: 'food', date: '2026-11-10', split: ['a', 'b'], parts: { a: 2, b: 1 } }], settlements: [], adjustments: [], paid: {}, savings: {} };
  assert.deepStrictEqual(L.calcBalances(t).owed, { a: 2000, b: 1000 }); assert.deepStrictEqual(L.roundBalances(t).net, { a: 1000, b: -1000 });
  assert.deepStrictEqual(L.settle(L.roundBalances(t).net), [{ from: 'b', to: 'a', amount: 1000 }]);
  const edited = { ...t.expenses[0], parts: { a: 2, b: 2 } }; delete edited.parts; const adj = L.expenseAdjustment({ ...t, settlements: [{ id: 's', n: 1, at: '2026-11-11', total: 3000, transfers: [] }] }, { ...t.expenses[0], settleId: 's' }, { ...edited, settleId: 's' }, 'adj1', 'メモ', '2026-11-12');
  assert.deepStrictEqual(adj && adj.nets, { a: 500, b: -500 }, 'taking the weights away: a paid 3000 and owed 2000 (net +1000), now owes 1500 (net +1500): a is owed 500 more, b owes 500 more');
  // sanitize keeps valid weights only
  const raw = { id: 'x', name: 't', start: '2026-11-10', end: '2026-11-11', budget: 1000, members: [{ id: 'a', name: 'あ' }, { id: 'b', name: 'い' }], expenses: [
    { id: 'e1', title: '', amount: 300, payer: 'a', cat: 'food', date: '2026-11-10', split: ['a', 'b'], parts: { a: 2, b: 1, z: 5 } }, { id: 'e2', title: '', amount: 300, payer: 'a', cat: 'food', date: '2026-11-10', split: ['a', 'b'], parts: { a: 4, b: 4 } }] };
  const sn = L.sanitizeTrip(raw, 'n'); assert.deepStrictEqual(sn.expenses[0].parts, { a: 2, b: 1 }); assert.strictEqual(sn.expenses[1].parts, undefined, 'equal weights are dropped');
  // CSV: the weights are written as あおい(1.5) and read back; a bad weight skips the line
  const ct = { ...t, expenses: [{ id: 'e1', title: '夕食', amount: 3000, payer: 'a', cat: 'food', date: '2026-11-10', split: ['a', 'b'], parts: { a: 3, b: 1 } }] };
  const csv = L.tripCsv(ct, c => ({ food: '食事' })[c]); assert.ok(csv.includes('あおい(1.5)・こども(0.5)'), csv);
  let nn = 0; const back = L.importCsv({ members: t.members, expenses: [] }, csv, () => 'n' + (++nn), { 食事: 'food' }); assert.deepStrictEqual(back.add.map(e => e.parts), [{ a: 3, b: 1 }]);
  const bad = L.importCsv({ members: t.members, expenses: [] }, '日付,内容,カテゴリ,金額,払った人,割り勘の対象\r\n2026-11-10,x,食事,300,あおい,あおい(5)・こども', () => 'm', { 食事: 'food' }); assert.ok(bad.skipped.length === 1 && /割合/.test(bad.skipped[0].why), JSON.stringify(bad));
  console.log('weighted split tests passed');
}
{
  // weights written after a name in the one-line input
  const q = L.parseQuick, names = ['あおい', 'けんた', 'こども', 'こう', 'こうき'], w = s => { const r = q(s, names); return r && [r.title, r.amount, r.weights, r.weightError]; };
  assert.deepStrictEqual(w('夕食 3000円 こどもは半分'), ['夕食', 3000, { こども: 1 }, false]);
  assert.deepStrictEqual(w('ランチ 1500 あおい1.5倍 けんた0.5倍'), ['ランチ', 1500, { あおい: 3, けんた: 1 }, false], 'two people, and the amount is still found');
  assert.deepStrictEqual(w('夕食 4000円 けんた×2'), ['夕食', 4000, { けんた: 4 }, false]); assert.deepStrictEqual(w('夕食 4000円 けんたx2'), ['夕食', 4000, { けんた: 4 }, false]);
  assert.deepStrictEqual(w('夕食 4000円 みくけんた(0.5)'), ['夕食 みく', 4000, { けんた: 1 }, false], 'brackets');
  assert.deepStrictEqual(w('こどもは半額 夕食 3000円'), ['夕食', 3000, { こども: 1 }, false], 'the name can come first');
  assert.deepStrictEqual(w('夕食 3000円 けんたは多め'), ['夕食', 3000, { けんた: 3 }, false]); assert.deepStrictEqual(w('夕食 3000円 けんたは少なめ'), ['夕食', 3000, { けんた: 1 }, false]);
  assert.deepStrictEqual(w('夕食 3000円 こうき半分'), ['夕食', 3000, { こうき: 1 }, false], 'the longest name wins (こう / こうき)');
  assert.deepStrictEqual(w('夕食 3000円 こどもは4倍'), ['夕食', 3000, {}, true], 'out of range: an error'); assert.strictEqual(w('夕食 3000円 けんた0.3倍')[3], true); assert.strictEqual(w('夕食 3000円 けんた1.7倍')[3], true);
  assert.deepStrictEqual(w('夕食 3000円'), ['夕食', 3000, {}, false], 'no weights'); assert.deepStrictEqual(w('あおいと夕食 3000円'), ['あおいと夕食', 3000, {}, false], 'a name alone is just text');
  assert.deepStrictEqual(q('夕食 3000円 こどもは半分'), { title: '夕食 こどもは半分', amount: 3000, cat: 'food', offset: 0, weights: {}, weightError: false, excluded: [], fixed: {}, multi: false }, 'without names it is the same as before');
  // leaving a person out: けんたなし / 抜き / 無し / ぬき
  const ex = s => { const r = q(s, names); return r && [r.title, r.amount, r.excluded, r.weights]; };
  assert.deepStrictEqual(ex('夕食 3000円 けんたなし'), ['夕食', 3000, ['けんた'], {}]); assert.deepStrictEqual(ex('夕食 3000円 けんた抜き'), ['夕食', 3000, ['けんた'], {}]);
  assert.deepStrictEqual(ex('夕食 3000円 けんたは無し'), ['夕食', 3000, ['けんた'], {}], 'with は'); assert.deepStrictEqual(ex('けんたぬきで 夕食 3000円'), ['夕食', 3000, ['けんた'], {}], 'the name can come first, and a で after it goes too');
  assert.deepStrictEqual(ex('夕食 3000円 けんたなし こどもは半分'), ['夕食', 3000, ['けんた'], { こども: 1 }], 'leaving out and a weight together');
  assert.deepStrictEqual(ex('夕食 3000円 あおいなし けんた抜き').slice(0, 2).concat([ex('夕食 3000円 あおいなし けんた抜き')[2].slice().sort()]), ['夕食', 3000, ['あおい', 'けんた']], 'two people');
  assert.deepStrictEqual(ex('夕食 3000円')[2], [], 'nobody left out by default'); assert.deepStrictEqual(ex('なしの夕食 3000円')[2], [], 'なし without a name is just text');
  console.log('quick input weights tests passed');
}

// 金額の指定 (fixed amounts): a person pays exactly that, the rest goes to the others by the usual rule (equal, or weighted)
{ const ids = ['a', 'b', 'c'];
  assert.deepStrictEqual(L.splitShares(5000, ids, 'x', null, { c: 1000 }), [['a', 2000], ['b', 2000], ['c', 1000]], 'けんたは1,000円だけ');
  assert.deepStrictEqual(L.splitShares(5000, ids, 'x', { a: 4, b: 2 }, { c: 1000 }), [['a', 2667], ['b', 1333], ['c', 1000]], 'weights still apply to the others (4:2 of 4,000)');
  assert.deepStrictEqual(L.splitShares(5000, ids, 'x', null, { a: 1000, b: 1000, c: 3000 }), [['a', 1000], ['b', 1000], ['c', 3000]], 'everybody fixed, adding up to the amount');
  assert.deepStrictEqual(L.splitShares(5000, ids, 'x', null, { a: 0 }), [['a', 0], ['b', 2500], ['c', 2500]], '0 yen is allowed');
  assert.deepStrictEqual(L.splitShares(5000, ids, 'x', null, { a: 6000 }), L.splitShares(5000, ids, 'x'), 'more than the amount: ignored');
  assert.deepStrictEqual(L.splitShares(5000, ids, 'x', null, { a: 1000, b: 1000, c: 1000 }), L.splitShares(5000, ids, 'x'), 'everybody fixed but not adding up: ignored');
  assert.deepStrictEqual(L.splitShares(5000, ids, 'x', null, { z: 100 }), L.splitShares(5000, ids, 'x'), 'a stranger is ignored');
  assert.strictEqual(L.cleanFixed({ a: 1.5 }, ids, 5000), null); assert.strictEqual(L.cleanFixed({ a: -1 }, ids, 5000), null); assert.strictEqual(L.cleanFixed({ a: '1000' }, ids, 5000), null); assert.strictEqual(L.cleanFixed(null, ids, 5000), null);
  assert.deepStrictEqual(L.cleanFixed({ a: 1000, z: 5 }, ids, 5000), { a: 1000 }, 'only the people who share it');
  for (let k = 0; k < 2000; k++){ const n = 2 + Math.floor(Math.random() * 5), ids2 = Array.from({ length: n }, (_, i) => 'm' + i), amt = 1 + Math.floor(Math.random() * 100000), fx = {}, w = {};
    ids2.forEach(id => { w[id] = 1 + Math.floor(Math.random() * 6); }); const nf = Math.floor(Math.random() * n); let left = amt; ids2.slice(0, nf).forEach(id => { const v = Math.floor(Math.random() * (left + 1) / 2); fx[id] = v; left -= v; });
    const r = L.splitShares(amt, ids2, 'e' + k, w, nf ? fx : null); assert.strictEqual(r.reduce((a, x) => a + x[1], 0), amt, 'always adds up to the amount'); r.forEach(x => { assert.ok(Number.isInteger(x[1]) && x[1] >= 0); if (fx[x[0]] !== undefined) assert.strictEqual(x[1], fx[x[0]]); });
    assert.deepStrictEqual(L.splitShares(amt, ids2, 'e' + k, w, undefined), L.splitShares(amt, ids2, 'e' + k, w), 'no fixed amounts: the same as before'); }
  // balances, settlement and adjustments use them
  const t = { members: [{ id: 'a', name: 'あおい' }, { id: 'b', name: 'けんた' }], budget: 1, expenses: [{ id: 'e1', title: '夕食', amount: 3000, payer: 'a', cat: 'food', date: '2026-11-09', split: ['a', 'b'], fixed: { b: 500 } }], paid: {}, savings: {}, settlements: [], adjustments: [] };
  assert.deepStrictEqual(L.calcBalances(t).owed, { a: 2500, b: 500 }); assert.deepStrictEqual(L.roundBalances(t).net, { a: 500, b: -500 });
  const t2 = JSON.parse(JSON.stringify(t)); t2.expenses[0].settleId = 's1'; t2.settlements = [{ id: 's1', n: 1, at: '2026-11-10', total: 3000, transfers: [{ from: 'b', to: 'a', amount: 500 }] }];
  const ed = JSON.parse(JSON.stringify(t2.expenses[0])); ed.fixed = { b: 1000 }; const adj = L.expenseAdjustment(t2, t2.expenses[0], ed, 'adj1', 'x', '2026-11-11'); assert.deepStrictEqual(adj.nets, { a: 500, b: -500 }, 'changing a fixed amount of a closed round makes an adjustment');
  assert.strictEqual(L.expenseAdjustment(t2, t2.expenses[0], Object.assign({}, ed, { fixed: { b: 500 } }), 'adj2', 'x', '2026-11-11'), null);
  // CSV: written as あおい(1000円), read back; a bad one is skipped; sanitizeTrip keeps valid ones only
  const csvT = { name: 'x', start: '2026-11-09', end: '2026-11-10', budget: 1, members: [{ id: 'a', name: 'あおい' }, { id: 'b', name: 'けんた' }, { id: 'c', name: 'みく' }], paid: {}, savings: {}, settlements: [], adjustments: [],
    expenses: [{ id: 'e1', title: '夕食', amount: 5000, payer: 'a', cat: 'food', date: '2026-11-09', split: ['a', 'b', 'c'], fixed: { c: 1000 } }] };
  const out = L.tripCsv(csvT, () => '食事'); assert.ok(out.includes('みく(1000円)'), out);
  let nn = 0; const idf = () => 'n' + (++nn), emptyT = Object.assign({}, csvT, { expenses: [] }), cb = { 食事: 'food' }, back = L.importCsv(emptyT, out, idf, cb); assert.strictEqual(back.add.length, 1, JSON.stringify(back.skipped)); assert.deepStrictEqual(back.add[0].fixed, { c: 1000 }); assert.deepStrictEqual(back.add[0].split.length, 3);
  const bad = L.importCsv(emptyT, out.replace('みく(1000円)', 'みく(9000円)'), idf, cb); assert.strictEqual(bad.add.length, 0); assert.ok(bad.skipped[0].why.includes('金額の指定'));
  const raw = JSON.parse(JSON.stringify(csvT)); raw.expenses.push({ id: 'e2', title: 'x', amount: 100, payer: 'a', cat: 'food', date: '2026-11-09', split: ['a', 'b'], fixed: { a: 500 } });
  const sn = L.sanitizeTrip(raw, 'n'); assert.deepStrictEqual(sn.expenses[0].fixed, { c: 1000 }); assert.strictEqual(sn.expenses[1].fixed, undefined, 'an impossible one is dropped');
  console.log('fixed amount tests passed'); }

// ひとことで記録: 金額の指定 (「けんたは1,000円だけ」)
{ const q = L.parseQuick, names = ['あおい', 'けんた', 'こども', 'こう', 'こうき'], f = s => { const r = q(s, names); return r && [r.title, r.amount, r.fixed, r.weights, r.excluded]; };
  assert.deepStrictEqual(f('夕食 5000円 けんたは1000円だけ'), ['夕食', 5000, { けんた: 1000 }, {}, []]);
  assert.deepStrictEqual(f('夕食 5,000円 けんた1,000円だけ'), ['夕食', 5000, { けんた: 1000 }, {}, []], 'commas, no は');
  assert.deepStrictEqual(f('けんたは1000円だけ 夕食 5000円'), ['夕食', 5000, { けんた: 1000 }, {}, []], 'the order does not matter');
  assert.deepStrictEqual(f('夕食 5000円 けんたが¥1000だけ'), ['夕食', 5000, { けんた: 1000 }, {}, []], '¥ form');
  assert.deepStrictEqual(f('夕食 1万円 けんたは3千円のみ'), ['夕食', 10000, { けんた: 3000 }, {}, []], '千 and のみ');
  assert.deepStrictEqual(f('夕食 ５０００円 けんたは１０００円だけ'), ['夕食', 5000, { けんた: 1000 }, {}, []], 'full-width digits');
  assert.deepStrictEqual(f('夕食 5000円 けんたは1000円だけ こどもは半分'), ['夕食', 5000, { けんた: 1000 }, { こども: 1 }, []], 'with a weight for someone else');
  assert.deepStrictEqual(f('夕食 5000円 けんたは1000円だけ あおいなし'), ['夕食', 5000, { けんた: 1000 }, {}, ['あおい']], 'with a person left out');
  assert.deepStrictEqual(f('夕食 6000円 あおいは1000円だけ けんたは2000円だけ'), ['夕食', 6000, { あおい: 1000, けんた: 2000 }, {}, []], 'two people');
  assert.deepStrictEqual(f('夕食 5000円 こうきは1000円だけ'), ['夕食', 5000, { こうき: 1000 }, {}, []], 'the longer name wins (こうき, not こう)');
  assert.deepStrictEqual(f('夕食 5000円 けんた 1000円').slice(1), [5000, {}, {}, []], 'without だけ it is not a fixed amount: the biggest yen is the total');
  assert.strictEqual(f('けんたは1000円だけ'), null, 'only a fixed amount, no total: nothing to record');
  assert.deepStrictEqual(f('夕食 5000円')[2], {}, 'nothing fixed by default');
  assert.deepStrictEqual(f('夕食 3000円 けんた×2')[3], { けんた: 4 }, 'weights are as before');
}

// 記録の入力欄: which sentences the quick record cannot read right (たびまる reads them)
{ const names = ['こうき', 'あおい', 'けんた', 'みく'], n = t => L.needsTabimaru(t, names);
  for (const t of ['夕食 2000円', '夕食 3,000円 全員で割り勘', 'タクシー 1,200円 けんたなし', '夕食 5000円 けんたは1000円だけ', '夕食 3000円 こどもは半分', '夕食 2000 3人', 'ランチ 1500円 昨日', '3000', 'ガム 80円'])
    assert.strictEqual(n(t), '', 'the quick record takes it: ' + t);
  for (const t of ['昨日の夕食、けんたが立て替えて3人で割った 6000円', '夕食 6000円 あおいが払った', '夕食 6000円 みくがおごり', '夕食 6000円 けんたが出してくれた', '夕食 6000円 たてかえ中 立替'])
    assert.strictEqual(n(t), 'payer', t);
  for (const t of ['タクシー 1,200円 あおいとみくの分', 'お菓子 600円 けんた以外', '夕食 6000円 あおいとけんたで割った']) assert.strictEqual(n(t), 'select', t);
  for (const t of ['昼 1200、夜 3000', '昼 1200円 夜 3000円 タクシー 1500円', 'ガム 80円 お茶 150円', '昼1200 夜3000']) assert.strictEqual(n(t), 'multi', t);
  assert.strictEqual(n('夕食 5000円 けんたは1000円だけ 昼 3000円'), 'multi', 'a fixed amount is not an extra expense, a second one is');
  assert.strictEqual(n('夕食 5000円 けんたは1000円だけ'), '', 'a fixed amount alone is one expense'); assert.strictEqual(n('こんにちは'), '', 'no amount: nothing to read');
  console.log('needsTabimaru tests passed'); }

// 受け取り方メモの https リンク: https だけがリンクになる。ほかは、リンクにしない
assert.strictEqual(L.noteUrl('PayPay：https://pay.paypay.ne.jp/AbCd123xyz'), 'https://pay.paypay.ne.jp/AbCd123xyz');
assert.strictEqual(L.noteUrl('https://pay.paypay.ne.jp/AbCd。よろしく'), 'https://pay.paypay.ne.jp/AbCd', 'stops at a Japanese full stop');
assert.strictEqual(L.noteUrl('（https://example.com/x）'), 'https://example.com/x', 'and at a closing bracket');
for (const bad of ['現金でOK', 'PayPay：kouki-0101', 'http://example.com/x', 'javascript:alert(1)', 'HTTP://example.com', 'ftp://example.com', 'https://', 'https://user:pw@example.com/x', 'https://evil@example.com', 'https://localhost/x', '//example.com/x', 'data:text/html,https', '', null, undefined])
  assert.strictEqual(L.noteUrl(bad), '', 'no link for: ' + bad);
assert.strictEqual(L.noteUrl('x'.repeat(10) + 'https://a.example/' + 'y'.repeat(300)), '', 'a very long one is not linked');
