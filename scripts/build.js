/* Copies only what the site needs into dist/. Run: npm run build */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'dist');
global.window = {}; eval(fs.readFileSync(path.join(root, 'config.js'), 'utf8'));

const files = ['index.html', 'manifest.json', 'sw.js', 'config.js', 'sync.js', 'share.js', 'line.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/line-login-icon.png', 'icons/og.png'];
['save', 'exp', 'settle'].forEach(n => files.push('icons/lp/' + n + '.png'));   // the screen pictures on the first page
fs.readdirSync(path.join(root, 'icons/splash')).filter(f => f.endsWith('.png')).forEach(f => files.push('icons/splash/' + f));   // iPhone start-up images
if (window.TABIWARI && window.TABIWARI.legalReady) files.push('terms.html', 'privacy.html', 'legal.css');

fs.rmSync(out, { recursive: true, force: true });
for (const f of files) { fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true }); fs.copyFileSync(path.join(root, f), path.join(out, f)); }
// Cloudflare header rules: a changed service worker or page must reach people quickly.
fs.writeFileSync(path.join(out, '_headers'), [
  '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin',
  '/sw.js', '  Cache-Control: no-cache', '/index.html', '  Cache-Control: no-cache', '/', '  Cache-Control: no-cache', ''].join('\n'));
console.log('built dist/ (' + files.length + ' files)');
