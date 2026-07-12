# Keiro（ケイロ）

広告クリックから **LINE公式アカウントの友だち追加** までを、**LINEログイン（認証画面）を出さずに** 紐づけて計測し、広告プラットフォーム（Meta / TikTok ほか）へコンバージョン（CV）をポストバックする計測ツールです。

> 本ツールは独立した実装であり、特定の商用製品とは無関係です。

整体院・整骨院向けの **マルチテナントSaaS** として動作します（院ごとにデータ・LINE連携・課金を分離）。

---

## SaaS 構成（マルチテナント）

- **テナント（院）**：各院が自分のアカウントでログインし、自院のLINE公式・ピクセル・計測リンク・統計を管理。データは `tenant_id` で完全分離。
- **運営（operator）**：`OPERATOR_EMAIL/PASSWORD` で作られる管理者。`/operator` で全院の状況・課金状態を確認、停止/再開が可能。
- **院ごとのLINE連携**：Webhookは院ごとの専用URL `/(webhook)/<webhook_token>`。各院のChannel Secretで署名検証。トークン類は **AES-256-GCMで暗号化保存**（画面に再表示しない）。
- **課金**：UnivaPayの定期課金。新規登録から **14日間トライアル**、以降はサブスク契約が必要（未契約/失効で計測を停止）。プランごとに固定の決済リンクへ誘導し、UnivaPay Webhook `/(webhook)/univapay` でメールアドレス・金額を照合して状態同期（`/api/billing/*`）。

### 主な画面 / 認証
| パス | 説明 | 認証 |
|---|---|---|
| `/` | ランディング | 公開 |
| `/signup`, `/login` | 院の登録・ログイン | 公開 |
| `/app` | 院ダッシュボード（KPI・連携設定・計測リンク・課金） | テナント(JWT) |
| `/operator` | 運営管理（院一覧・課金状態・停止/再開） | operator(JWT) |

認証はJWT（httpOnly Cookie）。パスワードは scrypt。いずれも Node 標準 `crypto` で実装（依存追加なし）。

### 必須の環境変数（本番）
`SECRET`（長いランダム値）, `OPERATOR_EMAIL`, `OPERATOR_PASSWORD`, `BASE_URL`(https)。
課金を有効化するには `UNIVAPAY_ENABLED=true` と `UNIVAPAY_JWT_TOKEN` / `UNIVAPAY_STORE_ID` / `UNIVAPAY_WEBHOOK_SECRET`。
LINE / Meta / TikTok の各認証情報は **院ごとにダッシュボードで設定**します（envでのグローバル設定は不要）。

---

## 計測の流れ

```
広告クリック                友だち追加              claimタップ              CV送信
 GET /c/:linkId  ──302──▶  LINE友だち追加  ──webhook──▶  GET /claim  ──▶  Meta/TikTok CAPI
   ・click保存                ・follow(pending)保存       ・トークン検証
   ・Cookie(keiro_cid)        ・claimリンク入り挨拶を返信   ・click↔follow紐づけ
   ・LINE OA URLへ転送                                    ・postback記録
```

1. **GET /c/:linkId** — 広告クリックが着弾。クエリ（`fbclid`/`gclid`/`ttclid`/`utm_*`）と IP・UA を保存してクリックIDを発行し、Cookie `keiro_cid` に保存。**認証画面を挟まず** 302 で LINE 友だち追加 URL（`links.oa_add_url`）へリダイレクト。
2. **POST /webhook** — 友だち追加で `follow` イベントが `X-Line-Signature` 付きで届く（**署名検証必須**）。`status=pending` で保存し、`replyToken` で挨拶＋**claimリンク（署名付きトークン入り）** を返信。
3. **GET /claim?t=…** — ユーザーが claim リンクをタップ。トークンを検証し、follow ↔ click を紐づけ。
4. 紐づいたら広告プラットフォームへ **ポストバック** を送信し、`postbacks` に成否を記録。

---

## 紐づけロジック（最重要）

スマホでは「広告クリック時のブラウザ」と「友だち追加後に claim を開く LINE アプリ内ブラウザ」が別物で、**Cookie も UserAgent も引き継がれません**。概ね一致するのは **IP アドレス** です。そこで次の優先順位で **1件のクリック** を選びます（[`src/match.js`](src/match.js)）。

| 優先 | method | 条件 | 主な経路 |
|---|---|---|---|
| 1 | `claim` | claim の Cookie にクリックIDがあり、そのクリックが未紐づけ | 同一ブラウザ（主に **PC**） |
| 2 | `ip` | 同一IP かつ 未紐づけ かつ 直近 `MATCH_WINDOW_SEC` 秒以内の最新クリック | **スマホの主力経路** |
| 最終 | `time` | **IPが取れない場合のみ** 時間窓だけで最新クリック | フォールバック |

設計方針：

