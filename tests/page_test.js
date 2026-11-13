// Run: node tests/page_test.js
// Drives src/AppPage.html's script against a tiny fake DOM and a fake google.script.run. Catches page crashes without a phone.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSrc } = require('./load');
const S = loadSrc();

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.className = ''; this._text = ''; this.value = ''; this.attrs = {}; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this.children = []; this._text = ''; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  fire(ev) { (this.listeners[ev] || []).forEach(f => f.call(this)); if (this['on' + ev]) this['on' + ev](); }
  click() { this.fire('click'); }
  find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach(c => c.find(pred, out)); return out; }
}

function openPage(answers) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'AppPage.html'), 'utf8');
  const parts = html.split('<script>').slice(1).map(x => x.split('</script>')[0]);
  const script = parts.join(';\n').replace('<?!= lib ?>', () => S.clientLib_())
    .replace('<?!= JSON.stringify(token) ?>', answers.static ? '""' : '"tok"').replace('<?!= JSON.stringify(categories) ?>', '["Resistors","Capacitors","Misc"]');
  const byId = {};
  const calls = [];
  const document = { createElement: t => {
    const e = new El(t);
    if (t === 'video') Object.assign(e, { videoWidth: 640, videoHeight: 480, play() {} });
    if (t === 'canvas') e.getContext = () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ width: w, height: h, data: [] }) });
    return e;
  },getElementById: id => (byId[id] = byId[id] || new El('div')) };
  const run = { withSuccessHandler(ok) { this.ok = ok; return this; }, withFailureHandler(f) { this.fail = f; return this; },
    invCall(token, req) { calls.push(JSON.parse(JSON.stringify(req))); const a = answers[req.action]; if (a instanceof Error) this.fail(a); else this.ok(a); } };
  const ctx = vm.createContext(Object.assign({ document, google: { script: { run } }, ZXing: {}, URL, Image: function () {}, console, setTimeout, Date }, answers.env));
  if (answers.static) {   // Cloudflare build: no google.script, fetch('/api'), token from #t=, inventory in localStorage
    delete ctx.google;
    const ls = answers.static.ls || {};
    Object.assign(ctx, { location: { hash: answers.static.hash || '', pathname: '/' }, history: { replaceState() { ctx.location.hash = ''; } },
      localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
      fetch: (url, o) => { const b = JSON.parse(o.body); calls.push(b.req); fetched.push(Object.assign({ url, token: b.token }, b.password ? { password: b.password } : {}));
        const a = answers[b.req.action]; return Promise.resolve({ json: () => Promise.resolve(a instanceof Error ? { ok: false, error: a.message } : { ok: true, data: a }) }); } });
  }
  const fetched = [];
  vm.runInContext(script, ctx);
  return { byId, calls, fetched, ctx, text: () => byId.app.textContent };
}

const rec = { supplier: 'DigiKey', mpn: 'AC0402FR-072K2L', manufacturer: 'YAGEO', description: 'RES 2.2K 1% 0402', dkPn: 'X-ND', mouserPn: '', groupKey: 'R|2.2k|0402', spec: '1%', category: 'Resistors' };
const row = { category: 'Resistors', value: '2.2k', package: '0402', spec: '1%', qty: 125, location: 'A1', mpns: 'AC0402FR-072K2L', description: 'RES 2.2K 1% 0402' };

// add flow: look up -> card -> confirm
let p = openPage({ load: { rows: [{ category: 'Resistors', groupKey: 'R|2.2k|0402', qty: 75, location: 'A1', value: '2.2k', package: '0402', mpns: 'X', description: 'd' }] }, scan: { parsed: { qty: 50, lot: 'L9' }, rec, source: 'DigiKey', warnings: [], existing: { qty: 75, location: 'A1' } }, confirm: { row, isNew: false } });
assert.ok(/Scan label/.test(p.text()) || p.byId.app.find(e => /Scan label/.test(e.textContent)).length);
const inputs = () => p.byId.app.find(e => e.tag === 'input' && !e.attrs.capture && e.type !== 'file');
inputs()[0].value = 'AC0402FR-072K2L'; inputs()[0].fire('input');
p.byId.app.find(e => e.textContent === 'Look up')[0].click();
assert.deepStrictEqual(p.calls[0], { action: 'load' });
assert.deepStrictEqual(p.calls[1], { action: 'scan', texts: ['AC0402FR-072K2L'], supplier: 'DigiKey', keys: ['ac0402fr072k2l'] });
assert.ok(/AC0402FR-072K2L/.test(p.text()) && /Already in stock: 75 at A1/.test(p.text()));
const qty = inputs().filter(e => e.value === '50')[0];
assert.ok(qty, 'quantity prefilled from the label');
qty.value = '25'; qty.fire('input');
p.byId.app.find(e => e.textContent === 'Add to stock')[0].click();
assert.strictEqual(p.calls[2].action, 'confirm'); assert.strictEqual(p.calls[2].qty, '25'); assert.strictEqual(p.calls[2].rec.groupKey, 'R|2.2k|0402');
assert.ok(/Updated: 2.2k 0402/.test(p.text()) && /now 125/.test(p.text()));

