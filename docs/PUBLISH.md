# 公開手順（Cloudflare Pages・端末のみ版）

共有機能なし（`config.js` が空）のまま公開する手順です。無料で、HTTPSは自動です。

1. https://dash.cloudflare.com にログイン → **Workers & Pages → Create → Pages → Connect to Git**。
2. GitHub と連携し、`tabiwari` リポジトリを選ぶ。
3. 設定：
   - Production branch：公開したいブランチ（`main`、またはマージ前なら `claude/app-development-6oxs5w`）
   - Framework preset：`None`
   - Build command：`npm run build`
   - Build output directory：`dist`
4. **Save and Deploy**。数分で `https://<プロジェクト名>.pages.dev` で公開される。
5. iPhone の Safari で開き、共有 →「ホーム画面に追加」。Android は Chrome の案内から追加。

以降は、ブランチにpushするたびに自動で再公開される。ファイルを変えたら `sw.js` の `VERSION` を上げること（古いキャッシュが残らないように）。

## 独自ドメイン
Pages のプロジェクト → **Custom domains** で追加。ドメインをCloudflareで管理していれば、設定は自動。

## 共有機能を足すとき
`config.js` に Supabase の値を入れて push するだけ。そのとき `npm run build` が、利用規約などの法務ページも `dist/` に含める。先に `node test/launch-check.js` を通すこと。
