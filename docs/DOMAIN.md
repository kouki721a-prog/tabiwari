# 独自ドメインにする手順（買ったあとに行う）

> **実施済み（2026-11-20）**: ドメイン **`tabiflow.app`** を Cloudflare Registrar で購入（初年度 $8.20、2年目から 年$14.20 で自動更新。登録者情報は、Cloudflare の WHOIS 保護）。Workers（`tabiwari`）の「ドメインとルート」に、カスタムドメインとして追加。**古い `tabiwari.tabiwari-app.workers.dev` も、オンのまま**（配った共有リンクが開ける）。コード側は、共有カード（`og:url`・`og:image`・`twitter:image`）とまとめ画像の `RECAP_SITE` を、`tabiflow.app` に。LINE Developers の登録（下の3か所）は、ユーザーが行う（コールバックURLが、先に必要）。

いまの公開URLは `https://tabiwari.tabiwari-app.workers.dev`。独自ドメインにしても、**アプリとサーバーのコードは、ほぼ変わりません**（ログインの戻り先・共有リンク・Origin の確認は、開いているアドレスから、自動で決まります）。作業の中心は、下の設定です。**利用者が増える前に、行うのが、いちばん安全です。**

## 1. ドメインを買う（お金がかかる。年1,500円前後から）
- Cloudflare → **ドメイン登録**（Domain Registration）→ 名前を検索（例：`tabiwari`）→ 空きと値段を見て、購入。原価に近い値段。`.com` `.app` `.net` など。`.jp` は、Cloudflare では売っていない。
- 他社で買った場合は、Cloudflare に、ドメインを追加して、**ネームサーバーを、Cloudflare のものに変える**。

## 2. Workers に接続する
Cloudflare → Workers & Pages → `tabiwari` → 設定 → **ドメインとルート** → ［追加］→ **カスタムドメイン** → 買ったドメイン（例：`tabiwari.app`）を入れる。証明書（https）は、自動。数分で有効になる。
- 古い `workers.dev` のアドレスは、**そのまま使える**（消さない）。すでに配った共有リンクも、開ける。

## 3. LINE Developers に、新しいアドレスを登録する（3か所）
`https://<新しいドメイン>` を、次に入れる（古いURLの**追加**でよい。消さない）。
1. **LINEログイン**のチャネル → LINEログイン設定 → **コールバックURL**：`https://<新しいドメイン>/api/auth/line/callback`
2. 同じチャネルの、**プライバシーポリシーURL・利用規約URL**：`https://<新しいドメイン>/privacy`、`/terms`
3. **Messaging API**のチャネル → **Webhook URL**：`https://<新しいドメイン>/api/line/webhook` →［検証］で成功を確認。

## 4. 確かめる
- 新しいアドレスで、アプリが開く／LINEでログインできる／共有リンクをつくると、新しいアドレスのリンクになる。
- 公式アカウントを友だち追加・ブロックして、友だちの状態が変わる（Webhook）。

## 5. 引っ越しで起きること（利用者への案内に使う）
- 端末の旅行データは、**アドレスごとに別**。新しいアドレスで開くと、空。**LINEのバックアップ、共有リンク、CSV**で戻す。
- ホーム画面のアプリは、**追加し直し**。
- ログインは、**新しいアドレスで、やり直し**。
- 古いアドレスで、開いた人に、新しいアドレスを案内するカード（`config.js` に、新しいアドレスを書くと出す、という案）は、**まだ作っていない**。必要になったら、案を見せてから作る。

## 6. 買ったあとの、コード・文書の更新
- `HANDOFF.md`：公開URL、LINEのコールバックURL、Webhook URL
- `docs/LINE.md`、`docs/PUBLISH.md`：URL
- `privacy.html`／`terms.html`：URLが書いてあれば。運営者の連絡先は、そのまま。