// not found
p = openPage({ load: { rows: [] }, scan: { parsed: { raw: '[)>\x1e06\x1d1PABC', fields: { '1P': 'ABC' }, mpn: 'ABC' }, rec: null, warnings: ['Mouser key missing'] } });
p.byId.app.find(e => e.tagName === undefined && e.textContent === 'Look up')[0];
inputs()[0].value = 'ZZZ'; inputs()[0].fire('input'); p.byId.app.find(e => e.textContent === 'Look up')[0].click();
assert.ok(/Part not found/.test(p.text()) && /Mouser key missing/.test(p.text()));
assert.ok(/Decoded: \[\)><RS>06<GS>1PABC/.test(p.text()) && /searched: ABC/.test(p.text()));

// search tab: filtered in the page, no server call after the first load
p = openPage({ load: { rows: [row, Object.assign({}, row, { value: '10k', mpns: 'OTHER', description: 'RES 10K' })] } });
p.byId.t2.click();
inputs()[0].value = '0402 2.2k'; inputs()[0].fire('input');
assert.deepStrictEqual(p.calls, [{ action: 'load' }], 'typing makes no server call');
assert.ok(/2.2k 0402/.test(p.text()) && !/RES 10K/.test(p.text()));
inputs()[0].value = '0402'; inputs()[0].fire('input');
assert.ok(/RES 10K/.test(p.text()));
inputs()[0].value = 'zzz'; inputs()[0].fire('input');
assert.ok(/Nothing matched/.test(p.text()));
p = openPage({ load: new Error('forbidden') });
assert.ok(/Error: forbidden/.test(p.text()));

// search sorting: no server call, order follows the controls
const srow = (v, q, m, cat) => Object.assign({}, row, { value: v, qty: q, mpns: m, category: cat || 'Capacitors', description: 'D' + m });
p = openPage({ load: { rows: [srow('1uF', 5, 'B'), srow('100nF', 50, 'A'), srow('2.2k', 7, 'C', 'Resistors')] } });
p.byId.t2.click();
const order = () => ['A', 'B', 'C'].map(m => [m, p.text().indexOf('D' + m)]).sort((a, b) => a[1] - b[1]).map(x => x[0]).join('');
const sel = () => p.byId.app.find(e => e.tag === 'select');
assert.strictEqual(order(), 'BAC'); assert.ok(/3 result/.test(p.text()));
sel()[0].value = 'value'; sel()[0].fire('change'); assert.strictEqual(order(), 'ABC');
p.byId.app.find(e => e.textContent === 'Ascending')[0].click(); assert.strictEqual(order(), 'CBA');
sel()[0].value = 'qty'; sel()[0].fire('change'); assert.strictEqual(order(), 'ACB');
sel()[1].value = 'Resistors'; sel()[1].fire('change'); assert.ok(/1 result/.test(p.text()) && !/DA/.test(p.text()));
assert.deepStrictEqual(p.calls, [{ action: 'load' }], 'sorting makes no server call');

