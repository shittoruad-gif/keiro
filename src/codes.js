'use strict';

// アクセスコード（パスコード）: クライアントがアプリ内で入力すると、
// 無料利用期間（既定30日）とプラン（既定プロ）が付与される。
// 公式LINE制作パッケージ購入者に配布し、制作なしの自己申込（14日）と区別する用途。

const crypto = require('crypto');
const config = require('./config');
const { newId } = require('./sign');

const DAY = 24 * 3600 * 1000;

/** 紛らわしい文字を避けた大文字英数でコード生成（例: KEIRO-7Q4M-K2P9）。 */
function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O/1/I を除外
  const pick = (n) => Array.from(crypto.randomBytes(n)).map((b) => alphabet[b % alphabet.length]).join('');
  return `KEIRO-${pick(4)}-${pick(4)}`;
}

function normalize(code) {
  return String(code || '').trim().toUpperCase();
}

/** 運営がコードを発行。code 未指定なら自動生成。 */
function createCode(db, { code, trialDays, plan, maxUses, note } = {}) {
  const now = Date.now();
  let c = code ? normalize(code) : genCode();
  // 自動生成の衝突回避
  if (!code) {
    for (let i = 0; i < 5 && db.prepare('SELECT 1 FROM access_codes WHERE code = ?').get(c); i++) c = genCode();
  }
  const row = {
    id: newId('code'),
    code: c,
    trial_days: Number.isFinite(trialDays) && trialDays > 0 ? Math.floor(trialDays) : config.codeTrialDays,
    plan: plan === 'light' ? 'light' : 'pro',
    max_uses: Number.isFinite(maxUses) && maxUses > 0 ? Math.floor(maxUses) : 1,
    note: note ? String(note).slice(0, 200) : null,
  };
  db.prepare(
    `INSERT INTO access_codes (id, code, trial_days, plan, max_uses, used_count, active, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`
  ).run(row.id, row.code, row.trial_days, row.plan, row.max_uses, row.note, now, now);
  return db.prepare('SELECT * FROM access_codes WHERE id = ?').get(row.id);
}

function listCodes(db) {
  return db.prepare('SELECT * FROM access_codes ORDER BY created_at DESC').all();
}

function setActive(db, id, active) {
  db.prepare('UPDATE access_codes SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, Date.now(), id);
  return db.prepare('SELECT * FROM access_codes WHERE id = ?').get(id);
}

/**
 * テナントがコードを適用。無料期間（今日から trial_days 日）とプランを付与。
 * @returns {{ok:boolean, error?:string, plan?:string, trialDays?:number, trialEndsAt?:number}}
 */
function redeemCode(db, tenant, codeStr) {
  const code = normalize(codeStr);
  if (!code) return { ok: false, error: 'パスコードを入力してください。' };
  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
  if (!row || !row.active) return { ok: false, error: 'このパスコードは無効です。番号をご確認ください。' };
  if (row.used_count >= row.max_uses) return { ok: false, error: 'このパスコードは既に使用済みです。' };

  const now = Date.now();
  // 再適用ガード（永年破壊・有料客の勝手な格上げ・同一コード多重適用を防ぐ）
  // ① 同じコードを既に適用済みなら二重適用しない
  if (tenant.code_redeemed && tenant.code_redeemed === code) {
    return { ok: false, error: 'このパスコードは既に適用済みです。' };
  }
  // ② 永年無料（残り約8年以上）を短い無料期間で上書きしない
  if ((tenant.trial_ends_at || 0) - now > 3000 * DAY) {
    return { ok: false, error: 'このアカウントは永年無料のため、パスコードの適用は不要です。' };
  }
  // ③ 有料契約中（active）はコードでプラン/無料期間を上書きしない（プラン変更はサポート対応）
  const activeSub = db.prepare("SELECT status FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1").get(tenant.id);
  if (activeSub && activeSub.status === 'active') {
    return { ok: false, error: '有料契約中のため、パスコードは適用できません。プラン変更はサポートへご連絡ください。' };
  }
  // 既存の無料期間を短縮しない（新旧のうち遅い満了日を採用）
  const trialEndsAt = Math.max(now + row.trial_days * DAY, tenant.trial_ends_at || 0);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE tenants SET plan = ?, trial_ends_at = ?, code_redeemed = ?, code_redeemed_at = ?, updated_at = ? WHERE id = ?`
    ).run(row.plan, trialEndsAt, code, now, now, tenant.id);
    db.prepare('UPDATE access_codes SET used_count = used_count + 1, updated_at = ? WHERE id = ?').run(now, row.id);
  });
  tx();
  return { ok: true, plan: row.plan, trialDays: row.trial_days, trialEndsAt };
}

module.exports = { genCode, createCode, listCodes, setActive, redeemCode };
