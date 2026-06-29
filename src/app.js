'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const logger = require('./logger');
const { getIp, escapeHtml } = require('./util');
const { signToken, verifyToken, verifyLineSignature, newId } = require('./sign');
const { applyMatch } = require('./match');
const { deleteLinkCascade } = require('./links');
const { replyGreeting, replyText, getProfile: lineProfile } = require('./line');
const { dispatchPostbacks } = require('./postback');
const { createRateLimiter } = require('./ratelimit');
const authmod = require('./auth');
const tenantmod = require('./tenant');
const billing = require('./billing');
const univapay = require('./univapay');
const steps = require('./steps');
const friends = require('./friends');
const broadcast = require('./broadcast');
const autoreply = require('./autoreply');
const richmenu = require('./richmenu');
const presets = require('./presets');
const analytics = require('./analytics');
const coupons = require('./coupons');
const birthday = require('./birthday');
const stampcard = require('./stampcard');

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

  // 誕生日配信：毎時0分ごろ実行（processBirthdays内部で0時台のみ実際に送信）
  setInterval(() => birthday.processBirthdays(db).catch((e) => logger.error('birthday scheduler', { err: String(e && e.message || e) })), 60 * 60 * 1000);

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

  // =====================================================================
  // 公開ページ（認証不要）
  // =====================================================================

  // クーポン公開ページ：/p/:webhook_token/coupon
  app.get('/p/:token/coupon', limiter, (req, res) => {
    const tenant = db.prepare('SELECT id, name FROM tenants WHERE webhook_token = ?').get(req.params.token);
    if (!tenant) return res.status(404).send('not found');
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
          <a class="btn" href="https://airrsv.net/moveact/calendar">今すぐ予約する →</a>
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

  // リッチメニューセットアップ用エンドポイント（webhook_token認証、CORS許可）
  app.options('/setup/richmenu', (req, res) => { res.set('Access-Control-Allow-Origin', '*').set('Access-Control-Allow-Headers', 'Content-Type').status(204).end(); });
  app.post('/setup/richmenu', express.json({ limit: '15mb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const b = req.body || {};
    const tenant = b.webhook_token ? db.prepare('SELECT * FROM tenants WHERE webhook_token = ?').get(b.webhook_token) : null;
    if (!tenant) return res.status(404).json({ error: 'not found' });
    const settings = require('./tenant').resolveSettings(tenant);
    const tok = settings.line && settings.line.channelAccessToken;
    if (!tok) return res.status(400).json({ error: 'LINE未設定' });
    const m = /^data:(image\/png|image\/jpeg);base64,(.+)$/.exec(b.image_base64 || '');
    if (!m) return res.status(400).json({ error: '画像不正' });
    const imageBuffer = Buffer.from(m[2], 'base64');
    const { createRichMenu: lineCreate, uploadRichMenuImage, setDefaultRichMenu, deleteRichMenu } = require('./line');
    try {
      // 旧リッチメニュー削除
      if (b.old_rich_menu_id) { try { await deleteRichMenu(tok, b.old_rich_menu_id); } catch {} }
      // 新規作成
      const cr = await lineCreate(tok, b.menu);
      if (!cr.ok) return res.status(400).json({ error: 'create failed', detail: cr });
      const rmId = cr.richMenuId;
      // 画像アップロード
      const ur = await uploadRichMenuImage(tok, rmId, imageBuffer, m[1]);
      if (!ur.ok) return res.status(400).json({ error: 'upload failed', detail: ur });
      // デフォルト設定
      await setDefaultRichMenu(tok, rmId);
      res.json({ ok: true, richMenuId: rmId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // キーワード自動応答セットアップ（webhook_token認証）
  app.post('/setup/autoreply', express.json(), (req, res) => {
    const b = req.body || {};
    const tenant = b.webhook_token ? db.prepare('SELECT * FROM tenants WHERE webhook_token = ?').get(b.webhook_token) : null;
    if (!tenant) return res.status(404).json({ error: 'not found' });
    const { keyword, match_type, reply_text } = b;
    if (!keyword || !reply_text) return res.status(400).json({ error: 'keyword and reply_text are required' });
    const rule = autoreply.createRule(db, tenant.id, { keyword, match_type: match_type || 'exact', reply_text, active: true });
    res.json({ ok: true, rule });
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

    const active = billing.isMeasurementActive(db, tenant);
    const accessToken = settings.line.channelAccessToken;
    const events = (parsed && parsed.events) || [];
    const pendingReplies = [];     // 友だち追加の挨拶（claimリンク）
    const pendingAutoReplies = []; // キーワード自動応答
    const newFollowUserIds = [];   // プロフィール取得対象
    for (const ev of events) {
      const lineUserId = ev.source && ev.source.userId;

      // ブロック/友だち解除 → ステップ配信停止＋friend.blocked
      if (ev.type === 'unfollow' && lineUserId) {
        try { steps.stopEnrollments(db, tenant.id, lineUserId); friends.markBlocked(db, tenant.id, lineUserId); }
        catch (e) { logger.error('unfollow handling error', { err: String((e && e.message) || e) }); }
        continue;
      }

      // テキスト受信 → キーワード自動応答
      if (ev.type === 'message' && ev.message && ev.message.type === 'text' && ev.replyToken) {
        try {
          const reply = autoreply.findReply(db, tenant.id, ev.message.text);
          if (reply) pendingAutoReplies.push({ replyToken: ev.replyToken, text: reply });
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
      // 友だちの流入経路を記録（CRM/セグメント用）
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
    authmod.setSessionCookie(res, authmod.signJwt({ sub: t.id, role: t.role }));
    logger.info('tenant signup', { tenant_id: t.id });
    res.status(201).json({ ok: true });
  });

  auth.post('/login', authLimiter, (req, res) => {
    const { email, password } = req.body || {};
    const t = db.prepare('SELECT * FROM tenants WHERE email = ?').get(String(email || '').toLowerCase());
    if (!t || !authmod.verifyPassword(password || '', t.password_hash)) {
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います' });
    }
    authmod.setSessionCookie(res, authmod.signJwt({ sub: t.id, role: t.role }));
    res.json({ ok: true, role: t.role });
  });

  auth.post('/logout', (req, res) => { authmod.clearSessionCookie(res); res.json({ ok: true }); });
  app.use('/auth', auth);

  // =====================================================================
  // テナントAPI（ログイン必須）
  // =====================================================================
  const api = express.Router();
  api.use(express.json({ limit: '8mb' })); // リッチメニュー画像(base64)を許容
  api.use(requireAuth);

  api.get('/me', (req, res) => {
    const st = billing.subscriptionState(db, req.tenant);
    res.json({
      id: req.tenant.id, email: req.tenant.email, name: req.tenant.name, role: req.tenant.role,
      billing: { status: st.status, active: st.active, in_trial: st.inTrial, trial_ends_at: st.trialEndsAt },
    });
  });

  api.get('/settings', (req, res) => {
    res.json(Object.assign(tenantmod.publicSettings(req.tenant), {
      webhook_url: `${config.baseUrl}/webhook/${req.tenant.webhook_token}`,
    }));
  });

  api.put('/settings', (req, res) => {
    tenantmod.updateTenantSettings(db, req.tenant.id, req.body || {});
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenant.id);
    res.json(Object.assign(tenantmod.publicSettings(t), { webhook_url: `${config.baseUrl}/webhook/${t.webhook_token}` }));
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
    const id = newId('lnk');
    db.prepare(
      `INSERT INTO links (id, tenant_id, name, oa_add_url, media, campaign, creative, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.tenant.id, String(b.name), String(b.oa_add_url),
      b.media ? String(b.media) : null, b.campaign ? String(b.campaign) : null, b.creative ? String(b.creative) : null, Date.now());
    res.status(201).json({ id, track_url: `${config.baseUrl}/c/${id}` });
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
    const plan = billing.ensureDefaultPlan(db);
    res.json({
      status: st.status, active: st.active, in_trial: st.inTrial, trial_ends_at: st.trialEndsAt,
      plan: { name: plan.name, amount: plan.amount, currency: config.univapay.currency, interval: plan.interval },
      univapay: { enabled: univapay.enabled(), app_jwt: config.univapay.appJwt, store_id: config.univapay.storeId },
    });
  });

  api.post('/billing/subscribe', async (req, res) => {
    if (!univapay.enabled()) return res.status(503).json({ error: '決済が未設定です（運営にお問い合わせください）' });
    const { transaction_token_id } = req.body || {};
    if (!transaction_token_id) return res.status(400).json({ error: 'transaction_token_id が必要です' });
    const plan = billing.ensureDefaultPlan(db);
    const r = await univapay.createSubscription({ transactionTokenId: transaction_token_id, amount: plan.amount, metadata: { tenant_id: req.tenant.id } });
    if (!r.ok || !r.json) {
      logger.warn('univapay subscribe failed', { tenant_id: req.tenant.id, status: r.status });
      return res.status(502).json({ error: '決済の作成に失敗しました', detail: r.json || r.text });
    }
    const status = univapay.normalizeStatus(r.json.status);
    billing.upsertSubscription(db, { tenantId: req.tenant.id, planId: plan.id, univapaySubId: r.json.id, status });
    billing.syncTenantStatus(db, req.tenant.id);
    logger.info('subscription created', { tenant_id: req.tenant.id, status });
    res.json({ ok: true, status });
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
    res.status(201).json(steps.createCampaign(db, req.tenant.id, { name: b.name, media: b.media, active: b.active }));
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
    res.json({ ok: true });
  });
  api.put('/friends/:id/birthday', (req, res) => {
    const r = birthday.setBirthday(db, req.tenant.id, req.params.id, (req.body && req.body.birthday) || null);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });
  api.post('/friends/:id/message', async (req, res) => {
    const text = (req.body && req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'テキストは必須です' });
    if (text.length > 2000) return res.status(400).json({ error: 'メッセージは2000字以内にしてください' });
    const r = await friends.pushToFriend(db, req.tenant, req.params.id, text);
    if (r.error) return res.status(400).json(r);
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
    const r = await richmenu.createAndDeploy(db, req.tenant, {
      name: b.name, template: b.template, chatBarText: b.chat_bar_text, cells: b.cells,
      imageBuffer, contentType: m[1],
    });
    if (r.error) return res.status(400).json(r);
    res.status(201).json(r);
  });
  api.post('/richmenus/:id/activate', async (req, res) => {
    const r = await richmenu.activate(db, req.tenant, req.params.id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });
  api.delete('/richmenus/:id', async (req, res) => res.json(await richmenu.remove(db, req.tenant, req.params.id)));

  // ---- 業種別プリセット（テナント） ----
  api.get('/presets', (req, res) => res.json(presets.listPresets()));
  api.post('/presets/apply', (req, res) => {
    const b = req.body || {};
    const r = presets.applyPreset(db, req.tenant, b.industry, { applySteps: b.apply_steps !== false, applyAutoreplies: b.apply_autoreplies !== false });
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  // ---- KPI分析（テナント） ----
  api.get('/analytics/summary', (req, res) => {
    res.json(analytics.getSummary(db, req.tenant.id));
  });
  api.get('/analytics/trend', (req, res) => {
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

  admin.post('/tenants/:id/:action', (req, res) => {
    const { id, action } = req.params;
    if (!['suspend', 'activate'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    const status = action === 'suspend' ? 'suspended' : 'active';
    const info = db.prepare("UPDATE tenants SET status = ?, updated_at = ? WHERE id = ? AND role='tenant'").run(status, Date.now(), id);
    res.json({ updated: info.changes, status });
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
  // UnivaPay Webhook（サブスク状態の同期）
  // =====================================================================
  app.post('/webhook/univapay', express.json({ type: '*/*' }), (req, res) => {
    if (!univapay.verifyWebhook(req)) return res.status(401).send('invalid');
    const body = req.body || {};
    const data = body.data || body;
    const subId = data.subscription_id || (data.id && (body.type || '').includes('subscription') ? data.id : data.subscription_id) || data.id;
    try {
      if (subId) {
        const sub = db.prepare('SELECT * FROM subscriptions WHERE univapay_subscription_id = ?').get(subId);
        if (sub) {
          if (data.status) billing.upsertSubscription(db, { tenantId: sub.tenant_id, univapaySubId: subId, status: univapay.normalizeStatus(data.status) });
          if (data.charge_id || data.id) billing.recordPayment(db, { tenantId: sub.tenant_id, subscriptionId: sub.id, chargeId: data.charge_id || null, amount: data.amount || null, status: data.status || (body.type || null), raw: body });
          billing.syncTenantStatus(db, sub.tenant_id);
          logger.info('univapay webhook', { type: body.type, sub: subId });
        }
      }
    } catch (e) { logger.error('univapay webhook error', { err: String((e && e.message) || e) }); }
    res.status(200).end();
  });

  // =====================================================================
  // 画面（静的）
  // =====================================================================
  app.use('/assets', express.static(path.join(PUB, 'assets')));
  app.get('/', (req, res) => sendPage(res, 'index.html'));
  app.get('/login', (req, res) => sendPage(res, 'login.html'));
  app.get('/signup', (req, res) => sendPage(res, 'signup.html'));
  app.get('/guide', (req, res) => sendPage(res, 'guide.html'));
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
