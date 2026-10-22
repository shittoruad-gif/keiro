'use strict';

// スタンプカード。スタッフがダッシュボードからスタンプを付与→規定数で報酬メッセージをLINE送信。
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const line = require('./line');
const logger = require('./logger');

function getCard(db, tenantId, id) {
  return db.prepare('SELECT * FROM stamp_cards WHERE id=? AND tenant_id=?').get(id, tenantId);
}

function listCards(db, tenantId) {
  return db.prepare('SELECT * FROM stamp_cards WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId);
}

function createCard(db, tenantId, data) {
  const { name, required_stamps, reward_text } = data || {};
  if (!name || !reward_text) return { error: 'name と reward_text は必須です' };
  const id = newId('scd');
  const now = Date.now();
  db.prepare('INSERT INTO stamp_cards (id, tenant_id, name, required_stamps, reward_text, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, tenantId, name.slice(0, 100), Math.max(1, parseInt(required_stamps, 10) || 10), reward_text, now);
  const extra = updateCard(db, tenantId, id, pickVisitFields(data));
  if (extra && extra.error) { db.prepare('DELETE FROM stamp_cards WHERE id=?').run(id); return extra; }
  return getCard(db, tenantId, id);
}

// 来店カード（受付のQR）の設定項目だけを取り出す
function pickVisitFields(data) {
  const out = {};
  for (const k of ['trigger_keyword', 'min_interval_hours', 'first_tag', 'first_campaign_id', 'style', 'logo_url']) {
    if (data && data[k] !== undefined) out[k] = data[k];
  }
  return out;
}

function updateCard(db, tenantId, id, data) {
  const sets = []; const args = [];
  if (data.name !== undefined) { sets.push('name=?'); args.push(String(data.name).slice(0, 100)); }
  if (data.required_stamps !== undefined) { sets.push('required_stamps=?'); args.push(Math.max(1, parseInt(data.required_stamps, 10) || 10)); }
  if (data.reward_text !== undefined) { sets.push('reward_text=?'); args.push(data.reward_text); }
  if (data.active !== undefined) { sets.push('active=?'); args.push(data.active ? 1 : 0); }
  if (data.trigger_keyword !== undefined) {
    const kw = data.trigger_keyword ? String(data.trigger_keyword).trim().slice(0, 60) : null;
    if (kw) {
      const dup = db.prepare('SELECT id FROM stamp_cards WHERE tenant_id=? AND trigger_keyword=? AND id<>?').get(tenantId, kw, id);
      if (dup) return { error: 'この合言葉はほかのカードで使われています' };
    }
    sets.push('trigger_keyword=?'); args.push(kw);
  }
  if (data.min_interval_hours !== undefined) { const h = parseInt(data.min_interval_hours, 10); sets.push('min_interval_hours=?'); args.push(h > 0 ? Math.min(h, 24 * 30) : null); }
  if (data.first_tag !== undefined) { sets.push('first_tag=?'); args.push(data.first_tag ? String(data.first_tag).trim().slice(0, 40) : null); }
  if (data.first_campaign_id !== undefined) { sets.push('first_campaign_id=?'); args.push(data.first_campaign_id || null); }
  if (data.style !== undefined) { sets.push('style=?'); args.push(data.style === 'poker' ? 'poker' : null); }
  if (data.logo_url !== undefined) {
    const u = data.logo_url ? String(data.logo_url).trim() : '';
    if (u && !/^https:\/\//.test(u)) return { error: 'ロゴはhttpsのURLで指定してください' };
    sets.push('logo_url=?'); args.push(u || null);
  }
  if (!sets.length) return getCard(db, tenantId, id);
  sets.push('updated_at=?'); args.push(Date.now());
  args.push(id, tenantId);
  db.prepare(`UPDATE stamp_cards SET ${sets.join(',')} WHERE id=? AND tenant_id=?`).run(...args);
  return getCard(db, tenantId, id);
}

function deleteCard(db, tenantId, id) {
  if (!getCard(db, tenantId, id)) return { deleted: 0 };
  db.prepare('DELETE FROM stamp_records WHERE card_id=? AND tenant_id=?').run(id, tenantId);
  return { deleted: db.prepare('DELETE FROM stamp_cards WHERE id=? AND tenant_id=?').run(id, tenantId).changes };
}

function listRecords(db, tenantId, cardId) {
  return db.prepare(
    `SELECT sr.id, sr.stamps, sr.completed, sr.last_stamp_at, sr.created_at,
            f.id AS friend_id, f.display_name
     FROM stamp_records sr
     LEFT JOIN friends f ON sr.friend_id = f.id
     WHERE sr.card_id=? AND sr.tenant_id=?
     ORDER BY sr.last_stamp_at DESC LIMIT 200`
  ).all(cardId, tenantId);
}

/** スタンプを1つ追加。規定数達成で報酬メッセージ送信＆リセット。 */
async function addStamp(db, tenant, { cardId, friendId }) {
  const card = getCard(db, tenant.id, cardId);
  if (!card) return { error: 'カードが見つかりません' };
  if (!card.active) return { error: 'このカードは現在無効です' };

  const friend = db.prepare('SELECT * FROM friends WHERE id=? AND tenant_id=?').get(friendId, tenant.id);
  if (!friend) return { error: '友だちが見つかりません' };

  const token = resolveSettings(tenant).line.channelAccessToken;
  if (!token) return { error: 'LINEアクセストークンが未設定です' };

  let rec = db.prepare('SELECT * FROM stamp_records WHERE card_id=? AND friend_id=?').get(cardId, friendId);
  const now = Date.now();
  if (!rec) {
    const rid = newId('srec');
    db.prepare('INSERT INTO stamp_records (id, card_id, tenant_id, friend_id, stamps, completed, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(rid, cardId, tenant.id, friendId, now);
    rec = db.prepare('SELECT * FROM stamp_records WHERE card_id=? AND friend_id=?').get(cardId, friendId);
  }

  const newStamps = rec.stamps + 1;
  if (newStamps >= card.required_stamps) {
    db.prepare('UPDATE stamp_records SET stamps=0, completed=completed+1, last_stamp_at=? WHERE card_id=? AND friend_id=?')
      .run(now, cardId, friendId);
    const rewardMsg = `🎉 スタンプカード達成おめでとうございます！\n\n${card.reward_text}\n\n次回ご来院時にスタッフへお声がけください😊`;
    await line.pushMessage(token, friend.line_user_id, rewardMsg);
    logger.info('stamp completed', { tenant_id: tenant.id, card_id: cardId, friend_id: friendId });
    return { ok: true, stamps: 0, completed: true, required: card.required_stamps };
  } else {
    db.prepare('UPDATE stamp_records SET stamps=?, last_stamp_at=? WHERE card_id=? AND friend_id=?')
      .run(newStamps, now, cardId, friendId);
    const notifyMsg = `スタンプが押されました！\n現在 ${newStamps}/${card.required_stamps} スタンプ\n\nあと ${card.required_stamps - newStamps} 個で特典プレゼント🎁`;
    await line.pushMessage(token, friend.line_user_id, notifyMsg);
    return { ok: true, stamps: newStamps, completed: false, required: card.required_stamps };
  }
}

// =====================================================================
// 来店カード（2026-10-22 BORDER様）
//   受付のQR（line.me/R/oaMessage/@OA/?合言葉）を読んだお客様が合言葉を送る → ポイント1つ
//   ・min_interval_hours 以内の2回目は増やさない（1日1回の目安＝12時間）
//   ・初めてポイントが付いた人に目印（first_tag）を付け、ステップ配信（first_campaign_id）へ登録
//     （BORDER様: 目印「来店」→ 翌日に「2回目のご来店 入店料無料」のクーポン）
//   ・required_stamps でたまったら 0 に戻し、特典を1回分（completed）足す。特典は来店カードの画面で
//     店員が「使用済みにする」を押して使う（5分以内なら取り消せる）
//   返事は reply（通数を使わない）。本文の {card} は app.js 側で友だち別の来店カードURLに置き換える。
// =====================================================================
const UNDO_MS = 5 * 60 * 1000;

function findVisitCard(db, tenantId, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  return db.prepare('SELECT * FROM stamp_cards WHERE tenant_id=? AND active=1 AND trigger_keyword=?').get(tenantId, t) || null;
}

/** お店の来店カード（画面に出す1枚）。合言葉のあるカードを優先。 */
function getVisitCard(db, tenantId) {
  return db.prepare("SELECT * FROM stamp_cards WHERE tenant_id=? AND active=1 ORDER BY (trigger_keyword IS NULL OR trigger_keyword=''), created_at LIMIT 1").get(tenantId) || null;
}

function getRecord(db, cardId, friendId) {
  return db.prepare('SELECT * FROM stamp_records WHERE card_id=? AND friend_id=?').get(cardId, friendId) || null;
}

const fmtNext = (ms) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Tokyo' });

/**
 * 合言葉でポイントを付ける。合言葉でなければ null。
 * @returns {{text:string, status:'added'|'completed'|'too_soon'|'not_friend', stamps?:number, first?:boolean}|null}
 */
function visitByKeyword(db, tenant, lineUserId, text, { now = Date.now() } = {}) {
  const card = findVisitCard(db, tenant.id, text);
  if (!card) return null;
  const friend = lineUserId ? db.prepare('SELECT id FROM friends WHERE tenant_id=? AND line_user_id=?').get(tenant.id, lineUserId) : null;
  if (!friend) return { status: 'not_friend', text: '来店ポイントは、公式LINEを友だち追加してから付けられます。\n友だち追加のあと、もう一度受付のQRを読み取ってください。' };
  const req = card.required_stamps;
  const reward = card.reward_text;
  const gap = (card.min_interval_hours || 0) * 3600000;
  const r = db.transaction(() => {
    let rec = getRecord(db, card.id, friend.id);
    if (!rec) {
      db.prepare('INSERT INTO stamp_records (id, card_id, tenant_id, friend_id, stamps, completed, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
        .run(newId('srec'), card.id, tenant.id, friend.id, now);
      rec = getRecord(db, card.id, friend.id);
    }
    if (gap && rec.last_stamp_at && now - rec.last_stamp_at < gap) return { status: 'too_soon', rec };
    let stamps = rec.stamps + 1; let completed = rec.completed; let status = 'added';
    if (stamps >= req) { stamps = 0; completed += 1; status = 'completed'; }
    const total = (rec.total_stamps || 0) + 1;
    db.prepare('UPDATE stamp_records SET stamps=?, completed=?, total_stamps=?, last_stamp_at=? WHERE id=?')
      .run(stamps, completed, total, now, rec.id);
    return { status, stamps, first: total === 1, rec };
  })();
  if (r.status === 'too_soon') {
    const h = card.min_interval_hours;
    return { status: 'too_soon', text: `今回の来店ポイントは、すでにお付けしています（${h}時間に1回まで）。\n次は ${fmtNext(r.rec.last_stamp_at + gap)} 以降に付きます。\n\n▼ 来店カードを見る\n{card}` };
  }
  // 初めてのポイント → 目印とステップ配信（2回目のクーポンなど）
  if (r.first) {
    try {
      if (card.first_tag) {
        const fr = db.prepare('SELECT id, tags FROM friends WHERE id=?').get(friend.id);
        const set = new Set(String(fr.tags || '').split(',').map((x) => x.trim()).filter(Boolean));
        if (!set.has(card.first_tag)) { set.add(card.first_tag); require('./friends').setTags(db, tenant.id, friend.id, Array.from(set)); }
      }
      if (card.first_campaign_id) require('./steps').enrollInCampaign(db, { tenantId: tenant.id, lineUserId, campaignId: card.first_campaign_id });
    } catch (e) { logger.error('visit first enroll error', { err: String((e && e.message) || e) }); }
  }
  logger.info('visit stamp', { tenant_id: tenant.id, card_id: card.id, status: r.status, first: !!r.first });
  if (r.status === 'completed') {
    return { status: 'completed', stamps: req, first: r.first,
      text: `ご来店ありがとうございます。来店ポイントが${req}個たまりました。\n「${reward}」をお使いいただけます。\nご利用の際は、受付で来店カードの画面をお見せください。\n\n▼ 来店カードを見る\n{card}` };
  }
  return { status: 'added', stamps: r.stamps, first: r.first,
    text: `ご来店ありがとうございます。来店ポイントを1つお付けしました。\n\n今のポイント：${r.stamps} / ${req}\nあと${req - r.stamps}回で${reward}\n\n▼ 来店カードを見る\n{card}` };
}

/** 来店カードの画面用：ポイント・使える特典の数・直近の使用（取り消せるか） */
function cardState(db, card, friendId, now = Date.now()) {
  const rec = friendId ? getRecord(db, card.id, friendId) : null;
  const available = rec ? Math.max(0, rec.completed - (rec.rewards_used || 0)) : 0;
  const last = rec ? db.prepare('SELECT * FROM stamp_reward_uses WHERE card_id=? AND friend_id=? AND undone_at IS NULL ORDER BY used_at DESC LIMIT 1').get(card.id, friendId) : null;
  return {
    stamps: rec ? rec.stamps : 0, total: rec ? (rec.total_stamps || 0) : 0, lastAt: rec ? rec.last_stamp_at : null,
    available, lastUse: last || null, canUndo: !!(last && now - last.used_at < UNDO_MS),
  };
}

/** 達成の特典を1回使う（店員がお客様の画面で押す） */
function useReward(db, tenantId, cardId, friendId) {
  return db.transaction(() => {
    const rec = db.prepare('SELECT * FROM stamp_records WHERE card_id=? AND friend_id=? AND tenant_id=?').get(cardId, friendId, tenantId);
    if (!rec || rec.completed - (rec.rewards_used || 0) <= 0) return { error: '使える特典がありません' };
    db.prepare('UPDATE stamp_records SET rewards_used = rewards_used + 1 WHERE id=?').run(rec.id);
    db.prepare('INSERT INTO stamp_reward_uses (id, tenant_id, card_id, friend_id, used_at) VALUES (?, ?, ?, ?, ?)')
      .run(newId('sru'), tenantId, cardId, friendId, Date.now());
    return { ok: true };
  })();
}

/** 押し間違いの取り消し（使ってから5分以内だけ） */
function undoReward(db, tenantId, cardId, friendId, now = Date.now()) {
  return db.transaction(() => {
    const last = db.prepare('SELECT * FROM stamp_reward_uses WHERE card_id=? AND friend_id=? AND tenant_id=? AND undone_at IS NULL ORDER BY used_at DESC LIMIT 1').get(cardId, friendId, tenantId);
    if (!last || now - last.used_at >= UNDO_MS) return { error: '取り消せるのは、使用済みにしてから5分以内です' };
    db.prepare('UPDATE stamp_reward_uses SET undone_at=? WHERE id=?').run(now, last.id);
    db.prepare('UPDATE stamp_records SET rewards_used = MAX(0, rewards_used - 1) WHERE card_id=? AND friend_id=?').run(cardId, friendId);
    return { ok: true };
  })();
}

module.exports = { listCards, createCard, updateCard, deleteCard, listRecords, addStamp,
  findVisitCard, getVisitCard, visitByKeyword, cardState, useReward, undoReward, UNDO_MS };
