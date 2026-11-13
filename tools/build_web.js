// Builds the static page for Cloudflare Pages: src/AppPage.html with the template tags filled, token left empty (the page reads #t=).
//   node tools/build_web.js   -> web/index.html   (Cloudflare build command; output directory "web")
const fs = require('fs');
const path = require('path');
const { loadSrc } = require('../tests/load');

function buildWeb() {
  const S = loadSrc();
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'AppPage.html'), 'utf8');
  return html.replace('<?!= lib ?>', () => S.clientLib_())   // function replacement: the lib contains "$'"
    .replace('<?!= JSON.stringify(token) ?>', () => '""')
    .replace('<?!= JSON.stringify(categories) ?>', () => JSON.stringify(S.CATEGORIES));
}

if (require.main === module) {
  const out = path.join(__dirname, '..', 'web');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), buildWeb());
  console.log('wrote web/index.html');
}
module.exports = { buildWeb };
