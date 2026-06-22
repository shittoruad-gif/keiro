'use strict';

// 依存を増やさない軽量な固定ウィンドウ レートリミッタ（IP単位）。
// 単一プロセス運用前提のインメモリ実装。
const { getIp } = require('./util');

function createRateLimiter({ windowSec, max }) {
  const windowMs = windowSec * 1000;
  /** @type {Map<string, {count:number, resetAt:number}>} */
  const buckets = new Map();

  // 期限切れバケットの定期掃除（メモリリーク防止）
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = getIp(req) || 'unknown';
    let b = buckets.get(ip);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, b);
    }
    b.count++;
    const remaining = Math.max(0, max - b.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).send('Too Many Requests');
    }
    return next();
  };
}

module.exports = { createRateLimiter };
