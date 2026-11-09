# 公開手順（Cloudflare Pages・端末のみ版）

共有機能なし（`config.js` が空）のまま公開する手順です。無料で、HTTPSは自動です。

1. https://dash.cloudflare.com にログイン → **Workers & Pages → Create → Connect to Git**（Pages の画面が出る場合もある。その場合は下の「Pages 方式」）。
2. GitHub と連携し、`tabiwari` リポジトリを選ぶ。
3. 設定（Workers 方式。リポジトリの `wrangler.jsonc` が公開フォルダ `dist` を指している）：
   - プロジェクト名：`tabiwari`（`wrangler.jsonc` の `name` と同じにする）
   - ビルドコマンド：`npm run build`
   - デプロイコマンド：`npx wrangler deploy`（初期値のまま）
   - プレビューコマンド：初期値のまま
4. **デプロイ**。数分で `https://tabiwari.<アカウント名>.workers.dev` で公開される。
5. iPhone の Safari で開き、共有 →「ホーム画面に追加」。Android は Chrome の案内から追加。

**Pages 方式**（古い画面）の場合：Framework preset は `None`、ビルドコマンド `npm run build`、出力ディレクトリ `dist`。

以降は、ブランチにpushするたびに自動で再公開される。ファイルを変えたら `sw.js` の `VERSION` を上げること（古いキャッシュが残らないように）。

## 独自ドメイン
Pages のプロジェクト → **Custom domains** で追加。ドメインをCloudflareで管理していれば、設定は自動。

## 共有機能を足すとき
`config.js` に Supabase の値を入れて push するだけ。そのとき `npm run build` が、利用規約などの法務ページも `dist/` に含める。先に `node test/launch-check.js` を通すこと。

## うまく更新されないとき
- 公開されている版は、`https://<URL>/sw.js` を開くと、`const VERSION = 'tabiwari-v〇'` で確認できる（リポジトリの `sw.js` と同じ数字なら、最新）。
- 古いままなら、Cloudflare の **設定 → ビルド** に「Git アカウントから切断されています」と出ていないか確認する。出ていたら、GitHub 側（https://github.com/settings/installations → Cloudflare Workers & Pages → Configure）で `tabiwari` へのアクセスが許可されているかを確かめたうえで、**接続を解除 → 同じリポジトリ・`main` で再接続**する。
- 再接続のとき、ビルドコマンド `npm run build`、デプロイコマンド `npx wrangler deploy` が残っているかも確認する。
- 「プレビュー ビルドを有効化」はオフにしておく（`main` 以外のブランチへの push で、不要なビルドが走るのを避ける）。
