# Keiro デプロイ手順（Coolify / ConoHa VPS）

既存の Coolify（ConoHa VPS, Traefik プロキシ）に同居させる前提の手順です。
他アプリと同じく **1台のVPSにDockerコンテナとして相乗り** します。

---

## 1. 事前準備

- GitHub にこのリポジトリを push（例: `shittoruad-gif/keiro`）。
- LINE / Meta / TikTok の各値を手元に用意（[README](README.md) 参照）。
- `SECRET` を生成: `openssl rand -hex 32`

## 2. Coolify でアプリ作成

1. Coolify ダッシュボード → **New Resource** → **Public/Private Repository**。
2. ビルドパックは **Dockerfile**（本リポジトリの `Dockerfile`）を選択。
   - もしくは **Docker Compose**（`docker-compose.yml`）でも可。
3. **Ports Exposes**: `3000`。
4. **Domains**: `https://<uuid>.163.44.103.9.sslip.io`（既存アプリと同形式）。独自ドメインでも可。HTTPSはCoolify/Traefikが終端。

## 3. 永続ストレージ（SQLite）

SQLite ファイルを残すため **Persistent Storage** を登録します（reservation-app と同様の構成）。

- Coolify → アプリ → **Storages** → Add：
  - Source（コンテナ内パス）: `/app/data`
  - Name: `keiro-data`

> これを忘れると再デプロイのたびに計測データが消えます。必須。

## 4. 環境変数

Coolify → アプリ → **Environment Variables** に設定（`.env.example` 参照）。最低限：

| 変数 | 値 |
|---|---|
| `NODE_ENV` | `production` |
| `BASE_URL` | 公開URL（httpsで末尾スラッシュなし） |
| `ADMIN_USER` / `ADMIN_PASS` | 管理画面のBasic認証 |
| `SECRET` | `openssl rand -hex 32` の値 |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` | LINE Messaging API |
| `META_PIXEL_ID` / `META_CAPI_TOKEN` | Meta CAPI（任意） |
| `TIKTOK_PIXEL_ID` / `TIKTOK_ACCESS_TOKEN` | TikTok（任意） |
| `RETENTION_DAYS` | 個人情報の保持日数（既定90） |
| `DB_PATH` | `/app/data/keiro.db` |
| `BACKUP_DIR` | `/app/data/backups` |

> `NODE_ENV=production` のとき、`SECRET`/`ADMIN_PASS` が初期値だと **起動を中止** します（env検証）。

## 5. デプロイ

1. Coolify の **Deploy** ボタン、または API で起動：
   ```bash
   curl -s -H "Authorization: Bearer <COOLIFY_API_TOKEN>" \
     "http://localhost:8000/api/v1/deploy?uuid=<UUID>&force=true"
   ```
   > 注: VPSの5分polling cronは threads-studio のみ監視。**本アプリはpushだけでは反映されず、上記の手動デプロイAPIが必要**。
2. 反映確認（status APIは当てにならないので直接確認）：
   ```bash
   CID=$(docker ps --format '{{.Names}}' | grep <UUID>)
   docker inspect -f '{{.Created}} {{.State.Status}}' "$CID"
   docker exec "$CID" wget -qO- http://127.0.0.1:3000/healthz
   ```

## 6. LINE Webhook 設定

- Webhook URL: `https://<BASE_URL>/webhook`
- 「検証」ボタンで 200 が返ること（署名が一致するため `LINE_CHANNEL_SECRET` が正しい必要あり）。
- 応答モード=Bot / あいさつメッセージ=OFF / Webhook=ON（[README](README.md) 参照）。

## 7. バックアップ（任意・推奨）

VPS の既存 cron（毎日3:00にDBバックアップ）に倣い、コンテナ内バックアップを cron 追加：

```bash
# ホスト側 crontab 例（毎日 3:15）
15 3 * * * docker exec <CID> node scripts/backup.js >> /var/log/keiro-backup.log 2>&1
```

`scripts/backup.js` は `/app/data/backups` に世代バックアップ（既定14世代保持）を作ります。
永続ストレージ配下なのでホストの `/opt/backups` 連携や rsync も容易です。

## 8. ロールバック / ログ

- ログは JSON 構造化（stdout/stderr）。`docker logs <CID>` で確認。
- ロールバックは Coolify のデプロイ履歴から前リビジョンを再デプロイ。
- データは永続ボリュームに残るためコンテナ作り直しでも消えません。

---

---

## 販売開始前チェックリスト（保留事項の手順）

