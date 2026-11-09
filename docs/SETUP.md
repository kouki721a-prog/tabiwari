# 共有機能のセットアップ（Supabase）

`config.js` が空のままなら、アプリは今までどおり端末内だけで動きます。共有を有効にする手順です。

## 1. Supabase プロジェクトをつくる
1. https://supabase.com でプロジェクトを作成（リージョンは東京 `ap-northeast-1` がおすすめ）。
2. SQL Editor で `supabase/migrations/0001_init.sql` の中身を実行。
3. **Authentication → Email Templates → Magic Link** の本文を、リンクではなく6桁コードにする：
   ```
   <h2>たびわりの確認コード</h2>
   <p>アプリに、次のコードを入力してください。</p>
   <p style="font-size:28px;letter-spacing:4px"><b>{{ .Token }}</b></p>
   ```
   （PWAでは、メールのリンクを開くとSafariに飛んでアプリに戻れないため、コード入力方式にしています。）
4. **Authentication → URL Configuration** の Site URL に、公開するURLを設定。
5. 本番では **Authentication → SMTP Settings** に独自SMTP（Resend、SendGrid など）を設定。標準のメール送信は、1時間あたりの送信数がごく少なく、本番には使えません。
6. **Project Settings → API** の `Project URL` と `anon public` キーを、`config.js` に貼る。anonキーは公開してよいものです（守っているのは行レベルのアクセス制御）。`service_role` キーは絶対に貼らないこと。

## 2. 公開する
静的ファイルだけなので、Cloudflare Pages / Netlify / Vercel のどれでも、リポジトリのルートをそのまま公開できます（ビルドコマンドなし、出力ディレクトリ `/`）。HTTPS必須。

## 3. 動作確認
- 2つのブラウザ（または端末）で別のメールアドレスでログイン。
- 片方で旅行をつくり、設定 → 友だちを招待 →「招待リンク」を、もう片方で開く。
- 片方で支出を記録すると、もう片方に反映される。

## テスト
```
npm test           # 計算ロジック + 同期の差分計算
node test/e2e.js   # ブラウザ（偽のSupabase）でログイン・同期・移行・招待を確認 ※playwright が必要
PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh   # Postgresで、アクセス制御と招待を確認
```

## 仕組み（メモ）
- 端末の状態（`state.trips`）と、最後にサーバーへ送れた状態（snapshot）の差分だけを送る（`cloud.js` の `diff`）。送信に失敗しても snapshot は進まないので、つながったら自動で再送される。
- 書き込みが衝突したときは、行ごとの「あとから保存した方が勝ち」。
- メンバーの本人確認は `trip_members.user_id`。招待リンクは `invites`（1回限り、7日で期限切れ）。
- 各ユーザーのキャッシュは `tabiwari.cloud.<user_id>`、端末のみのデータは `tabiwari.v1`。ログイン後に「移す」を押すと、前者へアップロードされる。
