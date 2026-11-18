/* The server's copy of the split logic (worker/split.js) must give exactly the same shares as the app (index.html, LOGIC block). */
import fs from 'fs'; import assert from 'assert'; import { fileURLToPath } from 'url'; import path from 'path';
import { splitShares as server } from '../worker/split.js';
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const m = html.match(/LOGIC_START[^\n]*\n([\s\S]*?)\/\* ===== LOGIC_END/);
const app = new Function(m[1] + '; return splitShares;')();
let n = 0;
for (let k = 0; k < 4000; k++) {
  const size = 1 + (k % 5), ids = ['a', 'b', 'c', 'd', 'e'].slice(0, size), amount = (k * 37) % 20000, seed = 'exp' + k;
  const parts = k % 3 === 0 ? Object.fromEntries(ids.map((id, i) => [id, 1 + ((k + i) % 6)])) : null;
  const fixed = k % 4 === 0 ? { [ids[0]]: Math.floor(amount / 3) } : null;
  assert.deepStrictEqual(server(amount, ids, seed, parts, fixed), app(amount, ids, seed, parts, fixed), 'case ' + k); n++;
}
console.log('split copy tests passed (' + n + ' cases)');
