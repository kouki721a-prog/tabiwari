# たびわり

友人・カップルで行く国内旅行の、予算管理と割り勘アプリ（PWA）。仕様と方針は [HANDOFF.md](HANDOFF.md)。

## できること
- 素のHTML/CSS/JS（フレームワークなし）。データは、端末の `localStorage`。ログインなしで、旅行・支出・精算・積立・CSV書き出しが使える。
- `manifest.json` + `sw.js` で、ホーム画面に追加、オフライン動作。
- 共有（リンク方式）：アカウントなしで、リンクを知っている人どうしが、同じ旅行を記録。Cloudflare Worker + D1。[docs/SHARING.md](docs/SHARING.md)
- LINEログインとバックアップ：旅行を暗号化してサーバーに控え、別の端末で戻す。[docs/LINE.md](docs/LINE.md)
- 通知（LINEログイン + 端末ごとにオン）：旅行の前日の夜、旅行中の記録のし忘れ、旅行の翌朝の精算。[docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- 利用規約・プライバシーポリシー（ひな形。不特定多数への公開や有料化の前に、専門家の確認が必要）。

公開手順：[docs/PUBLISH.md](docs/PUBLISH.md)（`main` にマージすると、Cloudflare が自動でビルドして公開する）。

## 開発
```
npm start            # http://localhost:8080 （Service Workerはhttp(s)でのみ動く）
npm test             # 計算ロジック・同期差分・リンク解析・通知の暗号化
npm run test:share   # 共有（ローカルWorker + D1 でAPIと複数人の通し）
npm run test:account # LINEログインとバックアップ（疑似LINE + ローカルWorker + D1）
npm run test:notify  # 通知（暗号化・購読・毎時の判定・配信を、疑似の配信サービスで通し）
node test/launch-check.js   # 公開前の確認
node icons/make.js   # icons/icon.svg からPNGアイコンを再生成（playwright必要）
```
`index.html` / `sync.js` / `share.js` / `line.js` / `manifest.json` / アイコンを変えたら、`sw.js` の `VERSION` を上げること。
