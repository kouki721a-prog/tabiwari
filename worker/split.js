/* A copy of the app's split logic (index.html, LOGIC block: hashStr, splitShares, cleanFixed), so the server computes the same share for a person. test/split.test.mjs keeps the two identical. */
export function hashStr(str){   // FNV-1a: the same text gives the same number on every device
  var h = 2166136261; str = String(str || '');
  for (var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/* amount split by weights. `parts` (optional) gives each person a weight in units of half: 2 = 1x (the default), 1 = 0.5x, 3 = 1.5x ... 6 = 3x.
   Everybody gets floor(amount x weight / total weight); the leftover yen go one each to the people with the biggest fractional remainder, ties broken by rotating
   from a start point that depends on `seed` (the expense id), so the same person is not always the one who pays the extra yen and every device computes the same result.
   With equal weights this is exactly "amount / people, leftover yen rotating" as before. */
export function splitShares(amount, ids, seed, parts, fixed){
  var fx = cleanFixed(fixed, ids, amount);   // 金額の指定: these people pay exactly that; the rest is split among the others as usual
  if (fx){
    var rest = ids.filter(function(id){ return fx[id] === undefined; }), F = 0, rs = {};
    ids.forEach(function(id){ if (fx[id] !== undefined) F += fx[id]; });
    if (rest.length) splitShares(amount - F, rest, seed, parts).forEach(function(x){ rs[x[0]] = x[1]; });
    return ids.map(function(id){ return [id, fx[id] !== undefined ? fx[id] : rs[id]]; });
  }
  var n = ids.length, w = ids.map(function(id){ var v = parts && parts[id]; return (typeof v === 'number' && v >= 1 && v <= 6 && v === Math.floor(v)) ? v : 2; });
  var W = w.reduce(function(a, b){ return a + b; }, 0), base = [], fr = [], used = 0;
  ids.forEach(function(id, i){ var t = amount * w[i]; base[i] = Math.floor(t / W); fr[i] = t - base[i] * W; used += base[i]; });
  var rem = amount - used, order = ids.slice().sort(), start = hashStr(seed) % n;
  var rank = ids.map(function(id, i){ return { i: i, f: fr[i], r: (order.indexOf(id) - start + n) % n }; });
  rank.sort(function(x, y){ return y.f - x.f || x.r - y.r; });
  var extra = {}; for (var k = 0; k < rem; k++) extra[rank[k].i] = 1;
  return ids.map(function(id, i){ return [id, base[i] + (extra[i] ? 1 : 0)]; });
}
/* the fixed amounts worth keeping for an expense: whole yen (0 or more) for people who share it; null when none, when they add up to more than the amount,
   or when everybody is fixed but the total is not the amount (nobody would pay the rest) */
export function cleanFixed(fixed, split, amount){
  if (!fixed || typeof fixed !== 'object' || !(amount >= 0)) return null;
  var out = {}, n = 0, sum = 0;
  split.forEach(function(id){ var v = fixed[id]; if (typeof v === 'number' && v >= 0 && v <= 1e9 && v === Math.floor(v)){ out[id] = v; n++; sum += v; } });
  if (!n || sum > amount || (n === split.length && sum !== amount)) return null;
  return out;
}
