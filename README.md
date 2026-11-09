# たびわり

友人・カップルで行く国内旅行の、予算管理と割り勘アプリ（PWA）。仕様と方針は [HANDOFF.md](HANDOFF.md)。

## 現状（フェーズ1：PWA / フェーズ2：共有）
- 素のHTML/CSS/JS（ビルド不要）。データは端末の `localStorage` のみ。
- `manifest.json` + `sw.js` でホーム画面に追加、オフライン動作。
- ホームに「ホーム画面に追加」の案内（Androidは `beforeinstallprompt`、iPhoneは手順表示）。
- 共有（任意）：Supabase でメールの6桁コードでログイン、旅行の共有、招待リンク、リアルタイム同期、端末データの移行。`config.js` が空なら端末内だけで動く。手順は [docs/SETUP.md](docs/SETUP.md)。

## 開発
```
npm start      # http://localhost:8080 （Service Workerはhttp(s)でのみ動く）
npm test       # 計算ロジックと同期差分のテスト
node test/e2e.js   # ブラウザでの通し確認（偽のSupabase）
node icons/make.js   # icons/icon.svg からPNGアイコンを再生成（playwright必要）
```
`index.html` / `cloud.js` / `manifest.json` / アイコンを変えたら、`sw.js` の `VERSION` を上げること。

## 次
フェーズ3（通知・課金）。公開前に、利用規約・プライバシーポリシー・アカウント削除の導線が必要。HANDOFF.md の §7 を参照。
