# たびわり

友人・カップルで行く国内旅行の、予算管理と割り勘アプリ（PWA）。仕様と方針は [HANDOFF.md](HANDOFF.md)。

## 現状（フェーズ1：土台とPWA）
- 素のHTML/CSS/JS（ビルド不要）。データは端末の `localStorage` のみ。
- `manifest.json` + `sw.js` でホーム画面に追加、オフライン動作。
- ホームに「ホーム画面に追加」の案内（Androidは `beforeinstallprompt`、iPhoneは手順表示）。

## 開発
```
npm start      # http://localhost:8080 （Service Workerはhttp(s)でのみ動く）
npm test       # 計算ロジックのテスト（LOGIC_START〜LOGIC_ENDを抽出して検証）
node icons/make.js   # icons/icon.svg からPNGアイコンを再生成（playwright必要）
```
`index.html` / `manifest.json` / アイコンを変えたら、`sw.js` の `VERSION` を上げること。

## 次
フェーズ2（アカウントと共有）は、技術・ログイン方式の決定待ち。HANDOFF.md の §7, §9 を参照。
