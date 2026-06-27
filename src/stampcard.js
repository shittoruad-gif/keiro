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

function createCard(db, tenantId, { name, required_stamps, reward_text }) {
  if (!name || !reward_text) return { error: 'name と reward_text は必須です' };
  const id = newId('scd');
  const now = Date.now();
  db.prepare('INSERT INTO stamp_cards (id, tenant_id, name, required_stamps, reward_text, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, tenantId, name.slice(0, 100), Math.max(1, parseInt(required_stamps, 10) || 10), reward_text, now);
  return getCard(db, tenantId, id);
}

function updateCard(db, tenantId, id, data) {
  const sets = []; const args = [];
  if (data.name !== undefined) { sets.push('name=?'); args.push(String(data.name).slice(0, 100)); }
  if (data.required_stamps !== undefined) { sets.push('required_stamps=?'); args.push(Math.max(1, parseInt(data.required_stamps, 10) || 10)); }
  if (data.reward_text !== undefined) { sets.push('reward_text=?'); args.push(data.reward_text); }
  if (data.active !== undefined) { sets.push('active=?'); args.push(data.active ? 1 : 0); }
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
    await line.pushMessage(token, friend.line_user_id, [{ type: 'text', text: rewardMsg }]);
    logger.info('stamp completed', { tenant_id: tenant.id, card_id: cardId, friend_id: friendId });
    return { ok: true, stamps: 0, completed: true, required: card.required_stamps };
  } else {
    db.prepare('UPDATE stamp_records SET stamps=?, last_stamp_at=? WHERE card_id=? AND friend_id=?')
      .run(newStamps, now, cardId, friendId);
    const notifyMsg = `スタンプが押されました！\n現在 ${newStamps}/${card.required_stamps} スタンプ\n\nあと ${card.required_stamps - newStamps} 個で特典プレゼント🎁`;
    await line.pushMessage(token, friend.line_user_id, [{ type: 'text', text: notifyMsg }]);
    return { ok: true, stamps: newStamps, completed: false, required: card.required_stamps };
  }
}

module.exports = { listCards, createCard, updateCard, deleteCard, listRecords, addStamp };
