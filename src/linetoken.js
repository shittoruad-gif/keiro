'use strict';
// チャネルアクセストークンの自動発行・自動更新。
// Channel ID と Channel secret が揃っていれば、LINE Developersを開かずにトークンを発行できる
// （v2 client_credentials・30日有効）。期限の7日前を切ったら自動で再発行して差し替える。
const line = require('./line');
const tenantmod = require('./tenant');
const logger = require('./logger');

const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

/** 指定テナントのトークンを発行して保存する。 */
async function issueForTenant(db, tenant, opts = {}) {
  const settings = tenantmod.resolveSettings(tenant);
  const channelId = String(opts.channelId || tenant.line_channel_id || '').trim();
  const secret = opts.channelSecret || settings.line.channelSecret;
  if (!channelId) return { ok: false, error: 'Channel ID が未設定です' };
  if (!secret) return { ok: false, error: 'Channel secret が未設定です' };
  const r = await (opts.issue || line.issueChannelAccessToken)(channelId, secret);
  if (!r.ok) return { ok: false, error: r.error || 'トークン発行に失敗しました', http_status: r.http_status };
  const expiresAt = Date.now() + r.expiresIn * 1000;
  tenantmod.updateTenantSettings(db, tenant.id, {
    line_channel_access_token: r.accessToken,
    line_channel_id: channelId,
    line_token_expires_at: expiresAt,
    line_token_auto: 1,
  });
  logger.info('line token issued', { tenant_id: tenant.id, expires_at: expiresAt });
  return { ok: true, expiresAt };
}

/** 自動発行テナントのうち期限が近い/不明なものを再発行する（スケジューラから呼ぶ）。 */
async function processTokenRenewals(db, opts = {}) {
  const now = opts.now || Date.now();
  const rows = db.prepare(
    "SELECT * FROM tenants WHERE role='tenant' AND line_token_auto=1 AND line_channel_id IS NOT NULL AND line_channel_secret IS NOT NULL"
  ).all();
  let renewed = 0, failed = 0;
  for (const t of rows) {
    const exp = Number(t.line_token_expires_at || 0);
    if (exp && exp - now > RENEW_BEFORE_MS) continue;
    const r = await issueForTenant(db, t, { issue: opts.issue });
    if (r.ok) renewed++;
    else { failed++; logger.warn('line token renew failed', { tenant_id: t.id, err: r.error }); }
  }
  return { checked: rows.length, renewed, failed };
}

module.exports = { issueForTenant, processTokenRenewals, RENEW_BEFORE_MS };
