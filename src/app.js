'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const logger = require('./logger');
const { getIp, escapeHtml } = require('./util');
const { signToken, verifyToken, verifyLineSignature, newId } = require('./sign');
const { applyMatch } = require('./match');
const { replyGreeting } = require('./line');
const { dispatchPostbacks } = require('./postback');
const { createRateLimiter } = require('./ratelimit');

const CLAIM_TOKEN_MAX_AGE_SEC = 60 * 60 * 24 * 7; // claimリンクの有効期間（7日）

/** Basic認証ミドルウェア。/admin と /api で同一realmを使う。 */
function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (m) {
    const [user, pass] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (user === config.adminUser && pass === config.adminPass) return next();
  }
  res.set('WWW-Authenticate', `Basic realm="${config.authRealm}", charset="UTF-8"`);
  return res.status(401).send('Authentication required');
}

/**
 * Expressアプリを生成する。
 * @param {import('better-sqlite3').Database} db
 */
function createApp(db) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  const limiter = createRateLimiter(config.rateLimit);

  // ---- ヘルスチェック ----
  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true, ts: Date.now() });
    } catch (e) {
      logger.error('healthz db error', { err: String((e && e.message) || e) });
      res.status(503).json({ ok: false });
    }
  });

  // ---- 1) クリック計測 + リダイレクト ----
  app.get('/c/:linkId', limiter, cookieParser(), (req, res) => {
    const link = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.linkId);
    if (!link) return res.status(404).send('リンクが見つかりません');

    const q = req.query || {};
    const ip = getIp(req);
    const ua = req.headers['user-agent'] || null;
    const clickId = newId('clk');
    const now = Date.now();

    db.prepare(
      `INSERT INTO clicks
       (id, link_id, fp, ip, ua, fbclid, gclid, ttclid,
        utm_source, utm_medium, utm_campaign, utm_content, params_json, matched, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      clickId, link.id,
      null, ip, ua,
      q.fbclid || null, q.gclid || null, q.ttclid || null,
      q.utm_source || null, q.utm_medium || null, q.utm_campaign || null, q.utm_content || null,
      JSON.stringify(q), now
    );

    // クリックIDをCookieに保存（同一ブラウザ=主にPCのclaim時に利用）
    res.cookie('keiro_cid', clickId, {
      maxAge: config.matchWindowSec * 1000,
      httpOnly: false,
      sameSite: 'lax',
    });

    // 認証画面は挟まず、そのままLINE友だち追加URLへ
    return res.redirect(302, link.oa_add_url);
  });

  // ---- 2) LINE Webhook（raw bodyで署名検証）----
  app.post('/webhook', limiter, express.raw({ type: '*/*' }), (req, res) => {
    const signature = req.headers['x-line-signature'];
    const raw = req.body; // Buffer
    if (!verifyLineSignature(config.line.channelSecret, raw, signature)) {
      return res.status(401).send('invalid signature');
    }

    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
    } catch {
      return res.status(400).send('bad request');
    }

    // LINEには即200を返す。followの記録は同期で行い、返信(外部API)は非同期で行う。
    const events = (parsed && parsed.events) || [];
    const pendingReplies = [];
    for (const ev of events) {
      if (ev.type !== 'follow') continue;
      const lineUserId = ev.source && ev.source.userId;
      if (!lineUserId) continue;

      const followId = newId('flw');
      db.prepare(
        `INSERT INTO follows (id, line_user_id, fp, click_id, match_method, status, created_at, matched_at)
         VALUES (?, ?, NULL, NULL, NULL, 'pending', ?, NULL)`
      ).run(followId, lineUserId, Date.now());
      logger.info('follow received', { follow_id: followId });

      // claimトークン（HMAC署名付き・改ざん不可）
      const token = signToken(config.secret, { fid: followId, uid: lineUserId, iat: Date.now() });
      const claimUrl = `${config.baseUrl}/claim?t=${encodeURIComponent(token)}`;
      if (ev.replyToken) pendingReplies.push({ replyToken: ev.replyToken, claimUrl, followId });
    }

    res.status(200).end();

    // replyTokenは短命なので即時に（ただしレスポンス後に）処理する
    for (const r of pendingReplies) {
      replyGreeting(r.replyToken, r.claimUrl).then((rr) => {
        if (rr && !rr.ok && !rr.skipped) {
          logger.warn('line reply failed', { follow_id: r.followId, http_status: rr.http_status });
        }
      }).catch((e) => logger.error('line reply error', { follow_id: r.followId, err: String((e && e.message) || e) }));
    }
  });

  // ---- 3) claim 紐づけ + 完了画面 ----
  app.get('/claim', limiter, cookieParser(), async (req, res) => {
    const payload = verifyToken(config.secret, req.query.t, CLAIM_TOKEN_MAX_AGE_SEC);
    if (!payload || !payload.fid) {
      return res.status(400).send(renderClaimPage({ ok: false, message: '無効なリンクです。' }));
    }
    const follow = db.prepare('SELECT * FROM follows WHERE id = ?').get(payload.fid);
    if (!follow) {
      return res.status(404).send(renderClaimPage({ ok: false, message: '対象が見つかりません。' }));
    }

    // 既に紐づけ済みなら完了画面を返す（claimの二度押し対策）
    if (follow.status === 'matched') {
      return res.send(renderClaimPage({ ok: true, message: '登録は完了しています。' }));
    }

    const ip = getIp(req);
    const ua = req.headers['user-agent'] || null;
    const cookieClickId = (req.cookies && req.cookies.keiro_cid) || null;

    const result = applyMatch(db, follow, {
      cookieClickId,
      ip,
      nowMs: Date.now(),
      windowSec: config.matchWindowSec,
    });

    if (result.matched) {
      // 4) ポストバック送信
      const click = db.prepare('SELECT * FROM clicks WHERE id = ?').get(result.clickId);
      const link = click ? db.prepare('SELECT * FROM links WHERE id = ?').get(click.link_id) : null;
      try {
        await dispatchPostbacks(db, {
          follow, click, link, ip, ua,
          eventSourceUrl: `${config.baseUrl}/claim`,
        });
      } catch (e) {
        logger.error('claim postback error', { follow_id: follow.id, err: String((e && e.message) || e) });
      }
      logger.info('claim matched', { follow_id: follow.id, method: result.method });
      return res.send(renderClaimPage({ ok: true, message: '登録が完了しました。ありがとうございます！' }));
    }

    // 紐づかなくても利用者には完了として見せる（計測都合を見せない）
    return res.send(renderClaimPage({ ok: true, message: '登録が完了しました。ありがとうございます！' }));
  });

  // ---- 管理API（Basic認証）----
  const api = express.Router();
  api.use(basicAuth);
  api.use(express.json());

  api.get('/links', (req, res) => {
    const rows = db.prepare(
      `SELECT l.*,
        (SELECT COUNT(*) FROM clicks c WHERE c.link_id = l.id) AS clicks,
        (SELECT COUNT(*) FROM follows f JOIN clicks c2 ON f.click_id = c2.id
           WHERE c2.link_id = l.id AND f.status = 'matched') AS follows
       FROM links l ORDER BY l.created_at DESC`
    ).all();
    res.json(rows.map((r) => ({
      ...r,
      track_url: `${config.baseUrl}/c/${r.id}`,
      cvr: r.clicks ? r.follows / r.clicks : 0,
    })));
  });

  api.post('/links', (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.oa_add_url) {
      return res.status(400).json({ error: 'name と oa_add_url は必須です' });
    }
    const id = newId('lnk');
    db.prepare(
      `INSERT INTO links (id, name, oa_add_url, media, campaign, creative, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, String(b.name), String(b.oa_add_url),
      b.media ? String(b.media) : null,
      b.campaign ? String(b.campaign) : null,
      b.creative ? String(b.creative) : null,
      Date.now()
    );
    res.status(201).json({ id, track_url: `${config.baseUrl}/c/${id}` });
  });

  api.delete('/links/:id', (req, res) => {
    const info = db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
    res.json({ deleted: info.changes });
  });

  api.get('/stats', (req, res) => {
    const clicks = db.prepare('SELECT COUNT(*) AS n FROM clicks').get().n;
    const follows = db.prepare('SELECT COUNT(*) AS n FROM follows').get().n;
    const matched = db.prepare("SELECT COUNT(*) AS n FROM follows WHERE status = 'matched'").get().n;
    const postbacksOk = db.prepare('SELECT COUNT(*) AS n FROM postbacks WHERE ok = 1').get().n;
    const postbacksTotal = db.prepare('SELECT COUNT(*) AS n FROM postbacks').get().n;
    res.json({
      clicks,
      follows,
      matched,
      match_rate: follows ? matched / follows : 0,
      postbacks_ok: postbacksOk,
      postbacks_total: postbacksTotal,
    });
  });

  api.get('/follows', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const rows = db.prepare(
      `SELECT f.id, f.line_user_id, f.status, f.match_method, f.created_at, f.matched_at,
              c.link_id, l.name AS link_name
       FROM follows f
       LEFT JOIN clicks c ON f.click_id = c.id
       LEFT JOIN links l ON c.link_id = l.id
       ORDER BY f.created_at DESC LIMIT ?`
    ).all(limit);
    // line_user_id は生で返さず先頭数文字のみ（管理画面表示用）
    res.json(rows.map((r) => ({
      ...r,
      line_user_id_short: r.line_user_id ? r.line_user_id.slice(0, 8) + '…' : null,
      line_user_id: undefined,
    })));
  });

  app.use('/api', api);

  // ---- 管理画面（Basic認証, 静的配信）----
  app.use('/admin', basicAuth, express.static(path.join(__dirname, '..', 'public', 'admin')));
  // /admin と /admin/ どちらでも index を返す
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
  });

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
  <div class="card">
    <div class="dot">${ok ? '✓' : '!'}</div>
    <p>${escapeHtml(message)}</p>
  </div>
</body></html>`;
}

module.exports = { createApp, getIp };
