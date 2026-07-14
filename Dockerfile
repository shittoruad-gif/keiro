# ---- build stage: native依存(better-sqlite3)のビルド ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 が prebuild を使えない環境向けにビルドツールを用意
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# タイムゾーン: リマインダ「前日18時」・毎朝のトークン監視・月次レポート・日別集計は
# サーバのローカル時刻に依存するため、日本時間で固定する（slimイメージはtzdata非搭載）
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*
ENV TZ=Asia/Tokyo

# 非rootユーザーで実行
COPY --from=build /app/node_modules ./node_modules
COPY . .

# データ用ディレクトリ（ボリュームでマウントして永続化する）
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data"]

# ヘルスチェック（/healthz）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
