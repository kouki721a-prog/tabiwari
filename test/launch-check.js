/* Run before going public: fails while any 【要記入】 / 【要確認】 placeholder remains, or while config.js is unfinished.  node test/launch-check.js */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'); let bad = 0;
for (const f of ['terms.html', 'privacy.html', 'legal.html']) {
  const m = fs.readFileSync(path.join(root, f), 'utf8').match(/【要(記入|確認)[^】]*】/g) || [];
  if (m.length) { bad++; console.log(f + ': ' + m.length + ' placeholder(s) left, e.g. ' + m[0]); }
}
global.window = {}; eval(fs.readFileSync(path.join(root, 'config.js'), 'utf8'));
const c = window.TABIWARI;
for (const k of ['supabaseUrl', 'supabaseKey', 'vapidPublicKey', 'premiumPriceLabel']) if (!c[k]) { bad++; console.log('config.js: ' + k + ' is empty'); }
if (/service_role/.test(fs.readFileSync(path.join(root, 'config.js'), 'utf8'))) { bad++; console.log('config.js mentions service_role'); }
console.log(bad ? '\nNOT ready to launch (' + bad + ' issue(s))' : 'launch check passed'); process.exit(bad ? 1 : 0);
