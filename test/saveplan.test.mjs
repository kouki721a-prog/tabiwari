/* The server's copy of the savings plan (worker/saveplan.js) must give exactly what the app shows (index.html, LOGIC block: savePlanOf). */
import fs from 'fs'; import assert from 'assert'; import { fileURLToPath } from 'url'; import path from 'path';
import { savePlanOf as server } from '../worker/saveplan.js';
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const m = html.match(/LOGIC_START[^\n]*\n([\s\S]*?)\/\* ===== LOGIC_END/);
const app = new Function(m[1] + '; return savePlanOf;')();
const add = (s, n) => { const p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return d.toISOString().slice(0, 10); };
let n = 0;
for (let k = 0; k < 6000; k++) {
  const today = add('2026-01-01', (k * 7) % 700), start = add(today, ((k * 13) % 260) - 3), target = [1000, 25000, 33334, 50000, 100000, 300000][k % 6], have = ((k * 977) % (target + 5000)) - (k % 7 === 0 ? 0 : 0);
  assert.deepStrictEqual(server(target, have, today, start), app(target, have, today, start), 'case ' + k + ': ' + [target, have, today, start].join(' ')); n++;
}
// month ends: the 29th to the 31st of departure in short months
for (const start of ['2027-03-31', '2027-03-30', '2027-03-29', '2028-03-31', '2027-05-31', '2027-12-31', '2027-01-31']) for (let d = 1; d < 30; d++) {
  const today = add(start, -(90 + d)); assert.deepStrictEqual(server(60000, 0, today, start), app(60000, 0, today, start), start + ' ' + today); n++; }
console.log('save plan copy tests passed (' + n + ' cases)');
