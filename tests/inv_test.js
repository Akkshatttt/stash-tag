// Run: node tests/inv_test.js
// Drives functions/api.js inventory actions against a real SQLite database (node:sqlite behind a small D1-shaped wrapper).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { makeD1 } = require('./d1');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const res = (code, body) => ({ status: code, text: async () => JSON.stringify(body) });
const supplier = [];
global.fetch = async url => {
  supplier.push(url);
  if (url.includes('oauth2')) return res(200, { access_token: 't', expires_in: 600 });
  if (url.includes('digikey.com')) return res(200, fx('dk_AC0402FR-072K2L.json'));
  return res(404, {});
};

(async () => {
  const base = pathToFileURL(path.join(__dirname, '..')).href;
  const { onRequestPost } = await import(base + '/functions/api.js');
  const inv = await import(base + '/lib/inv.js');
  const env = { DB: makeD1(), TOKEN: 'tok', DIGIKEY_CLIENT_ID: 'a', DIGIKEY_CLIENT_SECRET: 'b', MOUSER_KEY: 'c' };
  const waits = [];
  const call = async (req, extra) => { const r = await onRequestPost({ request: { json: async () => Object.assign({ token: 'tok', req }, extra) }, env, waitUntil: p => waits.push(p) }); await Promise.all(waits); return r.json(); };
  const ok = async req => { const r = await call(req); assert.ok(r.ok, JSON.stringify(r)); return r.data; };

  // empty database: schema is created, the taxonomy seeded
  let all = await ok({ action: 'inv_load' });
  assert.deepStrictEqual(all.groups, []);
  assert.ok(all.cats.find(c => c.name === 'Resistors' && !c.parent) && all.cats.find(c => c.name === 'Chip' && c.parent === 100) && all.cats.find(c => c.name === 'Unsorted'));

  // scan a DigiKey 2D label, add it
  const label = '[)>\x1e06\x1dP311-2.20KLRCT-ND\x1d1PAC0402FR-072K2L\x1d30P311-2.20KLRCT-ND\x1dK PO1\x1d1K88001\x1d10K99001\x1d11K5001\x1dQ50\x1d1T\x1e\x04';
  let s = await ok({ action: 'scan', texts: [label] });
  assert.strictEqual(s.rec.mpn, 'AC0402FR-072K2L'); assert.ok(s.fp && s.fp.startsWith('D|'), 'fingerprint from the label'); assert.strictEqual(s.comp, null); assert.strictEqual(s.dup, undefined);
  const box = await ok({ action: 'inv_box', name: 'B12' });
  let a = await ok({ action: 'inv_add', rec: s.rec, fp: s.fp, qty: 50, box: box.id, who: 'Asha', lot: 'L1' });
  assert.ok(!a.dup); assert.strictEqual(a.group.comps[0].packets[0].qty, 50); assert.strictEqual(a.group.comps[0].by, 'Asha');
  assert.ok(/^R\|/.test(a.group.key) && a.group.label.startsWith('Resistor'), 'passive grouped by value and package');
  assert.strictEqual(a.group.cat, 101, 'category Resistors > Chip from the supplier path');
  assert.ok(a.group.comps[0].descr.length > 5);

  // the same label again: recognised before any supplier call, nothing added
  supplier.length = 0;
  s = await ok({ action: 'scan', texts: [label] });
  assert.ok(s.dup && s.dup.qty === 50 && s.dup.group.comps[0].mpn === 'AC0402FR-072K2L'); assert.strictEqual(supplier.length, 0, 'a known packet costs no lookup');
  a = await ok({ action: 'inv_add', rec: s.dup && fx('dk_AC0402FR-072K2L.json'), fp: s.dup.packetId && s.fp || 'x', qty: 5, who: 'Ben' });
  assert.ok(a.dup, 'add of a known fingerprint is refused with the existing packet');
  all = await ok({ action: 'inv_load' }); assert.strictEqual(all.groups[0].comps[0].packets.length, 1);

  // a different packet of the same part joins the same part and group
  const label2 = label.replace('K PO1', 'K PO2').replace('10K99001', '10K99002');
  s = await ok({ action: 'scan', texts: [label2] });
  assert.ok(!s.dup && s.comp, 'new packet, existing part is reported'); assert.strictEqual(s.comp.group.comps[0].packets.length, 1);
  a = await ok({ action: 'inv_add', rec: s.rec, fp: s.fp, qty: 10, who: 'Ben' });
  assert.strictEqual(a.group.comps.length, 1); assert.strictEqual(a.group.comps[0].packets.length, 2); assert.strictEqual(a.group.comps[0].by, 'Ben');

  // transactions
  const [p1, p2] = a.group.comps[0].packets, take = (n, p, extra) => call(Object.assign({ action: 'inv_txn', packet: p || p1.id, mode: 'take', qty: n, who: 'Cy' }, extra));
  let t = await take(20); assert.ok(t.ok); assert.strictEqual(t.data.group.comps[0].packets[0].qty, 30); assert.strictEqual(t.data.group.comps[0].by, 'Cy');
  t = await take(31); assert.ok(!t.ok && /Only 30/.test(t.error), 'never negative');
  t = await take(0); assert.ok(!t.ok);
  t = await ok({ action: 'inv_txn', packet: p1.id, mode: 'add', qty: 5, who: 'Cy' }); assert.strictEqual(t.group.comps[0].packets[0].qty, 35);
  t = await ok({ action: 'inv_txn', packet: p1.id, mode: 'set', qty: 33, who: 'Cy' }); assert.strictEqual(t.group.comps[0].packets[0].qty, 33);
  t = await ok({ action: 'inv_txn', packet: p1.id, mode: 'move', box: box.id, who: 'Cy' });
  const b2 = await ok({ action: 'inv_box', name: 'B13' }); assert.strictEqual((await ok({ action: 'inv_box', name: 'B13' })).id, b2.id, 'same box name, same box');
  t = await ok({ action: 'inv_txn', packet: p2.id, mode: 'move', box: b2.id, who: 'Cy' }); assert.strictEqual(t.group.comps[0].packets[1].box, b2.id);
  // emptying archives the packet: it leaves the live list, its label stays blocked, and an add revives it
  t = await take(10, p2.id); assert.strictEqual(t.data.group.comps[0].packets.length, 1);
  s = await ok({ action: 'scan', texts: [label2] }); assert.ok(s.dup && s.dup.st === 1 && s.dup.qty === 0, 'archived packet still recognised');
  t = await ok({ action: 'inv_txn', packet: p2.id, mode: 'add', qty: 4, who: 'Cy' }); assert.strictEqual(t.group.comps[0].packets.length, 2);

  // reason on take is a deployment setting, off by default
  env.REQUIRE_REASON = '1';
  t = await take(1); assert.ok(!t.ok && /for/.test(t.error)); t = await take(1, p1.id, { note: 'board X' }); assert.ok(t.ok);
  assert.strictEqual((await ok({ action: 'inv_load' })).requireReason, true); delete env.REQUIRE_REASON;

  // audit: counted differs from recorded -> corrected and logged
  const au = await ok({ action: 'inv_audit', who: 'Dee', items: [{ packet: p1.id, counted: 30 }, { packet: p2.id, counted: 4 }] });
  assert.strictEqual(au.comps[0].group.comps[0].packets[0].qty, 30);
  const h = await ok({ action: 'inv_hist', comp: a.group.comps[0].id });
  assert.deepStrictEqual(h.slice(0, 1).map(x => [x.kind, x.by]), [['audit', 'Dee']]); assert.ok(h.some(x => x.kind === 'take' && x.delta === -20 && x.by === 'Cy'));

  // description and category overrides are saved on the part, logged, and taught to the next new part of that supplier category
  const cid = a.group.comps[0].id;
  let e = await ok({ action: 'inv_edit', comp: cid, descr: 'RES 2.2K 0402 precision', cat: 105, who: 'Eve' });
  assert.strictEqual(e.group.comps[0].descr, 'RES 2.2K 0402 precision'); assert.strictEqual(e.group.comps[0].cat, 105);
  assert.ok(!(await call({ action: 'inv_edit', comp: cid, cat: 99999 })).ok);
  assert.ok((await ok({ action: 'inv_hist', comp: cid })).some(x => x.kind === 'edit' && x.by === 'Eve'));
  const c2 = await ok({ action: 'inv_cat', name: 'Special', parent: 700 }); assert.ok(c2.id >= 10000);
  assert.strictEqual((await ok({ action: 'inv_cat', name: 'Special', parent: 700 })).id, c2.id);

  // a part with no order data on its label has no fingerprint: added each time, never blocked
  const typed = await ok({ action: 'scan', texts: ['AC0402FR-072K2L'] });
  assert.strictEqual(typed.fp, null);
  const m1 = await ok({ action: 'inv_add', rec: typed.rec, fp: null, qty: 3, who: 'Fay' }), m2 = await ok({ action: 'inv_add', rec: typed.rec, fp: null, qty: 3, who: 'Fay' });
  assert.strictEqual(m2.group.comps[0].packets.length, 4);

  // Mouser 2D without a part number: still recognised by invoice + line
  const mlabel = '[)>\x1e06\x1dK3999721\x1d14K001\x1d11K88123\x1dQ195\x1d1VHirose';
  await ok({ action: 'inv_add', rec: { supplier: 'Mouser', mpn: 'DF13-2P', mouserPn: '798-DF13-2P', manufacturer: 'Hirose', description: 'Connector', categoryPath: 'Headers & Wire Housings', groupKey: 'P|df132p' }, fp: (await ok({ action: 'scan', texts: [mlabel, '798-DF13-2P'], supplier: 'Mouser' })).fp, qty: 195, who: 'Gus' });
  const ms = await ok({ action: 'scan', texts: [mlabel] });
  assert.ok(ms.dup && ms.dup.group.comps[0].mpn === 'DF13-2P', 'Mouser packet recognised from the 2D code alone');
  assert.strictEqual((await ok({ action: 'inv_load' })).groups.find(g => g.key === 'P|df132p').cat, 701, 'connector category from the Mouser category');

  // bad input
  assert.ok(!(await call({ action: 'inv_add', rec: s.rec, qty: -3 })).ok); assert.ok(!(await call({ action: 'inv_txn', packet: 99999, mode: 'take', qty: 1 })).ok);
  assert.ok(!(await call({ action: 'inv_nope' })).ok);
  console.log('inventory ok');
})().catch(e => { console.error(e); process.exit(1); });