自社利用・無料トライアル提供は現状のまま可能。**有料サブスク販売を始める前**に以下を実施する。

### A. UnivaPay 定期課金を有効化（必須）
サブスクは「プランごとに手動作成した固定の決済リンク＋Webhookでのメール/金額照合」方式（Threads Studio方式）。
テナントはこのリンク上でカードを登録し、Webhook受信時にメールアドレスで契約者を、金額でプラン(ライト/プロ)を特定する。

1. UnivaPayの加盟店契約・App Token（JWT）を取得。**App TokenはURL(ドメイン)単位で発行される**ため、
   このサービスの公開ドメイン（例: keiro.s-toru.com）を許可ドメインとしたトークンを発行すること
   （他ドメイン用に発行済みのトークンは流用できない）。同一ストア（同一マーチャント）であれば
   `UNIVAPAY_STORE_ID` は他プロダクトと共有可。このApp Tokenはサーバ側の解約/照会にのみ使う。
2. UnivaPay管理画面でプランごとに決済リンク（定期課金）を2本、手動作成する
   （ライト: `PLAN_AMOUNT_LIGHT`円/月、プロ: `PLAN_AMOUNT_PRO`円/月）。
3. Coolify の Environment Variables に設定：
   - `UNIVAPAY_ENABLED=true`
   - `UNIVAPAY_JWT_TOKEN`（App Token JWT。認証はこれ単体＝`Bearer {jwt}`のみで完結）
   - `UNIVAPAY_STORE_ID`
   - `UNIVAPAY_WEBHOOK_SECRET`（Webhook署名検証用の鍵。UnivaPay管理画面のWebhook設定から取得・設定）
   - `UNIVAPAY_LINK_URL_LIGHT` / `UNIVAPAY_LINK_URL_PRO`（手順2で作成した決済リンクURL）
4. 再デプロイ。
5. UnivaPay管理画面の Webhook 宛先に `https://<ドメイン>/webhook/univapay` を登録する。
   ※ 検証はAuthorizationヘッダの固定値比較ではなく、生ボディのHMAC-SHA256署名（`x-univapay-signature`等の
   ヘッダー）で行う。`UNIVAPAY_WEBHOOK_SECRET`はその署名鍵。
6. テストモードで決済リンクから申し込み→課金→`subscriptions.status=active`、`tenant.status=active` を確認。
7. 料金は `PLAN_NAME` / `PLAN_AMOUNT`（円・税込）で設定。

### B. 独自ドメイン or DuckDNS（推奨）
`sslip.io` は一部端末で名前解決に失敗する恐れ（広告クリック先に使うため取りこぼしリスク）。
1. DNSで A レコード `（使うホスト名）→ 163.44.103.9` を作成。
   - 独自ドメイン: レジストラのDNSで設定。
   - DuckDNS（無料）: `duckdns.org` でサインイン→サブドメイン取得→トークンでA設定。
2. Coolify → アプリ → Domains を新ホスト名(https)に変更、環境変数 `BASE_URL` も同値に。
3. 再デプロイ（Let's Encryptで証明書自動発行）。`/healthz` がHTTPSで200を確認。

### C. 法務ページの記入（必須）
`/terms`・`/privacy`・`/tokushoho` は雛形。`〔〕`箇所（事業者名・住所・代表者・連絡先・料金・解約条件・管轄等）を記入し、専門家の確認を受ける。
ファイル: `public/legal/terms.html` / `privacy.html` / `tokushoho.html`。

### D. バックアップ自動実行（設定済み）
ホストの cron に日次バックアップを登録済み（毎日3:30）：
```
30 3 * * * CID=$(docker ps -q -f name=<UUID> | head -1); [ -n "$CID" ] && docker exec $CID node scripts/backup.js >> /var/log/keiro-backup.log 2>&1
```
`/app/data/backups` に世代保存（`BACKUP_KEEP` 世代）。

### 院オーナー向け
各院は `/guide` の手順に従い、自院のLINE Messaging APIチャネルを用意してダッシュボードで設定する。

---

## チェックリスト

- [ ] Persistent Storage `/app/data` を登録した
- [ ] `NODE_ENV=production`, `SECRET`, `ADMIN_PASS`, `BASE_URL(https)` を設定した
- [ ] `/healthz` が 200 を返す
- [ ] LINE Webhook 検証が通る
- [ ] 計測リンク `/c/<id>` をスマホで開き、友だち追加→claim→管理画面で「紐づけ済」を確認
- [ ] （任意）バックアップ cron を登録した
