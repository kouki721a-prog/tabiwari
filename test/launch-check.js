/* Run before going public: fails while any 【要記入】 / 【要確認】 placeholder remains, or while config.js is unfinished.  node test/launch-check.js */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'); let bad = 0;
for (const f of ['terms.html', 'privacy.html']) {
  const m = fs.readFileSync(path.join(root, f), 'utf8').match(/【要(記入|確認)[^】]*】/g) || [];
  if (m.length) { bad++; console.log(f + ': ' + m.length + ' placeholder(s) left, e.g. ' + m[0]); }
}
global.window = {}; eval(fs.readFileSync(path.join(root, 'config.js'), 'utf8'));
const c = window.TABIWARI;
if (!c.legalReady) { bad++; console.log('config.js: legalReady is false (set it to true once the legal pages are filled in)'); }
console.log(bad ? '\nNOT ready to launch (' + bad + ' issue(s))' : 'launch check passed'); process.exit(bad ? 1 : 0);