- **follow イベント時点では推定紐づけしない**（誤紐づけ防止）。claim が来るまで `pending`、来なければ未紐づけのまま放置。
- **再現率より精度を優先**。候補が無ければ紐づけない。
- **UserAgent を含むデバイス指紋でフォールバックしない**（UAが変わって破綻するため）。
- 紐づけたクリックは `matched=1` にして **二重紐づけを防止**。

---

## セットアップ

必要環境: **Node.js 20+**

```bash
npm install
cp .env.example .env       # 各値を設定（特に SECRET, ADMIN_PASS）
# SECRET の生成例:
#   openssl rand -hex 32
npm start                  # 起動。ログに BASE_URL と /admin の URL を表示
```

- デモデータ投入: `npm run seed`
- 紐づけロジックの自己検証（実機不要・成功で `PASS`）: `npm run selftest`
- 管理画面: `<BASE_URL>/admin`（Basic認証）

---

## LINE 設定

LINE Developers / LINE Official Account Manager で以下を設定します。

- **Messaging API チャネル** を作成し、`LINE_CHANNEL_ACCESS_TOKEN` と `LINE_CHANNEL_SECRET` を `.env` へ。
- **応答モード: Bot**
- **あいさつメッセージ: OFF** — 本ツールが claim リンク入りの挨拶を送るため、LINE 公式のあいさつ自動メッセージは必ず OFF にします。
- **Webhook: ON**、Webhook URL に `<BASE_URL>/webhook` を設定（**HTTPS 必須**）。
- 「自動応答メッセージ」は OFF 推奨。

友だち追加 URL（`https://lin.ee/xxxx` など）を、管理画面のリンク作成フォームの **友だち追加URL** に入れます。

---

## Meta / TikTok / Google 設定

### Meta Conversions API
- `META_PIXEL_ID`、`META_CAPI_TOKEN` を設定。テスト中は `META_TEST_EVENT_CODE` も設定（Events Manager のテストイベント）。
- 送信内容: `event_name=Lead`、`fbc = "fb.1.<クリック時刻ms>.<fbclid>"`、`external_id = sha256(line_user_id)`、`client_ip_address` / `client_user_agent` を付与。
- エンドポイント: `graph.facebook.com/v20.0/<pixel>/events`。

### TikTok Events API
- `TIKTOK_PIXEL_ID`、`TIKTOK_ACCESS_TOKEN` を設定。
- 送信内容: `event=CompleteRegistration`、`Access-Token` ヘッダ、`external_id=sha256(line_user_id)`、`ip`/`user_agent`/`ttclid` を付与。

### Google
- サーバ→サーバ送信に OAuth が必要なため、現状は **gclid の記録のみのスタブ**（`GOOGLE_ENABLED` と [`src/postback.js`](src/postback.js) の `sendGoogle` に差し込み口あり）。

### 送信先の振り分け
- link の **media** 設定（例: `meta,tiktok`）で送信先を限定。**未指定なら有効な全媒体**へ送信。
- 成功・失敗・スキップともに `postbacks` テーブルへ記録します。

---

## ngrok でのテスト手順

LINE Webhook は HTTPS が必須なので、ローカル開発では ngrok 等で公開します。

```bash
npm start                          # 例: PORT=3000
ngrok http 3000                    # https://xxxx.ngrok-free.app を取得
```

1. `.env` の `BASE_URL` を ngrok の HTTPS URL に設定し、再起動。
2. LINE の Webhook URL を `<BASE_URL>/webhook` に設定して「検証」。
3. 管理画面で計測リンクを作成 → 表示された `…/c/<linkId>` を **スマホ** で開く。
4. LINE 友だち追加 → 届いた挨拶の claim リンクをタップ。
5. 管理画面「直近の友だち追加」で `紐づけ済`（method=ip など）になることを確認。

---

## 紐づけ精度の注意点

- **PC からの友だち追加** は Cookie が効くため `claim` で確実に紐づきます。
- **スマホ** は `ip` 経路が主力。モバイル回線の CGNAT やテザリングで複数ユーザーが同一 IP になる、Wi-Fi↔モバイルの切替で IP が変わる、といった場合は紐づけ精度が落ちます。
- `MATCH_WINDOW_SEC`（初期 1800 秒）は **広すぎると誤紐づけ・狭すぎると取りこぼし**。運用実態に合わせて調整してください。
- 取りこぼしても **誤った CV を送らないこと** を優先する設計です。

