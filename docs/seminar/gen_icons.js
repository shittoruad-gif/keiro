// react-icons を PNG に変換（緑丸の中に置く白アイコン用）
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const {
  FaComments, FaBullhorn, FaRobot, FaThLarge, FaTicketAlt, FaYenSign,
  FaChartLine, FaTags, FaLink, FaBell, FaFilter, FaMagic, FaCheck,
  FaQuestion, FaStore, FaUsers, FaPaperPlane, FaReply, FaWpforms,
  FaCalendarCheck, FaSearchDollar, FaHandshake, FaExclamationTriangle,
  FaMobileAlt, FaGift, FaClock, FaChartBar, FaLightbulb, FaRoute,
} = require('react-icons/fa');

const icons = {
  comments: FaComments, bullhorn: FaBullhorn, robot: FaRobot, menu: FaThLarge,
  ticket: FaTicketAlt, yen: FaYenSign, chart: FaChartLine, tags: FaTags,
  link: FaLink, bell: FaBell, filter: FaFilter, magic: FaMagic, check: FaCheck,
  question: FaQuestion, store: FaStore, users: FaUsers, plane: FaPaperPlane,
  reply: FaReply, form: FaWpforms, calendar: FaCalendarCheck, searchyen: FaSearchDollar,
  handshake: FaHandshake, warn: FaExclamationTriangle, mobile: FaMobileAlt,
  gift: FaGift, clock: FaClock, bar: FaChartBar, bulb: FaLightbulb, route: FaRoute,
};

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  for (const [name, Comp] of Object.entries(icons)) {
    for (const [variant, color] of [['white', '#FFFFFF'], ['green', '#06C755'], ['ink', '#0F1720'], ['red', '#D0402B']]) {
      const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color, size: 256 }));
      await sharp(Buffer.from(svg)).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toFile(path.join(outDir, `${name}_${variant}.png`));
    }
  }
  console.log('icons done:', Object.keys(icons).length * 4);
})();
