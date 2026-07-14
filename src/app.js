'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const logger = require('./logger');
const { getIp, escapeHtml } = require('./util');
const { signToken, verifyToken, verifyLineSignature, newId, sha256hex } = require('./sign');
const mailer = require('./mailer');
const { applyMatch } = require('./match');
const { deleteLinkCascade } = require('./links');
const { replyGreeting, replyText, replyMessages, pushMessages, getProfile: lineProfile, getBotInfo } = require('./line');
const { dispatchPostbacks } = require('./postback');
const { createRateLimiter } = require('./ratelimit');
const authmod = require('./auth');
const tenantmod = require('./tenant');
const billing = require('./billing');
const codes = require('./codes');
const pwreset = require('./pwreset');
const appsettings = require('./appsettings');
const univapay = require('./univapay');
const steps = require('./steps');
const friends = require('./friends');
const broadcast = require('./broadcast');
const autoreply = require('./autoreply');
const identify = require('./identify');
const richmenu = require('./richmenu');
const presets = require('./presets');
const analytics = require('./analytics');
const coupons = require('./coupons');
const birthday = require('./birthday');
const stampcard = require('./stampcard');
const inbox = require('./inbox');
const reminders = require('./reminders');
const usage = require('./usage');
const report = require('./report');
const preview = require('./preview');
const support = require('./support');
const forms = require('./forms');
const trackurl = require('./trackurl');
const aisetup = require('./aisetup');

const CLAIM_TOKEN_MAX_AGE_SEC = 60 * 60 * 24 * 7;
const PUB = path.join(__dirname, '..', 'public');

function sendPage(res, file) {
  res.sendFile(path.join(PUB, file));
}

