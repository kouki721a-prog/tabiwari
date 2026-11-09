# セットアップ（共有・課金・通知）

`config.js` が空のままなら、アプリは今までどおり端末内だけで動きます。共有を有効にする手順です。

## 1. Supabase プロジェクトをつくる
1. https://supabase.com でプロジェクトを作成（リージョンは東京 `ap-northeast-1` がおすすめ）。
2. SQL Editor で `supabase/migrations/` の `0001_init.sql`、`0002_billing_push_delete.sql` を、この順に実行。
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

## 2. 課金（Stripe）
1. Stripe で商品「たびわり プレミアム」をつくり、**月額・円・定期**の価格を設定（金額は決定事項。仮は400円）。その `price_...` のIDを控える。
2. **Settings → Billing → カスタマーポータル**を有効にし、「サブスクリプションのキャンセル」を許可する。
3. Supabase の Edge Functions をデプロイ（[Supabase CLI](https://supabase.com/docs/guides/cli) が必要）：
   ```
   supabase functions deploy create-checkout billing-portal
   supabase functions deploy stripe-webhook send-reminders --no-verify-jwt
   supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_PRICE_ID=price_... SITE_URL=https://（公開URL。末尾スラッシュなし）
   ```
4. Stripe の **Developers → Webhooks** に、`https://<project-ref>.supabase.co/functions/v1/stripe-webhook` を追加。イベントは `checkout.session.completed`、`customer.subscription.created`、`customer.subscription.updated`、`customer.subscription.deleted`。表示された署名シークレットを登録：
   ```
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```
5. `config.js` の `premiumPriceLabel` を、Stripe の価格と同じ表示にする。
6. 先に Stripe の**テストモード**（テストキー、カード `4242 4242 4242 4242`）で、購入 → プレミアム表示 → 解約 まで通す。

無料の線引きを変えるときは、`index.html` の `FREE_TRIP_LIMIT` と、SQL の `enforce_trip_limit()` の `3` を、両方変える（新しいマイグレーションで関数を差し替える）。

## 3. 通知（Web Push）
1. 鍵をつくる：`npx web-push generate-vapid-keys`。公開鍵を `config.js` の `vapidPublicKey` に、両方を Supabase の secrets に：
   ```
   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:（連絡先） CRON_SECRET=（長いランダムな文字列）
   ```
2. 毎時に `send-reminders` を呼ぶ。SQL Editor で（Database → Extensions で `pg_cron` と `pg_net` を有効にしてから）：
   ```sql
   select cron.schedule('tabiwari-reminders', '0 * * * *', $$
     select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/send-reminders',
                          headers := jsonb_build_object('Authorization', 'Bearer （CRON_SECRETと同じ値）')) $$);
   ```
   送る内容と時刻（日本時間）は、`claim_notifications()` で決まる：旅行の前日18時以降／旅行中の20時以降に、その日の支出がまだないとき／旅行の翌日10時以降（精算）。同じ人・旅行・種類・日に、2回は送らない。
3. iPhone では、ホーム画面に追加したアプリ（iOS 16.4 以降）でだけ通知が使える。アプリの「アカウント → この端末への通知」で、端末ごとに入り切りする。

## 4. 公開前の最終確認
- `terms.html` `privacy.html` `legal.html` の `【要記入】`（運営者名、所在地、連絡先、価格など）を埋め、**専門家（弁護士など）に確認してもらう**。ひな形であり、法的な助言ではない。
- `node test/launch-check.js` が通ること（記入漏れと、`config.js` の未設定を検出する）。
- Supabase の Authentication で、独自SMTPとSite URLを設定済みであること（§1）。

## 5. 公開する
静的ファイルだけなので、Cloudflare Pages / Netlify / Vercel のどれでも、リポジトリのルートをそのまま公開できます（ビルドコマンドなし、出力ディレクトリ `/`）。HTTPS必須。

## 6. 動作確認
- 2つのブラウザ（または端末）で別のメールアドレスでログイン。
- 片方で旅行をつくり、設定 → 友だちを招待 →「招待リンク」を、もう片方で開く。
- 片方で支出を記録すると、もう片方に反映される。

## テスト
```
npm test           # 計算ロジック + 同期の差分計算
node test/e2e.js   # ブラウザ（偽のSupabase）でログイン・同期・移行・招待・上限・CSV・退会を確認 ※playwright が必要
node test/launch-check.js   # 公開前の確認（未記入の法務ページ・未設定のconfig.jsを検出）
PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh   # Postgresで、アクセス制御と招待を確認
```

## 仕組み（メモ）
- 端末の状態（`state.trips`）と、最後にサーバーへ送れた状態（snapshot）の差分だけを送る（`cloud.js` の `diff`）。送信に失敗しても snapshot は進まないので、つながったら自動で再送される。
- 書き込みが衝突したときは、行ごとの「あとから保存した方が勝ち」。
- メンバーの本人確認は `trip_members.user_id`。招待リンクは `invites`（1回限り、7日で期限切れ）。
- 課金の状態は `subscriptions` テーブル（Stripe の Webhook だけが書き込む。サーバー側で再取得して反映するので、イベントの順序が前後しても崩れない）。無料プランの上限は、DBのトリガーで強制する。
- 各ユーザーのキャッシュは `tabiwari.cloud.<user_id>`、端末のみのデータは `tabiwari.v1`。ログイン後に「移す」を押すと、前者へアップロードされる。
