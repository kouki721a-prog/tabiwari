/* The iPhone start-up images: every <link rel="apple-touch-startup-image"> points at a real PNG of exactly (width x ratio) x (height x ratio) pixels, in both colour schemes. */
const assert = require('assert'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tags = html.match(/<link rel="apple-touch-startup-image"[^>]*>/g) || [];
assert.ok(tags.length >= 20, 'start-up images are declared (' + tags.length + ')');
const seen = {}; let light = 0, dark = 0;
tags.forEach(t => {
  const m = /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: portrait\) and \(prefers-color-scheme: (light|dark)\)" href="([^"]+)"/.exec(t);
  assert.ok(m, 'well-formed: ' + t); const [, w, h, r, mode, href] = m; assert.ok(!seen[href], 'listed once: ' + href); seen[href] = 1; if (mode === 'light') light++; else dark++;
  const f = path.join(root, href), buf = fs.readFileSync(f); assert.strictEqual(buf.toString('latin1', 1, 4), 'PNG', href + ' is a PNG');
  assert.deepStrictEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [w * r, h * r], href + ' has the size of the screen');
});
assert.strictEqual(light, dark, 'one image per colour scheme');
const onDisk = fs.readdirSync(path.join(root, 'icons/splash')).filter(f => f.endsWith('.png')); assert.strictEqual(onDisk.length, tags.length, 'no image on disk that is not declared');
assert.ok(/icons\/splash/.test(fs.readFileSync(path.join(root, 'scripts/build.js'), 'utf8')), 'the build copies them');
console.log('splash tests passed');
