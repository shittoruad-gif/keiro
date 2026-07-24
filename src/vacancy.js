'use strict';

// 空き枠おしらせ配信：予約システムの「空き枠フィード」（JSON）を読み、
// 今日・明日の空き状況を差し込んだお知らせを自動配信する。
//
// しつこさ防止（既定・設定で変更不可の安全弁も含む）:
//   - 1日1回、設定時刻(JST)にだけ判定する
//   - 前回送信から min_gap_hours（既定72時間）未満は送らない
//   - 直近7日間で weekly_cap（既定2回）に達していたら送らない
//   - 今日も明日も空きゼロ（または取得失敗）の日は送らない
//
// フィード契約（予約システム側が返すJSON）:
//   { days: [ { date: 'YYYY-MM-DD', groups: [ { name: '店舗名', closed: bool, times: ['HH:MM', ...] } ] } ] }
//   days に今日・明日ぶんが含まれていること（date文字列でマッチする）。
const logger = require('./logger');
const { newId } = require('./sign');
const broadcast = require('./broadcast');
const billing = require('./billing');
const { isSafeUrl } = require('./aisetup');

const DEFAULT_TEMPLATE = `{name}さん、こんにちは😊

ご予約の空き状況をお知らせします。

◆ 本日 {today_date}
{today}

◆ 明日 {tomorrow_date}
{tomorrow}

ご希望の時間があれば、下記からかんたんにご予約いただけます👇`;

// ---- 設定 ----

function getSettings(db, tenantId) {
  const row = db.prepare('SELECT * FROM vacancy_settings WHERE tenant_id = ?').get(tenantId);
  return row || {
    tenant_id: tenantId, enabled: 0, feed_url: '', send_hour: 10,
    audience_type: 'all', audience_value: null,
    template: DEFAULT_TEMPLATE, min_gap_hours: 72, weekly_cap: 2, last_sent_at: null,
  };
}

function saveSettings(db, tenantId, b) {
  const cur = getSettings(db, tenantId);
  const feedUrl = b.feed_url !== undefined ? String(b.feed_url || '').trim() : cur.feed_url;
  if (feedUrl && !/^https:\/\//.test(feedUrl)) return { error: 'フィードURLは https:// で始まる必要があります' };
  const sendHour = b.send_hour !== undefined ? parseInt(b.send_hour, 10) : cur.send_hour;
  if (!(sendHour >= 7 && sendHour <= 20)) return { error: '送信時刻は7〜20時の間で設定してください' };
  // 安全弁: 間隔は48時間未満・週3回超にはできない（しつこさ防止）
  const minGap = Math.max(48, parseInt(b.min_gap_hours ?? cur.min_gap_hours, 10) || 72);
  const cap = Math.min(3, Math.max(1, parseInt(b.weekly_cap ?? cur.weekly_cap, 10) || 2));
  const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : cur.enabled;
  if (enabled && !feedUrl) return { error: '有効にするにはフィードURLの設定が必要です' };
  const template = b.template !== undefined ? String(b.template || '').slice(0, 2000) : cur.template;
  const audienceType = b.audience_type !== undefined ? String(b.audience_type) : cur.audience_type;
  const audienceValue = b.audience_value !== undefined ? (b.audience_value ? String(b.audience_value) : null) : cur.audience_value;
  db.prepare(
    `INSERT INTO vacancy_settings (tenant_id, enabled, feed_url, send_hour, audience_type, audience_value, template, min_gap_hours, weekly_cap, last_sent_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT last_sent_at FROM vacancy_settings WHERE tenant_id = ?), ?)
     ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled, feed_url=excluded.feed_url, send_hour=excluded.send_hour,
       audience_type=excluded.audience_type, audience_value=excluded.audience_value, template=excluded.template,
       min_gap_hours=excluded.min_gap_hours, weekly_cap=excluded.weekly_cap, updated_at=excluded.updated_at`
  ).run(tenantId, enabled, feedUrl, sendHour, audienceType, audienceValue,
    template || DEFAULT_TEMPLATE, minGap, cap, tenantId, Date.now());
  return getSettings(db, tenantId);
}

// ---- フィード取得・整形 ----

async function fetchFeed(feedUrl, opts = {}) {
  if (opts.feed) return opts.feed; // テスト用
  if (!(await isSafeUrl(feedUrl))) throw new Error('フィードURLが不正です');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(feedUrl, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`フィード取得に失敗しました (HTTP ${res.status})`);
    const json = await res.json();
    if (!json || !Array.isArray(json.days)) throw new Error('フィードの形式が不正です');
    return json;
  } finally { clearTimeout(timer); }
}

function jstParts(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d);
  const get = (t) => (p.find((x) => x.type === t) || {}).value || '';
  const iso = `${get('year')}-${get('month')}-${get('day')}`;
  const WD = { Sun: '日', Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土' };
  return { iso, label: `${parseInt(get('month'), 10)}/${parseInt(get('day'), 10)}(${WD[get('weekday')] || ''})` };
}

