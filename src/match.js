'use strict';

/**
 * 紐づけ（attribution）ロジック。
 *
 * スマホでは「広告クリック時のブラウザ」と「友だち追加後にclaimを開くLINEアプリ内ブラウザ」が
 * 別物で、Cookie も UserAgent も引き継がれない。概ね一致するのは IP アドレスのみ。
 * したがって精度を最優先に、次の優先順位で1件のクリックを選ぶ:
 *
 *   優先1 (claim): claimのCookieにクリックIDがあり、そのクリックが未紐づけならそれを使う。
 *                  同一ブラウザ（主にPC）のとき有効。最も確実。
 *   優先2 (ip)   : 同一IP かつ 未紐づけ かつ 直近 windowSec 秒以内 の最新クリック。スマホの主力経路。
 *   最終手段 (time): IPも取れない場合のみ、未紐づけ かつ 時間窓以内 の最新クリック。
 *
 * 重要な方針:
 *   - follow イベント時点では推定紐づけをしない（誤紐づけ防止）。本関数は claim 到達時に呼ぶ。
 *   - UserAgent を含むデバイス指紋でのフォールバックは行わない（UAが変わって破綻するため）。
 *   - 候補が無ければ null（=未紐づけのまま放置）。再現率より精度を優先。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} ctx
 * @param {string}      ctx.tenantId       テナントID（必須。突合は必ず同一テナント内）
 * @param {string|null} ctx.cookieClickId  claimリクエストのCookie keiro_cid
 * @param {string|null} ctx.ip             claimリクエストのIP
 * @param {number}      ctx.nowMs          現在時刻(ms)
 * @param {number}      ctx.windowSec      MATCH_WINDOW_SEC
 * @returns {{clickId: string, method: 'claim'|'ip'|'time'}|null}
 */
function findMatch(db, ctx) {
  const { tenantId, cookieClickId, ip, nowMs, windowSec } = ctx;
  const sinceMs = nowMs - windowSec * 1000;

  // 優先1: Cookieのクリックが存在し未紐づけなら採用（同一テナント内・時間窓非依存＝確実な同一ブラウザ）
  if (cookieClickId) {
    const click = db.prepare(
      'SELECT id FROM clicks WHERE id = ? AND tenant_id = ? AND matched = 0'
    ).get(cookieClickId, tenantId);
    if (click) return { clickId: click.id, method: 'claim' };
  }

  // 優先2: 同一テナント・同一IP・未紐づけ・時間窓以内の最新クリック
  if (ip) {
    const click = db.prepare(
      `SELECT id FROM clicks
       WHERE tenant_id = ? AND ip = ? AND matched = 0 AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(tenantId, ip, sinceMs);
    if (click) return { clickId: click.id, method: 'ip' };
  }

  // 最終手段: IPが取れない場合のみ、同一テナント内の時間窓だけで最新クリックに紐づけ
  if (!ip) {
    const click = db.prepare(
      `SELECT id FROM clicks
       WHERE tenant_id = ? AND matched = 0 AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(tenantId, sinceMs);
    if (click) return { clickId: click.id, method: 'time' };
  }

  return null;
}

/**
 * follow に対して紐づけを実行し、結果をDBに反映する（トランザクション）。
 * 紐づいたクリックは matched=1 にして二重紐づけを防ぐ。
 * @returns {{matched: boolean, clickId?: string, method?: string}}
 */
function applyMatch(db, follow, ctx) {
  const tx = db.transaction(() => {
    const m = findMatch(db, ctx);
    if (!m) {
      db.prepare(
        "UPDATE follows SET status = 'unmatched' WHERE id = ?"
      ).run(follow.id);
      return { matched: false };
    }
    // 二重紐づけ防止: 該当クリックを未紐づけのまま掴めた場合のみ確定
    const upd = db.prepare(
      'UPDATE clicks SET matched = 1 WHERE id = ? AND matched = 0'
    ).run(m.clickId);
    if (upd.changes !== 1) {
      // 競合で他のfollowに取られた → 未紐づけ扱い
      db.prepare(
        "UPDATE follows SET status = 'unmatched' WHERE id = ?"
      ).run(follow.id);
      return { matched: false };
    }
    db.prepare(
      `UPDATE follows
       SET click_id = ?, match_method = ?, status = 'matched', matched_at = ?
       WHERE id = ?`
    ).run(m.clickId, m.method, ctx.nowMs, follow.id);
    return { matched: true, clickId: m.clickId, method: m.method };
  });
  return tx();
}

module.exports = { findMatch, applyMatch };
