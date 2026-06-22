'use strict';

const config = require('./config');
const logger = require('./logger');

/**
 * データ保持期間を超えた個人情報（IP/UA/line_user_id を含む行）を物理削除する。
 * 紐づけ済みの古いクリックは、参照する follow が残っている間は保持し、
 * follow が消えてから削除する（FK整合性を保つ）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} retentionDays
 * @param {number} [nowMs]
 * @returns {{clicks:number, follows:number, postbacks:number, cutoff:number}}
 */
function purgeOldData(db, retentionDays, nowMs) {
  const now = nowMs || Date.now();
  const cutoff = now - retentionDays * 24 * 3600 * 1000;

  const tx = db.transaction(() => {
    // 1) 期限切れ follow に紐づく postback を先に削除（孤児防止）
    const pbOrphan = db.prepare(
      `DELETE FROM postbacks
       WHERE follow_id IN (SELECT id FROM follows WHERE created_at < ?)`
    ).run(cutoff).changes;
    // 2) 古い postback 本体
    const pbOld = db.prepare('DELETE FROM postbacks WHERE created_at < ?').run(cutoff).changes;
    // 3) 古い follow（line_user_id を保持しているため最優先で削除対象）
    const follows = db.prepare('DELETE FROM follows WHERE created_at < ?').run(cutoff).changes;
    // 4) 古い click。ただし現存 follow から参照されているものは残す
    const clicks = db.prepare(
      `DELETE FROM clicks
       WHERE created_at < ?
         AND id NOT IN (SELECT click_id FROM follows WHERE click_id IS NOT NULL)`
    ).run(cutoff).changes;
    return { clicks, follows, postbacks: pbOrphan + pbOld, cutoff };
  });

  const result = tx();
  if (result.clicks || result.follows || result.postbacks) {
    logger.info('retention purge', result);
  }
  return result;
}

/** 設定の保持日数で purge を実行（無効なら何もしない）。 */
function runRetention(db) {
  if (!config.retentionDays || config.retentionDays <= 0) return null;
  return purgeOldData(db, config.retentionDays);
}

module.exports = { purgeOldData, runRetention };