---

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/c/:linkId` | クリック計測 + 302 リダイレクト |
| POST | `/webhook` | LINE Webhook（raw body で署名検証） |
| GET | `/claim?t=…` | 紐づけ + 完了画面 |
| GET | `/healthz` | ヘルスチェック |
| GET/POST/DELETE | `/api/links` | 計測リンク管理（Basic認証） |
| GET | `/api/stats` | KPI（Basic認証） |
| GET | `/api/follows` | 直近の友だち追加（Basic認証） |
| GET | `/admin`, `/admin/` | 管理画面（Basic認証, 静的配信） |

---

## セキュリティ / プライバシー

- **LINE 署名検証**（HMAC-SHA256 を base64 し `X-Line-Signature` と一致確認）必須。
- **claim トークン**は HMAC 署名付きで改ざん不可（[`src/sign.js`](src/sign.js)）。失効（既定7日）あり。
- 管理画面・API は **Basic 認証** で保護。`/api` と `/admin` の realm を同一にして、ブラウザが資格情報を再利用できるようにしています。
- **個人情報の保存について**: 本ツールは計測のため **IP アドレス・UserAgent・LINE ユーザーID** を保存します。`line_user_id` はポストバック時に SHA-256 ハッシュ化して送信し、API 応答では先頭数文字のみ返します。プライバシーポリシーへの明記・保存期間の管理を行ってください。

---

## ディレクトリ構成

```
keiro/
├── package.json
├── .env.example
├── README.md
├── DEPLOY.md          # Coolify / ConoHa VPS デプロイ手順
├── Dockerfile         # 本番イメージ（better-sqlite3 ビルド対応・非root・healthcheck）
├── docker-compose.yml # /app/data 永続ボリューム付き
├── .dockerignore
├── .github/workflows/ci.yml   # selftest + docker build を回すCI
├── src/
│   ├── config.js      # 環境変数の読み込み
│   ├── db.js          # SQLite（WAL）スキーマ・接続・マイグレーション
│   ├── sign.js        # HMAC署名（claimトークン / LINE署名）, sha256, ID生成
│   ├── util.js        # getIp / escapeHtml
│   ├── logger.js      # JSON構造化ログ
│   ├── ratelimit.js   # 軽量レートリミッタ（IP単位・依存なし）
│   ├── match.js       # 紐づけロジック（最重要）
│   ├── line.js        # LINE 返信（claimリンク入り挨拶）
│   ├── postback.js    # Meta / TikTok / Google ポストバック・振り分け・リトライ
│   ├── retention.js   # データ保持（個人情報の自動削除）
│   ├── app.js         # Express アプリ（全エンドポイント）
│   └── server.js      # 起動エントリ（env検証・スケジューラ）
├── public/admin/      # 管理画面（素のHTML/CSS/JS, ビルド不要）
│   ├── index.html
│   ├── styles.css
│   └── dashboard.js   # /admin と /admin/ のパスずれ回避のため絶対パスで読み込み
├── scripts/
│   ├── seed.js        # デモデータ投入
│   ├── selftest.js    # 実機なしの検証（マッチング/保持/署名 → PASS出力）
│   └── backup.js      # SQLite オンラインバックアップ（世代管理）
└── data/              # SQLite ファイル・バックアップ（gitignore）
```

---

## 本番運用

`NODE_ENV=production` で起動すると、運用向けの挙動が有効になります。

- **env検証**: `SECRET`/`ADMIN_PASS` が初期値、`BASE_URL` が非httpsだと **起動を中止**。
- **Webhook即200**: LINE には即 200 を返し、follow記録は同期・挨拶返信は非同期で処理（replyToken失効を避けつつタイムアウトを防ぐ）。
- **ポストバック リトライ**: 送信失敗（ネットワーク/HTTPエラー）は指数バックオフで `POSTBACK_MAX_ATTEMPTS` まで自動再送（`postbacks.done/next_retry_at`）。設定不足によるスキップは再送しない。
- **データ保持 / PII自動削除**: `RETENTION_DAYS`（既定90日）より古い `clicks/follows/postbacks` を定期削除。現存followが参照する古いclickはFK整合のため保持。
- **レート制限**: 公開エンドポイント（`/c` `/webhook` `/claim`）にIP単位の固定ウィンドウ制限。
- **構造化ログ**: stdout/stderr に1行JSON。`docker logs` やログ基盤に流しやすい。
- **バックアップ**: `npm run backup` で `BACKUP_DIR` に世代バックアップ（`BACKUP_KEEP` 世代保持）。cron推奨。

### Docker

```bash
docker build -t keiro .
docker run -d --name keiro -p 3000:3000 \
  -v keiro-data:/app/data --env-file .env keiro
```

### Coolify / ConoHa VPS

既存Coolifyへの相乗りデプロイ手順は **[DEPLOY.md](DEPLOY.md)** を参照（永続ストレージ `/app/data` の登録が必須）。

---

## データモデル（SQLite）

- `links(id, name, oa_add_url, media, campaign, creative, created_at)`
- `clicks(id, link_id, fp, ip, ua, fbclid, gclid, ttclid, utm_source, utm_medium, utm_campaign, utm_content, params_json, matched, created_at)`
- `follows(id, line_user_id, fp, click_id, match_method, status, created_at, matched_at)` — `status`: `pending` / `matched` / `unmatched`
- `postbacks(id, follow_id, platform, ok, http_status, response, created_at)`
