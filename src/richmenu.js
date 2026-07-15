'use strict';

// リッチメニュー（LINEチャット下部メニュー）。テンプレ＋ボタン設定＋画像から作成・配信。
const logger = require('./logger');
const trackurl = require('./trackurl');
const config = require('./config');
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const line = require('./line');

const FULL = { width: 2500, height: 1686 };
const COMPACT = { width: 2500, height: 843 };

// テンプレ：セルの座標(px)。クライアントは同じ座標でCanvas画像を生成する。
const TEMPLATES = {
  'full-1': { name: 'フル・1ボタン', size: FULL, cells: [{ x: 0, y: 0, w: 2500, h: 1686 }] },
  'full-2col': { name: 'フル・左右2分割', size: FULL, cells: [{ x: 0, y: 0, w: 1250, h: 1686 }, { x: 1250, y: 0, w: 1250, h: 1686 }] },
  'full-2row': { name: 'フル・上下2分割', size: FULL, cells: [{ x: 0, y: 0, w: 2500, h: 843 }, { x: 0, y: 843, w: 2500, h: 843 }] },
  'full-3col': { name: 'フル・横3分割', size: FULL, cells: [{ x: 0, y: 0, w: 833, h: 1686 }, { x: 833, y: 0, w: 834, h: 1686 }, { x: 1667, y: 0, w: 833, h: 1686 }] },
  'full-4': { name: 'フル・4分割(2×2)', size: FULL, cells: [{ x: 0, y: 0, w: 1250, h: 843 }, { x: 1250, y: 0, w: 1250, h: 843 }, { x: 0, y: 843, w: 1250, h: 843 }, { x: 1250, y: 843, w: 1250, h: 843 }] },
  'full-6': { name: 'フル・6分割(2×3)', size: FULL, cells: [
    { x: 0, y: 0, w: 1250, h: 562 }, { x: 1250, y: 0, w: 1250, h: 562 },
    { x: 0, y: 562, w: 1250, h: 562 }, { x: 1250, y: 562, w: 1250, h: 562 },
    { x: 0, y: 1124, w: 1250, h: 562 }, { x: 1250, y: 1124, w: 1250, h: 562 }] },
  'full-6-3x2': { name: 'フル・6分割(3×2)', size: FULL, cells: [
    { x: 0, y: 0, w: 833, h: 843 }, { x: 833, y: 0, w: 834, h: 843 }, { x: 1667, y: 0, w: 833, h: 843 },
    { x: 0, y: 843, w: 833, h: 843 }, { x: 833, y: 843, w: 834, h: 843 }, { x: 1667, y: 843, w: 833, h: 843 }] },
  'compact-1': { name: 'コンパクト・1ボタン', size: COMPACT, cells: [{ x: 0, y: 0, w: 2500, h: 843 }] },
  'compact-2': { name: 'コンパクト・左右2分割', size: COMPACT, cells: [{ x: 0, y: 0, w: 1250, h: 843 }, { x: 1250, y: 0, w: 1250, h: 843 }] },
  'compact-3': { name: 'コンパクト・横3分割', size: COMPACT, cells: [{ x: 0, y: 0, w: 833, h: 843 }, { x: 833, y: 0, w: 834, h: 843 }, { x: 1667, y: 0, w: 833, h: 843 }] },
};

function templatesForClient() {
  return Object.keys(TEMPLATES).map((key) => ({ key, name: TEMPLATES[key].name, size: TEMPLATES[key].size, cells: TEMPLATES[key].cells }));
}

