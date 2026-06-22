'use strict';

// SQLite のオンラインバックアップを作成し、古い世代を削除する。
//   node scripts/backup.js
// cron 例（毎日 3:15）:  15 3 * * *  cd /app && node scripts/backup.js

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { openDb } = require('../src/db');
const logger = require('../src/logger');

async function main() {
  if (!fs.existsSync(config.dbPath)) {
    logger.warn('backup skipped: db not found', { db: config.dbPath });
    return;
  }
  fs.mkdirSync(config.backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(config.backupDir, `keiro-${stamp}.db`);

  const db = openDb(config.dbPath);
  // better-sqlite3 の .backup は WAL を含む一貫したスナップショットを作る
  await db.backup(dest);
  db.close();

  // 世代管理: 新しい順に backupKeep 件だけ残す
  const files = fs.readdirSync(config.backupDir)
    .filter((f) => /^keiro-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(config.backupDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  let removed = 0;
  for (const { f } of files.slice(config.backupKeep)) {
    fs.unlinkSync(path.join(config.backupDir, f));
    removed++;
  }

  const size = fs.statSync(dest).size;
  logger.info('backup done', { dest, bytes: size, kept: Math.min(files.length, config.backupKeep), removed });
  console.log(`バックアップ完了: ${dest} (${size} bytes), 削除 ${removed} 件`);
}

main().catch((e) => {
  logger.error('backup failed', { err: String((e && e.message) || e) });
  process.exit(1);
});
