/* Makes the picture shown when the link is shared on social media (icons/og.png, 1200x630).   node icons/make-og.js   (needs playwright) */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'icon-512.png')).toString('base64');
  const step = (a, b) => '<div class="s"><small>' + a + '</small><b>' + b + '</b></div>';
  const html = '<style>body{margin:0;width:1200px;height:630px;background:#0f2742;color:#fff;font-family:system-ui,"Hiragino Sans","Noto Sans CJK JP","Noto Sans JP",sans-serif;position:relative}' +
    '.t{position:absolute;left:84px;top:88px;display:flex;align-items:center;gap:28px}.t img{width:120px;height:120px;border-radius:28px}.t span{font-size:84px;font-weight:600;letter-spacing:2px}' +
    'h1{position:absolute;left:84px;top:260px;margin:0;font-size:60px;font-weight:600;line-height:1.35}h1 em{font-style:normal;color:#ffc83d}' +
    '.r{position:absolute;left:84px;right:84px;top:440px;display:flex;gap:20px;align-items:center}.s{flex:1;background:rgba(255,255,255,.08);border-radius:20px;padding:22px 26px}.s small{display:block;font-size:24px;opacity:.7}.s b{font-size:36px;font-weight:600}' +
    '.a{font-size:36px;color:#ffc83d}</style><body><div class="t"><img src="' + icon + '"><span>たびわり</span></div>' +
    '<h1>旅行のお金の不安を、<em>なくす</em></h1><div class="r">' + step('出発前', '積立') + '<div class="a">›</div>' + step('旅行中', '1日の目安') + '<div class="a">›</div>' + step('旅行後', '通知つきの精算') + '</div></body>';
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(html); await p.screenshot({ path: path.join(__dirname, 'og.png') }); await b.close();
})();
