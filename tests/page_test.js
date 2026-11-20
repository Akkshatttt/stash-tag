// Run: node tests/page_test.js
// Drives src/AppPage.html's script against a tiny fake DOM and a fake fetch('/api'). Catches page crashes without a phone.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSrc } = require('./load');
const S = loadSrc();

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.className = ''; this._text = ''; this._val = ''; this.attrs = {}; }
  get value() { if (this._set !== undefined) return this._set; if (this.tag === 'select') { const o = this.children.find(c => c.selected) || this.children[0]; return o ? String(o._val) : ''; } return this._val; }
  set value(v) { if (this.tag === 'option') this._val = v; else this._set = v; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this.children = []; this._text = ''; this._set = undefined; }
  appendChild(c) { this.children.push(c); return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  get firstChild() { return this.children[0]; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  fire(ev) { (this.listeners[ev] || []).forEach(f => f.call(this)); if (this['on' + ev]) this['on' + ev](); }
  click() { this.fire('click'); }
  find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach(c => c.find(pred, out)); return out; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function openPage(answers) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'AppPage.html'), 'utf8');
  const parts = html.split('<script>').slice(1).map(x => x.split('</script>')[0]);
  const script = parts.join(';\n').replace('<?!= lib ?>', () => S.clientLib_()).replace('<?!= JSON.stringify(token) ?>', '""');
  const byId = {}, calls = [], fetched = [], ls = (answers.ls = answers.ls || { pass: '"pw"', who: '"Asha"' });
  const document = { createElement: t => {
    const e = new El(t);
    if (t === 'video') Object.assign(e, { videoWidth: 640, videoHeight: 480, play() {} });
    if (t === 'canvas') e.getContext = () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ width: w, height: h, data: [] }) });
    return e;
  }, getElementById: id => (byId[id] = byId[id] || new El('div')) };
  const ctx = vm.createContext(Object.assign({ document, ZXing: {}, URL, Image: function () {}, console, setTimeout, Date,
    location: { hash: answers.hash || '', pathname: '/' }, history: { replaceState() { ctx.location.hash = ''; } },
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    fetch: (url, o) => {
      const b = JSON.parse(o.body); calls.push(b.req); fetched.push(Object.assign({ url, token: b.token }, b.password ? { password: b.password } : {}));
      const a = typeof answers[b.req.action] === 'function' ? answers[b.req.action](b.req) : answers[b.req.action];
      return Promise.resolve({ json: () => Promise.resolve(a instanceof Error ? { ok: false, error: a.message } : { ok: true, data: a }) });
    } }, answers.env));
  vm.runInContext(script, ctx);
  return { byId, calls, fetched, ctx, ls, text: () => byId.app.textContent };
}
const btn = (p, t, root) => (root || p.byId.app).find(e => e.tag === 'button' && e.textContent === t);
const inputs = p => p.byId.app.find(e => e.tag === 'input' && !e.attrs.capture && e.type !== 'file');
const inputWith = (p, ph, root) => (root || p.byId.app).find(e => e.tag === 'input' && e.placeholder === ph)[0];
const type = (i, v) => { i.value = v; i.fire('input'); };
const pk = (id, qty, box, extra) => Object.assign({ id, qty, box, lot: '', dc: '', made: 1700000000, upd: 1700000000, by: 'Asha' }, extra);
const comp = (id, mpn, packets, extra) => Object.assign({ id, mpn, mfr: 'YAGEO', dkpn: 'X-ND', mopn: '', descr: 'D-' + mpn, spec: '1%', src: 1, cat: 101, ds: '', by: 'Asha', ts: 1700000000, packets }, extra);
const mkInv = () => ({
  cats: [{ id: 100, parent: null, name: 'Resistors' }, { id: 101, parent: 100, name: 'Chip' }, { id: 200, parent: null, name: 'Capacitors' }, { id: 201, parent: 200, name: 'Ceramic' }, { id: 1400, parent: null, name: 'Unsorted' }],
  boxes: [{ id: 1, name: 'B12' }, { id: 2, name: 'B13' }], requireReason: false,
  groups: [{ id: 1, key: 'R|2.2k|0402', label: 'Resistor 2.2k 0402', cat: 101, comps: [comp(10, 'AC0402FR-072K2L', [pk(100, 50, 1), pk(101, 25, 2)]), comp(11, 'RC0402FR-072K2L', [pk(102, 5, 1)])] },
    { id: 2, key: 'C|100nF|0402', label: 'Capacitor 100nF 0402', cat: 201, comps: [comp(20, 'CAPX', [pk(200, 7, 1)], { cat: 201, descr: 'CAP CER 100nF' })] }]
});
const rec = { supplier: 'DigiKey', mpn: 'AC0402FR-072K2L', manufacturer: 'YAGEO', description: 'RES 2.2K 1% 0402', dkPn: 'X-ND', mouserPn: '', groupKey: 'R|2.2k|0402', spec: '1%', category: 'Resistors', categoryPath: 'Resistors > Chip Resistor - Surface Mount' };
const oneComp = () => ({ group: { id: 1, key: 'R|2.2k|0402', label: 'Resistor 2.2k 0402', cat: 101, comps: [comp(10, 'AC0402FR-072K2L', [pk(100, 50, 1), pk(101, 25, 2)])] } });