/** テンプレのセルとセル設定(action)から、LINEのareas配列を作る（アクション未設定セルは除外）。 */
function buildAreas(templateKey, cells) {
  const tpl = TEMPLATES[templateKey];
  if (!tpl) return null;
  const areas = [];
  tpl.cells.forEach((bounds, i) => {
    const cell = (cells || [])[i] || {};
    const value = (cell.action_value || '').toString().trim();
    if (!value) return; // アクション未設定セルはタップ領域を作らない
    let action;
    if (cell.action_type === 'message') {
      action = { type: 'message', text: value.slice(0, 300) };
    } else {
      let uri = value;
      if (!/^https?:\/\//i.test(uri) && !/^tel:/i.test(uri)) uri = 'https://' + uri;
      action = { type: 'uri', uri };
      if (cell.label) action.label = String(cell.label).slice(0, 20);
    }
    areas.push({ bounds: { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h }, action });
  });
  return areas;
}

function listMenus(db, tenantId) {
  return db.prepare('SELECT id, name, template, chat_bar_text, status, audience_tag, created_at FROM rich_menus WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
}

/**
 * リッチメニューを作成→画像アップ→デフォルト設定→保存。
 * @param {object} p {name, template, chatBarText, cells, imageBuffer, contentType}
 */
async function createAndDeploy(db, tenant, p) {
  const tpl = TEMPLATES[p.template];
  if (!tpl) return { error: '不正なテンプレートです' };
  // ボタン別タップ計測: リンク型セルは計測URL(/r/)で自動ラップ（tel:等は対象外）。
  // 同名・同宛先の計測URLがあれば再利用（再作成のたびに増殖させない）。
  const cells = (p.cells || []).map((c) => {
    if (!c || c.action_type === 'message') return c;
    const dest = String(c.action_value || '').trim();
    if (!/^https?:\/\//i.test(dest) && !(dest && !/^tel:/i.test(dest) && dest.includes('.'))) return c;
    if (/^tel:/i.test(dest)) return c;
    const full = /^https?:\/\//i.test(dest) ? dest : 'https://' + dest;
    if (full.startsWith(config.baseUrl + '/r/')) return c; // 既にラップ済み
    const name = `メニュー「${(c.label || 'ボタン').slice(0, 20)}」`;
    try {
      let tu = db.prepare('SELECT id FROM tracked_urls WHERE tenant_id=? AND name=? AND dest_url=?').get(tenant.id, name, full);
      if (!tu) {
        const created2 = trackurl.createUrl(db, tenant.id, { name, destUrl: full });
        if (created2.error) return c;
        tu = { id: created2.id };
      }
      return { ...c, action_value: `${config.baseUrl}/r/${tu.id}`, dest_url: full, track_url_id: tu.id };
    } catch { return c; }
  });
  p = { ...p, cells };
  const areas = buildAreas(p.template, p.cells);
  if (!areas || !areas.length) return { error: 'ボタンを1つ以上設定してください' };
  if (!p.imageBuffer || !p.imageBuffer.length) return { error: '画像がありません' };

  const token = resolveSettings(tenant).line.channelAccessToken;
  if (!token) return { error: 'LINEのアクセストークンが未設定です（連携設定で登録してください）' };

  const menuObject = {
    size: tpl.size,
    selected: true,
    name: (p.name || 'メニュー').slice(0, 300),
    chatBarText: (p.chatBarText || 'メニュー').slice(0, 14),
    areas,
  };

  const created = await line.createRichMenu(token, menuObject);
  if (!created.ok || !created.richMenuId) return { error: 'LINEでの作成に失敗しました', detail: created.response };
  const rid = created.richMenuId;

  const up = await line.uploadRichMenuImage(token, rid, p.imageBuffer, p.contentType || 'image/png');
  if (!up.ok) { await line.deleteRichMenu(token, rid); return { error: '画像アップロードに失敗しました', detail: up.response }; }

  const audienceTag = (p.audienceTag || '').trim() || null;
  if (audienceTag) {
    // タグ別メニュー: デフォルトにはせず、該当タグの友だちへ個別リンク
    const users = db.prepare(
      "SELECT line_user_id FROM friends WHERE tenant_id=? AND status='active' AND (',' || IFNULL(tags,'') || ',') LIKE ?"
    ).all(tenant.id, '%,' + audienceTag + ',%').map((r) => r.line_user_id);
    for (let i = 0; i < users.length; i += 500) {
      await line.bulkLinkRichMenu(token, users.slice(i, i + 500), rid);
    }
    // 同タグの旧メニューをinactiveに
    db.prepare("UPDATE rich_menus SET status='inactive', updated_at=? WHERE tenant_id=? AND status='active' AND audience_tag=?")
      .run(Date.now(), tenant.id, audienceTag);
  } else {
    const def = await line.setDefaultRichMenu(token, rid);
    if (!def.ok) { await line.deleteRichMenu(token, rid); return { error: 'デフォルト設定に失敗しました', detail: def.response }; }
    // 既存のデフォルト(タグ無し)activeをinactiveに（LINE側は新しいデフォルトで上書き済み）
    db.prepare("UPDATE rich_menus SET status='inactive', updated_at=? WHERE tenant_id=? AND status='active' AND audience_tag IS NULL")
      .run(Date.now(), tenant.id);
  }

  const id = newId('rmn');
  const now = Date.now();
  db.prepare(
    `INSERT INTO rich_menus (id, tenant_id, name, template, chat_bar_text, line_rich_menu_id, config_json, status, audience_tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(id, tenant.id, menuObject.name, p.template, menuObject.chatBarText, rid, JSON.stringify({ cells: p.cells || [] }), audienceTag, now, now);
  logger.info('richmenu deployed', { tenant_id: tenant.id, id, rid, audience_tag: audienceTag });
  return { ok: true, id, line_rich_menu_id: rid, audience_tag: audienceTag };
}

/**
 * タグ変更時にその友だちへ該当タグのメニューを適用（無ければデフォルトに戻す）。
 * 会話ボットのタグ付与・手動タグ編集の直後に呼ぶ。失敗しても本処理は止めない。
 */
async function applyMenuForUser(db, tenant, lineUserId) {
  try {
    const token = resolveSettings(tenant).line.channelAccessToken;
    if (!token) return;
    const friend = db.prepare('SELECT tags FROM friends WHERE tenant_id=? AND line_user_id=?').get(tenant.id, lineUserId);
    const tags = ((friend && friend.tags) || '').split(',').map((s) => s.trim()).filter(Boolean);
    const menus = db.prepare(
      "SELECT line_rich_menu_id, audience_tag FROM rich_menus WHERE tenant_id=? AND status='active' AND audience_tag IS NOT NULL ORDER BY created_at DESC"
    ).all(tenant.id);
    const match = menus.find((m) => tags.includes(m.audience_tag));
    if (match) await line.linkRichMenuToUser(token, lineUserId, match.line_rich_menu_id);
    else await line.unlinkRichMenuFromUser(token, lineUserId);
  } catch (e) {
    logger.warn('applyMenuForUser failed', { err: String((e && e.message) || e) });
  }
}

async function activate(db, tenant, id) {
  const m = db.prepare('SELECT * FROM rich_menus WHERE id=? AND tenant_id=?').get(id, tenant.id);
  if (!m || !m.line_rich_menu_id) return { error: 'not found' };
  const token = resolveSettings(tenant).line.channelAccessToken;
  const def = await line.setDefaultRichMenu(token, m.line_rich_menu_id);
  if (!def.ok) return { error: '有効化に失敗しました', detail: def.response };
  db.prepare("UPDATE rich_menus SET status='inactive', updated_at=? WHERE tenant_id=? AND status='active'").run(Date.now(), tenant.id);
  db.prepare("UPDATE rich_menus SET status='active', updated_at=? WHERE id=?").run(Date.now(), id);
  return { ok: true };
}

async function remove(db, tenant, id) {
  const m = db.prepare('SELECT * FROM rich_menus WHERE id=? AND tenant_id=?').get(id, tenant.id);
  if (!m) return { deleted: 0 };
  const token = resolveSettings(tenant).line.channelAccessToken;
  if (m.line_rich_menu_id) {
    if (m.status === 'active') await line.clearDefaultRichMenu(token);
    await line.deleteRichMenu(token, m.line_rich_menu_id);
  }
  db.prepare('DELETE FROM rich_menus WHERE id=? AND tenant_id=?').run(id, tenant.id);
  return { deleted: 1 };
}

module.exports = { TEMPLATES, templatesForClient, buildAreas, listMenus, createAndDeploy, activate, remove, applyMenuForUser };
