'use strict';

/**
 * お店がLINE（しっとる通知ハブ）から送る商品の連絡を、運営の手を介さずに反映する。
 *
 * なぜ要るか:
 *   好み別のステップ配信や自動応答は、パンなどの商品を名前つきで紹介している。終売した商品の
 *   紹介が届いたり、新作の案内が無かったりすると、お店が困る（2026-10 ツラジマベーカリー様）。
 *   お店は管理画面を開かないので、LINEで一言送るだけで済むようにする。
 *
 *   終売 〇〇  … ①その名前を含むステップの通は送らずに飛ばす
 *               ②その商品だけを紹介する自動応答（1行目が「■ 〇〇」）は「販売を終了しました」に置き換える
 *               ③一覧の中の「・〇〇」の行は消す。②③は元の文面を控え、「再開」で戻す
 *   新作 〇〇  … その名前で自動応答を作る（説明・限定かどうかは続く行から）。写真は続けて送ってもらう
 *
 * 照合は空白を除いて行う（全角・半角の空白の違いでお店を困らせない）。
 */
const fs = require('fs');
const path = require('path');
const { newId } = require('./sign');

function normName(s) {
  return String(s || '').replace(/[\s　]/g, '').trim();
}

function list(db, tenantId) {
  return db.prepare('SELECT name, created_at FROM paused_products WHERE tenant_id = ? ORDER BY created_at').all(tenantId);
}

/** 本文が止めている商品のどれかを含めば、その商品名を返す。 */
function pausedIn(db, tenantId, text) {
  const body = normName(text);
  if (!body) return null;
  for (const p of list(db, tenantId)) if (p.name && body.includes(p.name)) return p.name;
  return null;
}

/** その商品名を含むステップの通の数（お店への返事で「何通止めたか」を伝える）。 */
function countStepMentions(db, tenantId, name) {
  const n = normName(name);
  if (!n) return 0;
  const rows = db.prepare(
    'SELECT m.text FROM step_messages m JOIN step_campaigns c ON c.id = m.campaign_id WHERE c.tenant_id = ?'
  ).all(tenantId);
  return rows.filter((r) => normName(r.text).includes(n)).length;
}

function endedText(displayName) {
  return `■ ${displayName}\n\n${displayName}は、販売を終了しました。\nほかのパンは、下のメニューからご覧いただけます。`;
}

/**
 * 自動応答の文面から、終売の商品を外した文面を作る。変えなくてよければ null。
 * 1行目が「■ 〇〇」の応答はその商品だけの紹介なので、丸ごと終売の案内にする。
 * それ以外は「・〇〇」の行だけを消す（一覧の中の1品）。
 */
function replyWithout(text, name, displayName) {
  const lines = String(text || '').split('\n');
  const first = (lines.find((l) => l.trim()) || '').trim();
  if (first.startsWith('■') && normName(first).includes(name)) return endedText(displayName);
  let changed = false;
  const kept = lines.filter((l) => {
    const t = l.trim();
    if ((t.startsWith('・') || t.startsWith('-')) && normName(t).includes(name)) { changed = true; return false; }
    return true;
  });
  return changed ? kept.join('\n') : null;
}

function pause(db, tenantId, rawName, now = Date.now()) {
  const name = normName(rawName);
  const displayName = String(rawName || '').trim();
  if (!name) return { ok: false };
  const exists = db.prepare('SELECT id FROM paused_products WHERE tenant_id = ? AND name = ?').get(tenantId, name);
  if (exists) return { ok: true, name, already: true, replies: 0, steps: countStepMentions(db, tenantId, name) };
  let replies = 0;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO paused_products (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)').run(newId('pp'), tenantId, name, now);
    const rules = db.prepare('SELECT id, reply_text FROM autoreplies WHERE tenant_id = ?').all(tenantId);
    for (const r of rules) {
      const next = replyWithout(r.reply_text, name, displayName);
      if (next === null || next === r.reply_text) continue;
      db.prepare('INSERT INTO product_reply_backups (id, tenant_id, product, autoreply_id, original_text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(newId('prb'), tenantId, name, r.id, r.reply_text, now);
      db.prepare('UPDATE autoreplies SET reply_text = ? WHERE id = ?').run(next, r.id);
      replies++;
    }
  });
  tx();
  return { ok: true, name, already: false, replies, steps: countStepMentions(db, tenantId, name) };
}

function resume(db, tenantId, rawName) {
  const name = normName(rawName);
  let restored = 0;
  let removed = 0;
  const tx = db.transaction(() => {
    removed = db.prepare('DELETE FROM paused_products WHERE tenant_id = ? AND name = ?').run(tenantId, name).changes;
    const backups = db.prepare('SELECT * FROM product_reply_backups WHERE tenant_id = ? AND product = ? ORDER BY created_at DESC').all(tenantId, name);
    for (const b of backups) {
      restored += db.prepare('UPDATE autoreplies SET reply_text = ? WHERE id = ? AND tenant_id = ?').run(b.original_text, b.autoreply_id, tenantId).changes;
    }
    db.prepare('DELETE FROM product_reply_backups WHERE tenant_id = ? AND product = ?').run(tenantId, name);
  });
  tx();
  return { ok: removed > 0, name, restored };
}

