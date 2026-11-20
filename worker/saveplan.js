/* The server's copy of the savings plan (index.html, LOGIC block: savePlanOf). The app shows "毎週◯曜日に、約◯円"; the reminder goes out on those same days,
   so both must work out the same dates and amounts (test/saveplan.test.mjs compares them over many inputs). Keep the two in step. */
export function dayDiff(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
export function savePlanOf(target, have, today, start) {
  const miss = target - have, d = dayDiff(today, start);
  if (!(miss > 0) || !(d > 0)) return null;
  const weeks = Math.floor(d / 7), p = start.split('-').map(Number), fmt = (y, m, dd) => y + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
  const round = n => Math.min(miss, Math.ceil(miss / n / 100) * 100);
  if (weeks < 1) return { kind: 'once', miss, days: d };
  if (weeks <= 12) {
    const nx = new Date(p[0], p[1] - 1, p[2] - 7 * weeks);
    return { kind: 'weekly', miss, n: weeks, per: round(weeks), wd: new Date(p[0], p[1] - 1, p[2]).getDay(), next: fmt(nx.getFullYear(), nx.getMonth() + 1, nx.getDate()) };
  }
  const dates = [];
  for (let k = 1; k < 120; k++) {
    const first = new Date(p[0], p[1] - 1 - k, 1), last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), day = Math.min(p[2], last), ds = fmt(first.getFullYear(), first.getMonth() + 1, day);
    if (dayDiff(today, ds) < 0) break; dates.push(ds);
  }
  return { kind: 'monthly', miss, n: dates.length, per: round(dates.length), dom: p[2], next: dates[dates.length - 1] };
}
