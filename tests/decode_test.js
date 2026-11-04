// Run: node tests/decode_test.js
// Decodes every photo in samples/ (git-ignored, so the whole test is skipped when the folder is missing) with the same decodeWasm_ and
// mergeLabels_ the phone page and server use, and prints what each photo yields. Asserts only on photos listed in MUST.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadSrc } = require('./load');

const root = path.join(__dirname, '..', 'samples');
if (!fs.existsSync(root)) { console.log('skip decode test: no samples/ folder'); process.exit(0); }
const wasm = require('zxing-wasm/reader');
const { Jimp } = require('jimp');
const S = loadSrc({});

// photo -> expected parsed fields (a full DigiKey bag shot on a phone, a scanned Mouser label, DigiKey's forum label photos)
const MUST = {
  'digikey/reddit_04e8.jpg': { mpn: 'SSM2019BRNZ', supplierPn: '505-SSM2019BRNZ-ND', qty: 1 },
  'mouser/mouser_diyaudio.jpg': { mpn: 'RN60D3920FB14', qty: 4 },
  'digikey/23b09f6d945a1ec538b5417a06e72e9703359a3e.jpeg': { mpn: '364019-01', supplierPn: 'Q1045-ND', qty: 3 }
};

(async () => {
  let n = 0;
  for (const sup of ['digikey', 'mouser']) {
    const dir = path.join(root, sup);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => /\.(jpe?g|png)$/i.test(x))) {
      const key = sup + '/' + f;
      let img;
      try { img = await Jimp.read(path.join(dir, f)); } catch (e) { console.log('unreadable', key, e.message); continue; }
      const t0 = Date.now();
      const rs = await S.decodeWasm_(wasm, { width: img.bitmap.width, height: img.bitmap.height, data: new Uint8ClampedArray(img.bitmap.data) }, false);
      const p = S.mergeLabels_(rs.map(r => r.text));
      console.log(key, img.bitmap.width + 'x' + img.bitmap.height, (Date.now() - t0) + 'ms', rs.length + ' barcode(s)', JSON.stringify({ mpn: p.mpn, supplierPn: p.supplierPn, qty: p.qty, supplier: p.supplier }));
      if (MUST[key]) { n++; Object.keys(MUST[key]).forEach(k => assert.strictEqual(p[k], MUST[key][k], key + ' ' + k)); }
    }
  }
  console.log('decode ok (' + n + ' checked)');
})().catch(e => { console.error(e); process.exit(1); });
