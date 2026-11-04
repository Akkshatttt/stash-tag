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
    .replace('<?!= JSON.stringify(token) ?>', '"tok"').replace('<?!= JSON.stringify(categories) ?>', '["Resistors","Capacitors","Misc"]');
  const byId = {};
  const calls = [];
  const document = { createElement: t => new El(t), getElementById: id => (byId[id] = byId[id] || new El('div')) };
  const run = { withSuccessHandler(ok) { this.ok = ok; return this; }, withFailureHandler(f) { this.fail = f; return this; },
    invCall(token, req) { calls.push(JSON.parse(JSON.stringify(req))); const a = answers[req.action]; if (a instanceof Error) this.fail(a); else this.ok(a); } };
  const ctx = vm.createContext({ document, google: { script: { run } }, ZXing: {}, URL, Image: function () {}, console });
  vm.runInContext(script, ctx);
  return { byId, calls, text: () => byId.app.textContent };
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
assert.deepStrictEqual(p.calls[1], { action: 'scan', text: 'AC0402FR-072K2L' });
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
console.log('page ok');
