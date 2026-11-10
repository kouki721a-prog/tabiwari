# たびわり

友人・カップルで行く国内旅行の、予算管理と割り勘アプリ（PWA）。仕様と方針は [HANDOFF.md](HANDOFF.md)。

## 現状（フェーズ1：PWA / フェーズ2：共有 / フェーズ3：通知・課金・公開準備）
- 素のHTML/CSS/JS（ビルド不要）。データは端末の `localStorage` のみ。
- `manifest.json` + `sw.js` でホーム画面に追加、オフライン動作。
- ホームに「ホーム画面に追加」の案内（Androidは `beforeinstallprompt`、iPhoneは手順表示）。
- 共有（任意）：Supabase でメールの6桁コードでログイン、旅行の共有、招待リンク、リアルタイム同期、端末データの移行。`config.js` が空なら端末内だけで動く。手順は [docs/SETUP.md](docs/SETUP.md)。

- 通知（Web Push）：旅行の前日、記録のし忘れ、精算。端末ごとに入り切り。
- 課金（Stripe）：無料は、自分でつくる旅行が3件まで。プレミアムは、旅行の数が無制限 + CSV書き出し。
- アカウントの削除、利用規約・プライバシーポリシー・特定商取引法の表記（ひな形。公開前に記入と専門家の確認が必要）。

公開手順：[docs/PUBLISH.md](docs/PUBLISH.md)（`npm run build` で `dist/` をつくる）。

- 共有（リンク方式）：アカウントなしで、リンクを知っている人どうしが同じ旅行を記録。Cloudflare Worker + D1。[docs/SHARING.md](docs/SHARING.md)。

## 開発
```
npm start      # http://localhost:8080 （Service Workerはhttp(s)でのみ動く）
npm test       # 計算ロジック・同期差分・リンク解析のテスト
npm run test:share   # 共有（ローカルWorker + D1 でAPIと複数人の通し）
node test/e2e.js   # ブラウザでの通し確認（偽のSupabase）
node test/launch-check.js   # 公開前の確認
node icons/make.js   # icons/icon.svg からPNGアイコンを再生成（playwright必要）
```
`index.html` / `cloud.js` / `manifest.json` / アイコンを変えたら、`sw.js` の `VERSION` を上げること。

## 次
公開前の準備は docs/SETUP.md の §4。