(async () => {
  // ---- sign in: name + password, no server call before; the password goes with every call; a forbidden answer signs out
  let p = openPage({ ls: {}, inv_load: mkInv() });
  assert.ok(/Sign in/.test(p.text()) && !p.calls.length && !/Live scan/.test(p.text()));
  p.byId.app.find(e => e.tag === 'input' && e.placeholder && /your name/.test(e.placeholder))[0].value = 'Asha';
  p.byId.app.find(e => e.type === 'password')[0].value = 'secret'; btn(p, 'Sign in')[0].click();
  await sleep(10);
  assert.deepStrictEqual(p.fetched[0], { url: '/api', token: '', password: 'secret' }); assert.strictEqual(JSON.parse(p.ls.pass), 'secret'); assert.strictEqual(JSON.parse(p.ls.who), 'Asha');
  assert.strictEqual(p.calls[0].who, 'Asha', 'every call carries the name'); assert.ok(/Live scan/.test(p.text()), 'app shows after sign-in');
  p = openPage({ ls: { pass: '"old"', inv2: JSON.stringify(mkInv()) }, inv_load: new Error('forbidden') });
  await sleep(10);
  assert.ok(/wrong password/.test(p.text()) && /Sign in/.test(p.text())); p.byId.t2.click(); assert.ok(!/Resistor 2.2k/.test(p.text()), 'stored inventory hidden after sign-out');
  p = openPage({ hash: '#t=abc', ls: {}, inv_load: mkInv() });   // token link: remembered, removed from the address bar
  assert.strictEqual(JSON.parse(p.ls.token), 'abc'); assert.strictEqual(p.ctx.location.hash, '');
  await sleep(10); assert.strictEqual(p.fetched[0].token, 'abc');

  // ---- new packet of a known part: card, existing stock warning, add
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 25, lot: 'L9', dateCode: '2501' }, fp: 'D|x', comp: oneComp(), rec, source: 'DigiKey', warnings: [], cat: 101, descr: 'RES 2.2K 1% 0402' },
    inv_add: { packetId: 103, group: { id: 1, key: 'R|2.2k|0402', label: 'Resistor 2.2k 0402', cat: 101, comps: [comp(10, 'AC0402FR-072K2L', [pk(100, 50, 1), pk(101, 25, 2), pk(103, 25, 2)])] } } });
  await sleep(10);
  type(inputs(p)[0], 'AC0402FR-072K2L'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.deepStrictEqual(p.calls.slice(0, 2).map(c => c.action), ['inv_load', 'scan']); assert.deepStrictEqual(p.calls[1].texts, ['AC0402FR-072K2L']);
  assert.ok(/Already in stock: 75 pcs in 2 packet/.test(p.text()) && /AC0402FR-072K2L/.test(p.text()));
  assert.ok(inputs(p).some(e => e.value === '25'), 'quantity prefilled from the label');
  type(inputWith(p, 'how many'), '20');
  const boxSel = p.byId.app.find(e => e.tag === 'select')[0]; boxSel.value = '2'; boxSel.fire('change');
  btn(p, 'Add packet')[0].click();
  const add = p.calls.at(-1);
  assert.strictEqual(add.action, 'inv_add'); assert.strictEqual(add.qty, '20'); assert.strictEqual(add.box, '2'); assert.strictEqual(add.fp, 'D|x'); assert.strictEqual(add.lot, 'L9'); assert.strictEqual(add.dc, '2501'); assert.strictEqual(add.rec.mpn, 'AC0402FR-072K2L');
  await sleep(10);
  assert.ok(/Added 20 x AC0402FR-072K2L to box B13\. Total 100/.test(p.text()), p.text());
  // a new part has an editable description and category, and a new box is made first
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 3 }, fp: null, comp: null, rec: Object.assign({}, rec, { mpn: 'NEW1', groupKey: 'P|new1' }), source: 'DigiKey', warnings: [], cat: 1400, descr: 'RES NEW' },
    inv_box: { id: 9, name: 'Z9' }, inv_add: { packetId: 7, group: { id: 5, key: 'P|new1', label: 'NEW1', cat: 1400, comps: [comp(30, 'NEW1', [pk(7, 3, 9)], { cat: 1400 })] } } });
  await sleep(10);
  type(inputs(p)[0], 'NEW1'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.ok(/New part \(no order data/.test(p.text()) && inputs(p).some(e => e.value === 'RES NEW'), 'description is editable');
  type(inputs(p).find(e => e.value === 'RES NEW'), 'RES NEW EDITED'); type(inputWith(p, 'only if not listed'), 'Z9');
  btn(p, 'Add packet')[0].click(); await sleep(20);
  assert.deepStrictEqual(p.calls.filter(c => /inv_(box|add)/.test(c.action)).map(c => c.action), ['inv_box', 'inv_add']);
  const add2 = p.calls.at(-1); assert.strictEqual(add2.descr, 'RES NEW EDITED'); assert.strictEqual(add2.box, '9'); assert.strictEqual(add2.cat, 0, 'category not changed: server keeps its own');
  assert.ok(/Added 3 x NEW1 to box Z9/.test(p.text()), p.text());

  // ---- a packet already in stock: prompt, then take
  const dupAns = { parsed: {}, fp: 'D|x', rec: null, dup: Object.assign({ packetId: 100, st: 0, qty: 50, box: 1 }, oneComp()), warnings: [] };
  p = openPage({ inv_load: mkInv(), scan: dupAns, inv_txn: { group: { id: 1, key: 'R|2.2k|0402', label: 'Resistor 2.2k 0402', cat: 101, comps: [comp(10, 'AC0402FR-072K2L', [pk(100, 45, 1), pk(101, 25, 2)])] } } });
  await sleep(10);
  type(inputs(p)[0], 'x'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.ok(/Already in stock/.test(p.text()) && /This packet: 50 pcs · box B12/.test(p.text()), p.text());
  type(inputWith(p, 'quantity'), '5'); btn(p, 'Take')[0].click();
  assert.deepStrictEqual(p.calls.at(-1), { action: 'inv_txn', packet: 100, note: '', mode: 'take', qty: '5', who: 'Asha' });
  await sleep(10); assert.ok(/Saved\./.test(p.text()));
  p.byId.t2.click(); assert.ok(p.byId.app.find(e => e.className === 'qty').some(e => e.textContent === '75'), 'search shows the patched total (45 + 25 + 5)');
  // an archived packet says so
  p = openPage({ inv_load: mkInv(), scan: Object.assign({}, dupAns, { dup: Object.assign({ packetId: 100, st: 1, qty: 0, box: 1 }, oneComp()) }) }); await sleep(10);
  type(inputs(p)[0], 'x'); btn(p, 'Look up')[0].click(); await sleep(10); assert.ok(/was used up/.test(p.text()));

  // ---- not found
  p = openPage({ inv_load: mkInv(), scan: { parsed: { raw: '[)>\x1e06\x1d1PABC', fields: { '1P': 'ABC' }, mpn: 'ABC' }, rec: null, warnings: ['Mouser key missing'] } }); await sleep(10);
  type(inputs(p)[0], 'ZZZ'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.ok(/Part not found/.test(p.text()) && /Mouser key missing/.test(p.text()) && /Decoded: \[\)><RS>06<GS>1PABC/.test(p.text()) && /searched: ABC/.test(p.text()));

  // ---- Search: filtered in the page (no server call), tiles drill down, chips remove, group opens into parts and packets
  p = openPage({ inv_load: mkInv(), inv_txn: oneComp(), inv_edit: oneComp() }); await sleep(10); p.byId.t2.click();
  const nCalls = p.calls.length;
  assert.ok(/Resistors/.test(p.text()) && /Capacitors/.test(p.text()) && !/Unsorted/.test(p.text()), 'tiles for categories that have parts');
  assert.ok(/2 result/.test(p.text()));
  type(inputs(p)[0], '0402 2.2k'); assert.ok(/Resistor 2.2k 0402/.test(p.text()) && !/Capacitor 100nF/.test(p.text())); assert.strictEqual(p.calls.length, nCalls, 'typing makes no server call');
  type(inputs(p)[0], 'zzz'); assert.ok(/Nothing matched/.test(p.text())); type(inputs(p)[0], '');
  btn(p, 'Capacitors').concat(p.byId.app.find(e => e.tag === 'button' && /^Capacitors/.test(e.textContent)))[0].click();
  assert.ok(/1 result/.test(p.text()) && !/Resistor 2.2k/.test(p.text()) && /Ceramic/.test(p.text()), 'category tile filters and shows sub-category tiles');
  p.byId.app.find(e => e.tag === 'button' && /^Capacitors ?$/.test(e.textContent) && /x/.test(e.className))[0].click(); assert.ok(/2 result/.test(p.text()), 'chip removes the filter');
  p.byId.app.find(e => e.tag === 'button' && e.textContent === 'In stock')[0].click(); assert.ok(/2 result/.test(p.text()));
  p.byId.app.find(e => e.className === 'tap' && /Resistor 2.2k/.test(e.textContent))[0].click();
  assert.ok(/AC0402FR-072K2L/.test(p.text()) && /RC0402FR-072K2L/.test(p.text()) && /50 pcs · box B12/.test(p.text()) && /Last change: Asha 2023-11-14/.test(p.text()), 'group opens into part numbers and packets: ' + p.text());
  assert.ok(/2 part numbers/.test(p.text()));
  // change a packet from the list
  btn(p, 'Change')[0].click(); type(inputWith(p, 'quantity'), '10'); btn(p, 'Add')[0].click();
  assert.deepStrictEqual(p.calls.at(-1), { action: 'inv_txn', packet: 100, note: '', mode: 'add', qty: '10', who: 'Asha' });
  // edit a part's description
  btn(p, 'Edit')[0].click(); const di = p.byId.app.find(e => e.tag === 'input' && e.value === 'D-AC0402FR-072K2L')[0]; assert.ok(di, 'description editable'); type(di, 'RES precise');
  btn(p, 'Save')[0].click(); assert.deepStrictEqual(Object.keys(p.calls.at(-1)).sort(), ['action', 'cat', 'comp', 'descr', 'who']); assert.strictEqual(p.calls.at(-1).comp, 10); assert.strictEqual(p.calls.at(-1).cat, 101);
  // sort controls
  const order = () => ['Resistor 2.2k', 'Capacitor 100nF'].map(m => [m, p.text().indexOf(m)]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  const sel = p.byId.app.find(e => e.tag === 'select')[0]; sel.value = 'qty'; sel.fire('change'); assert.strictEqual(order()[0], 'Capacitor 100nF', 'ascending quantity: 7 before 80');
  p.byId.app.find(e => e.textContent === 'Ascending')[0].click(); assert.strictEqual(order()[0], 'Resistor 2.2k');

  // ---- require reason (a deployment setting) adds a field
  const need = mkInv(); need.requireReason = true; p = openPage({ inv_load: need }); await sleep(10); p.byId.t2.click();
  p.byId.app.find(e => e.className === 'tap' && /Capacitor/.test(e.textContent))[0].click(); btn(p, 'Change')[0].click(); assert.ok(inputWith(p, 'what is it for?'));

  // ---- Count tab
  p = openPage({ inv_load: mkInv(), inv_audit: { comps: [oneComp()] } }); await sleep(10); p.byId.t3.click();
  assert.ok(/Pick a box/.test(p.text())); const cs = p.byId.app.find(e => e.tag === 'select')[0]; cs.value = '1'; cs.fire('change');
  assert.ok(/AC0402FR-072K2L/.test(p.text()) && /recorded 50/.test(p.text()) && /CAPX/.test(p.text()) && !/box B13/.test(p.text()));
  const c1 = inputs(p).find(e => e.value === '50'); type(c1, '48'); btn(p, 'Save counts')[0].click();
  assert.deepStrictEqual(p.calls.at(-1).items, [{ packet: 100, counted: '48' }, { packet: 102, counted: 5 }, { packet: 200, counted: 7 }]); await sleep(10);
  assert.ok(/Counted 3 packet\(s\), 1 corrected/.test(p.text()), p.text());

  // ---- name is required before a change
  p = openPage({ ls: { pass: '"pw"' }, inv_load: mkInv() }); await sleep(10); p.byId.t2.click();
  p.byId.app.find(e => e.className === 'tap' && /Capacitor/.test(e.textContent))[0].click(); btn(p, 'Change')[0].click(); type(inputWith(p, 'quantity'), '1'); btn(p, 'Take')[0].click();
  assert.ok(/Enter your name first/.test(p.text()) && !p.calls.some(c => c.action === 'inv_txn'));

  // ---- live scan: camera blocked; a packet in stock gets the prompt in the overlay; a new part goes on to the card
  p = openPage({ inv_load: mkInv(), env: { navigator: { mediaDevices: { getUserMedia: () => Promise.reject({ name: 'NotAllowedError', message: 'denied' }) } } } });
  assert.ok(btn(p, 'Take photo').length && btn(p, 'Live scan').length); btn(p, 'Live scan')[0].click(); await sleep(10);
  assert.ok(/live camera blocked \(NotAllowedError: denied\)/.test(p.text()) && /photo button/.test(p.text()));
  let stopped = 0; const asked = [];
  const label = '[)>\x1e06\x1d1PAC0402FR-072K2L\x1d30PX-ND\x1d10K9001\x1dQ50';
  const wasm = { readBarcodes: (img, o) => { asked.push(JSON.parse(JSON.stringify(o.formats))); return Promise.resolve([{ text: label, format: 'DataMatrix', isValid: true }]); } };
  const env = { ZXingWASM: wasm, navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => stopped++ }] }) } } };
  p = openPage({ inv_load: mkInv(), scan: dupAns, inv_txn: { group: { id: 1, key: 'R|2.2k|0402', label: 'x', cat: 101, comps: [comp(10, 'AC0402FR-072K2L', [pk(100, 44, 1), pk(101, 25, 2)])] } }, env });
  btn(p, 'Live scan')[0].click(); await sleep(1500);
  const live = p.byId.live;
  assert.ok(/Packet in stock/.test(live.textContent) && /AC0402FR-072K2L/.test(live.textContent) && /50 pcs/.test(live.textContent), 'live shows the packet: ' + live.textContent);
  assert.strictEqual(p.calls.filter(c => c.action === 'scan').length, 1, 'asked once');
  type(inputWith(p, 'quantity', live), '6'); btn(p, 'Take', live)[0].click(); await sleep(10);
  assert.deepStrictEqual(p.calls.at(-1), { action: 'inv_txn', packet: 100, note: '', mode: 'take', qty: '6', who: 'Asha' });
  assert.ok(/Saved \(take\)\. Now 44/.test(live.textContent), live.textContent);
  btn(p, 'Close', live)[0].click(); assert.strictEqual(stopped, 1, 'camera stopped'); assert.strictEqual(live.style.display, 'none');
  assert.deepStrictEqual(asked[0], ['DataMatrix'], 'only the Data Matrix is read for a DigiKey label');
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 50, lot: '' }, rec, comp: null, fp: 'D|y', source: 'DigiKey', warnings: [], cat: 101, descr: 'd' }, env });
  btn(p, 'Live scan')[0].click(); await sleep(1500);
  assert.ok(/Part detected/.test(p.byId.live.textContent) && /Quantity on label: 50/.test(p.byId.live.textContent));
  btn(p, 'Use this part', p.byId.live)[0].click(); assert.ok(/Add packet/.test(p.text()) && /AC0402FR-072K2L/.test(p.text()), 'normal add card follows');

  // ---- Mouser: a label without a part number makes a server call only to recognise a known packet, then offers the bars to pick
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 6 }, rec, source: 'Mouser', warnings: [] } }); await sleep(10);
  const two = '[)>␞06␝K37412632␝14K024␝PIC1␝Q6␝4LPH␝1VSTMicro', before = p.calls.length;
  p.ctx.doScan([two, '37412632', 'IC1', '6', 'PH', '467DPD', '511-STM32H755ZIT6']); await sleep(10);
  assert.strictEqual(p.calls.length, before + 1); assert.strictEqual(p.calls.at(-1).supplier, undefined, 'the page sends no supplier: the label says which it is');
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 6 }, rec: null, warnings: ['x'] } }); await sleep(10);
  p.ctx.doScan([two, '37412632', 'IC1', '6', 'PH', '467DPD']); await sleep(10);
  assert.ok(/Which barcode is the part number/.test(p.text())); assert.ok(!btn(p, 'IC1').length, 'customer P/N from the 2D code is not offered');
  btn(p, '467DPD')[0].click(); await sleep(10);
  assert.deepStrictEqual(p.calls.at(-1).texts, ['467DPD'], 'the tapped bar is looked up as typed');
  // Mouser live scan: 4K with continuous focus; a bar counts once two frames agree
  const dm = '[)>\x1e06\x1dK37412632\x1d14K024\x1dPIC1\x1dQ6', pos = { topLeft: { x: 0, y: 0 }, topRight: { x: 100, y: 0 }, bottomRight: { x: 100, y: 100 }, bottomLeft: { x: 0, y: 100 } };
  const barPos = { topLeft: { x: -300, y: 150 }, bottomRight: { x: -100, y: 170 } };
  const mouserPage = bars => {
    let frames = 0; const wanted = [];
    const w = { readBarcodes: (img, o) => {
      if (o.formats[0] === 'DataMatrix') { frames++; return Promise.resolve([{ text: dm, format: 'DataMatrix', isValid: true, position: pos }]); }
      return Promise.resolve(bars(frames).map(t => ({ text: t, format: 'Code128', isValid: true, position: barPos })));
    } };
    const q = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 6 }, rec, source: 'Mouser', warnings: [] },
      env: { ZXingWASM: w, navigator: { mediaDevices: { getUserMedia: c => { wanted.push(c.video); return Promise.resolve({ getTracks: () => [{ stop() {} }] }); } } } } });
    btn(q, 'Live scan')[0].click();
    return { q, wanted, frames: () => frames };
  };
  let m = mouserPage(f => (f === 1 ? ['511-STM32H755ZIT6'] : []));
  await sleep(700);
  assert.strictEqual(m.wanted[0].width.ideal, 3840); assert.strictEqual(JSON.stringify(m.wanted[0].advanced), '[{"focusMode":"continuous"}]');
  assert.ok(m.frames() >= 2 && !m.q.calls.some(c => c.action === 'scan'), 'a bar seen in a single frame starts no lookup, and a 2D code with no order data none either');
  assert.ok(/looking for the part number/.test(m.q.byId.live.textContent));
  btn(m.q, 'Close', m.q.byId.live)[0].click();
  m = mouserPage(() => ['511-STM32H755ZIT6']);
  await sleep(700);
  const sc = m.q.calls.find(c => c.action === 'scan');
  assert.ok(sc && sc.texts.includes('511-STM32H755ZIT6') && sc.texts.includes(dm), 'two agreeing frames start the lookup with the 2D code and the bar');
  assert.ok(/Part detected/.test(m.q.byId.live.textContent));
  m.q.ctx.ui.dbg = true; m.q.ctx.render();
  assert.ok(/decoder ready/.test(m.q.text()) && /stage full/.test(m.q.text()) && /P\/N 511-STM32H755ZIT6/.test(m.q.text()), 'debug line says what the decoder did: ' + m.q.text());
  // Mouser 2D with invoice + line: asked at once (it may be a packet in stock), once per distinct reading
  const dmInv = dm + '\x1d11K88123';
  const w2 = { readBarcodes: () => Promise.resolve([{ text: dmInv, format: 'DataMatrix', isValid: true, position: pos }]) };
  p = openPage({ inv_load: mkInv(), scan: { parsed: {}, rec: null, warnings: ['no part number'] }, env: { ZXingWASM: w2, navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) } } } });
  btn(p, 'Live scan')[0].click(); await sleep(900);
  assert.strictEqual(p.calls.filter(c => c.action === 'scan').length, 1, 'the same 2D reading is asked once, then the page keeps reading bars');
  assert.ok(/looking for the part number/.test(p.byId.live.textContent));

  // ---- debug panel: API calls today per provider
  p = openPage({ ls: { token: '"abc"', debug: 'true' }, inv_load: mkInv(), usage: { day: '2026-11-19', DigiKey: 12, Mouser: 3 } }); await sleep(10);
  assert.ok(/DigiKey calls today \(UTC\)12 \/ 1000/.test(p.text()) && /Mouser calls today \(UTC\)3 \/ 1000/.test(p.text()), p.text());
  const built = require('../tools/build_web').buildWeb();
  assert.ok(!/<\?/.test(built) && /function partKeys_/.test(built) && /function fingerprint_/.test(built), 'build fills every template tag');
  console.log('page ok'); process.exit(0);   // live-scan pages left open keep their frame timers running
})().catch(e => { console.error(e); process.exit(1); });
