'use strict';

const config = require('./config');
const { newId } = require('./sign');

const DAY = 24 * 3600 * 1000;

/** 既定プランを用意（無ければ作成）して返す。 */
function ensureDefaultPlan(db) {
  let plan = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get();
  if (!plan) {
    const id = newId('pln');
    db.prepare(
      `INSERT INTO plans (id, name, amount, interval, active, created_at) VALUES (?, ?, ?, 'month', 1, ?)`
    ).run(id, config.defaultPlan.name, config.defaultPlan.amount, Date.now());
    plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  }
  return plan;
}

function latestSubscription(db, tenantId) {
  return db.prepare(
    'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(tenantId);
}

/** テナントの利用プラン情報（プロ標準 / ライト）。tenant.plan 未設定は 'pro' 扱い。 */
function planInfo(tenant) {
  const key = (tenant && tenant.plan) === 'light' ? 'light' : 'pro';
  const amount = key === 'light' ? config.planAmounts.light : config.planAmounts.pro;
  const name = key === 'light' ? 'ライトプラン' : 'プロプラン';
  return { key, name, amount };
}

/**
 * テナントの課金状態。operatorは常にactive、トライアル中もactive。
 * 無料期間は tenant.trial_ends_at（パスコード適用時に設定）を優先し、無ければ created_at + TRIAL_DAYS。
 * @returns {{active:boolean, status:string, inTrial:boolean, trialEndsAt:number, subscription:object|null}}
 */
function subscriptionState(db, tenant) {
  const trialEndsAt = tenant.trial_ends_at || ((tenant.created_at || Date.now()) + config.trialDays * DAY);
  const inTrial = Date.now() < trialEndsAt;
  const sub = latestSubscription(db, tenant.id);
  const subActive = !!sub && sub.status === 'active';

  let status;
  if (tenant.role === 'operator') status = 'operator';
  else if (subActive) status = 'active';
  else if (sub) status = sub.status;        // past_due / canceled / trialing 等
  else if (inTrial) status = 'trialing';
  else status = 'none';

  const active = tenant.role === 'operator' || subActive || (inTrial && (!sub || sub.status === 'trialing'));
  return { active, status, inTrial, trialEndsAt, subscription: sub || null };
}

/** 計測（/c, /webhook）を稼働させてよいか。停止テナント/失効は止める。 */
function isMeasurementActive(db, tenant) {
  if (!tenant) return false;
  if (tenant.status === 'suspended') return false;
  return subscriptionState(db, tenant).active;
}

/** UnivaPayのサブスクをDBへ反映（作成/更新）。 */
function upsertSubscription(db, { tenantId, planId, univapaySubId, status, currentPeriodEnd }) {
  const existing = univapaySubId
    ? db.prepare('SELECT * FROM subscriptions WHERE univapay_subscription_id = ?').get(univapaySubId)
    : null;
  const now = Date.now();
  if (existing) {
    db.prepare(
      `UPDATE subscriptions SET status = ?, current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?`
    ).run(status, currentPeriodEnd || null, now, existing.id);
    return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(existing.id);
  }
  const id = newId('sub');
  db.prepare(
    `INSERT INTO subscriptions (id, tenant_id, plan_id, univapay_subscription_id, status, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, planId || null, univapaySubId || null, status, currentPeriodEnd || null, now, now);
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
}

function recordPayment(db, { tenantId, subscriptionId, chargeId, amount, status, raw }) {
  db.prepare(
    `INSERT INTO payments (id, tenant_id, subscription_id, univapay_charge_id, amount, status, raw, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('pay'), tenantId, subscriptionId || null, chargeId || null, amount || null, status || null,
    raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : null, Date.now());
}

/** サブスク状態に応じて tenant.status を同期（active→active, canceled/past_due→suspended）。 */
function syncTenantStatus(db, tenantId) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant || tenant.role === 'operator') return;
  const st = subscriptionState(db, tenant);
  const newStatus = st.active ? 'active' : 'suspended';
  if (tenant.status !== newStatus) {
    db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, Date.now(), tenantId);
  }
}

module.exports = {
  ensureDefaultPlan, latestSubscription, subscriptionState, planInfo,
  isMeasurementActive, upsertSubscription, recordPayment, syncTenantStatus,
};
