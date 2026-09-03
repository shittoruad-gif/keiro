'use strict';

/**
 * クローラー（bot）判定。
 *
 * 計測リンクをSNSに貼ると、人が押す前にプラットフォーム側のプレビュー取得が走る。
 * 2026-09-03の実測では、Moveactの計測リンク2,582クリックのうち **98.7%（2,548件）が
 * facebookexternalhit 等のbot** だった。これを人のクリックと混ぜると、
 * 「2,582クリックで登録2件」のような実態とかけ離れた数字になる。
 *
 * いまはこの判定を「友だち追加とクリックの突合」でのみ使う。
 * bot のクリックを突合候補に入れると、人が押したクリックではなく
 * 直前のプレビュー取得に紐づいてしまうため。
 * （ダッシュボードのクリック数表示は現状のまま。表示の扱いは別途判断する）
 */
const BOT_UA_RE =
  /facebookexternalhit|meta-externalagent|curl|wget|bot\b|crawler|spider|preview|python-requests|okhttp|Go-http|node-fetch|axios|HeadlessChrome|Slackbot|Twitterbot|LinkedInBot|Discordbot|WhatsApp|TelegramBot|Applebot|bingbot|Googlebot/i;

/** UA文字列が bot と判定できるか（UAが無い場合も bot 扱い＝人のタップとは見なさない） */
function isBotUa(ua) {
  const s = String(ua || '');
  if (!s.trim()) return true;
  return BOT_UA_RE.test(s);
}

module.exports = { isBotUa, BOT_UA_RE };
