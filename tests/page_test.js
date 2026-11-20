// Run: node tests/page_test.js
// Drives src/AppPage.html's script against a tiny fake DOM and a fake fetch('/api'). Catches page crashes without a phone.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSrc } = require('./load');
const S = loadSrc();

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.className = ''; this._text = ''; this._val = ''; this.attrs = {}; this.disabled = false; }
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
  click() { if (!this.disabled) this.fire('click'); }   // a disabled button does not fire, as in a browser
  find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach(c => c.find(pred, out)); return out; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function openPage(answers) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'AppPage.html'), 'utf8');
  const parts = html.split('<script>').slice(1).map(x => x.split('</script>')[0]);
  const script = parts.join(';\n').replace('<?!= lib ?>', () => S.clientLib_()).replace('<?!= JSON.stringify(token) ?>', '""');
  const byId = {}, calls = [], fetched = [], held = [], ls = (answers.ls = answers.ls || { pass: '"pw"', who: '"Asha"' });
  const document = { createElement: t => {
    const e = new El(t);
    if (t === 'video') Object.assign(e, { videoWidth: 640, videoHeight: 480, play() {} });
    if (t === 'canvas') e.getContext = () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ width: w, height: h, data: answers.frame ? answers.frame(w, h) : [] }) });
    return e;
  }, getElementById: id => (byId[id] = byId[id] || new El('div')) };
  const ctx = vm.createContext(Object.assign({ document, ZXing: {}, URL, Image: function () {}, console, setTimeout, clearTimeout, Date,
    location: { hash: answers.hash || '', pathname: '/' }, history: { replaceState() { ctx.location.hash = ''; } },
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    fetch: (url, o) => {
      const b = JSON.parse(o.body); calls.push(b.req); fetched.push(Object.assign({ url, token: b.token }, b.password ? { password: b.password } : {}));
      const a = typeof answers[b.req.action] === 'function' ? answers[b.req.action](b.req) : answers[b.req.action];
      const reply = () => ({ json: () => Promise.resolve(a instanceof Error ? { ok: false, error: a.message } : { ok: true, data: a }) });
      if (answers.hold && answers.hold.includes(b.req.action)) return new Promise(res => held.push(() => res(reply())));   // the test decides when the server answers
      return Promise.resolve(reply());
    } }, answers.env));
  vm.runInContext(script, ctx);
  return { byId, calls, fetched, held, ctx, ls, text: () => [byId.msg, byId.app, byId.modal].filter(Boolean).map(e => e.textContent).join(' | ') };
}
const btn = (p, t, root) => (root || p.byId.app).find(e => e.tag === 'button' && e.textContent === t);
const inputs = p => p.byId.app.find(e => e.tag === 'input' && !e.attrs.capture && e.type !== 'file');
const inputWith = (p, ph, root) => (root || p.byId.app).find(e => e.tag === 'input' && e.placeholder === ph)[0];
const selects = p => p.byId.app.find(e => e.tag === 'select');
const type = (i, v) => { i.value = v; i.fire('input'); };
const choose = (s, v) => { s.value = v; s.fire('change'); };
const strip = c => { const o = Object.assign({}, c); delete o.rid; return o; };
const pk = (id, qty, box, extra) => Object.assign({ id, qty, box, lot: '', dc: '', made: 1700000000, upd: 1700000000, by: 'Asha' }, extra);
const comp = (id, mpn, packets, extra) => Object.assign({ id, mpn, mfr: 'YAGEO', dkpn: 'X-ND', mopn: '', descr: 'D-' + mpn, spec: '1%', sp: { tol: '1%' }, src: 1, cat: 106, ds: '', by: 'Asha', ts: 1700000000, packets }, extra);
const mkInv = () => ({
  cats: [{ id: 100, parent: null, name: 'Resistors' }, { id: 106, parent: 100, name: 'General Purpose' }, { id: 107, parent: 100, name: 'Precision' }, { id: 200, parent: null, name: 'Capacitors' }, { id: 201, parent: 200, name: 'MLCC' },
    { id: 300, parent: null, name: 'Inductors & Ferrites' }, { id: 301, parent: 300, name: 'Inductors' }, { id: 600, parent: null, name: 'ICs' }, { id: 601, parent: 600, name: 'Power Management' }, { id: 1400, parent: null, name: 'Unsorted' }],
  boxes: [{ id: 1, name: 'B12' }, { id: 2, name: 'B13' }], requireReason: false,
  groups: [{ id: 1, key: 'R|2.2k|0402', label: 'Resistor 2.2k 0402', cat: 106, comps: [comp(10, 'AC0402FR-072K2L', [pk(100, 50, 1), pk(101, 25, 2)]), comp(11, 'RC0402FR-072K2L', [pk(102, 5, 1)])] },
    { id: 2, key: 'C|100nF|0402', label: 'Capacitor 100nF 0402', cat: 201, comps: [comp(20, 'CAPX', [pk(200, 7, 1)], { cat: 201, descr: 'CAP CER 100nF', sp: { volt: '50V' } })] }]
});
const rec = { supplier: 'DigiKey', mpn: 'AC0402FR-072K2L', manufacturer: 'YAGEO', description: 'RES 2.2K 1% 0402', dkPn: 'X-ND', mouserPn: '', groupKey: 'R|2.2k|0402', spec: '1%', category: 'Resistors',
  value: '2.2k', package: '0402', sp: { tol: '1%' }, missing: [], from: [] };
