'use strict';

/**
 * 計測リンクと、それに紐づく依存データを削除する。
 * FK整合のため postbacks → follows → clicks → links の順に削除する。
 * @returns {{deleted:number, clicks:number}}
 */
function deleteLinkCascade(db, id) {
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM postbacks WHERE follow_id IN (
         SELECT f.id FROM follows f JOIN clicks c ON f.click_id = c.id WHERE c.link_id = ?)`
    ).run(id);
    db.prepare(
      `DELETE FROM follows WHERE click_id IN (SELECT id FROM clicks WHERE link_id = ?)`
    ).run(id);
    const clicks = db.prepare('DELETE FROM clicks WHERE link_id = ?').run(id).changes;
    const deleted = db.prepare('DELETE FROM links WHERE id = ?').run(id).changes;
    return { deleted, clicks };
  });
  return tx();
}

module.exports = { deleteLinkCascade };