/** 1日ぶんの空きをお客さま向けの行に整形。空きが全く無ければ null。 */
function renderDay(day) {
  if (!day || !Array.isArray(day.groups)) return null;
  const lines = [];
  for (const g of day.groups) {
    if (g.closed || !Array.isArray(g.times) || !g.times.length) continue;
    // 15分刻みだと羅列が長いので、00分・30分を優先して最大5つ + 「ほか」
    const preferred = g.times.filter((t) => /:(00|30)$/.test(t));
    const shown = (preferred.length ? preferred : g.times).slice(0, 5);
    const rest = g.times.length - shown.length;
    const plenty = g.times.length >= 12;
    lines.push(`・${g.name}：${shown.join(' / ')}${rest > 0 ? ' ほか' : ''}${plenty ? '（空きに余裕あり）' : ''}`);
  }
  return lines.length ? lines.join('\n') : null;
}

/** テンプレートに空き状況を差し込む。空きが全く無ければ { empty: true }。 */
function renderMessage(settings, feed) {
  const today = jstParts(0), tomorrow = jstParts(1);
  const dayOf = (iso) => (feed.days || []).find((d) => d && d.date === iso);
  const todayText = renderDay(dayOf(today.iso));
  const tomorrowText = renderDay(dayOf(tomorrow.iso));
  if (!todayText && !tomorrowText) return { empty: true, text: null };
  let text = String(settings.template || DEFAULT_TEMPLATE);
  text = text
    .replace(/\{today_date\}/g, today.label)
    .replace(/\{tomorrow_date\}/g, tomorrow.label)
    .replace(/\{today\}/g, todayText || '本日の空きは埋まりました🙏')
    .replace(/\{tomorrow\}/g, tomorrowText || '明日の空きは埋まりました🙏');
  return { empty: false, text };
}

// ---- 送信判定・実行 ----

/** 送信してよいか（時刻以外の抑制ルール）。理由文字列 or null(送信可)。 */
function suppressReason(db, s, now) {
  if (s.last_sent_at && now - s.last_sent_at < s.min_gap_hours * 3600 * 1000) {
    return `前回送信から${s.min_gap_hours}時間経っていない`;
  }
  const weekAgo = now - 7 * 86400000;
  const n = db.prepare('SELECT COUNT(*) n FROM vacancy_sends WHERE tenant_id = ? AND ok = 1 AND created_at >= ?')
    .get(s.tenant_id, weekAgo).n;
  if (n >= s.weekly_cap) return `今週すでに${n}回送信済み（上限${s.weekly_cap}回）`;
  return null;
}

function logSend(db, tenantId, ok, detail) {
  db.prepare('INSERT INTO vacancy_sends (id, tenant_id, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(newId('vcs'), tenantId, ok ? 1 : 0, (detail || '').slice(0, 500), Date.now());
}

/**
 * 毎時スケジューラ本体。設定時刻(JST)のテナントだけ処理する。
 * @param {object} [opts] テスト用: now(ms), feed(JSONを直接渡す), sender/pushSender(broadcast側へ)
 */
async function processVacancy(db, opts = {}) {
  const now = opts.now || Date.now();
  const hourJst = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false }).format(new Date(now)), 10) % 24;
  const rows = db.prepare('SELECT * FROM vacancy_settings WHERE enabled = 1').all();
  let sent = 0;
  for (const s of rows) {
    if (s.send_hour !== hourJst) continue;
    // 同じ時間帯の二重送信防止（毎時実行でも、この1時間内に送信済みならスキップ）
    if (s.last_sent_at && now - s.last_sent_at < 3600 * 1000) continue;
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(s.tenant_id);
    if (!tenant || !billing.isMeasurementActive(db, tenant)) continue;
    const reason = suppressReason(db, s, now);
    if (reason) { logger.info('vacancy suppressed', { tenant_id: s.tenant_id, reason }); continue; }
    let msg;
    try {
      const feed = await fetchFeed(s.feed_url, opts);
      msg = renderMessage(s, feed);
    } catch (e) {
      logSend(db, s.tenant_id, false, 'フィード取得失敗: ' + String((e && e.message) || e));
      logger.warn('vacancy feed error', { tenant_id: s.tenant_id, err: String((e && e.message) || e) });
      continue;
    }
    if (msg.empty) { logger.info('vacancy skipped (no slots)', { tenant_id: s.tenant_id }); continue; }
    const b = broadcast.createBroadcast(db, s.tenant_id, {
      name: '空き枠おしらせ（自動）', text: msg.text,
      audience_type: s.audience_type || 'all', audience_value: s.audience_value,
    });
    const r = await broadcast.sendBroadcast(db, s.tenant_id, b.id, opts);
    if (r.error) { logSend(db, s.tenant_id, false, r.error); continue; }
    db.prepare('UPDATE vacancy_settings SET last_sent_at = ? WHERE tenant_id = ?').run(now, s.tenant_id);
    logSend(db, s.tenant_id, true, `sent=${r.sent} fail=${r.fail}`);
    logger.info('vacancy sent', { tenant_id: s.tenant_id, sent: r.sent, fail: r.fail });
    sent++;
  }
  return { sent };
}

module.exports = { getSettings, saveSettings, fetchFeed, renderDay, renderMessage, suppressReason, processVacancy, DEFAULT_TEMPLATE };