/**
 * 「新作 〇〇\n説明…\n限定（期間）」から自動応答を作る（同じ名前があれば文面を更新）。
 * 部分一致は先に作ったルールが勝つため、既存のどのルールより前の created_at にして、
 * 新作の名前を含む問い合わせには新作の案内が返るようにする。
 */
function addNew(db, tenantId, text, now = Date.now()) {
  const body = String(text || '').replace(/^新作[\s　:：、]*/, '').trim();
  const lines = body.split('\n').map((l) => l.trim().replace(/^[・\-]\s*/, '')).filter(Boolean);
  const displayName = (lines.shift() || '').replace(/[（(].*$/, '').trim();
  const name = normName(displayName);
  if (!name) return { ok: false };
  const limited = /限定|季節|期間/.test(body);
  const desc = lines.filter((l) => !/^(定番|限定|期間限定|季節限定)$/.test(l)).join('\n');
  const reply = `■ ${displayName}\n\n${desc ? desc + '\n\n' : ''}`
    + (limited ? '限定のパンです。並ぶ日や数が決まっています。売り切れの際はご容赦ください。' : '毎日お店に並びます。売り切れの際はご容赦ください。');

  // 終売にしていた名前なら、終売を解除してから作る
  if (db.prepare('SELECT 1 FROM paused_products WHERE tenant_id = ? AND name = ?').get(tenantId, name)) resume(db, tenantId, displayName);

  const minAt = (db.prepare('SELECT MIN(created_at) m FROM autoreplies WHERE tenant_id = ?').get(tenantId) || {}).m;
  const at = minAt ? minAt - 1 : now;
  const ex = db.prepare("SELECT id FROM autoreplies WHERE tenant_id = ? AND keyword = ? AND match_type = 'contains'").get(tenantId, displayName);
  let autoreplyId;
  if (ex) {
    db.prepare('UPDATE autoreplies SET reply_text = ?, active = 1 WHERE id = ?').run(reply, ex.id);
    autoreplyId = ex.id;
  } else {
    autoreplyId = newId('ar');
    db.prepare("INSERT INTO autoreplies (id, tenant_id, keyword, match_type, reply_text, active, created_at) VALUES (?, ?, ?, 'contains', ?, 1, ?)")
      .run(autoreplyId, tenantId, displayName, reply, at);
  }
  const id = newId('np');
  db.prepare('INSERT INTO new_products (id, tenant_id, name, display_name, limited, autoreply_id, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(id, tenantId, name, displayName, limited ? 1 : 0, autoreplyId, now);
  return { ok: true, id, name, displayName, limited, reply, updated: !!ex };
}

const MEDIA_RE = /^[a-z0-9_]+\.(jpg|png)$/;

function mediaDir() {
  const config = require('./config');
  return path.join(path.dirname(path.resolve(config.dbPath || './data/keiro.db')), 'media');
}

/**
 * お店がLINEで送った写真を保存し、直近48時間の新作（写真まだ）に付ける。
 * LINEの画像メッセージは1枚10MBまで・プレビューは1MBまでのため、1MBを超える写真は付けずに運営へ回す。
 */
function attachImage(db, tenantId, buf, contentType, now = Date.now()) {
  const ext = /png/.test(contentType || '') ? 'png' : 'jpg';
  if (!buf || !buf.length) return { ok: false, reason: 'empty' };
  if (buf.length > 10 * 1024 * 1024) return { ok: false, reason: 'too_large' };
  const dir = mediaDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${newId('img').toLowerCase()}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  const config = require('./config');
  const url = `${config.baseUrl}/media/${file}`;
  const np = db.prepare('SELECT * FROM new_products WHERE tenant_id = ? AND image_url IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId, now - 48 * 3600 * 1000);
  if (!np) return { ok: true, url, product: null };
  if (buf.length > 1024 * 1024) return { ok: true, url, product: np.display_name, attached: false, reason: 'over_1mb' };
  db.prepare('UPDATE new_products SET image_url = ? WHERE id = ?').run(url, np.id);
  if (np.autoreply_id) db.prepare('UPDATE autoreplies SET image_url = ? WHERE id = ?').run(url, np.autoreply_id);
  return { ok: true, url, product: np.display_name, attached: true };
}

module.exports = { normName, list, pause, resume, pausedIn, countStepMentions, replyWithout, addNew, attachImage, mediaDir, MEDIA_RE };
