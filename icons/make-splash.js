/* Makes the iPhone start-up images (icons/splash/*.png) and prints the <link> tags for index.html.   node icons/make-splash.js   (needs playwright)
   The picture is the app's own start-up screen without the text: the icon on the paper colour (light) or the dark colour (dark), placed where the app's
   splash puts it, so nothing jumps when the app takes over. iOS picks the image by the screen size, so there is one per size and per colour scheme. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const SIZES = [[440, 956, 3], [402, 874, 3], [420, 912, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3], [375, 812, 3], [414, 896, 3], [414, 896, 2], [414, 736, 3], [375, 667, 2]];   // logical width, height, pixel ratio
const MODES = [['light', '#eef2f7'], ['dark', '#0a1626']];
(async () => {
  const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'icon-512.png')).toString('base64'), dir = path.join(__dirname, 'splash'), tags = [];
  fs.mkdirSync(dir, { recursive: true });
  const b = await chromium.launch();
  for (const [w, h, r] of SIZES) for (const [mode, bg] of MODES) {
    const c = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: r }), p = await c.newPage(), name = w + 'x' + h + '-' + r + 'x-' + mode + '.png';
    await p.setContent('<body style="margin:0;background:' + bg + ';height:100vh;position:relative"><img src="' + icon + '" width="96" height="96" style="position:absolute;left:50%;top:50%;margin:-68px 0 0 -48px;border-radius:22px;box-shadow:0 6px 18px rgba(15,39,66,.18)"></body>');
    await p.screenshot({ path: path.join(dir, name) }); await c.close();
    tags.push('<link rel="apple-touch-startup-image" media="(device-width: ' + w + 'px) and (device-height: ' + h + 'px) and (-webkit-device-pixel-ratio: ' + r + ') and (orientation: portrait) and (prefers-color-scheme: ' + mode + ')" href="icons/splash/' + name + '">');
  }
  await b.close(); fs.writeFileSync(path.join(dir, 'tags.html'), tags.join('\n') + '\n'); console.log(tags.length + ' images');
})();