function createApp(db) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(cookieParser());

  const limiter = createRateLimiter(config.rateLimit);
  const authLimiter = createRateLimiter({ windowSec: 60, max: 20 });
  const { requireAuth, requireOperator } = authmod.makeAuth(db);

  billing.ensureDefaultPlan(db);
  appsettings.init(db); // 運営画面で保存したUnivaPay設定をconfigへ反映

  // 誕生日配信：毎時実行（processBirthdays内部で0時台のみ実際に送信）。
  // unref: テスト・graceful shutdown時にプロセスを塞がない
  const birthdayTimer = setInterval(() => birthday.processBirthdays(db).catch((e) => logger.error('birthday scheduler', { err: String(e && e.message || e) })), 60 * 60 * 1000);
  if (birthdayTimer.unref) birthdayTimer.unref();

  // 月次成果レポート: 毎時チェック（毎月1〜3日9時以降に前月ぶんを送信）
  const reportTimer = setInterval(() => report.processMonthlyReports(db).catch((e) => logger.error('monthly report scheduler', { err: String(e && e.message || e) })), 60 * 60 * 1000);
  if (reportTimer.unref) reportTimer.unref();

  // ---- ヘルスチェック ----
  app.get('/healthz', (req, res) => {
    try { db.prepare('SELECT 1').get(); res.json({ ok: true, ts: Date.now() }); }
    catch (e) { logger.error('healthz db error', { err: String((e && e.message) || e) }); res.status(503).json({ ok: false }); }
  });

  // ブラウザからのワンタイムLINE連携（webhook_tokenで認可・no-cors POST対応）。
  // LINE Developers画面から secret/token を直接Keiroへ送るために使用。
  app.options('/connect/line', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
  });
  app.post('/connect/line', limiter, express.json({ type: () => true, limit: '64kb' }), (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    b = b || {};
    const tenant = b.webhook_token ? db.prepare('SELECT * FROM tenants WHERE webhook_token = ?').get(b.webhook_token) : null;
    if (!tenant) return res.status(404).json({ error: 'not found' });
    const fields = {};
    if (b.channel_secret) fields.line_channel_secret = b.channel_secret;
    if (b.channel_access_token) fields.line_channel_access_token = b.channel_access_token;
    if (b.oa_add_url) fields.line_oa_add_url = b.oa_add_url;
    tenantmod.updateTenantSettings(db, tenant.id, fields);
    logger.info('line connected via browser', { tenant_id: tenant.id, has_secret: !!b.channel_secret, has_token: !!b.channel_access_token, has_oa: !!b.oa_add_url });
    res.json({ ok: true });
  });

  // 接続テスト（webhook_tokenで認可）: 保存済みトークンでLINEのbot情報が取れるか確認。秘密情報は返さない。
  app.post('/connect/line/check', limiter, express.json({ type: () => true, limit: '8kb' }), async (req, res) => {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    b = b || {};
    const tenant = b.webhook_token ? db.prepare('SELECT * FROM tenants WHERE webhook_token = ?').get(b.webhook_token) : null;
    if (!tenant) return res.status(404).json({ error: 'not found' });
    try {
      const settings = tenantmod.resolveSettings(tenant);
      if (!settings.line.channelAccessToken) return res.json({ ok: false, error: 'トークン未設定' });
      const r = await getBotInfo(settings.line.channelAccessToken);
      if (!r || !r.ok) return res.json({ ok: false, error: 'LINE接続エラー' });
      res.json({ ok: true, bot_name: (r.info && r.info.displayName) || null });
    } catch (e) {
      logger.error('connect check error', { err: String((e && e.message) || e) });
      res.json({ ok: false, error: 'check failed' });
    }
  });

  // =====================================================================
  // 公開ページ（認証不要）
  // =====================================================================

  // クーポン公開ページ：/p/:webhook_token/coupon
  app.get('/p/:token/coupon', limiter, (req, res) => {
    const tenant = db.prepare('SELECT id, name, line_oa_add_url FROM tenants WHERE webhook_token = ?').get(req.params.token);
    if (!tenant) return res.status(404).send('not found');
    // 予約/友だち追加ボタンの遷移先は院ごとの設定（LINE友だち追加URL）。未設定ならボタン非表示。
    const ctaUrl = (tenant.line_oa_add_url || '').trim();
    const list = db.prepare(
      'SELECT id, title, description, discount_text, expires_at FROM coupons WHERE tenant_id = ? AND active = 1 ORDER BY created_at DESC'
    ).all(tenant.id);
    const now = Date.now();
    const items = list.map((c) => {
      const expired = c.expires_at && c.expires_at < now;
      const expStr = c.expires_at
        ? new Date(c.expires_at).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
        : '期限なし';
      return `
        <div class="coupon${expired ? ' expired' : ''}">
          <div class="badge">${escapeHtml(c.discount_text || 'クーポン')}</div>
          <h2>${escapeHtml(c.title)}</h2>
          ${c.description ? `<p>${escapeHtml(c.description).replace(/\n/g, '<br>')}</p>` : ''}
          <div class="exp">有効期限：${expStr}${expired ? '（終了）' : ''}</div>
          ${ctaUrl ? `<a class="btn" href="${escapeHtml(ctaUrl)}">今すぐ予約・お問い合わせ →</a>` : ''}
        </div>`;
    }).join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>クーポン一覧 | ${escapeHtml(tenant.name || '')}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#333;padding:16px}
h1{text-align:center;font-size:20px;padding:20px 0 4px;color:#1a56db}
.sub{text-align:center;color:#666;font-size:13px;margin-bottom:20px}
.coupon{background:#fff;border-radius:16px;padding:24px 20px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,.08);position:relative;overflow:hidden}
.coupon::before{content:'';position:absolute;top:0;left:0;width:6px;height:100%;background:#1a56db}
.badge{display:inline-block;background:#1a56db;color:#fff;font-size:14px;font-weight:bold;padding:4px 12px;border-radius:20px;margin-bottom:12px}
.coupon h2{font-size:18px;margin-bottom:8px;line-height:1.4}
.coupon p{font-size:14px;color:#555;line-height:1.6;margin-bottom:10px;white-space:pre-wrap}
.exp{font-size:12px;color:#888;margin-bottom:16px}
.btn{display:block;background:#1a56db;color:#fff;text-align:center;padding:12px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px}
.expired{opacity:.5}.expired .btn{background:#999}
.empty{text-align:center;padding:40px;color:#999}
</style></head><body>
<h1>🎟 クーポン一覧</h1>
<p class="sub">${escapeHtml(tenant.name || '')}</p>
${items || '<div class="empty">現在利用できるクーポンはありません</div>'}
</body></html>`);
  });

  // =====================================================================
  // 外部予約システム連携フック（認証: URL内のwebhook_token）
  //   予約確定時に呼ぶと ①LINEに予約確認を自動送信 ②前日リマインドを自動登録。
  //   POST /hooks/:token/booking        {line_user_id, date:"YYYY-MM-DD", time:"HH:MM"?, menu?, message?}
  //   POST /hooks/:token/booking/cancel {line_user_id}
  //   message省略時は既定文。{name}/{date}/{time}/{menu} が差し込み可能。
  // =====================================================================
  function bookingHookTenant(req, res) {
    const tenant = db.prepare('SELECT * FROM tenants WHERE webhook_token = ?').get(req.params.token);
    if (!tenant) { res.status(404).json({ ok: false, error: 'not found' }); return null; }
    return tenant;
  }

  app.post('/hooks/:token/booking', limiter, express.json({ type: () => true, limit: '32kb' }), async (req, res) => {
    const tenant = bookingHookTenant(req, res);
    if (!tenant) return;
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    b = b || {};

    const lineUserId = String(b.line_user_id || '').trim();
    if (!lineUserId) return res.status(400).json({ ok: false, error: 'line_user_id は必須です' });

    // 日時: date+time または datetime("YYYY-MM-DDTHH:MM" / "YYYY-MM-DD HH:MM")
    let date = String(b.date || '').trim();
    let time = String(b.time || '').trim();
    if (!date && b.datetime) {
      const m = String(b.datetime).trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
      if (m) { date = m[1]; time = m[2]; }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.datetime).trim())) date = String(b.datetime).trim();
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'date は YYYY-MM-DD 形式で指定してください（datetime="YYYY-MM-DDTHH:MM" でも可）' });
    if (time && !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ ok: false, error: 'time は HH:MM 形式で指定してください' });

    // 友だちレコードを確保（LINE未友だちの場合は送信自体がLINE側で失敗する）
    friends.upsertFollow(db, { tenantId: tenant.id, lineUserId, displayName: b.name ? String(b.name).slice(0, 100) : undefined });
    const friend = db.prepare('SELECT * FROM friends WHERE tenant_id = ? AND line_user_id = ?').get(tenant.id, lineUserId);

    // 確認メッセージ（既定文 or カスタム。{name}/{date}/{time}/{menu} を差し込み）
    const fb = reminders.formatBase(date, time);
    const menu = b.menu ? String(b.menu).slice(0, 100) : '';
    const nameStr = (friend && friend.display_name) || (b.name ? String(b.name).slice(0, 100) : '');
    let text = b.message ? String(b.message).slice(0, 2000)
      : `{name}さん、ご予約を承りました✅\n\n📅 {date} {time}〜${menu ? `\n📋 ${menu}` : ''}\n\n前日にもこのLINEでリマインドをお送りします。\nご変更・キャンセルの際は、このLINEにご連絡ください。`;
    if (!nameStr) text = text.replace(/\{name\}さん/g, 'お客さま'); // 名前不明時は「お客さまさん」にならないように
    text = text.replace(/\{name\}/g, nameStr || 'お客さま').replace(/\{date\}/g, fb.date).replace(/\{time\}/g, fb.time).replace(/\{menu\}/g, menu);

    // LINE送信
    let sent = false; let sendError = null;
    try {
      const settings = tenantmod.resolveSettings(tenant);
      if (!settings.line.channelAccessToken) sendError = 'LINEアクセストークンが未設定です';
      else {
        const r = await require('./line').pushMessage(settings.line.channelAccessToken, lineUserId, text);
        sent = !!(r && r.ok);
        if (sent) { try { inbox.saveMessage(db, { tenantId: tenant.id, lineUserId, direction: 'out', text }); } catch { /* 受信箱記録は補助 */ } }
        else sendError = (r && (r.response || r.reason)) || 'LINE送信に失敗しました（友だち追加済みかご確認ください）';
      }
    } catch (e) { sendError = String((e && e.message) || e); }

    // 前日リマインドの自動登録（リマインダ機能が使えるプランのみ）
    let reminder = 'skipped';
    if (billing.planLimits(tenant).reminders) {
      const camp = reminders.ensureQuickCampaign(db, tenant.id);
      const en = reminders.enroll(db, tenant.id, camp.id, lineUserId, date, time || null);
      reminder = en.ok ? 'enrolled' : (en.error || 'error');
    } else reminder = 'plan_not_supported';

    logger.info('booking hook', { tenant_id: tenant.id, sent, reminder, date, time: time || null });
    res.json({ ok: true, sent, send_error: sendError, reminder });
  });

  app.post('/hooks/:token/booking/cancel', limiter, express.json({ type: () => true, limit: '16kb' }), async (req, res) => {
    const tenant = bookingHookTenant(req, res);
    if (!tenant) return;
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    b = b || {};
    const lineUserId = String((b && b.line_user_id) || '').trim();
    if (!lineUserId) return res.status(400).json({ ok: false, error: 'line_user_id は必須です' });
    // 自動リマインドキャンペーンの登録だけを停止（他のリマインダには触れない）
    const camp = db.prepare('SELECT id FROM reminder_campaigns WHERE tenant_id = ? AND name = ?').get(tenant.id, reminders.QUICK_CAMPAIGN_NAME);
    let stopped = 0;
    if (camp) {
      stopped = db.prepare("UPDATE reminder_enrollments SET status='stopped' WHERE tenant_id = ? AND campaign_id = ? AND line_user_id = ? AND status = 'active'")
        .run(tenant.id, camp.id, lineUserId).changes;
    }
    logger.info('booking hook cancel', { tenant_id: tenant.id, stopped });
    res.json({ ok: true, stopped });
  });

  // 回答フォーム公開ページ：/f/:formId（?u=署名付きトークンで友だち自動特定）
  app.get('/f/:formId', limiter, (req, res) => {
    const f = db.prepare('SELECT * FROM forms WHERE id = ? AND active = 1').get(req.params.formId);
    if (!f) return res.status(404).send('フォームが見つかりません');
    const tenant = db.prepare('SELECT name FROM tenants WHERE id = ?').get(f.tenant_id);
    const form = { ...f, fields: JSON.parse(f.fields_json || '[]') };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(forms.renderPublicPage(form, tenant && tenant.name));
  });
  app.post('/f/:formId', limiter, express.urlencoded({ extended: false, limit: '64kb' }), (req, res) => {
    const f = db.prepare('SELECT * FROM forms WHERE id = ? AND active = 1').get(req.params.formId);
    if (!f) return res.status(404).send('フォームが見つかりません');
    const form = { ...f, fields: JSON.parse(f.fields_json || '[]') };
    try {
      forms.submitAnswer(db, form, req.body || {}, req.query.u || null);
    } catch (e) {
      return res.status(e.statusCode || 400).send(escapeHtml(String((e && e.message) || '入力内容を確認してください')));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(forms.renderDonePage(form));
  });

  // 配信内リンクのタップ計測：/r/:urlId（?u=署名付きトークンで友だち別クリックを記録）
  app.get('/r/:urlId', limiter, (req, res) => {
    const dest = trackurl.recordClick(db, req.params.urlId, req.query.u || null);
    if (!dest) return res.status(404).send('リンクが見つかりません');
    res.redirect(302, dest);
  });

  // 画像配信（配信・カルーセル用にアップロードした画像。LINEがhttpsで取得する）
  app.get('/img/:id', (req, res) => {
    const img = db.prepare('SELECT mime, data FROM images WHERE id = ?').get(req.params.id);
    if (!img) return res.status(404).end();
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(img.data);
  });

  // =====================================================================
  // 計測フロー（テナント別）
  // =====================================================================

  // 1) クリック計測 + リダイレクト
  app.get('/c/:linkId', limiter, (req, res) => {
    const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.linkId);
    if (!link) return res.status(404).send('リンクが見つかりません');
    const tenant = link.tenant_id ? db.prepare('SELECT * FROM tenants WHERE id = ?').get(link.tenant_id) : null;

    // 計測停止中（未契約/停止）の院でも、友だち追加の導線は壊さずリダイレクトだけ行う
    if (tenant && billing.isMeasurementActive(db, tenant)) {
      const q = req.query || {};
      const clickId = newId('clk');
      db.prepare(
        `INSERT INTO clicks (id, tenant_id, link_id, fp, ip, ua, fbclid, gclid, ttclid,
            utm_source, utm_medium, utm_campaign, utm_content, params_json, matched, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).run(
        clickId, link.tenant_id, link.id, getIp(req), req.headers['user-agent'] || null,
        q.fbclid || null, q.gclid || null, q.ttclid || null,
        q.utm_source || null, q.utm_medium || null, q.utm_campaign || null, q.utm_content || null,
        JSON.stringify(q), Date.now()
      );
      res.cookie('keiro_cid', clickId, { maxAge: config.matchWindowSec * 1000, httpOnly: false, sameSite: 'lax' });
    }
    return res.redirect(302, link.oa_add_url);
  });

  // =====================================================================
  // UnivaPay Webhook（サブスク状態の同期）
  // 署名検証(HMAC-SHA256)には生ボディが必須のため、express.json()より前・raw()で受ける。
  // ※ 固定パス '/webhook/univapay' は、下の '/webhook/:token'（ワイルドカード）より
  //   必ず前に登録すること。Expressはルートを登録順にマッチするため、逆順だと
  //   'univapay' が :token として解釈され、この専用ハンドラに一切到達できなくなる
  //   （tenants.webhook_token='univapay' は存在しないため常に404）。
  // 以下の冪等性・常時ログ・未特定時アラートは、Threads Studio（同社の稼働中プロダクト）の
  // 本番運用実績に基づく設計を移植したもの（UnivaPayの実イベント構造・再送挙動は
  // 環境により差があるため、事前に決め打ちせず生ログと防御的な運用で吸収する）。
  // =====================================================================
  const univapayWebhookSeen = []; // 冪等性: 同一ボディの再送（UnivaPayのリトライ）を一定時間は無視
  const UNIVAPAY_WEBHOOK_DEDUP_MS = 10 * 60 * 1000;
  const UNIVAPAY_WEBHOOK_DEDUP_MAX = 500;

  // Threads Studio方式: サブスクは固定の決済リンク（プランごとに手動作成）から作られるため、
  // Webhookペイロードにこちら発行のsubscription_idは事前に存在しない。
  // そこで「メールアドレス」でテナントを、「金額」でプラン(light/pro)を特定する。
  function findEmailInPayload(o, depth) {
    depth = depth || 0;
    if (o == null || depth > 6) return null;
    if (typeof o === 'string') {
      const m = o.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      return m ? m[0] : null;
    }
    if (typeof o !== 'object') return null;
    for (const k of Object.keys(o)) {
      if (/email/i.test(k) && typeof o[k] === 'string' && o[k].includes('@')) return o[k];
    }
    for (const k of Object.keys(o)) {
      const r = findEmailInPayload(o[k], depth + 1);
      if (r) return r;
    }
    return null;
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function planKeyForAmount(amount) {
    if (amount == null) return null;
    if (amount === config.planAmounts.pro) return 'pro';
    if (amount === config.planAmounts.light) return 'light';
    return null;
  }

  app.post('/webhook/univapay', express.raw({ type: '*/*' }), (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    if (!univapay.verifyWebhook(rawBody, req.headers)) return res.status(401).send('invalid');
    let body;
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch (e) {
      logger.warn('univapay webhook: invalid JSON body', { err: String((e && e.message) || e), preview: rawBody.slice(0, 200) });
      return res.status(400).send('invalid json');
    }
    // 実イベント構造の調査用に必ず生ログを残す（本番投入後、ここで実構造を確認する）
    logger.info('univapay webhook received', { preview: JSON.stringify(body).slice(0, 2000) });

    // 冪等性チェック（UnivaPayが同じ通知を再送しても二重処理しない）
    const now = Date.now();
    const bodyHash = sha256hex(rawBody);
    while (univapayWebhookSeen.length && now - univapayWebhookSeen[0].ts > UNIVAPAY_WEBHOOK_DEDUP_MS) univapayWebhookSeen.shift();
    if (univapayWebhookSeen.some((s) => s.h === bodyHash)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    univapayWebhookSeen.push({ h: bodyHash, ts: now });
    if (univapayWebhookSeen.length > UNIVAPAY_WEBHOOK_DEDUP_MAX) univapayWebhookSeen.shift();

    const data = body.data || body;
    try {
      const eventType = String(body.event || body.type || body.event_type || data.event || '').toLowerCase();
      const status = String(data.status || body.status || '').toLowerCase();
      const blob = `${eventType} ${status}`;
      const email = findEmailInPayload(body);
      const univapaySubId = data.subscription_id || (data.subscription && data.subscription.id) || data.id || body.id || null;

      const subscriptionAmount = toNum(data.subscription && data.subscription.amount)
        ?? (/subscription/.test(eventType) ? toNum(data.amount) : null);
      const chargeAmount = toNum(data.charge && data.charge.amount)
        ?? (/charge/.test(eventType) ? toNum(data.amount) : null);
      const anyAmount = toNum(data.amount) ?? toNum(body.amount);
      const planAmount = subscriptionAmount ?? chargeAmount ?? anyAmount;
      const matchedPlanKey = planKeyForAmount(planAmount);

      const isCanceled = /(cancel|suspend|refund)/.test(blob);
      const isFailed = !isCanceled && /(fail|error|declined|past_due|unpaid|chargeback)/.test(blob);
      const isPaidCharge = !isCanceled && !isFailed
        && /charge|payment/.test(eventType)
        && /(finish|success|paid|completed|captured|authorized|current)/.test(blob)
        && (chargeAmount ?? 0) > 0;
      const isSubscriptionStart = !isCanceled && !isFailed && !isPaidCharge;

      if (!email) {
        logger.warn('univapay webhook: email not found in payload', { type: eventType, keys: Object.keys(data || {}) });
        mailer.sendMail({
          to: config.operator.email,
          subject: '[Keiro] UnivaPay Webhook: メールアドレス特定不可',
          text: `type=${eventType}\n生データ: ${JSON.stringify(body).slice(0, 1500)}`,
        }).catch(() => {});
        return res.status(200).json({ received: true, note: 'email not found' });
      }

      // マルチ店舗: 同一メールの店舗が複数ある場合の振り分け。
      // ①UnivaPayのsubscription_idが既にどこかの店舗に紐づいていればその店舗（継続課金）
      // ②未紐づけなら「アクティブな契約を持たない店舗」（=支払い待ちの新店舗）を優先
      // ③それも無ければ最古の店舗
      const candidates = db.prepare("SELECT * FROM tenants WHERE email = ? AND role = 'tenant' ORDER BY created_at").all(email.toLowerCase());
      let tenant = candidates[0] || null;
      if (candidates.length > 1) {
        let linked = null;
        if (univapaySubId) {
          linked = candidates.find((t) => {
            const s = billing.latestSubscription(db, t.id);
            return s && s.univapay_subscription_id === univapaySubId;
          });
        }
        const waiting = candidates.find((t) => {
          const s = billing.latestSubscription(db, t.id);
          return !s || s.status !== 'active';
        });
        tenant = linked || waiting || candidates[0];
        logger.info('univapay webhook: multi-store resolved', { email, stores: candidates.length, resolved: tenant.id, via: linked ? 'sub_id' : (waiting ? 'waiting' : 'oldest') });
      }
      if (!tenant) {
        logger.warn('univapay webhook: no tenant for email', { email, type: eventType });
        mailer.sendMail({
          to: config.operator.email,
          subject: '[Keiro] UnivaPay Webhook: 未登録メールアドレスでの決済',
          text: `email=${email}\ntype=${eventType}\n生データ: ${JSON.stringify(body).slice(0, 1500)}`,
        }).catch(() => {});
        return res.status(200).json({ received: true, note: 'tenant not found for email' });
      }

      const existing = billing.latestSubscription(db, tenant.id);

      if (isCanceled) {
        billing.upsertSubscription(db, { tenantId: tenant.id, univapaySubId: univapaySubId || (existing && existing.univapay_subscription_id), status: 'canceled' });
        billing.syncTenantStatus(db, tenant.id);
        logger.info('univapay webhook: canceled', { tenant_id: tenant.id, type: eventType });
      } else if (isFailed) {
        billing.upsertSubscription(db, { tenantId: tenant.id, univapaySubId: univapaySubId || (existing && existing.univapay_subscription_id), status: 'past_due' });
        billing.syncTenantStatus(db, tenant.id);
        logger.warn('univapay webhook: payment failed', { tenant_id: tenant.id, type: eventType });
        mailer.sendMail({
          to: config.operator.email,
          subject: '[Keiro] 決済失敗',
          text: `テナント: ${tenant.email}（${tenant.name || ''}）\ntype=${eventType}\n生データ: ${JSON.stringify(body).slice(0, 1500)}`,
        }).catch(() => {});
      } else if (isPaidCharge) {
        const planKey = matchedPlanKey || (tenant.plan === 'light' ? 'light' : 'pro');
        if (!matchedPlanKey) {
          logger.warn('univapay webhook: charge amount did not match a known plan', { tenant_id: tenant.id, amount: planAmount });
        }
        const plan = billing.ensureDefaultPlan(db);
        if (tenant.plan !== planKey) {
          db.prepare('UPDATE tenants SET plan = ?, updated_at = ? WHERE id = ?').run(planKey, Date.now(), tenant.id);
        }
        const sub = billing.upsertSubscription(db, { tenantId: tenant.id, planId: plan.id, univapaySubId: univapaySubId || (existing && existing.univapay_subscription_id), status: 'active' });
        billing.recordPayment(db, { tenantId: tenant.id, subscriptionId: sub.id, chargeId: (data.charge && data.charge.id) || data.charge_id || null, amount: chargeAmount, status: eventType, raw: body });
        billing.syncTenantStatus(db, tenant.id);
        logger.info('univapay webhook: paid', { tenant_id: tenant.id, plan: planKey, amount: chargeAmount });
      } else if (isSubscriptionStart) {
        if (univapaySubId) billing.upsertSubscription(db, { tenantId: tenant.id, univapaySubId, status: 'trialing' });
        logger.info('univapay webhook: subscription registered', { tenant_id: tenant.id, type: eventType });
      }
    } catch (e) { logger.error('univapay webhook error', { err: String((e && e.message) || e) }); }
    res.status(200).end();
  });

  // 2) LINE Webhook（院ごとの専用URL・raw bodyで署名検証）
  app.post('/webhook/:token', limiter, express.raw({ type: '*/*' }), (req, res) => {
    const tenant = db.prepare('SELECT * FROM tenants WHERE webhook_token = ?').get(req.params.token);
    if (!tenant) return res.status(404).send('not found');
    const settings = tenantmod.resolveSettings(tenant);

    const signature = req.headers['x-line-signature'];
    const raw = req.body;
    if (!verifyLineSignature(settings.line.channelSecret, raw, signature)) {
      return res.status(401).send('invalid signature');
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw); }
    catch { return res.status(400).send('bad request'); }

    // 連携ウィザードの「Webhook受信確認」用（検証ボタンの空イベントでも記録）
    try { db.prepare('UPDATE tenants SET webhook_last_at = ? WHERE id = ?').run(Date.now(), tenant.id); } catch (e) { /* noop */ }

    const active = billing.isMeasurementActive(db, tenant);
    const accessToken = settings.line.channelAccessToken;
    const events = (parsed && parsed.events) || [];
    const pendingReplies = [];     // 友だち追加の挨拶（claimリンク）
    const pendingAutoReplies = []; // キーワード自動応答
    const newFollowUserIds = [];   // プロフィール取得対象
    const pendingIdentify = [];    // 自己申告フロー（follow時・push）
    const pendingRich = [];        // 会話ボット リッチ返信（ボタン/カルーセル/多段分岐・reply）
    for (const ev of events) {
      const lineUserId = ev.source && ev.source.userId;

      // postback（クイックリプライのタップ）→ 自己申告：タグ付与＋対応ステップ配信へ登録
      if (ev.type === 'postback' && lineUserId && ev.postback && ev.postback.data) {
        try {
          const out = identify.handlePostback(db, tenant, lineUserId, ev.postback.data);
          friends.addScore(db, tenant.id, lineUserId, 2);
          richmenu.applyMenuForUser(db, tenant, lineUserId).catch(() => {});
          if (out && ev.replyToken) {
            const msgs = [];
            if (out.replyText) msgs.push({ type: 'text', text: out.replyText });
            if (out.nextFlowId) {
              const nf = identify.getFlow(db, tenant.id, out.nextFlowId); // 多段分岐：次のフローを送る
              if (nf) msgs.push(...identify.buildFlowMessages(nf));
            }
            if (msgs.length) pendingRich.push({ replyToken: ev.replyToken, messages: msgs.slice(0, 5) });
          }
        } catch (e) { logger.error('identify postback error', { err: String((e && e.message) || e) }); }
        continue;
      }

      // ブロック/友だち解除 → ステップ配信停止＋friend.blocked
      if (ev.type === 'unfollow' && lineUserId) {
        try { steps.stopEnrollments(db, tenant.id, lineUserId); friends.markBlocked(db, tenant.id, lineUserId); reminders.stopAllForUser(db, tenant.id, lineUserId); }
        catch (e) { logger.error('unfollow handling error', { err: String((e && e.message) || e) }); }
        continue;
      }

      // テキスト受信 → 受信箱へ保存（1:1チャット履歴）→ キーワード自動応答
      if (ev.type === 'message' && ev.message && ev.message.type === 'text' && ev.replyToken) {
        try {
          inbox.saveMessage(db, { tenantId: tenant.id, lineUserId, direction: 'in', text: ev.message.text });
          friends.addScore(db, tenant.id, lineUserId, 1);
        } catch (e) { logger.error('inbox save error', { err: String((e && e.message) || e) }); }
        // リッチメニュー（メッセージ送信型ボタン）のタップ計測: 稼働中メニューのボタン文言と完全一致した受信をカウント
        try {
          const activeMenus = db.prepare("SELECT id, config_json FROM rich_menus WHERE tenant_id=? AND status='active'").all(tenant.id);
          for (const m of activeMenus) {
            const cells = (JSON.parse(m.config_json || '{}').cells || []);
            const hit = cells.find((c) => c && c.action_type === 'message' && String(c.action_value || '').trim() === ev.message.text.trim());
            if (hit) {
              db.prepare('INSERT INTO richmenu_taps (id, tenant_id, menu_id, cell_label, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(newId('rmt'), tenant.id, m.id, String(hit.label || hit.action_value).slice(0, 40), Date.now());
              break;
            }
          }
        } catch (e) { logger.error('richmenu tap count error', { err: String((e && e.message) || e) }); }
        // 新着通知: 直近30分に通知していなければ院へメール（見逃し防止・連続受信はまとめる）
        try {
          const NOTICE_GAP_MS = 30 * 60 * 1000;
          if (!tenant.inbox_notice_at || Date.now() - tenant.inbox_notice_at > NOTICE_GAP_MS) {
            db.prepare('UPDATE tenants SET inbox_notice_at = ? WHERE id = ?').run(Date.now(), tenant.id);
            tenant.inbox_notice_at = Date.now(); // 同一Webhook内の連続イベントで二重送信しない
            const fr = db.prepare('SELECT display_name FROM friends WHERE tenant_id=? AND line_user_id=?').get(tenant.id, lineUserId);
            mailer.sendMail({
              to: tenant.email,
              subject: '[Keiro] お客さまからLINEメッセージが届いています',
              text: `${tenant.name || ''} 様\n\nお客さまからメッセージが届きました。\n\n${(fr && fr.display_name) ? fr.display_name + 'さん' : 'お客さま'}:\n「${String(ev.message.text).slice(0, 200)}」\n\nKeiroの「受信箱」から返信できます（キーワード自動応答が返信済みの場合もあります）。\n${config.baseUrl}/app\n\n※このお知らせは30分に1回までにまとめてお送りしています。`,
            }).catch((e2) => logger.error('inbox notice mail error', { err: String((e2 && e2.message) || e2) }));
          }
        } catch (e) { logger.error('inbox notice error', { err: String((e && e.message) || e) }); }
        try {
          const msgs = [];
          // キーワードで起動する会話ボット（ボタン/カルーセル）を優先。無ければ通常の自動応答。
          const kwFlow = identify.getKeywordFlow(db, tenant.id, ev.message.text);
          if (kwFlow) {
            msgs.push(...identify.buildFlowMessages(kwFlow));
          } else {
            const reply = autoreply.findReply(db, tenant.id, ev.message.text, lineUserId);
            if (reply) msgs.push({ type: 'text', text: reply });
          }
          // 見逃し救済: 自己申告が未回答の友だちには、返信に質問を再掲（24h間隔・上限あり・トークに残るボタン形式）
          if (lineUserId) {
            const reask = identify.getReaskFlow(db, tenant, lineUserId);
            if (reask) {
              msgs.push(...identify.buildReaskMessages(reask));
              identify.markAsked(db, tenant.id, lineUserId);
            }
          }
          if (msgs.length) pendingRich.push({ replyToken: ev.replyToken, messages: msgs.slice(0, 5) });
        } catch (e) { logger.error('autoreply error', { err: String((e && e.message) || e) }); }
        continue;
      }

      if (ev.type !== 'follow' || !lineUserId) continue;
      if (!active) continue; // 計測停止中はfollow記録しない

      const followId = newId('flw');
      db.prepare(
        `INSERT INTO follows (id, tenant_id, line_user_id, fp, click_id, match_method, status, created_at, matched_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, 'pending', ?, NULL)`
      ).run(followId, tenant.id, lineUserId, Date.now());
      logger.info('follow received', { tenant_id: tenant.id, follow_id: followId });

      // 友だち登録（CRM）＋全員向けステップ配信に登録
      try { friends.upsertFollow(db, { tenantId: tenant.id, lineUserId }); } catch (e) { logger.error('friend upsert error', { err: String((e && e.message) || e) }); }
      try { steps.enrollFriend(db, { tenantId: tenant.id, lineUserId, media: null }); } catch (e) { logger.error('step enroll error', { err: String((e && e.message) || e) }); }
      newFollowUserIds.push(lineUserId);

      // 自己申告フロー（新規/通院中の分岐）が有効なら、あいさつに続けて質問を送る
      try {
        const flow = identify.getActiveFollowFlow(db, tenant.id);
        if (flow) {
          pendingIdentify.push({ userId: lineUserId, flow });
          identify.markAsked(db, tenant.id, lineUserId); // 質問回数を記録（見逃し救済の起点）
        }
      } catch (e) { logger.error('identify flow lookup error', { err: String((e && e.message) || e) }); }

      const token = signToken(config.secret, { fid: followId, uid: lineUserId, iat: Date.now() });
      const claimUrl = `${config.baseUrl}/claim?t=${encodeURIComponent(token)}`;
      if (ev.replyToken) pendingReplies.push({ replyToken: ev.replyToken, claimUrl, followId });
    }

    res.status(200).end();

    // レスポンス後に外部API（返信・プロフィール取得）を実行
    for (const r of pendingReplies) {
      replyGreeting(accessToken, r.replyToken, r.claimUrl).then((rr) => {
        if (rr && !rr.ok && !rr.skipped) logger.warn('line reply failed', { follow_id: r.followId, http_status: rr.http_status });
      }).catch((e) => logger.error('line reply error', { err: String((e && e.message) || e) }));
    }
    for (const r of pendingAutoReplies) {
      replyText(accessToken, r.replyToken, r.text).catch((e) => logger.error('autoreply send error', { err: String((e && e.message) || e) }));
    }
    for (const r of pendingRich) {
      replyMessages(accessToken, r.replyToken, r.messages).catch((e) => logger.error('rich reply send error', { err: String((e && e.message) || e) }));
    }
    for (const r of pendingIdentify) {
      pushMessages(accessToken, r.userId, identify.buildFlowMessages(r.flow))
        .catch((e) => logger.error('identify send error', { err: String((e && e.message) || e) }));
    }
    for (const uid of newFollowUserIds) {
      lineProfile(accessToken, uid).then((p) => {
        if (p && p.displayName) db.prepare('UPDATE friends SET display_name=? WHERE tenant_id=? AND line_user_id=?').run(p.displayName, tenant.id, uid);
      }).catch(() => {});
    }
  });

  // 3) claim 紐づけ + 完了画面
  app.get('/claim', limiter, async (req, res) => {
    const payload = verifyToken(config.secret, req.query.t, CLAIM_TOKEN_MAX_AGE_SEC);
    if (!payload || !payload.fid) return res.status(400).send(renderClaimPage({ ok: false, message: '無効なリンクです。' }));
    const follow = db.prepare('SELECT * FROM follows WHERE id = ?').get(payload.fid);
    if (!follow) return res.status(404).send(renderClaimPage({ ok: false, message: '対象が見つかりません。' }));
    if (follow.status === 'matched') return res.send(renderClaimPage({ ok: true, message: '登録は完了しています。' }));

    const tenant = follow.tenant_id ? db.prepare('SELECT * FROM tenants WHERE id = ?').get(follow.tenant_id) : null;
    const settings = tenant ? tenantmod.resolveSettings(tenant) : null;
    const ip = getIp(req);
    const ua = req.headers['user-agent'] || null;
    const cookieClickId = (req.cookies && req.cookies.keiro_cid) || null;

    const result = applyMatch(db, follow, {
      tenantId: follow.tenant_id,
      cookieClickId, ip,
      nowMs: Date.now(),
      windowSec: settings ? settings.matchWindowSec : config.matchWindowSec,
    });

    if (result.matched) {
      const click = db.prepare('SELECT * FROM clicks WHERE id = ?').get(result.clickId);
      const link = click ? db.prepare('SELECT * FROM links WHERE id = ?').get(click.link_id) : null;
      try {
        await dispatchPostbacks(db, { tenant, settings, follow, click, link, ip, ua, eventSourceUrl: `${config.baseUrl}/claim` });
      } catch (e) { logger.error('claim postback error', { follow_id: follow.id, err: String((e && e.message) || e) }); }
      // 友だちの流入経路を記録（CRM/セグメント用）＋スコア加点（広告経由の特定）
      try { friends.addScore(db, follow.tenant_id, follow.line_user_id, 3); } catch (e) { /* noop */ }
      try { friends.setSource(db, { tenantId: follow.tenant_id, lineUserId: follow.line_user_id, media: link && link.media, linkId: link && link.id }); }
      catch (e) { logger.error('friend setSource error', { err: String((e && e.message) || e) }); }
      // 流入経路（媒体）別のステップ配信に追加登録
      if (link && link.media) {
        try { steps.enrollFriend(db, { tenantId: follow.tenant_id, lineUserId: follow.line_user_id, media: link.media }); }
        catch (e) { logger.error('step enroll (media) error', { err: String((e && e.message) || e) }); }
      }
      logger.info('claim matched', { tenant_id: follow.tenant_id, follow_id: follow.id, method: result.method });
    }
    return res.send(renderClaimPage({ ok: true, message: '登録が完了しました。ありがとうございます！' }));
  });

  // =====================================================================
  // 認証
  // =====================================================================
  const auth = express.Router();
  auth.use(express.json());

  auth.post('/signup', authLimiter, (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !password || String(password).length < 8) {
      return res.status(400).json({ error: 'メールアドレスと8文字以上のパスワードが必要です' });
    }
    const t = tenantmod.createTenant(db, { email, password, name });
    if (!t) return res.status(409).json({ error: 'このメールアドレスは既に登録されています' });
    // 登録時パスコード（任意）: LINE構築客はここで30日プロを即適用
    let code_applied = false, code_error = null;
    const code = String((req.body || {}).code || '').trim();
    if (code) {
      const r = codes.redeemCode(db, t, code);
      if (r.ok) { code_applied = true; logger.info('signup code applied', { tenant_id: t.id, trial_days: r.trialDays }); }
      else code_error = r.error;
    }
    db.prepare('UPDATE tenants SET last_login_at = ? WHERE id = ?').run(Date.now(), t.id);
    authmod.setSessionCookie(res, authmod.signJwt({ sub: t.id, role: t.role }));
    logger.info('tenant signup', { tenant_id: t.id, code_applied });
    res.status(201).json({ ok: true, code_applied, code_error });
  });

  auth.post('/login', authLimiter, (req, res) => {
    const { email, password } = req.body || {};
    // マルチ店舗: 同一メールの店舗が複数ある場合は最初に作った店舗（本店）でログイン
    const cands = db.prepare('SELECT * FROM tenants WHERE email = ? ORDER BY created_at').all(String(email || '').toLowerCase());
    const t = cands.find((c) => authmod.verifyPassword(password || '', c.password_hash));
    if (!t) {
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います' });
    }
    db.prepare('UPDATE tenants SET last_login_at = ? WHERE id = ?').run(Date.now(), t.id);
    authmod.setSessionCookie(res, authmod.signJwt({ sub: t.id, role: t.role }));
    res.json({ ok: true, role: t.role, stores: cands.length });
  });

  auth.post('/logout', (req, res) => { authmod.clearSessionCookie(res); res.json({ ok: true }); });

  // パスワードを忘れた場合（メールで再設定リンク送信）。ユーザー列挙防止のため常に200。
  auth.post('/forgot', authLimiter, (req, res) => {
    const email = String((req.body || {}).email || '').toLowerCase().trim();
    res.json({ ok: true }); // 先に応答（存在有無を漏らさない）
    if (!email) return;
    const t = db.prepare('SELECT * FROM tenants WHERE email = ?').get(email);
    if (!t) { logger.info('pwreset forgot: unknown email', {}); return; }
    const url = pwreset.makeResetUrl(t);
    mailer.sendMail({
      to: t.email,
      subject: '[Keiro] パスワード再設定のご案内',
      text: `Keiroをご利用いただきありがとうございます。\n\n以下のリンクから新しいパスワードを設定してください（有効期限：72時間）。\n${url}\n\n※このメールに心当たりがない場合は破棄してください。パスワードは変更されません。`,
    }).then((r) => {
      if (r && r.skipped) {
        // メール未設定環境では運営に通知（手動でリンクをお渡しできるように）
        logger.warn('pwreset mail skipped (RESEND未設定)', { tenant_id: t.id });
      }
    }).catch((e) => logger.error('pwreset mail error', { err: String((e && e.message) || e) }));
  });

  // 再設定リンクからの新パスワード設定
  auth.post('/reset', authLimiter, (req, res) => {
    const { token, password } = req.body || {};
    const t = pwreset.verifyResetToken(db, token);
    if (!t) return res.status(400).json({ error: 'リンクが無効か、期限切れです。もう一度発行してください。' });
    const r = pwreset.applyNewPassword(db, t.id, password);
    if (!r.ok) return res.status(400).json({ error: r.error });
    tenantmod.syncPasswordHashFrom(db, t.id); // マルチ店舗: 同一メールの全店舗に同期
    logger.info('password reset done', { tenant_id: t.id });
    authmod.setSessionCookie(res, authmod.signJwt({ sub: t.id, role: t.role })); // そのままログイン状態に
    res.json({ ok: true, role: t.role });
  });

  app.use('/auth', auth);

  // =====================================================================
  // テナントAPI（ログイン必須）
  // =====================================================================
  const api = express.Router();
  api.use(express.json({ limit: '8mb' })); // リッチメニュー画像(base64)を許容
  api.use(requireAuth);

  api.get('/me', (req, res) => {
    const st = billing.subscriptionState(db, req.tenant);
    const pi = billing.planInfo(req.tenant);
    res.json({
      id: req.tenant.id, email: req.tenant.email, name: req.tenant.name, role: req.tenant.role,
      plan: pi.key, plan_name: pi.name,
      limits: billing.planLimits(req.tenant),
      billing: { status: st.status, active: st.active, in_trial: st.inTrial, trial_ends_at: st.trialEndsAt },
    });
  });

  api.get('/settings', (req, res) => {
    res.json(Object.assign(tenantmod.publicSettings(req.tenant), {
      webhook_url: `${config.baseUrl}/webhook/${req.tenant.webhook_token}`,
      booking_hook_url: `${config.baseUrl}/hooks/${req.tenant.webhook_token}/booking`,
    }));
  });

  api.put('/settings', (req, res) => {
    tenantmod.updateTenantSettings(db, req.tenant.id, req.body || {});
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenant.id);
    res.json(Object.assign(tenantmod.publicSettings(t), {
      webhook_url: `${config.baseUrl}/webhook/${t.webhook_token}`,
      booking_hook_url: `${config.baseUrl}/hooks/${t.webhook_token}/booking`,
    }));
  });

  api.get('/links', (req, res) => {
    const rows = db.prepare(
      `SELECT l.*,
        (SELECT COUNT(*) FROM clicks c WHERE c.link_id = l.id) AS clicks,
        (SELECT COUNT(*) FROM follows f JOIN clicks c2 ON f.click_id = c2.id WHERE c2.link_id = l.id AND f.status='matched') AS follows
       FROM links l WHERE l.tenant_id = ? ORDER BY l.created_at DESC`
    ).all(req.tenant.id);
    res.json(rows.map((r) => ({ ...r, track_url: `${config.baseUrl}/c/${r.id}`, cvr: r.clicks ? r.follows / r.clicks : 0 })));
  });

  api.post('/links', (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.oa_add_url) return res.status(400).json({ error: 'name と oa_add_url は必須です' });
    const limits = billing.planLimits(req.tenant);
    if (limits.maxLinks != null) {
      const n = db.prepare('SELECT COUNT(*) n FROM links WHERE tenant_id = ?').get(req.tenant.id).n;
      if (n >= limits.maxLinks) return res.status(403).json({ error: `ライトプランで作成できる計測リンクは${limits.maxLinks}本までです。プロプランへの変更をご検討ください。` });
    }
    const id = newId('lnk');
    db.prepare(
      `INSERT INTO links (id, tenant_id, name, oa_add_url, media, campaign, creative, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.tenant.id, String(b.name), String(b.oa_add_url),
      b.media ? String(b.media) : null, b.campaign ? String(b.campaign) : null, b.creative ? String(b.creative) : null, Date.now());
    res.status(201).json({ id, track_url: `${config.baseUrl}/c/${id}` });
  });

  // 計測リンクのQRコードPNG（チラシ・店頭POP用にその場で発行）
  api.get('/links/:id/qr.png', async (req, res) => {
    const link = db.prepare('SELECT id FROM links WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenant.id);
    if (!link) return res.status(404).json({ error: 'not found' });
    const size = Math.min(2000, Math.max(128, parseInt(req.query.size, 10) || 600));
    try {
      const buf = await require('qrcode').toBuffer(`${config.baseUrl}/c/${link.id}`, { width: size, margin: 2 });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `inline; filename="keiro-qr-${link.id}.png"`);
      res.send(buf);
    } catch (e) {
      logger.error('qr generate error', { err: String((e && e.message) || e) });
      res.status(500).json({ error: 'QRコードの生成に失敗しました' });
    }
  });

  api.delete('/links/:id', (req, res) => {
    const link = db.prepare('SELECT * FROM links WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenant.id);
    if (!link) return res.status(404).json({ error: 'not found' });
    try { res.json(deleteLinkCascade(db, req.params.id)); }
    catch (e) { logger.error('link delete failed', { err: String((e && e.message) || e) }); res.status(500).json({ error: '削除に失敗しました' }); }
  });

  api.get('/stats', (req, res) => {
    const tid = req.tenant.id;
    const one = (sql, ...a) => db.prepare(sql).get(tid, ...a).n;
    const clicks = one('SELECT COUNT(*) n FROM clicks WHERE tenant_id = ?');
    const follows = one('SELECT COUNT(*) n FROM follows WHERE tenant_id = ?');
    const matched = one("SELECT COUNT(*) n FROM follows WHERE tenant_id = ? AND status='matched'");
    const pbOk = one('SELECT COUNT(*) n FROM postbacks WHERE tenant_id = ? AND ok = 1');
    const pbTotal = one('SELECT COUNT(*) n FROM postbacks WHERE tenant_id = ?');
    res.json({ clicks, follows, matched, match_rate: follows ? matched / follows : 0, postbacks_ok: pbOk, postbacks_total: pbTotal });
  });

  // LINE配信数の当月使用量と上限（無料プランは月200通）
  api.get('/line/quota', async (req, res) => {
    const settings = tenantmod.resolveSettings(req.tenant);
    const quota = await require('./line').getMessageQuota(settings.line.channelAccessToken);
    if (!quota) return res.json({ available: false });
    res.json({ available: true, used: quota.used, limit: quota.limit, remaining: quota.limit == null ? null : Math.max(0, quota.limit - quota.used) });
  });

  // LINE連携ウィザード用：接続状態（キー有効性＋Webhook受信）をまとめて返す
  api.get('/line/status', async (req, res) => {
    const settings = tenantmod.resolveSettings(req.tenant);
    const secretSet = !!settings.line.channelSecret;
    const tokenSet = !!settings.line.channelAccessToken;
    let tokenValid = false, botName = null, err = null;
    if (tokenSet) {
      const info = await getBotInfo(settings.line.channelAccessToken);
      tokenValid = !!info.ok;
      if (info.ok && info.info) botName = info.info.displayName || info.info.basicId || null;
      else err = (info.response && String(info.response).slice(0, 200)) || info.reason || `HTTP ${info.http_status}`;
    }
    const t = db.prepare('SELECT webhook_last_at FROM tenants WHERE id = ?').get(req.tenant.id);
    res.json({
      secret_set: secretSet,
      token_set: tokenSet,
      token_valid: tokenValid,
      bot_name: botName,
      error: tokenValid ? null : err,
      webhook_received: !!(t && t.webhook_last_at),
      webhook_last_at: (t && t.webhook_last_at) || null,
      webhook_url: `${config.baseUrl}/webhook/${req.tenant.webhook_token}`,
    });
  });

  api.get('/follows', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const rows = db.prepare(
      `SELECT f.id, f.line_user_id, f.status, f.match_method, f.created_at, f.matched_at, l.name AS link_name
       FROM follows f LEFT JOIN clicks c ON f.click_id = c.id LEFT JOIN links l ON c.link_id = l.id
       WHERE f.tenant_id = ? ORDER BY f.created_at DESC LIMIT ?`
    ).all(req.tenant.id, limit);
    res.json(rows.map((r) => ({ ...r, line_user_id_short: r.line_user_id ? r.line_user_id.slice(0, 8) + '…' : null, line_user_id: undefined })));
  });

  // ---- 課金（テナント） ----
  api.get('/billing/status', (req, res) => {
    const st = billing.subscriptionState(db, req.tenant);
    const pi = billing.planInfo(req.tenant);
    // 決済リンクの選択:
    //  試用中（カード先行登録）→ 繰り延べリンク: ライト14日後 / プロ＋パスコード適用(LINE構築客)30日後 / プロ通常14日後
    //  期限切れ・未契約（今すぐ課金が正しい）→ 当日課金リンク: ライト当日 / プロ当日
    let linkUrl;
    if (st.inTrial) {
      if (pi.key === 'light') linkUrl = config.univapay.linkUrlLight;
      else if (req.tenant.code_redeemed && config.univapay.linkUrlPro30) linkUrl = config.univapay.linkUrlPro30;
      else linkUrl = config.univapay.linkUrlPro;
    } else {
      linkUrl = pi.key === 'light'
        ? (config.univapay.linkUrlLightNow || config.univapay.linkUrlLight)
        : (config.univapay.linkUrlProNow || config.univapay.linkUrlPro);
    }
    // 永年無料（社内・特別付与）: 無料期間の残りが10年以上ならカード登録不要の永年扱い
    const permanent = st.inTrial && (st.trialEndsAt - Date.now()) > 3650 * 24 * 3600 * 1000;
    res.json({
      status: st.status, active: st.active, in_trial: st.inTrial, trial_ends_at: st.trialEndsAt,
      permanent,
      plan_key: pi.key,
      plan: { name: pi.name, amount: pi.amount, currency: config.univapay.currency, interval: 'month' },
      code_redeemed: !!req.tenant.code_redeemed,
      card_registered: !!billing.latestSubscription(db, req.tenant.id), // Webhook受信済み=カード登録済み
      univapay: { checkout_enabled: !!linkUrl, link_url: linkUrl || null },
    });
  });

  // ログイン中ユーザー自身のパスワード変更（現在のパスワード必須）
  api.put('/me/password', (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!authmod.verifyPassword(current_password || '', req.tenant.password_hash)) {
      return res.status(400).json({ error: '現在のパスワードが違います' });
    }
    const r = pwreset.applyNewPassword(db, req.tenant.id, new_password);
    if (!r.ok) return res.status(400).json({ error: r.error });
    tenantmod.syncPasswordHashFrom(db, req.tenant.id); // マルチ店舗: 同一メールの全店舗に同期
    logger.info('password changed', { tenant_id: req.tenant.id });
    res.json({ ok: true });
  });

  // ---- マルチ店舗（同一オーナーの店舗一覧・切替・追加） ----
  // 認可は「メール＋パスワードハッシュの一致」。2店舗目以降はログイン画面からは作れず、
  // ここ（ログイン済みセッション内）からのみ追加できる。
  const MAX_STORES_PER_OWNER = 10;

  function myStores(t) {
    return db.prepare(
      "SELECT id, name, plan, status, created_at FROM tenants WHERE email = ? AND password_hash = ? AND role = 'tenant' ORDER BY created_at"
    ).all(t.email, t.password_hash);
  }

  api.get('/my-stores', (req, res) => {
    res.json(myStores(req.tenant).map((s) => ({ ...s, current: s.id === req.tenant.id })));
  });

  api.post('/switch-store', (req, res) => {
    const targetId = String((req.body || {}).tenant_id || '');
    const target = db.prepare('SELECT * FROM tenants WHERE id = ?').get(targetId);
    // 同一オーナー（メール＋ハッシュ一致）以外への切替は404扱いで存在も漏らさない
    if (!target || target.role !== 'tenant' || target.email !== req.tenant.email || target.password_hash !== req.tenant.password_hash) {
      return res.status(404).json({ error: '店舗が見つかりません' });
    }
    db.prepare('UPDATE tenants SET last_login_at = ? WHERE id = ?').run(Date.now(), target.id);
    authmod.setSessionCookie(res, authmod.signJwt({ sub: target.id, role: target.role }));
    logger.info('store switched', { from: req.tenant.id, to: target.id });
    res.json({ ok: true, id: target.id, name: target.name });
  });

  api.post('/stores', (req, res) => {
    if (req.tenant.role !== 'tenant') return res.status(403).json({ error: '店舗アカウントからのみ追加できます' });
    const name = String((req.body || {}).name || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: '店舗名を入力してください' });
    const count = myStores(req.tenant).length;
    if (count >= MAX_STORES_PER_OWNER) return res.status(400).json({ error: `店舗数の上限（${MAX_STORES_PER_OWNER}店舗）に達しています。運営までご相談ください。` });
    const t = tenantmod.createStore(db, req.tenant, name);
    logger.info('store created', { owner: req.tenant.id, new_tenant: t.id, name });
    res.status(201).json({ ok: true, id: t.id, name: t.name });
  });

  // ---- お客さま体験プレビュー（新規のお客さまにどう見えるかをアプリ内で疑似体験） ----
  api.get('/preview/experience', (req, res) => {
    res.json(preview.buildExperience(db, req.tenant));
  });

  // キーワードを送ったらどうなるか（実際の一致ロジックで判定・送信はしない）
  api.post('/preview/reply', (req, res) => {
    const text = String((req.body || {}).text || '').trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: 'テキストを入力してください' });
    const kwFlow = identify.getKeywordFlow(db, req.tenant.id, text);
    if (kwFlow) {
      const choices = db.prepare('SELECT label, tag, reply_text FROM bot_choices WHERE flow_id = ? ORDER BY sort').all(kwFlow.id)
        .map((c) => ({ label: c.label, tag: c.tag || null, reply_text: c.reply_text ? preview.renderPreviewText(req.tenant.id, c.reply_text) : null }));
      return res.json({ type: 'bot', question: kwFlow.question_text, choices });
    }
    const reply = autoreply.findReply(db, req.tenant.id, text, 'Upreview-sample');
    if (reply) return res.json({ type: 'text', text: preview.renderPreviewText(req.tenant.id, reply) });
    res.json({ type: 'none', text: '（自動返信は設定されていません。この場合、お客さまへの返事は受信箱からの手動返信になります）' });
  });

  // ---- リッチメニュー: ボタン別タップ数（稼働中メニュー・直近30日） ----
  api.get('/richmenu/taps', (req, res) => {
    const since = Date.now() - 30 * 86400000;
    const menus = db.prepare("SELECT id, name, config_json FROM rich_menus WHERE tenant_id=? AND status='active' ORDER BY created_at DESC").all(req.tenant.id);
    res.json(menus.map((m) => {
      const cells = (JSON.parse(m.config_json || '{}').cells || []).filter((c) => c && (c.action_value || '').trim());
      return {
        id: m.id, name: m.name,
        cells: cells.map((c) => {
          let taps = 0;
          if (c.track_url_id) {
            taps = db.prepare('SELECT COUNT(*) n FROM url_clicks WHERE url_id=? AND created_at>=?').get(c.track_url_id, since).n;
          } else if (c.action_type === 'message') {
            taps = db.prepare('SELECT COUNT(*) n FROM richmenu_taps WHERE menu_id=? AND cell_label=? AND created_at>=?')
              .get(m.id, String(c.label || c.action_value).slice(0, 40), since).n;
          } else taps = null; // 計測対象外（tel:等）
          return { label: c.label || c.action_value, type: c.action_type === 'message' ? 'message' : 'uri', taps };
        }),
      };
    }));
  });

  // ---- 解約申請（アプリ内から）: サポートの対応キュー＋運営メールに乗せる ----
  api.post('/cancel-request', (req, res) => {
    const reason = String((req.body || {}).reason || '').trim().slice(0, 1000);
    db.prepare('UPDATE tenants SET cancel_requested_at = ? WHERE id = ?').run(Date.now(), req.tenant.id);
    support.saveMessage(db, {
      tenantId: req.tenant.id, sender: 'tenant', escalated: true,
      text: `【解約申請】${reason ? `理由: ${reason}` : '（理由の記載なし）'}`,
    });
    support.saveMessage(db, {
      tenantId: req.tenant.id, sender: 'system',
      text: '解約のお申し出を受け付けました。担当者から手続きのご案内をこの欄とメールにお送りします。なお、無料期間中の解約は費用が一切かかりません。',
    });
    if (config.operator.email) {
      mailer.sendMail({
        to: config.operator.email,
        subject: `[Keiro] ⚠️ 解約申請: ${req.tenant.name || req.tenant.email}`,
        text: `院: ${req.tenant.name || ''}（${req.tenant.email}）\nプラン: ${req.tenant.plan === 'light' ? 'ライト' : 'プロ'}\n理由: ${reason || '（記載なし）'}\n\n運営管理画面のサポート欄から連絡してください: ${config.baseUrl}/operator`,
      }).catch((e) => logger.error('cancel request mail error', { err: String((e && e.message) || e) }));
    }
    logger.info('cancel requested', { tenant_id: req.tenant.id });
    res.json({ ok: true });
  });

  // ---- サポートチャット（AIが回答→解決しなければ運営へ） ----
  api.get('/support', (req, res) => {
    const messages = support.listForTenant(db, req.tenant.id);
    support.markReadByTenant(db, req.tenant.id);
    res.json({ messages, ai_enabled: aisetup.enabled() });
  });

  api.post('/support', async (req, res) => {
    const text = String((req.body || {}).text || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: '質問を入力してください' });
    const q = support.saveMessage(db, { tenantId: req.tenant.id, sender: 'tenant', text });
    const out = [q];
    if (!aisetup.enabled()) {
      out.push(support.saveMessage(db, { tenantId: req.tenant.id, sender: 'system', text: 'ただいまAI回答は準備中です。「運営に問い合わせる」からご連絡いただければ、担当者がお答えします。' }));
      return res.json({ messages: out, confident: false });
    }
    if (!aiQuotaOk(req.tenant.id, 'support', 30)) {
      out.push(support.saveMessage(db, { tenantId: req.tenant.id, sender: 'system', text: '本日のAI回答の上限に達しました。お急ぎの場合は「運営に問い合わせる」からご連絡ください。' }));
      return res.json({ messages: out, confident: false });
    }
    const history = support.listForTenant(db, req.tenant.id, 10);
    const r = await aisetup.supportReply(db, req.tenant, history);
    if (r.error) {
      out.push(support.saveMessage(db, { tenantId: req.tenant.id, sender: 'system', text: r.error }));
      return res.json({ messages: out, confident: false });
    }
    out.push(support.saveMessage(db, { tenantId: req.tenant.id, sender: 'ai', text: r.answer }));
    logger.info('support ai replied', { tenant_id: req.tenant.id, confident: r.confident });
    res.json({ messages: out, confident: r.confident });
  });

  // 運営へエスカレーション（それまでの会話ごと運営の対応キューへ・メール通知）
  api.post('/support/escalate', (req, res) => {
    const text = String((req.body || {}).text || '').trim().slice(0, 2000);
    const out = [];
    out.push(support.saveMessage(db, {
      tenantId: req.tenant.id, sender: 'tenant', escalated: true,
      text: text || '（上記の内容について、運営の担当者に確認をお願いします）',
    }));
    out.push(support.saveMessage(db, {
      tenantId: req.tenant.id, sender: 'system',
      text: '✉️ 運営に送信しました。担当者の返信がこの欄に届きます（メールでもお知らせします）。',
    }));
    // 運営へメール通知（失敗しても本処理は成功扱い）
    const recent = support.listForTenant(db, req.tenant.id, 8)
      .map((m) => `${m.sender === 'tenant' ? '院' : m.sender === 'operator' ? '運営' : 'AI'}: ${m.text}`).join('\n');
    if (config.operator.email) {
      mailer.sendMail({
        to: config.operator.email,
        subject: `[Keiro] サポート問い合わせ: ${req.tenant.name || req.tenant.email}`,
        text: `院: ${req.tenant.name || ''}（${req.tenant.email}）\nプラン: ${req.tenant.plan === 'light' ? 'ライト' : 'プロ'}\n\n--- 直近の会話 ---\n${recent}\n\n返信は運営管理画面のサポート欄から: ${config.baseUrl}/operator`,
      }).catch((e) => logger.error('support escalate mail error', { err: String((e && e.message) || e) }));
    }
    logger.info('support escalated', { tenant_id: req.tenant.id });
    res.json({ messages: out });
  });

  // パスコード（アクセスコード）適用: 無料期間＋プランを付与
  api.post('/redeem-code', (req, res) => {
    const r = codes.redeemCode(db, req.tenant, (req.body || {}).code);
    if (!r.ok) return res.status(400).json({ error: r.error });
    logger.info('access code redeemed', { tenant_id: req.tenant.id, plan: r.plan, trial_days: r.trialDays });
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenant.id);
    const st = billing.subscriptionState(db, t);
    const pi = billing.planInfo(t);
    res.json({ ok: true, plan_key: pi.key, plan_name: pi.name, trial_ends_at: st.trialEndsAt });
  });

  api.post('/billing/cancel', async (req, res) => {
    const sub = billing.latestSubscription(db, req.tenant.id);
    if (!sub || !sub.univapay_subscription_id) return res.status(404).json({ error: 'サブスクリプションがありません' });
    if (univapay.enabled()) await univapay.cancelSubscription(sub.univapay_subscription_id);
    billing.upsertSubscription(db, { tenantId: req.tenant.id, univapaySubId: sub.univapay_subscription_id, status: 'canceled' });
    billing.syncTenantStatus(db, req.tenant.id);
    res.json({ ok: true });
  });

  // ---- ステップ配信（テナント） ----
  api.get('/steps', (req, res) => res.json(steps.listCampaigns(db, req.tenant.id)));

  api.post('/steps', (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'シナリオ名は必須です' });
    const limits = billing.planLimits(req.tenant);
    if (limits.maxStepCampaigns != null) {
      const n = db.prepare('SELECT COUNT(*) n FROM step_campaigns WHERE tenant_id = ?').get(req.tenant.id).n;
      if (n >= limits.maxStepCampaigns) return res.status(403).json({ error: `ライトプランで作成できるステップ配信シナリオは${limits.maxStepCampaigns}件までです。プロプランへの変更をご検討ください。` });
    }
    res.status(201).json(steps.createCampaign(db, req.tenant.id, { name: b.name, media: b.media, audienceTag: b.audience_tag, active: b.active }));
  });

  api.get('/steps/:id', (req, res) => {
    const c = steps.getCampaign(db, req.tenant.id, req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });

  api.put('/steps/:id', (req, res) => {
    const c = steps.updateCampaign(db, req.tenant.id, req.params.id, req.body || {});
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });

  api.put('/steps/:id/messages', (req, res) => {
    const c = steps.setSteps(db, req.tenant.id, req.params.id, (req.body && req.body.steps) || []);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });

  api.delete('/steps/:id', (req, res) => res.json(steps.deleteCampaign(db, req.tenant.id, req.params.id)));

  // ---- 会話ボット：自己申告フロー（新規/通院中の自動分岐） ----
  // プロプラン限定機能（契約書 別紙「プラン別 機能一覧」）
  const requirePro = (feature) => (req, res, next) => {
    const limits = billing.planLimits(req.tenant);
    if (!limits[feature]) return res.status(403).json({ error: 'この機能はプロプラン限定です。プランの変更は運営までご連絡ください。', pro_only: true });
    next();
  };

  api.get('/bot-flows', (req, res) => res.json(identify.listFlows(db, req.tenant.id)));

  api.post('/bot-flows', requirePro('bot'), (req, res) => {
    const b = req.body || {};
    res.status(201).json(identify.createFlow(db, req.tenant.id, {
      name: b.name, triggerType: b.trigger_type, triggerKeyword: b.trigger_keyword,
      questionText: b.question_text, active: b.active,
      messageType: b.message_type, altText: b.alt_text, imageUrl: b.image_url,
    }));
  });

  api.get('/bot-flows/:id', (req, res) => {
    const f = identify.getFlow(db, req.tenant.id, req.params.id);
    if (!f) return res.status(404).json({ error: 'not found' });
    res.json(f);
  });

  api.put('/bot-flows/:id', requirePro('bot'), (req, res) => {
    const b = req.body || {};
    const f = identify.updateFlow(db, req.tenant.id, req.params.id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.question_text !== undefined ? { questionText: b.question_text } : {}),
      ...(b.trigger_type !== undefined ? { triggerType: b.trigger_type } : {}),
      ...(b.trigger_keyword !== undefined ? { triggerKeyword: b.trigger_keyword } : {}),
      ...(b.active !== undefined ? { active: b.active } : {}),
      ...(b.message_type !== undefined ? { messageType: b.message_type } : {}),
      ...(b.alt_text !== undefined ? { altText: b.alt_text } : {}),
      ...(b.image_url !== undefined ? { imageUrl: b.image_url } : {}),
    });
    if (!f) return res.status(404).json({ error: 'not found' });
    res.json(f);
  });

  api.put('/bot-flows/:id/choices', requirePro('bot'), (req, res) => {
    const f = identify.setChoices(db, req.tenant.id, req.params.id, (req.body && req.body.choices) || []);
    if (!f) return res.status(404).json({ error: 'not found' });
    res.json(f);
  });

  // カルーセルのカラム設定（返り値: 一時ID→本ID のマップ。フロントは choices の column_id をこれで貼替）
  api.put('/bot-flows/:id/columns', requirePro('bot'), (req, res) => {
    const idMap = identify.setColumns(db, req.tenant.id, req.params.id, (req.body && req.body.columns) || []);
    if (idMap === null) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, id_map: idMap });
  });

  api.delete('/bot-flows/:id', (req, res) => res.json(identify.deleteFlow(db, req.tenant.id, req.params.id)));

  // 治療院向け「初めて/通院中」フローを一括生成（初期セット）
  api.post('/bot-flows/seed-seitai', requirePro('bot'), (req, res) => {
    res.status(201).json(identify.seedSeitaiIdentify(db, req.tenant.id, { force: !!(req.body && req.body.force) }));
  });

  // ---- 友だち管理（テナント） ----
  api.get('/friends', (req, res) => {
    res.json({
      counts: friends.counts(db, req.tenant.id),
      friends: friends.listFriends(db, req.tenant.id, { media: req.query.media, status: req.query.status, tag: req.query.tag, limit: req.query.limit }),
    });
  });
  api.put('/friends/:id/tags', (req, res) => {
    const n = friends.setTags(db, req.tenant.id, req.params.id, (req.body && req.body.tags) || '');
    if (!n) return res.status(404).json({ error: 'not found' });
    const f = db.prepare('SELECT line_user_id FROM friends WHERE id = ?').get(req.params.id);
    if (f) richmenu.applyMenuForUser(db, req.tenant, f.line_user_id).catch(() => {});
    res.json({ ok: true });
  });
  api.put('/friends/:id/birthday', (req, res) => {
    const r = birthday.setBirthday(db, req.tenant.id, req.params.id, (req.body && req.body.birthday) || null);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });
  api.put('/friends/:id/memo', (req, res) => {
    const n = friends.setMemo(db, req.tenant.id, req.params.id, (req.body || {}).memo);
    if (!n) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });
  api.put('/friends/:id/fields', (req, res) => {
    const n = friends.setFields(db, req.tenant.id, req.params.id, (req.body || {}).fields);
    if (!n) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });
  api.get('/friends/export.csv', requirePro('csvExport'), (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="friends.csv"');
    res.send(friends.exportCsv(db, req.tenant.id));
  });
  api.post('/friends/:id/message', async (req, res) => {
    const text = (req.body && req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'テキストは必須です' });
    if (text.length > 2000) return res.status(400).json({ error: 'メッセージは2000字以内にしてください' });
    const r = await friends.pushToFriend(db, req.tenant, req.params.id, text);
    if (r.error) return res.status(400).json(r);
    if (r.line_user_id) inbox.saveMessage(db, { tenantId: req.tenant.id, lineUserId: r.line_user_id, direction: 'out', text });
    res.json({ ok: true });
  });

  // ---- 一斉配信（テナント） ----
  api.get('/broadcasts', (req, res) => res.json(broadcast.listBroadcasts(db, req.tenant.id)));
  api.post('/broadcasts', (req, res) => {
    const b = req.body || {};
    if (!b.text || !b.text.trim()) return res.status(400).json({ error: '本文は必須です' });
    res.status(201).json(broadcast.createBroadcast(db, req.tenant.id, b));
  });
  api.delete('/broadcasts/:id', (req, res) => res.json(broadcast.deleteBroadcast(db, req.tenant.id, req.params.id)));
  api.post('/broadcasts/:id/send', async (req, res) => {
    const r = await broadcast.sendBroadcast(db, req.tenant.id, req.params.id);
    if (r.error) return res.status(400).json(r);
    // ライトプランは月4回目安（契約上ブロックはしない・超過時に警告のみ）
    const limits = billing.planLimits(req.tenant);
    if (limits.broadcastMonthly != null) {
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const n = db.prepare("SELECT COUNT(*) n FROM broadcasts WHERE tenant_id = ? AND status = 'sent' AND created_at >= ?")
        .get(req.tenant.id, monthStart.getTime()).n;
      if (n > limits.broadcastMonthly) r.warning = `今月の一斉配信は${n}回目です。ライトプランの目安（月${limits.broadcastMonthly}回）を超えています。`;
    }
    res.json(r);
  });
  // 配信対象の件数プレビュー
  api.get('/audience', (req, res) => {
    const ids = friends.getRecipients(db, req.tenant.id, req.query.type || 'all', req.query.value);
    res.json({ count: ids.length });
  });

  // ---- キーワード自動応答（テナント） ----
  api.get('/autoreplies', (req, res) => res.json(autoreply.listRules(db, req.tenant.id)));
  api.post('/autoreplies', (req, res) => {
    const b = req.body || {};
    if (!b.keyword || !b.reply_text) return res.status(400).json({ error: 'キーワードと返信文は必須です' });
    res.status(201).json(autoreply.createRule(db, req.tenant.id, b));
  });
  api.put('/autoreplies/:id', (req, res) => {
    const r = autoreply.updateRule(db, req.tenant.id, req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  });
  api.delete('/autoreplies/:id', (req, res) => res.json(autoreply.deleteRule(db, req.tenant.id, req.params.id)));

  // ---- リッチメニュー（テナント） ----
  api.get('/richmenu/templates', (req, res) => res.json(richmenu.templatesForClient()));
  api.get('/richmenus', (req, res) => res.json(richmenu.listMenus(db, req.tenant.id)));
  api.post('/richmenus', async (req, res) => {
    const b = req.body || {};
    const m = /^data:(image\/png|image\/jpeg);base64,(.+)$/.exec(b.image_base64 || '');
    if (!m) return res.status(400).json({ error: '画像が不正です' });
    const imageBuffer = Buffer.from(m[2], 'base64');
    if (imageBuffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: '画像が大きすぎます（10MB以下にしてください）' });
    if (b.audience_tag && !billing.planLimits(req.tenant).richmenuByTag) {
      return res.status(403).json({ error: 'タグ別のリッチメニュー出し分けはプロプラン限定です。', pro_only: true });
    }
    const r = await richmenu.createAndDeploy(db, req.tenant, {
      name: b.name, template: b.template, chatBarText: b.chat_bar_text, cells: b.cells,
      audienceTag: b.audience_tag,
      imageBuffer, contentType: m[1],
    });
    if (r.error) return res.status(400).json(r);
    res.status(201).json(r);
  });
  // リッチメニューのAI壁打ち（構成の相談→提案JSONを返す）
  api.post('/richmenu/ai-chat', async (req, res) => {
    if (!aisetup.enabled()) return res.status(503).json({ error: 'AI機能は現在準備中です（運営にお問い合わせください）' });
    if (!aiQuotaOk(req.tenant.id, 'rmchat', 50)) return res.status(429).json({ error: '本日のAI利用回数の上限に達しました。' });
    const b = req.body || {};
    const r = await aisetup.richmenuChat(db, req.tenant, b.messages || [], b.current_menu || null);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  // リッチメニュー背景画像のAI生成（文字なし背景→フロントのCanvasが文言を重ねる）
  api.post('/richmenu/ai-image', async (req, res) => {
    if (!aisetup.enabled()) return res.status(503).json({ error: 'AI機能は現在準備中です（運営にお問い合わせください）' });
    if (!aiQuotaOk(req.tenant.id, 'rmimg', 15)) return res.status(429).json({ error: '本日の画像生成回数の上限に達しました。' });
    const b = req.body || {};
    const r = await aisetup.generateMenuBackground(b.prompt, b.template);
    if (r.error) return res.status(400).json(r);
    logger.info('rm image generated', { tenant_id: req.tenant.id });
    res.json({ image: `data:${r.mime};base64,${r.base64}` });
  });

  api.post('/richmenus/:id/activate', async (req, res) => {
    const r = await richmenu.activate(db, req.tenant, req.params.id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });
  api.delete('/richmenus/:id', async (req, res) => res.json(await richmenu.remove(db, req.tenant, req.params.id)));

  // ---- 1:1チャット受信箱（プロ） ----
  api.get('/inbox/threads', requirePro('inbox'), (req, res) => res.json({
    threads: inbox.listThreads(db, req.tenant.id),
    unread: inbox.unreadCount(db, req.tenant.id),
  }));
  api.get('/inbox/:userId/messages', requirePro('inbox'), (req, res) => {
    inbox.markRead(db, req.tenant.id, req.params.userId);
    res.json(inbox.listMessages(db, req.tenant.id, req.params.userId));
  });
  api.post('/inbox/:userId/reply', requirePro('inbox'), async (req, res) => {
    const text = ((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'テキストは必須です' });
    const r = await inbox.sendReply(db, req.tenant, tenantmod.resolveSettings(req.tenant), req.params.userId, text);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });
  // AI返信案: 会話履歴＋院の自動応答（正しい案内文）を基に返信案を3つ提案
  api.post('/inbox/:userId/suggest', requirePro('inbox'), async (req, res) => {
    if (!aisetup.enabled()) return res.status(503).json({ error: 'AI機能は現在準備中です（運営にお問い合わせください）' });
    if (!aiQuotaOk(req.tenant.id, 'reply', 100)) return res.status(429).json({ error: '本日のAI利用回数の上限に達しました。' });
    const r = await aisetup.suggestReplies(db, req.tenant, req.params.userId);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  // ---- リマインダ配信（プロ） ----
  api.get('/reminders', requirePro('reminders'), (req, res) => res.json(reminders.listCampaigns(db, req.tenant.id)));
  api.post('/reminders', requirePro('reminders'), (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: '名前は必須です' });
    res.status(201).json(reminders.createCampaign(db, req.tenant.id, b));
  });
  api.get('/reminders/:id', requirePro('reminders'), (req, res) => {
    const c = reminders.getCampaign(db, req.tenant.id, req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });
  api.put('/reminders/:id', requirePro('reminders'), (req, res) => {
    const c = reminders.updateCampaign(db, req.tenant.id, req.params.id, req.body || {});
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });
  api.put('/reminders/:id/steps', requirePro('reminders'), (req, res) => {
    const c = reminders.setSteps(db, req.tenant.id, req.params.id, (req.body || {}).steps || []);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });
  api.delete('/reminders/:id', requirePro('reminders'), (req, res) => res.json(reminders.deleteCampaign(db, req.tenant.id, req.params.id)));
  api.get('/reminders/:id/enrollments', requirePro('reminders'), (req, res) => res.json(reminders.listEnrollments(db, req.tenant.id, req.params.id)));
  // 友だちをリマインダに登録（基準日=YYYY-MM-DD）。friendId経由でline_user_idを解決
  api.post('/reminders/:id/enroll', requirePro('reminders'), (req, res) => {
    const b = req.body || {};
    const friend = db.prepare('SELECT line_user_id FROM friends WHERE id = ? AND tenant_id = ?').get(b.friend_id || '', req.tenant.id);
    if (!friend) return res.status(404).json({ error: '友だちが見つかりません' });
    const r = reminders.enroll(db, req.tenant.id, req.params.id, friend.line_user_id, b.base_date, b.base_time);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  // かんたん予約リマインド: 日時を登録するだけで「前日18時」に自動でお知らせが届く
  // （既定キャンペーン「予約リマインド（自動）」を自動作成。文面はリマインダ配信画面で編集可能）
  api.post('/reminders/quick', requirePro('reminders'), (req, res) => {
    const b = req.body || {};
    const friend = db.prepare('SELECT line_user_id FROM friends WHERE id = ? AND tenant_id = ?').get(b.friend_id || '', req.tenant.id);
    if (!friend) return res.status(404).json({ error: '友だちが見つかりません' });
    const camp = reminders.ensureQuickCampaign(db, req.tenant.id);
    const r = reminders.enroll(db, req.tenant.id, camp.id, friend.line_user_id, b.base_date, b.base_time);
    if (r.error) return res.status(400).json(r);
    res.json({ ...r, campaign_id: camp.id, campaign_name: camp.name });
  });

  // ---- 回答フォーム（プロ） ----
  api.get('/forms', requirePro('forms'), (req, res) => res.json(forms.listForms(db, req.tenant.id)));
  api.post('/forms', requirePro('forms'), (req, res) => {
    const r = forms.createForm(db, req.tenant.id, req.body || {});
    if (r.error) return res.status(400).json(r);
    res.status(201).json(r);
  });
  api.put('/forms/:id', requirePro('forms'), (req, res) => {
    const r = forms.updateForm(db, req.tenant.id, req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'not found' });
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });
  api.delete('/forms/:id', requirePro('forms'), (req, res) => res.json(forms.deleteForm(db, req.tenant.id, req.params.id)));
  api.get('/forms/:id/answers', requirePro('forms'), (req, res) => res.json(forms.listAnswers(db, req.tenant.id, req.params.id)));

  // ---- 配信内リンクのタップ計測（プロ） ----
  api.get('/tracked-urls', requirePro('roiDashboard'), (req, res) => res.json(trackurl.listUrls(db, req.tenant.id)));
  api.post('/tracked-urls', requirePro('roiDashboard'), (req, res) => {
    const b = req.body || {};
    const r = trackurl.createUrl(db, req.tenant.id, { name: b.name, destUrl: b.dest_url });
    if (r.error) return res.status(400).json(r);
    res.status(201).json(r);
  });
  api.delete('/tracked-urls/:id', requirePro('roiDashboard'), (req, res) => res.json(trackurl.deleteUrl(db, req.tenant.id, req.params.id)));
  api.get('/tracked-urls/:id/clicks', requirePro('roiDashboard'), (req, res) => res.json(trackurl.listClicks(db, req.tenant.id, req.params.id)));

  // ---- メッセージテンプレート（定型文） ----
  api.get('/templates', (req, res) => res.json(
    db.prepare('SELECT * FROM message_templates WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenant.id)));
  api.post('/templates', (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.text) return res.status(400).json({ error: '名前と本文は必須です' });
    const id = newId('tpl');
    db.prepare('INSERT INTO message_templates (id, tenant_id, name, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, req.tenant.id, String(b.name).slice(0, 100), String(b.text).slice(0, 5000), Date.now());
    res.status(201).json({ id });
  });
  api.delete('/templates/:id', (req, res) => {
    db.prepare('DELETE FROM message_templates WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenant.id);
    res.json({ ok: true });
  });

  // ---- 画像アップロード（配信・カルーセル用） ----
  api.post('/images', (req, res) => {
    const m = /^data:(image\/png|image\/jpeg);base64,(.+)$/.exec((req.body || {}).image_base64 || '');
    if (!m) return res.status(400).json({ error: '画像が不正です（PNG/JPEGのみ）' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: '画像が大きすぎます（5MB以下にしてください）' });
    const id = newId('img');
    db.prepare('INSERT INTO images (id, tenant_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, req.tenant.id, m[1], buf, Date.now());
    res.status(201).json({ id, url: `${config.baseUrl}/img/${id}` });
  });

  // ---- 広告費の手入力（ROIダッシュボード: CPA算出用）（プロ） ----
  api.get('/ad-costs', requirePro('roiDashboard'), (req, res) => res.json(
    db.prepare('SELECT * FROM ad_costs WHERE tenant_id = ? ORDER BY month DESC, media').all(req.tenant.id)));
  api.put('/ad-costs', requirePro('roiDashboard'), (req, res) => {
    const b = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(b.month || '')) return res.status(400).json({ error: '月は YYYY-MM 形式で指定してください' });
    const media = String(b.media || 'meta').trim().toLowerCase();
    const amount = parseInt(b.amount, 10);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: '金額（円）を入力してください' });
    db.prepare(
      `INSERT INTO ad_costs (id, tenant_id, media, month, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, media, month) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`
    ).run(newId('adc'), req.tenant.id, media, b.month, amount, Date.now(), Date.now());
    res.json({ ok: true });
  });
  api.delete('/ad-costs/:id', requirePro('roiDashboard'), (req, res) => {
    db.prepare('DELETE FROM ad_costs WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenant.id);
    res.json({ ok: true });
  });
  // ROI集計: 月×媒体の 広告費・獲得友だち数・CPA
  api.get('/analytics/roi', requirePro('roiDashboard'), (req, res) => {
    const costs = db.prepare('SELECT media, month, amount FROM ad_costs WHERE tenant_id = ?').all(req.tenant.id);
    const acq = db.prepare(
      `SELECT IFNULL(source_media,'') AS media, strftime('%Y-%m', datetime(created_at/1000, 'unixepoch', 'localtime')) AS month, COUNT(*) AS friends
       FROM friends WHERE tenant_id = ? AND source_media IS NOT NULL GROUP BY media, month`
    ).all(req.tenant.id);
    const map = new Map();
    for (const c of costs) map.set(`${c.media}|${c.month}`, { media: c.media, month: c.month, cost: c.amount, friends: 0 });
    for (const a of acq) {
      const k = `${a.media}|${a.month}`;
      if (map.has(k)) map.get(k).friends = a.friends;
      else map.set(k, { media: a.media, month: a.month, cost: null, friends: a.friends });
    }
    const rows = [...map.values()].sort((x, y) => (y.month + y.media).localeCompare(x.month + x.media))
      .map((r) => ({ ...r, cpa: r.cost != null && r.friends > 0 ? Math.round(r.cost / r.friends) : null }));
    res.json(rows);
  });

  // ---- 業種別プリセット（テナント） ----
  api.get('/presets', (req, res) => res.json(presets.listPresets()));
  api.post('/presets/apply', (req, res) => {
    const b = req.body || {};
    const r = presets.applyPreset(db, req.tenant, b.industry, { applySteps: b.apply_steps !== false, applyAutoreplies: b.apply_autoreplies !== false });
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  // ---- AI初期構築: ホームページ/LPのURLから、その店に合わせた設定を自動生成 ----
  const aiUsage = new Map(); // `${tenantId}:${kind}` -> {day, count}（APIコスト保護）
  function aiQuotaOk(tenantId, kind, limit) {
    const key = `${tenantId}:${kind}`;
    const day = new Date().toISOString().slice(0, 10);
    const u = aiUsage.get(key);
    if (!u || u.day !== day) { aiUsage.set(key, { day, count: 1 }); return true; }
    if (u.count >= limit) return false;
    u.count++;
    return true;
  }

  api.get('/ai-setup/status', (req, res) => res.json({ enabled: aisetup.enabled() }));

  api.post('/ai-setup/analyze', async (req, res) => {
    if (!aisetup.enabled()) return res.status(503).json({ error: 'AI自動構築は現在準備中です（運営にお問い合わせください）' });
    const url = ((req.body || {}).url || '').trim();
    const rawText = String((req.body || {}).text || '').trim();
    if (!url && rawText.length < 30) return res.status(400).json({ error: 'ホームページのURLを入力するか、お店の紹介文（30文字以上）を貼り付けてください' });
    if (!aiQuotaOk(req.tenant.id, 'setup', 10)) return res.status(429).json({ error: '本日の解析回数の上限に達しました。明日また試すか、運営にご相談ください。' });
    const r = await aisetup.analyze(url || null, url ? {} : { rawText });
    if (r.error) return res.status(400).json(r);
    logger.info('ai-setup analyzed', { tenant_id: req.tenant.id, url, shop: r.plan.shop_name });
    res.json(r);
  });

  api.post('/ai-setup/apply', (req, res) => {
    const plan = (req.body || {}).plan;
    if (!plan) return res.status(400).json({ error: '先にURLの解析を行ってください' });
    try {
      const r = aisetup.applyPlan(db, req.tenant, plan);
      logger.info('ai-setup applied', { tenant_id: req.tenant.id, created: r.created });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: String((e && e.message) || '反映に失敗しました') });
    }
  });

  // ---- KPI分析（テナント） ----
  api.get('/analytics/summary', requirePro('roiDashboard'), (req, res) => {
    res.json(analytics.getSummary(db, req.tenant.id));
  });
  api.get('/analytics/trend', requirePro('roiDashboard'), (req, res) => {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 397);
    res.json(analytics.getFriendsTrend(db, req.tenant.id, days));
  });
  api.get('/analytics/sources', (req, res) => {
    res.json(analytics.getSourceBreakdown(db, req.tenant.id));
  });
  api.get('/analytics/broadcasts', (req, res) => {
    res.json(analytics.getBroadcastStats(db, req.tenant.id));
  });
  api.get('/analytics/kpi-targets', (req, res) => {
    res.json(analytics.getKpiTargets(db, req.tenant.id));
  });
  api.put('/analytics/kpi-targets', (req, res) => {
    analytics.setKpiTargets(db, req.tenant.id, req.body || {});
    res.json({ ok: true });
  });

  // ---- クーポン（テナント） ----
  api.get('/coupons', (req, res) => res.json(coupons.listCoupons(db, req.tenant.id)));
  api.post('/coupons', (req, res) => {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'クーポン名は必須です' });
    res.status(201).json(coupons.createCoupon(db, req.tenant.id, b));
  });
  api.put('/coupons/:id', (req, res) => {
    const c = coupons.updateCoupon(db, req.tenant.id, req.params.id, req.body || {});
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });
  api.delete('/coupons/:id', (req, res) => res.json(coupons.deleteCoupon(db, req.tenant.id, req.params.id)));
  api.post('/coupons/:id/send', async (req, res) => {
    const r = await coupons.sendCoupon(db, req.tenant.id, req.params.id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });
  api.post('/coupons/:id/mark-used', (req, res) => {
    const b = req.body || {};
    if (!b.line_user_id) return res.status(400).json({ error: 'line_user_id が必要です' });
    res.json(coupons.markUsed(db, req.tenant.id, req.params.id, b.line_user_id));
  });

  // ---- 誕生日配信（テナント） ----
  api.get('/birthday-campaigns', (req, res) => res.json(birthday.listCampaigns(db, req.tenant.id)));
  api.post('/birthday-campaigns', (req, res) => {
    const r = birthday.createCampaign(db, req.tenant.id, req.body || {});
    if (r.error) return res.status(400).json(r);
    res.status(201).json(r);
  });
  api.put('/birthday-campaigns/:id', (req, res) => {
    const r = birthday.updateCampaign(db, req.tenant.id, req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  });
  api.delete('/birthday-campaigns/:id', (req, res) => res.json(birthday.deleteCampaign(db, req.tenant.id, req.params.id)));

  // ---- スタンプカード（テナント） ----
  api.get('/stamp-cards', (req, res) => res.json(stampcard.listCards(db, req.tenant.id)));
  api.post('/stamp-cards', (req, res) => {
    const r = stampcard.createCard(db, req.tenant.id, req.body || {});
    if (r.error) return res.status(400).json(r);
    res.status(201).json(r);
  });
  api.put('/stamp-cards/:id', (req, res) => {
    const r = stampcard.updateCard(db, req.tenant.id, req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  });
  api.delete('/stamp-cards/:id', (req, res) => res.json(stampcard.deleteCard(db, req.tenant.id, req.params.id)));
  api.get('/stamp-cards/:id/records', (req, res) => res.json(stampcard.listRecords(db, req.tenant.id, req.params.id)));
  api.post('/stamp-cards/:id/stamp/:friendId', async (req, res) => {
    const r = await stampcard.addStamp(db, req.tenant, { cardId: req.params.id, friendId: req.params.friendId });
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  app.use('/api', api);

  // =====================================================================
  // 運営API（operatorロール必須）
  // =====================================================================
  const admin = express.Router();
  admin.use(express.json());
  admin.use(requireOperator);

  admin.get('/tenants', (req, res) => {
    const rows = db.prepare(
      `SELECT id, email, name, role, status, created_at FROM tenants WHERE role = 'tenant' ORDER BY created_at DESC`
    ).all();
    res.json(rows.map((t) => {
      const st = billing.subscriptionState(db, t);
      const clicks = db.prepare('SELECT COUNT(*) n FROM clicks WHERE tenant_id = ?').get(t.id).n;
      const follows = db.prepare("SELECT COUNT(*) n FROM follows WHERE tenant_id = ? AND status='matched'").get(t.id).n;
      return { ...t, billing_status: st.status, billing_active: st.active, clicks, follows };
    }));
  });

  // ---- 利用状況の見える化 ----
  admin.get('/usage', (req, res) => {
    const rows = db.prepare("SELECT * FROM tenants WHERE role = 'tenant' ORDER BY created_at DESC").all();
    res.json(rows.map((t) => {
      const st = billing.subscriptionState(db, t);
      return {
        id: t.id, email: t.email, name: t.name, status: t.status, plan: t.plan === 'light' ? 'light' : 'pro',
        created_at: t.created_at,
        billing_status: st.status, billing_active: st.active,
        usage: usage.tenantUsage(db, t),
      };
    }));
  });
  admin.get('/usage/trend', (req, res) => res.json(usage.overviewTrend(db, 30)));
  admin.get('/usage/:id/trend', (req, res) => res.json(usage.tenantTrend(db, req.params.id, 30)));

  // ---- サポート対応（院からの問い合わせ） ----
  admin.get('/support', (req, res) => res.json(support.listThreads(db)));
  admin.get('/support/pending-count', (req, res) => res.json({ pending: support.pendingCount(db) }));
  admin.get('/support/:tenantId', (req, res) => {
    const msgs = support.listForTenant(db, req.params.tenantId, 200);
    support.markReadByOperator(db, req.params.tenantId);
    res.json({ messages: msgs });
  });
  admin.post('/support/:tenantId', (req, res) => {
    const text = String((req.body || {}).text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: '返信を入力してください' });
    const t = db.prepare("SELECT * FROM tenants WHERE id = ? AND role = 'tenant'").get(req.params.tenantId);
    if (!t) return res.status(404).json({ error: 'not found' });
    const m = support.saveMessage(db, { tenantId: t.id, sender: 'operator', text });
    // 院へメール通知（アプリを開いてもらう導線）
    mailer.sendMail({
      to: t.email,
      subject: '[Keiro] サポートからの返信が届いています',
      text: `${t.name || ''} 様\n\nお問い合わせいただいた件について、サポートから返信があります。\nKeiroにログインし、「質問・サポート」欄をご確認ください。\n${config.baseUrl}/app\n\n--- 返信内容 ---\n${text}`,
    }).catch((e) => logger.error('support reply mail error', { err: String((e && e.message) || e) }));
    logger.info('support operator replied', { tenant_id: t.id });
    res.json({ ok: true, message: m });
  });

  // パスワード設定リンクの再発行（招待済み/忘れた場合の手渡し用）※ 汎用 :action より先に定義
  admin.post('/tenants/:id/reset-link', (req, res) => {
    const t = db.prepare("SELECT * FROM tenants WHERE id = ? AND role = 'tenant'").get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({ reset_url: pwreset.makeResetUrl(t) });
  });

  // 運営がテナントへパスコードを直接適用（本人の入力なしで無料期間＋プランを付与）
  // ※ 汎用 :action ルートより先に定義すること
  admin.post('/tenants/:id/apply-code', (req, res) => {
    const t = db.prepare("SELECT * FROM tenants WHERE id = ? AND role = 'tenant'").get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const r = codes.redeemCode(db, t, (req.body || {}).code);
    if (!r.ok) return res.status(400).json({ error: r.error });
    logger.info('access code applied by operator', { tenant_id: t.id, plan: r.plan, trial_days: r.trialDays });
    const fresh = db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.id);
    const st = billing.subscriptionState(db, fresh);
    res.json({ ok: true, plan_name: billing.planInfo(fresh).name, trial_ends_at: st.trialEndsAt });
  });

  // 解約申請を対応済みにする（バッジを消す）※ 汎用 :action より先に定義
  admin.post('/tenants/:id/clear-cancel', (req, res) => {
    const info = db.prepare("UPDATE tenants SET cancel_requested_at = NULL WHERE id = ? AND role='tenant'").run(req.params.id);
    res.json({ ok: true, updated: info.changes });
  });

  admin.post('/tenants/:id/:action', (req, res) => {
    const { id, action } = req.params;
    if (!['suspend', 'activate'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    const status = action === 'suspend' ? 'suspended' : 'active';
    const info = db.prepare("UPDATE tenants SET status = ?, updated_at = ? WHERE id = ? AND role='tenant'").run(status, Date.now(), id);
    res.json({ updated: info.changes, status });
  });

  // テナント招待: 初期パスワード無しで作成し、本人が設定リンクからパスワードを決める
  admin.post('/tenants/invite', (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').toLowerCase().trim();
    if (!email || !/@/.test(email)) return res.status(400).json({ error: 'メールアドレスが必要です' });
    const t = tenantmod.createTenant(db, { email, password: null, name: b.name || null });
    if (!t) return res.status(409).json({ error: 'このメールアドレスは既に登録されています' });
    // ログイン不能なランダムハッシュへ差し替え（平文はどこにも存在しない）
    db.prepare('UPDATE tenants SET password_hash = ?, updated_at = ? WHERE id = ?').run(pwreset.unusablePasswordHash(), Date.now(), t.id);
    const fresh = db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.id);
    const reset_url = pwreset.makeResetUrl(fresh);
    logger.info('tenant invited', { tenant_id: t.id });
    res.status(201).json({ id: t.id, email: fresh.email, name: fresh.name, reset_url });
  });

  // 決済設定（UnivaPay）: 運営画面から貼り付け→暗号化保存→即時反映。値は返さない
  admin.get('/billing-settings', (req, res) => {
    res.json(appsettings.status(db));
  });
  admin.post('/billing-settings', (req, res) => {
    const b = req.body || {};
    const st = appsettings.saveUnivapay(db, { jwt: b.jwt, app_secret: b.app_secret, store_id: b.store_id, webhook_secret: b.webhook_secret });
    logger.info('billing settings updated by operator', st);
    res.json(st);
  });

  // アクセスコード（パスコード）の発行・一覧・有効切替
  admin.get('/codes', (req, res) => {
    res.json(codes.listCodes(db));
  });
  admin.post('/codes', (req, res) => {
    const b = req.body || {};
    const c = codes.createCode(db, {
      code: b.code, trialDays: Number(b.trial_days), plan: b.plan,
      maxUses: Number(b.max_uses), note: b.note,
    });
    res.status(201).json(c);
  });
  admin.post('/codes/:id/:action', (req, res) => {
    const { id, action } = req.params;
    if (!['activate', 'deactivate'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    res.json(codes.setActive(db, id, action === 'activate'));
  });

  admin.get('/stats', (req, res) => {
    res.json({
      tenants: db.prepare("SELECT COUNT(*) n FROM tenants WHERE role='tenant'").get().n,
      active: db.prepare("SELECT COUNT(*) n FROM tenants WHERE role='tenant' AND status='active'").get().n,
      subscriptions_active: db.prepare("SELECT COUNT(*) n FROM subscriptions WHERE status='active'").get().n,
      clicks: db.prepare('SELECT COUNT(*) n FROM clicks').get().n,
      follows_matched: db.prepare("SELECT COUNT(*) n FROM follows WHERE status='matched'").get().n,
    });
  });

  app.use('/api/admin', admin);

  // =====================================================================
  // 画面（静的）
  // =====================================================================
  app.use('/assets', express.static(path.join(PUB, 'assets')));
  app.get('/', (req, res) => sendPage(res, 'index.html'));
  app.get('/login', (req, res) => sendPage(res, 'login.html'));
  app.get('/signup', (req, res) => sendPage(res, 'signup.html'));
  app.get('/forgot', (req, res) => sendPage(res, 'forgot.html'));
  app.get('/reset', (req, res) => sendPage(res, 'reset.html'));
  app.get('/connect', (req, res) => sendPage(res, 'connect.html'));
  app.get('/guide', (req, res) => sendPage(res, 'guide.html'));
  // クライアント配布用の統合ガイド（スライド形式・スクショ入り）
  app.get('/manual', (req, res) => sendPage(res, 'manual.html'));
  app.use('/manual-assets', express.static(path.join(PUB, 'manual-assets'), { maxAge: '7d' }));
  app.get('/terms', (req, res) => sendPage(res, 'legal/terms.html'));
  app.get('/privacy', (req, res) => sendPage(res, 'legal/privacy.html'));
  app.get('/tokushoho', (req, res) => sendPage(res, 'legal/tokushoho.html'));
  app.get(['/app', '/app/*'], (req, res) => sendPage(res, 'app.html'));
  app.get(['/operator', '/operator/*'], (req, res) => sendPage(res, 'operator.html'));
  app.get('/admin', (req, res) => res.redirect('/app'));

  return app;
}

function renderClaimPage({ ok, message }) {
  const color = ok ? '#06c755' : '#9aa0a6';
  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登録完了</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; font-family: -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
    background:#f5f6f7; color:#1f2328; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { background:#fff; border:1px solid #e6e8eb; border-radius:14px; padding:40px 28px; max-width:360px;
    text-align:center; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  .dot { width:56px; height:56px; border-radius:50%; background:${color}; margin:0 auto 20px;
    display:flex; align-items:center; justify-content:center; color:#fff; font-size:28px; }
  p { font-size:15px; line-height:1.7; margin:0; }
</style></head><body>
  <div class="card"><div class="dot">${ok ? '✓' : '!'}</div><p>${escapeHtml(message)}</p></div>
</body></html>`;
}

module.exports = { createApp };
