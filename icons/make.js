const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const b = await chromium.launch(); 
  for (const [n, s] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]) {
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent('<body style="margin:0">' + svg.replace('<svg ', '<svg width="'+s+'" height="'+s+'" ') + '</body>');
    await p.screenshot({ path: path.join(__dirname, n) }); await p.close();
  }
  await b.close();
})();
