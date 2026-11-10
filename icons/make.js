const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const b = await chromium.launch(); 
  for (const [n, s, f] of [['icon-192.png',192,'icon.svg'],['icon-512.png',512,'icon.svg'],['apple-touch-icon.png',180,'icon.svg'],['icon-maskable-512.png',512,'icon-maskable.svg']]) {
    const svg = read(f);
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent('<body style="margin:0">' + svg.replace('<svg ', '<svg width="'+s+'" height="'+s+'" ') + '</body>');
    await p.screenshot({ path: path.join(__dirname, n) }); await p.close();
  }
  await b.close();
})();