// two separate scan buttons; live scan: blocked camera, then detect -> popup -> confirm -> normal part card
p = openPage({ load: { rows: [] } });
assert.ok(p.byId.app.find(e => e.textContent === 'Scan label (take photo)').length && p.byId.app.find(e => e.textContent === 'Live scan (camera)').length, 'photo and live buttons are separate');
p = openPage({ load: { rows: [] }, env: { navigator: { mediaDevices: { getUserMedia: () => Promise.reject({ name: 'NotAllowedError', message: 'denied' }) } } } });
p.byId.app.find(e => e.textContent === 'Live scan (camera)')[0].click();
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(10);
  assert.ok(/live camera blocked \(NotAllowedError: denied\)/.test(p.text()) && /photo button/.test(p.text()), 'blocked camera says why and points to the photo button');
  // static (Cloudflare) page: token from #t= is remembered, inventory shows from localStorage before the load answers, cloud-cache hit has no parsed
  const ls = { inv: JSON.stringify([row]) };
  p = openPage({ static: { hash: '#t=abc', ls }, load: { rows: [row] }, scan: { rec, source: 'cloud cache', warnings: [] } });
  assert.strictEqual(JSON.parse(ls.token), 'abc'); assert.strictEqual(p.ctx.location.hash, '', 'token removed from the address bar');
  p.byId.t2.click(); assert.ok(/2.2k 0402/.test(p.text()), 'search shows the stored inventory at once');
  await sleep(10);
  assert.deepStrictEqual(p.fetched[0], { url: '/api', token: 'abc' });
  p.byId.t1.click();
  inputs()[0].value = '[)>\x1e06\x1d1PAC0402FR-072K2L\x1dQ40'; inputs()[0].fire('input');
  p.byId.app.find(e => e.textContent === 'Look up')[0].click();
  await sleep(10);
  assert.ok(/Add to stock/.test(p.text()) && inputs().some(e => e.value === '40'), 'qty comes from the local parse on a cloud hit');
  p = openPage({ static: { ls: { token: '"abc"' } }, load: { rows: [] } });
  await sleep(10);
  assert.strictEqual(p.fetched[0].token, 'abc', 'token remembered from localStorage');
  // no token, no password: sign-in card, no server call; password goes with every call; a forbidden answer signs out
  const ls2 = {};
  p = openPage({ static: { ls: ls2 }, load: { rows: [row] } });
  assert.ok(/Sign in/.test(p.text()) && !p.calls.length && !/Add to stock|Scan label/.test(p.text()));
  const pw = p.byId.app.find(e => e.type === 'password')[0];
  pw.value = 'secret'; p.byId.app.find(e => e.textContent === 'Sign in' && e.tag === 'button')[0].click();
  await sleep(10);
  assert.deepStrictEqual(p.fetched[0], { url: '/api', token: '', password: 'secret' }); assert.strictEqual(JSON.parse(ls2.pass), 'secret');
  assert.ok(/Scan label/.test(p.text()), 'app shows after sign-in');
  p = openPage({ static: { ls: { pass: '"old"', inv: JSON.stringify([row]) } }, load: new Error('forbidden') });
  await sleep(10);
  assert.ok(/wrong password/.test(p.text()) && /Sign in/.test(p.text()));
  p.byId.t2.click(); assert.ok(!/2.2k 0402/.test(p.text()), 'stored inventory hidden after sign-out');
  const built = require('../tools/build_web').buildWeb();
  assert.ok(!/<\?/.test(built) && /function partKeys_/.test(built), 'build fills every template tag');

  let stopped = 0;
  const asked = [];
  const wasm = { readBarcodes: (img, o) => { asked.push(JSON.parse(JSON.stringify(o.formats))); return Promise.resolve([{ text: '[)>\x1e06\x1d1PAC0402FR-072K2L\x1dQ50', format: 'DataMatrix', isValid: true }]); } };
  p = openPage({ load: { rows: [] }, scan: { parsed: { qty: 50, lot: '' }, rec, source: 'DigiKey', warnings: [] }, confirm: { row, isNew: false },
    env: { ZXingWASM: wasm, navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => stopped++ }] }) } } } });
  p.byId.app.find(e => e.textContent === 'Live scan (camera)')[0].click();
  await sleep(1500);
  const live = p.byId.live;
  assert.ok(/Part detected/.test(live.textContent) && /AC0402FR-072K2L/.test(live.textContent) && /Quantity on label: 50/.test(live.textContent), 'popup shows the detected part');
  assert.deepStrictEqual(p.calls[1].texts, ['[)>\x1e06\x1d1PAC0402FR-072K2L\x1dQ50'], 'live scan sends every barcode read');
  live.find(e => e.textContent === 'Use this part')[0].click();
  assert.strictEqual(stopped, 1, 'camera stopped'); assert.strictEqual(live.style.display, 'none');
  assert.ok(/Add to stock/.test(p.text()) && /AC0402FR-072K2L/.test(p.text()), 'normal part card follows');
  assert.deepStrictEqual(asked[0], ['DataMatrix'], 'DigiKey mode reads only the Data Matrix');

  // scan mode switch: remembered and sent with the scan; a label without a part number makes no server call and offers the bars to pick
  const ls3 = { pass: '"pw"' };
  p = openPage({ static: { ls: ls3 }, load: { rows: [] }, scan: { parsed: { qty: 6 }, rec, source: 'Mouser', warnings: [] } });
  await sleep(10);
  p.byId.app.find(e => e.tag === 'button' && e.textContent === 'Mouser')[0].click();
  assert.strictEqual(JSON.parse(ls3.supplier), 'Mouser');
  const two = '[)>␞06␝K37412632␝14K024␝PIC1␝Q6␝4LPH␝1VSTMicro';
  const before = p.calls.length;
  p.ctx.doScan([two, '37412632', 'IC1', '6', 'PH', '467DPD', '511-STM32H755ZIT6']);
  await sleep(10);
  assert.strictEqual(p.calls.length, before + 1, 'a Mouser PN on the label goes to the server');
  assert.strictEqual(p.calls.at(-1).supplier, 'Mouser');
  p.ctx.doScan([two, '37412632', 'IC1', '6', 'PH', '467DPD']);
  await sleep(10);
  assert.strictEqual(p.calls.length, before + 1, 'no part number: no server call');
  assert.ok(/Which barcode is the part number/.test(p.text()), 'pick list instead of a lookup');
  assert.ok(!p.byId.app.find(e => e.tag === 'button' && e.textContent === 'IC1').length, 'customer P/N from the 2D code is not offered');
  p.byId.app.find(e => e.tag === 'button' && e.textContent === '467DPD')[0].click();
  await sleep(10);
  assert.deepStrictEqual(p.calls.at(-1).texts, ['467DPD'], 'the tapped bar is looked up as typed');
  assert.ok(p.byId.app.find(e => e.tag === 'input' && e.value === '6').length, 'quantity kept from the 2D code');
  console.log('page ok');
})().catch(e => { console.error(e); process.exit(1); });
