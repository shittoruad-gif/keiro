'use strict';

// 認証: パスワードハッシュ(scrypt) と JWT(HS256) を Node 標準 crypto で実装（依存追加なし）。
const crypto = require('crypto');
const config = require('./config');

const SESSION_COOKIE = 'keiro_session';
const JWT_TTL_SEC = 60 * 60 * 24 * 7; // 7日

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }
function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function timingEq(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ---- パスワード ----
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}
function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt:')) return false;
  const [, saltB, hashB] = stored.split(':');
  const salt = Buffer.from(saltB, 'base64');
  const expected = Buffer.from(hashB, 'base64');
  const actual = crypto.scryptSync(String(plain), salt, expected.length);
  return timingEq(actual, expected);
}

// ---- JWT (HS256) ----
function signJwt(payload, ttlSec = JWT_TTL_SEC) {
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({ iat: now, exp: now + ttlSec }, payload);
  const head = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const data = `${head}.${b64urlJson(body)}`;
  const sig = b64url(crypto.createHmac('sha256', config.secret).update(data).digest());
  return `${data}.${sig}`;
}
function verifyJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = b64url(crypto.createHmac('sha256', config.secret).update(data).digest());
  if (!timingEq(parts[2], expected)) return null;
  let body;
  try { body = JSON.parse(fromB64url(parts[1]).toString('utf8')); } catch { return null; }
  if (!body || typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

// ---- Expressミドルウェア（dbを束ねて返す） ----
function makeAuth(db) {
  function readToken(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) return m[1];
    return (req.cookies && req.cookies[SESSION_COOKIE]) || null;
  }

  function loadTenant(req) {
    const payload = verifyJwt(readToken(req));
    if (!payload || !payload.sub) return null;
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(payload.sub);
    if (!t) return null;
    req.tenant = t;
    return t;
  }

  // ログイン必須。停止テナントは403。
  function requireAuth(req, res, next) {
    const t = loadTenant(req);
    if (!t) return res.status(401).json({ error: 'unauthorized' });
    if (t.status === 'suspended') return res.status(403).json({ error: 'suspended' });
    next();
  }

  // 運営(オペレーター)ロール必須
  function requireOperator(req, res, next) {
    const t = loadTenant(req);
    if (!t) return res.status(401).json({ error: 'unauthorized' });
    if (t.role !== 'operator') return res.status(403).json({ error: 'forbidden' });
    next();
  }

  return { requireAuth, requireOperator, loadTenant };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: JWT_TTL_SEC * 1000,
    path: '/',
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

module.exports = {
  SESSION_COOKIE, JWT_TTL_SEC,
  hashPassword, verifyPassword,
  signJwt, verifyJwt,
  makeAuth, setSessionCookie, clearSessionCookie,
};