const oneGroup = (comps, extra) => ({ group: Object.assign({ id: 1, key: 'R|2.2k|0402', label: 'Resistor 2.2k 0402', cat: 106, comps }, extra) });
const oneComp = () => oneGroup([comp(10, 'AC0402FR-072K2L', [pk(100, 50, 1), pk(101, 25, 2)])]);
const dupAns = { parsed: {}, fp: 'D|x', rec: null, dup: Object.assign({ packetId: 100, st: 0, qty: 50, box: 1 }, oneComp()), warnings: [] };

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
  assert.ok(/wrong password/.test(p.text()) && /Sign in/.test(p.text()), p.text()); p.byId.t2.click(); assert.ok(!/Resistor 2.2k/.test(p.text()), 'stored inventory hidden after sign-out');
  p = openPage({ hash: '#t=abc', ls: {}, inv_load: mkInv() });   // token link: remembered, removed from the address bar
  assert.strictEqual(JSON.parse(p.ls.token), 'abc'); assert.strictEqual(p.ctx.location.hash, '');
  await sleep(10); assert.strictEqual(p.fetched[0].token, 'abc');

  // ---- two tabs (Scan with an Add stock | Update stock switch, Search); the Count tab is hidden until it is reworked
  p = openPage({ inv_load: mkInv() }); await sleep(10);
  assert.ok(/Add stock/.test(p.text()) && p.byId.app.className === 'mode-add'); btn(p, 'Update stock')[0].click(); assert.ok(/Update stock/.test(p.text()) && /already in stock/.test(p.text()) && p.byId.app.className === 'mode-upd', 'a different colour in update mode'); assert.strictEqual(JSON.parse(p.ls.mode), 'upd', 'the mode is remembered');
  p.byId.t2.click(); assert.ok(/Search/.test(p.text())); p.byId.t1.click(); btn(p, 'Add stock')[0].click(); assert.strictEqual(p.ctx.ui.mode, 'add');
  assert.ok(!/id="t4"/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'AppPage.html'), 'utf8')), 'the Count tab is hidden from the tab bar');

  // ---- a new packet of a known part: the box must be chosen, then it is added
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 25, lot: 'L9', dateCode: '2501' }, fp: 'D|x', comp: oneComp(), rec, source: 'DigiKey', warnings: [], cat: 106, descr: 'RES 2.2K 1% 0402' },
    inv_add: oneGroup([comp(10, 'AC0402FR-072K2L', [pk(100, 50, 1), pk(101, 25, 2), pk(103, 20, 2)])]) });
  await sleep(10);
  type(inputs(p)[0], 'AC0402FR-072K2L'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.deepStrictEqual(p.calls.slice(0, 2).map(c => c.action), ['inv_load', 'scan']); assert.deepStrictEqual(p.calls[1].texts, ['AC0402FR-072K2L']);
  assert.ok(/PART ALREADY IN STOCK/.test(p.text()) && /75 pcs in 2 packet/.test(p.text()) && /AC0402FR-072K2L/.test(p.text()));
  assert.ok(p.byId.app.find(e => /alert bad/.test(e.className) && /ALREADY IN STOCK/.test(e.textContent)).length, 'a red block, not a line of text');
  assert.ok(inputs(p).some(e => e.value === '25'), 'quantity prefilled from the label');
  const addBtn = () => btn(p, 'Add packet')[0];
  assert.ok(addBtn().disabled && /Still needed: box/.test(p.text()), 'no box, no add: ' + p.text());
  btn(p, 'Add packet')[0].click(); assert.ok(!p.calls.some(c => c.action === 'inv_add'), 'a disabled Add does nothing');
  type(inputWith(p, 'how many'), '20'); const boxSel = selects(p)[0]; choose(boxSel, '2');
  assert.ok(!addBtn().disabled && !/Still needed/.test(p.text()), 'box chosen: Add is enabled');
  addBtn().click(); await sleep(10);
  const add = p.calls.at(-1);
  assert.deepStrictEqual(strip(add), { action: 'inv_add', rec, fp: 'D|x', qty: '20', box: '2', lot: 'L9', dc: '2501', who: 'Asha' }); assert.ok(add.rid, 'every change carries a request id');
  assert.ok(/Added 20 x AC0402FR-072K2L to box B13\. Total 95/.test(p.text()), p.text());

  // ---- a new IC: editable description, category chosen, a new box is made first
  const icRec = { supplier: 'Mouser', mpn: 'NEW1', manufacturer: 'X', description: 'Some regulator', mouserPn: '1-NEW1', groupKey: 'P|new1', category: 'Misc', missing: [], from: [], sp: {} };
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 3 }, fp: null, comp: null, rec: icRec, source: 'Mouser', warnings: [], cat: 601, descr: 'Some regulator' },
    inv_box: { id: 9, name: 'Z9' }, inv_add: oneGroup([comp(30, 'NEW1', [pk(7, 3, 9)], { cat: 601 })], { id: 5, key: 'P|new1', label: 'NEW1', cat: 601 }) });
  await sleep(10);
  type(inputs(p)[0], 'NEW1'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.ok(/NEW PART/.test(p.text()) && /No order data on the label/.test(p.text()) && p.byId.app.find(e => /alert good/.test(e.className)).length && inputs(p).some(e => e.value === 'Some regulator'), 'description is editable');
  assert.ok(btn(p, 'Add packet')[0].disabled, 'box still missing');
  type(inputs(p).find(e => e.value === 'Some regulator'), 'Linear regulator 3.3V'); type(inputWith(p, 'or type a new box name'), 'Z9');
  assert.ok(!btn(p, 'Add packet')[0].disabled, 'a new box name counts as a box: ' + p.ctx.ui.cat + ' ' + selects(p).map(x => x.value + '/' + x.children.map(o => o.selected).join(',')).join(' ; '));
  btn(p, 'Add packet')[0].click(); await sleep(30);
  assert.deepStrictEqual(p.calls.filter(c => /inv_(box|add)/.test(c.action)).map(c => c.action), ['inv_box', 'inv_add']);
  const add2 = p.calls.at(-1); assert.strictEqual(add2.descr, 'Linear regulator 3.3V'); assert.strictEqual(add2.box, '9'); assert.strictEqual(add2.cat, 0, 'category left as suggested: the server keeps its own'); assert.ok(!('fix' in add2));
  assert.ok(/Added 3 x NEW1 to box Z9/.test(p.text()), p.text());
  // description untouched: not sent (the server writes its own)
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 3 }, fp: null, comp: null, rec: icRec, source: 'Mouser', warnings: [], cat: 601, descr: 'Some regulator' }, inv_add: oneGroup([comp(30, 'NEW1', [pk(7, 3, 1)], { cat: 601 })], { id: 5, key: 'P|new1', label: 'NEW1', cat: 601 }) });
  await sleep(10); type(inputs(p)[0], 'NEW1'); btn(p, 'Look up')[0].click(); await sleep(10); choose(selects(p)[0], '1'); btn(p, 'Add packet')[0].click(); await sleep(10);
  assert.ok(!('descr' in p.calls.at(-1)), 'an untouched description is not sent');
  // category not chosen (Unsorted suggestion): required
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 3 }, fp: null, comp: null, rec: icRec, source: 'Mouser', warnings: [], cat: 1400, descr: 'Some regulator' } }); await sleep(10);
  type(inputs(p)[0], 'NEW1'); btn(p, 'Look up')[0].click(); await sleep(10); choose(selects(p)[0], '1');
  assert.ok(btn(p, 'Add packet')[0].disabled && /Still needed: category/.test(p.text()), 'category required: ' + p.text());
  const catSel = selects(p)[1]; assert.ok(!catSel.children.some(o => o.textContent === 'Unsorted'), 'Unsorted is not offered'); choose(catSel, '600');
  assert.ok(!btn(p, 'Add packet')[0].disabled, 'a category chosen');

  // ---- a Mouser chip resistor with no package: the field is required, filled in, and the description follows
  const mres = { supplier: 'Mouser', mpn: 'XYZ-9', manufacturer: 'X', description: 'Thick Film Resistors - SMD 2.2 kOhms 1%', mouserPn: '603-XYZ-9', groupKey: 'P|xyz9', category: 'Resistors', value: '2.2k', package: '', sp: { tol: '1%' }, missing: ['package'], from: ['tolerance'] };
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 5 }, fp: 'M|1', comp: null, rec: mres, source: 'Mouser', warnings: [], cat: 106, descr: 'Thick Film Resistors - SMD 2.2 kOhms 1%' }, inv_add: oneGroup([comp(40, 'XYZ-9', [pk(8, 5, 1)], { src: 2 })], { id: 6, key: 'R|2.2k|0603', label: 'Resistor 2.2k 0603' }) });
  await sleep(10); type(inputs(p)[0], '603-XYZ-9'); btn(p, 'Look up')[0].click(); await sleep(10); choose(selects(p)[0], '1');
  assert.ok(btn(p, 'Add packet')[0].disabled && /Still needed: package/.test(p.text()), 'package required: ' + p.text());
  assert.ok(/Read from the part number: please check it/.test(p.text()), 'values read from the part number are marked');
  const pkgSel = selects(p).find(s => s.children.some(o => o.textContent === 'Choose a size...')); assert.ok(pkgSel, 'package is a dropdown');
  choose(pkgSel, '0603');
  assert.ok(inputs(p).some(e => e.value === 'RES 2.2K OHM 1% 0603'), 'description follows the fields: ' + inputs(p).map(e => e.value));
  assert.ok(!btn(p, 'Add packet')[0].disabled);
  btn(p, 'Add packet')[0].click(); await sleep(10);   // power is blank: only an optional value, so a question comes first
  assert.ok(/1 value is missing for this part \(power\)\. Add anyway\?/.test(p.byId.modal.textContent), p.text()); assert.ok(!p.calls.some(c => c.action === 'inv_add'));
  btn(p, 'Go back', p.byId.modal)[0].click(); assert.strictEqual(p.byId.modal.style.display, 'none'); assert.ok(!p.calls.some(c => c.action === 'inv_add'));
  btn(p, 'Add packet')[0].click(); btn(p, 'Add anyway', p.byId.modal)[0].click(); await sleep(10);
  const add3 = p.calls.at(-1); assert.strictEqual(add3.action, 'inv_add'); assert.deepStrictEqual(add3.fix, { value: '2.2k', package: '0603', tol: '1%', pow: '', volt: '', diel: '', cur: '' });
  // a capacitor: three optional values missing
  const mcap = Object.assign({}, mres, { mpn: 'CAP-1', category: 'Capacitors', value: '100nF', package: '0402', sp: {}, missing: [], from: [], groupKey: 'C|100nF|0402' });
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 5 }, fp: null, comp: null, rec: mcap, source: 'Mouser', warnings: [], cat: 201, descr: 'CAP CER 100nF 0402' } }); await sleep(10);
  type(inputs(p)[0], 'CAP-1'); btn(p, 'Look up')[0].click(); await sleep(10); choose(selects(p)[0], '1'); btn(p, 'Add packet')[0].click();
  assert.ok(/3 values are missing for this part \(voltage, dielectric, tolerance\)/.test(p.byId.modal.textContent), p.byId.modal.textContent);

  // ---- an inductor has no standard package: "Other (type it)" shows a text box and what is typed is the package
  const mind = Object.assign({}, mres, { mpn: 'IND-1', category: 'Inductors', value: '10uH', package: '', sp: { cur: '2A' }, missing: ['package'], from: [], groupKey: 'P|ind1', description: 'Fixed Inductors 10uH 2A' });
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 5 }, fp: null, comp: null, rec: mind, source: 'Mouser', warnings: [], cat: 301, descr: 'Fixed Inductors 10uH 2A' }, inv_add: oneGroup([comp(41, 'IND-1', [pk(9, 5, 1)], { cat: 301 })], { id: 7, key: 'L|10uH|7x7 shielded', label: 'Inductor 10uH 7x7 shielded', cat: 301 }) });
  await sleep(10); type(inputs(p)[0], 'IND-1'); btn(p, 'Look up')[0].click(); await sleep(10); choose(selects(p)[0], '1');
  const pkgS = selects(p).find(x => x.children.some(o => o.textContent === 'Choose a size...')); assert.ok(pkgS.children.some(o => o.textContent === 'Other (type it)'), 'the dropdown ends with Other');
  const ptxt = inputWith(p, 'e.g. 7x7 shielded'); assert.strictEqual(ptxt.style.display, 'none'); choose(pkgS, 'Other (type it)'); assert.strictEqual(ptxt.style.display, 'block', 'Other shows a text box');
  assert.ok(btn(p, 'Add packet')[0].disabled && /package/.test(p.text()), 'an empty "Other" is still missing'); type(ptxt, '7x7 shielded');
  assert.ok(!btn(p, 'Add packet')[0].disabled && inputs(p).some(e => e.value === 'FIXED IND 10uH 2A 7x7 shielded'), 'description follows the typed package');
  btn(p, 'Add packet')[0].click(); await sleep(10); assert.strictEqual(p.calls.at(-1).fix.package, '7x7 shielded');

  // ---- a packet already in stock (Scan tab): asks whether to change something, then switches to Update stock
  p = openPage({ inv_load: mkInv(), scan: dupAns, inv_txn: oneGroup([comp(10, 'AC0402FR-072K2L', [pk(100, 45, 1), pk(101, 25, 2)])]) });
  await sleep(10); type(inputs(p)[0], 'x'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.ok(/PART ALREADY IN STOCK/.test(p.text()) && /Do you want to change something\?/.test(p.text()) && /This packet: 50 pcs · box B12/.test(p.text()), p.text());
  btn(p, 'Yes, update stock')[0].click(); assert.strictEqual(p.ctx.ui.mode, 'upd'); assert.ok(/Update stock/.test(p.text()) && /PACKET FOUND/.test(p.text()) && p.byId.app.find(e => /alert good/.test(e.className)).length && btn(p, 'Take').length);
  const takeB = btn(p, 'Take')[0]; takeB.click(); assert.ok(/Enter a whole number above 0/.test(p.text()) && !p.calls.some(c => c.action === 'inv_txn'), 'no quantity, no request');
  type(inputWith(p, 'e.g. 10'), '5'); takeB.click();
  assert.ok(!p.calls.some(c => c.action === 'inv_txn'), 'tapping Take only asks');
  assert.ok(/Take 5 from AC0402FR-072K2L\?/.test(p.byId.modal.textContent) && /goes from 50 to 45 pcs/.test(p.byId.modal.textContent), p.byId.modal.textContent);
  btn(p, 'Cancel', p.byId.modal)[0].click(); assert.ok(!p.calls.some(c => c.action === 'inv_txn') && p.byId.modal.style.display === 'none', 'Cancel does nothing');
  takeB.click(); btn(p, 'Yes, take 5', p.byId.modal)[0].click();
  assert.deepStrictEqual(strip(p.calls.at(-1)), { action: 'inv_txn', packet: 100, note: '', mode: 'take', qty: '5', who: 'Asha' });
  await sleep(10); assert.ok(/Took 5 from AC0402FR-072K2L\. 45 in this packet now\./.test(p.text()), p.text());
  // busy lock: while the server has not answered, no button works and the tapped one says what it does
  p = openPage({ inv_load: mkInv(), scan: dupAns, inv_txn: oneGroup([comp(10, 'AC0402FR-072K2L', [pk(100, 45, 1), pk(101, 25, 2)])]), hold: ['inv_txn'] });
  await sleep(10); btn(p, 'Update stock')[0].click(); type(inputs(p)[0], 'x'); btn(p, 'Look up')[0].click(); await sleep(10);
  type(inputWith(p, 'e.g. 10'), '5'); const tk = btn(p, 'Take')[0], ad = btn(p, 'Add')[0]; tk.click(); btn(p, 'Yes, take 5', p.byId.modal)[0].click();
  assert.strictEqual(tk.textContent, 'Taking...'); assert.ok(ad.disabled && btn(p, 'Move')[0].disabled && btn(p, 'Set count')[0].disabled && p.byId.t1.disabled && p.byId.t2.disabled, 'everything is locked');
  assert.ok(/Taking/.test(p.byId.msg.textContent) || /Saving/.test(p.byId.msg.textContent), 'the banner says it is working');
  tk.fire('click'); ad.fire('click'); p.byId.t2.fire('click');
  assert.strictEqual(p.calls.filter(c => c.action === 'inv_txn').length, 1, 'a second tap does not repeat the action'); assert.strictEqual(p.byId.t1.className, 'on', 'tabs do not switch while busy');
  p.held.shift()(); await sleep(10);
  assert.ok(!p.byId.t1.disabled && !btn(p, 'Take').length, 'unlocked, the next packet can be scanned'); assert.ok(/Took 5/.test(p.text()));
  // an error unlocks too, and stays on screen
  p = openPage({ inv_load: mkInv(), scan: dupAns, inv_txn: new Error('Only 3 left in that packet.') }); await sleep(10); btn(p, 'Update stock')[0].click(); type(inputs(p)[0], 'x'); btn(p, 'Look up')[0].click(); await sleep(10);
  type(inputWith(p, 'e.g. 10'), '5'); btn(p, 'Take')[0].click(); btn(p, 'Yes, take 5', p.byId.modal)[0].click(); await sleep(10);
  assert.ok(/Only 3 left in that packet\./.test(p.byId.msg.textContent) && /bad/.test(p.byId.msg.className) && !p.byId.t1.disabled && !btn(p, 'Take')[0].disabled, 'red banner, buttons back');
  // an archived packet says so
  p = openPage({ inv_load: mkInv(), scan: Object.assign({}, dupAns, { dup: Object.assign({ packetId: 100, st: 1, qty: 0, box: 1 }, oneComp()) }) }); await sleep(10);
  type(inputs(p)[0], 'x'); btn(p, 'Look up')[0].click(); await sleep(10); assert.ok(/was used up/.test(p.text()));
  // Update stock with a label that is not in stock: no changes offered, a way to add it
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 5 }, fp: 'D|n', comp: null, rec, source: 'DigiKey', warnings: [], cat: 106, descr: 'd' } }); await sleep(10);
  btn(p, 'Update stock')[0].click(); type(inputs(p)[0], 'x'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.ok(/THIS PACKET IS NOT IN STOCK/.test(p.text()) && p.byId.app.find(e => /alert bad/.test(e.className)).length && !btn(p, 'Take').length); btn(p, 'Add it as new stock')[0].click(); assert.strictEqual(p.ctx.ui.mode, 'add'); assert.ok(btn(p, 'Add packet').length);

  // ---- not found
  p = openPage({ inv_load: mkInv(), scan: { parsed: { raw: '[)>\x1e06\x1d1PABC', fields: { '1P': 'ABC' }, mpn: 'ABC' }, rec: null, warnings: ['Mouser key missing'] } }); await sleep(10);
  type(inputs(p)[0], 'ZZZ'); btn(p, 'Look up')[0].click(); await sleep(10);
  assert.ok(/PART NOT FOUND/.test(p.text()) && /Mouser key missing/.test(p.text()) && /Decoded: \[\)><RS>06<GS>1PABC/.test(p.text()) && /searched: ABC/.test(p.text()));

  // ---- Search: filtered in the page (no server call), tiles drill down, chips remove, group opens into parts and packets
  p = openPage({ inv_load: mkInv(), inv_txn: oneComp(), inv_edit: oneGroup([comp(10, 'AC0402FR-072K2L', [pk(100, 50, 1), pk(101, 25, 2)], { descr: 'RES precise' })], { id: 9, key: 'R|4.7k|0402', label: 'Resistor 4.7k 0402' }) });
  await sleep(10); p.byId.t2.click();
  const nCalls = p.calls.length;
  assert.ok(/Resistors/.test(p.text()) && /Capacitors/.test(p.text()) && !/Unsorted/.test(p.text()), 'tiles for categories that have parts'); assert.ok(/2 result/.test(p.text()));
  type(inputs(p)[0], '0402 2.2k'); assert.ok(/Resistor 2.2k 0402/.test(p.text()) && !/Capacitor 100nF/.test(p.text())); assert.ok(p.byId.app.find(e => e.tag === 'mark').length >= 2, 'the search words are highlighted'); assert.strictEqual(p.calls.length, nCalls, 'typing makes no server call');
  type(inputs(p)[0], 'zzz'); assert.ok(/Nothing matched/.test(p.text())); type(inputs(p)[0], '');
  p.byId.app.find(e => e.tag === 'button' && /^Capacitors/.test(e.textContent))[0].click();
  assert.ok(/1 result/.test(p.text()) && !/Resistor 2.2k/.test(p.text()) && /MLCC/.test(p.text()), 'category tile filters and shows sub-category tiles');
  p.byId.app.find(e => e.tag === 'button' && /^Capacitors ?$/.test(e.textContent) && /x/.test(e.className))[0].click(); assert.ok(/2 result/.test(p.text()), 'chip removes the filter');
  p.byId.app.find(e => e.tag === 'button' && e.textContent === 'In stock')[0].click(); assert.ok(/2 result/.test(p.text()));
  p.byId.app.find(e => e.className === 'tap' && /Resistor 2.2k/.test(e.textContent))[0].click();
  assert.ok(/AC0402FR-072K2L/.test(p.text()) && /RC0402FR-072K2L/.test(p.text()) && /50 pcs · box B12/.test(p.text()) && /Last change: Asha 2023-11-14/.test(p.text()), 'group opens into part numbers and packets: ' + p.text());
  assert.ok(/2 part numbers/.test(p.text()));
  // edit a packet from the list
  btn(p, 'Edit packet')[0].click(); type(inputWith(p, 'e.g. 10'), '10'); btn(p, 'Add')[0].click(); btn(p, 'Yes, add 10', p.byId.modal)[0].click();
  assert.deepStrictEqual(strip(p.calls.at(-1)), { action: 'inv_txn', packet: 100, note: '', mode: 'add', qty: '10', who: 'Asha' });
  await sleep(10); assert.ok(/Added 10 to AC0402FR-072K2L/.test(p.text()));
  // edit a part: description, category, value and package; saving re-groups it
  btn(p, 'Edit part')[0].click(); const di =p.byId.app.find(e => e.tag === 'input' && e.value === 'D-AC0402FR-072K2L')[0]; assert.ok(di, 'description editable'); type(di, 'RES precise');
  const vi = inputs(p).find(e => e.value === '2.2k'); assert.ok(vi, 'value editable'); type(vi, '4.7k'); assert.ok(selects(p).some(s => s.children.some(o => o.textContent === 'Choose a size...') && s.value === '0402'), 'package dropdown shows 0402');
  btn(p, 'Save changes')[0].click();
  const ed = p.calls.at(-1); assert.deepStrictEqual(Object.keys(strip(ed)).sort(), ['action', 'cat', 'comp', 'descr', 'fix', 'who']); assert.strictEqual(ed.comp, 10); assert.strictEqual(ed.cat, 106); assert.strictEqual(ed.fix.value, '4.7k'); assert.strictEqual(ed.fix.package, '0402'); assert.strictEqual(ed.descr, 'RES precise');
  await sleep(10); assert.ok(/Saved changes to AC0402FR-072K2L/.test(p.text()));
  assert.ok(/Resistor 4.7k 0402/.test(p.text()) && /Resistor 2.2k 0402/.test(p.text()), 'the part moved to its new group, the old group keeps the other part');
  // sort controls
  const order = () => ['Resistor 4.7k', 'Capacitor 100nF'].map(m => [m, p.text().indexOf(m)]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  const sel = p.byId.app.find(e => e.tag === 'select')[0]; sel.value = 'qty'; sel.fire('change'); assert.strictEqual(order()[0], 'Capacitor 100nF', 'ascending quantity');
  p.byId.app.find(e => e.textContent === 'Ascending')[0].click(); assert.strictEqual(order()[0], 'Resistor 4.7k');

  // ---- Search loads 25 groups at a time; a new search or filter starts from the first page again
  const big = mkInv(); for (let i = 0; i < 60; i++) big.groups.push({ id: 100 + i, key: 'P|x' + i, label: 'Part ' + String(i).padStart(2, '0'), cat: 601, comps: [comp(500 + i, 'X-' + i, [pk(900 + i, 1, 1)], { cat: 601 })] });
  p = openPage({ inv_load: big }); await sleep(10); p.byId.t2.click();
  const shown = () => p.byId.app.find(e => e.className === 'tap').length;
  // opening a group closes the one that was open
  const tapOf = n => p.byId.app.find(e => e.className === 'tap' && e.textContent.indexOf('Part ' + n) === 0)[0];
  tapOf('00').click(); assert.strictEqual(btn(p, 'Edit part').length, 1); tapOf('01').click();
  assert.strictEqual(btn(p, 'Edit part').length, 1, 'only one group is open'); assert.strictEqual(p.byId.app.find(e => /item open/.test(e.className)).length, 1); assert.strictEqual(p.byId.app.find(e => e.className === 'kid')[0].textContent.indexOf('X-1'), 0, 'the open one is the second');
  tapOf('01').click(); assert.strictEqual(btn(p, 'Edit part').length, 0, 'tapping the open one closes it');
  assert.strictEqual(shown(), 25, 'first page'); assert.ok(/25 of 62 result/.test(p.text()) && /Load more \(37 left\)/.test(p.text()));
  btn(p, 'Load more (37 left)')[0].click(); assert.strictEqual(shown(), 50, 'the next 25'); btn(p, 'Load more (12 left)')[0].click(); assert.strictEqual(shown(), 62); assert.ok(!/Load more/.test(p.text()) && /62 result/.test(p.text()));
  type(inputs(p)[0], 'Part'); assert.strictEqual(shown(), 25, 'a new search starts from the first page'); assert.ok(/25 of 60 result/.test(p.text()));
  assert.strictEqual(p.calls.length, 1, 'loading more makes no server call');

  // ---- require reason (a deployment setting) adds a field and checks it
  const need = mkInv(); need.requireReason = true; p = openPage({ inv_load: need, inv_txn: oneComp() }); await sleep(10); p.byId.t2.click();
  p.byId.app.find(e => e.className === 'tap' && /Capacitor/.test(e.textContent))[0].click(); btn(p, 'Edit packet')[0].click(); assert.ok(inputWith(p, 'e.g. board X build'));
  type(inputWith(p, 'e.g. 10'), '1'); btn(p, 'Take')[0].click(); assert.ok(/Say what the parts are for/.test(p.text()) && !p.calls.some(c => c.action === 'inv_txn'));

  // ---- Count tab
  p = openPage({ inv_load: mkInv(), inv_audit: { comps: [oneComp()] } }); await sleep(10); p.ctx.tab = 'count'; p.ctx.render();   // hidden from the tab bar, the code still works
  assert.ok(/Pick a box/.test(p.text())); choose(selects(p)[0], '1');
  assert.ok(/AC0402FR-072K2L \(recorded 50\)/.test(p.text()) && /CAPX/.test(p.text()));
  const c1 = inputs(p).find(e => e.value === '50'); type(c1, '48'); btn(p, 'Save counts')[0].click();
  assert.deepStrictEqual(p.calls.at(-1).items, [{ packet: 100, counted: '48' }, { packet: 102, counted: 5 }, { packet: 200, counted: 7 }]); await sleep(10);
  assert.ok(/Counted 3 packet\(s\), 1 corrected/.test(p.text()), p.text());

  // ---- the name is required before a change
  p = openPage({ ls: { pass: '"pw"' }, inv_load: mkInv() }); await sleep(10); p.byId.t2.click();
  p.byId.app.find(e => e.className === 'tap' && /Capacitor/.test(e.textContent))[0].click(); btn(p, 'Edit packet')[0].click(); type(inputWith(p, 'e.g. 10'), '1'); btn(p, 'Take')[0].click(); btn(p, 'Yes, take 1', p.byId.modal)[0].click();
  assert.ok(/enter your name first/i.test(p.text()) && !p.calls.some(c => c.action === 'inv_txn'));

  // ---- live scan: camera blocked; a packet in stock gets "Change something?" (Yes switches to Update stock, No keeps scanning); a new part goes on to the add form
  p = openPage({ inv_load: mkInv(), env: { navigator: { mediaDevices: { getUserMedia: () => Promise.reject({ name: 'NotAllowedError', message: 'denied' }) } } } });
  assert.ok(btn(p, 'Take photo').length && btn(p, 'Live scan').length); btn(p, 'Live scan')[0].click(); await sleep(10);
  assert.ok(/live camera blocked \(NotAllowedError: denied\)/.test(p.text()) && /photo button/.test(p.text()) && /bad/.test(p.byId.msg.className));
  let stopped = 0; const asked = [];
  const label = '[)>\x1e06\x1d1PAC0402FR-072K2L\x1d30PX-ND\x1d10K9001\x1dQ50';
  const wasm = { readBarcodes: (img, o) => { asked.push(JSON.parse(JSON.stringify(o.formats))); return Promise.resolve([{ text: label, format: 'DataMatrix', isValid: true }]); } };
  const env = { ZXingWASM: wasm, navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => stopped++ }] }) } } };
  p = openPage({ inv_load: mkInv(), scan: dupAns, env });
  btn(p, 'Live scan')[0].click(); await sleep(1500);
  const live = p.byId.live;
  assert.ok(/ALREADY IN STOCK/.test(live.textContent) && /This packet is in stock/.test(live.textContent) && /AC0402FR-072K2L/.test(live.textContent) && /50 pcs/.test(live.textContent) && /Change something\?/.test(live.textContent), 'live prompt: ' + live.textContent);
  assert.strictEqual(p.calls.filter(c => c.action === 'scan').length, 1, 'asked once');
  btn(p, 'No, keep scanning', live)[0].click(); assert.strictEqual(live.style.display, 'block', 'No: the camera keeps running'); assert.ok(/Reading/.test(live.textContent), 'No resumes scanning');
  await sleep(900);
  btn(p, 'Yes, update stock', live)[0].click(); assert.strictEqual(stopped, 1, 'camera stopped'); assert.strictEqual(live.style.display, 'none');
  assert.strictEqual(p.ctx.ui.mode, 'upd'); assert.ok(btn(p, 'Take').length && /AC0402FR-072K2L/.test(p.text()), 'Yes opens the packet in Update stock');
  assert.deepStrictEqual(asked[0], ['DataMatrix'], 'only the Data Matrix is read for a DigiKey label');
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 50, lot: '' }, rec, comp: null, fp: 'D|y', source: 'DigiKey', warnings: [], cat: 106, descr: 'd' }, env });
  btn(p, 'Live scan')[0].click(); await sleep(1500);
  assert.ok(/Part detected/.test(p.byId.live.textContent) && /Quantity on label: 50/.test(p.byId.live.textContent));
  btn(p, 'Use this part', p.byId.live)[0].click(); assert.ok(btn(p, 'Add packet').length && /AC0402FR-072K2L/.test(p.text()), 'normal add form follows');
  p = openPage({ inv_load: mkInv(), scan: { parsed: { qty: 50, lot: '' }, rec, comp: null, fp: 'D|y', source: 'DigiKey', warnings: [], cat: 106, descr: 'd' }, env }); await sleep(10); btn(p, 'Update stock')[0].click();
  btn(p, 'Live scan')[0].click(); await sleep(1500);
  assert.ok(/This packet is not in stock/.test(p.byId.live.textContent)); btn(p, 'Add it as new stock', p.byId.live)[0].click(); assert.strictEqual(p.ctx.ui.mode, 'add'); assert.ok(btn(p, 'Add packet').length, 'Update-mode live scan of a new label offers to add it');

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

  // ---- scanning filters: plain frames first; after two empty frames a clean-up (stretch, then local threshold) is tried on later frames. A dull label (grey 100/140) only
  // reads once stretched; the plain frames cost nothing extra and the clean-up is never used while frames read.
  const dull = (w, h) => { if (!dull.d) { dull.d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const v = (((i % w) >> 4) + (((i / w) | 0) >> 4)) % 2 ? 100 : 140; dull.d.set([v, v, v, 255], i * 4); } } return dull.d; };
  const seenLight = []; const dullWasm = { readBarcodes: (img, o) => { seenLight.push(img.data[1]); return Promise.resolve(img.data[1] > 200 ? [{ text: label, format: 'DataMatrix', isValid: true }] : []); } };
  p = openPage({ inv_load: mkInv(), scan: dupAns, frame: dull, env: { ZXingWASM: dullWasm, navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) } } } });
  btn(p, 'Live scan')[0].click(); await sleep(1500);
  const reads = seenLight.filter(v => v);   // (the decoder warm-up read has no pixels)
  assert.ok(reads.slice(0, 4).every(v => v === 140) && reads.includes(255), 'two plain frames (two reads each), then a stretched one: ' + reads.slice(0, 8));
  assert.ok(/ALREADY IN STOCK/.test(p.byId.live.textContent), 'the dull label read after the clean-up');
  const crisp = (w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set([255, 255, 255, 255], i * 4); for (let i = 0; i < 40; i++) d.set([0, 0, 0, 255], i * 4); return d; };
  const plainWasm = { readBarcodes: (img) => { seenLight.length = 0; seenLight.push(img.data[1000 * 4 + 1]); return Promise.resolve([{ text: label, format: 'DataMatrix', isValid: true }]); } };
  p = openPage({ inv_load: mkInv(), scan: dupAns, frame: crisp, env: { ZXingWASM: plainWasm, navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) } } } });
  btn(p, 'Live scan')[0].click(); await sleep(700); assert.ok(p.ctx.st.dbg && p.ctx.st.dbg.filter === 'raw' || p.ctx.st.dbg === undefined, 'a frame that reads is never filtered');

  // ---- debug panel: API calls today per provider
  p = openPage({ ls: { token: '"abc"', debug: 'true' }, inv_load: mkInv(), usage: { day: '2026-11-19', DigiKey: 12, Mouser: 3 } }); await sleep(10);
  assert.ok(/DigiKey calls today \(UTC\)12 \/ 1000/.test(p.text()) && /Mouser calls today \(UTC\)3 \/ 1000/.test(p.text()), p.text());
  const built = require('../tools/build_web').buildWeb();
  assert.ok(!/<\?/.test(built) && /function partKeys_/.test(built) && /function fingerprint_/.test(built) && /function describePassive_/.test(built), 'build fills every template tag');
  console.log('page ok'); process.exit(0);   // live-scan pages left open keep their frame timers running
})().catch(e => { console.error(e); process.exit(1); });
