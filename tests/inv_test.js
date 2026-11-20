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
  assert.ok(all.cats.find(c => c.name === 'Resistors' && !c.parent) && all.cats.find(c => c.name === 'General Purpose' && c.parent === 100) && !all.cats.find(c => c.name === 'Chip') && all.cats.find(c => c.name === 'Unsorted'));

  // scan a DigiKey 2D label, add it
  const label = '[)>\x1e06\x1dP311-2.20KLRCT-ND\x1d1PAC0402FR-072K2L\x1d30P311-2.20KLRCT-ND\x1dK PO1\x1d1K88001\x1d10K99001\x1d11K5001\x1dQ50\x1d1T\x1e\x04';
  let s = await ok({ action: 'scan', texts: [label] });
  assert.strictEqual(s.rec.mpn, 'AC0402FR-072K2L'); assert.ok(s.fp && s.fp.startsWith('D|'), 'fingerprint from the label'); assert.strictEqual(s.comp, null); assert.strictEqual(s.dup, undefined);
  const box = await ok({ action: 'inv_box', name: 'B12' });
  let a = await ok({ action: 'inv_add', rec: s.rec, fp: s.fp, qty: 50, box: box.id, who: 'Asha', lot: 'L1' });
  assert.ok(!a.dup); assert.strictEqual(a.group.comps[0].packets[0].qty, 50); assert.strictEqual(a.group.comps[0].by, 'Asha');
  assert.ok(/^R\|/.test(a.group.key) && a.group.label.startsWith('Resistor'), 'passive grouped by value and package');
  assert.strictEqual(a.group.cat, 106, 'category Resistors > General Purpose (1% thick film)');
  assert.ok(a.group.comps[0].descr.length > 5);

  // the same label again: recognised before any supplier call, nothing added
  supplier.length = 0;
  s = await ok({ action: 'scan', texts: [label] });
  assert.ok(s.dup && s.dup.qty === 50 && s.dup.group.comps[0].mpn === 'AC0402FR-072K2L'); assert.strictEqual(supplier.length, 0, 'a known packet costs no lookup');
  a = await ok({ action: 'inv_add', rec: s.dup && fx('dk_AC0402FR-072K2L.json'), fp: s.dup.packetId && s.fp || 'x', qty: 5, box: box.id, who: 'Ben' });
  assert.ok(a.dup, 'add of a known fingerprint is refused with the existing packet');
  all = await ok({ action: 'inv_load' }); assert.strictEqual(all.groups[0].comps[0].packets.length, 1);

  // a different packet of the same part joins the same part and group
  const label2 = label.replace('K PO1', 'K PO2').replace('10K99001', '10K99002');
  s = await ok({ action: 'scan', texts: [label2] });
  assert.ok(!s.dup && s.comp, 'new packet, existing part is reported'); assert.strictEqual(s.comp.group.comps[0].packets.length, 1);
  a = await ok({ action: 'inv_add', rec: s.rec, fp: s.fp, qty: 10, box: box.id, who: 'Ben' });
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
  const m1 = await ok({ action: 'inv_add', rec: typed.rec, fp: null, qty: 3, box: box.id, who: 'Fay' }), m2 = await ok({ action: 'inv_add', rec: typed.rec, fp: null, qty: 3, box: box.id, who: 'Fay' });
  assert.strictEqual(m2.group.comps[0].packets.length, 4);

  // Mouser 2D without a part number: still recognised by invoice + line
  const mlabel = '[)>\x1e06\x1dK3999721\x1d14K001\x1d11K88123\x1dQ195\x1d1VHirose';
  await ok({ action: 'inv_add', rec: { supplier: 'Mouser', mpn: 'DF13-2P', mouserPn: '798-DF13-2P', manufacturer: 'Hirose', description: 'Connector', categoryPath: 'Headers & Wire Housings', groupKey: 'P|df132p' }, fp: (await ok({ action: 'scan', texts: [mlabel, '798-DF13-2P'], supplier: 'Mouser' })).fp, qty: 195, box: box.id, who: 'Gus' });
  const ms = await ok({ action: 'scan', texts: [mlabel] });
  assert.ok(ms.dup && ms.dup.group.comps[0].mpn === 'DF13-2P', 'Mouser packet recognised from the 2D code alone');
  assert.strictEqual((await ok({ action: 'inv_load' })).groups.find(g => g.key === 'P|df132p').cat, 701, 'connector category from the Mouser category');

  // bad input
  assert.ok(!(await call({ action: 'inv_add', rec: s.rec, qty: -3 })).ok); assert.ok(!(await call({ action: 'inv_txn', packet: 99999, mode: 'take', qty: 1 })).ok);
  assert.ok(!(await call({ action: 'inv_nope' })).ok);
  // ---- required fields: box always; a new part also needs its critical fields; a chip passive needs value and package (a fix fills them)
  const mrec = { supplier: 'Mouser', mpn: 'XYZ-9', mouserPn: '603-XYZ-9', manufacturer: 'X', description: 'Thick Film Resistors - SMD 2.2 kOhms 1%', categoryPath: 'Thick Film Resistors - SMD',
    category: 'Resistors', value: '2.2k', package: '', sp: { tol: '1%' }, spec: '1%', missing: ['package'], groupKey: 'P|xyz9' };
  let e2 = await call({ action: 'inv_add', rec: mrec, qty: 5, who: 'Hal' }); assert.ok(!e2.ok && /box/.test(e2.error), 'no box, no add');
  e2 = await call({ action: 'inv_add', rec: mrec, qty: 5, box: 9999, who: 'Hal' }); assert.ok(!e2.ok && /box/.test(e2.error), 'unknown box');
  e2 = await call({ action: 'inv_add', rec: mrec, qty: 5, box: box.id, who: 'Hal' }); assert.ok(!e2.ok && /package/.test(e2.error) && !/box/.test(e2.error), 'package missing: ' + e2.error);
  e2 = await call({ action: 'inv_add', rec: mrec, qty: 5, box: box.id, fix: { package: '0603', value: 'abc' }, who: 'Hal' }); assert.ok(!e2.ok && /not understood/.test(e2.error));
  assert.ok(!(await ok({ action: 'inv_load' })).groups.some(g => g.comps.some(c => c.mpn === 'XYZ-9')), 'a refused add leaves nothing behind');
  const fixed = await ok({ action: 'inv_add', rec: mrec, qty: 5, box: box.id, fix: { package: '0603', diel: '', pow: '1/10W' }, who: 'Hal', rid: 'rq1' });
  assert.strictEqual(fixed.group.key, 'R|2.2k|0603'); assert.strictEqual(fixed.group.cat, 106); assert.strictEqual(fixed.group.comps[0].descr, 'RES 2.2K OHM 1% 1/10W 0603'); assert.deepStrictEqual(fixed.group.comps[0].sp, { tol: '1%', pow: '1/10W' });
  e2 = await call({ action: 'inv_add', rec: Object.assign({}, mrec, { mpn: 'XYZ-10' }), qty: 5, box: box.id, fix: { package: '0603' }, who: 'Hal', rid: 'rq1' }); assert.ok(!e2.ok && /Already done/.test(e2.error), 'same request id twice');
  e2 = await call({ action: 'inv_add', rec: { supplier: 'Mouser', mpn: 'IC-1', description: 'Some IC', categoryPath: 'Something odd' }, qty: 1, box: box.id, who: 'Hal' }); assert.ok(!e2.ok && /category/.test(e2.error), 'Unsorted is not a chosen category');
  e2 = await call({ action: 'inv_add', rec: { supplier: 'Mouser', mpn: 'IC-1', description: '', categoryPath: 'Interface ICs' }, qty: 1, box: box.id, who: 'Hal' }); assert.ok(!e2.ok && /description/.test(e2.error));
  const ic = await ok({ action: 'inv_add', rec: { supplier: 'Mouser', mpn: 'IC-1', description: 'Some IC', categoryPath: 'Something odd' }, qty: 1, box: box.id, cat: 607, descr: 'Typed IC description', who: 'Hal' });
  assert.strictEqual(ic.group.comps[0].descr, 'Typed IC description'); assert.strictEqual(ic.group.comps[0].cat, 607);
  const xp = fixed.group.comps[0].packets[0].id;
  e2 = await call({ action: 'inv_txn', packet: xp, mode: 'move', who: 'Hal' }); assert.ok(!e2.ok && /box/.test(e2.error), 'a move needs a box');
  let tk = await ok({ action: 'inv_txn', packet: xp, mode: 'take', qty: 2, who: 'Hal', rid: 'rq2' }); assert.strictEqual(tk.group.comps[0].packets[0].qty, 3);
  e2 = await call({ action: 'inv_txn', packet: xp, mode: 'take', qty: 2, who: 'Hal', rid: 'rq2' }); assert.ok(!e2.ok && /Already done/.test(e2.error));
  assert.strictEqual((await ok({ action: 'inv_load' })).groups.find(g => g.key === 'R|2.2k|0603').comps[0].packets[0].qty, 3, 'the repeated take did nothing');
  // editing value / package / secondary parameters re-groups the part and refreshes its generated description; an emptied group goes away
  const xid = fixed.group.comps[0].id;
  e2 = await call({ action: 'inv_edit', comp: xid, fix: { value: 'zz' }, who: 'Hal' }); assert.ok(!e2.ok && /not understood/.test(e2.error));
  const moved = await ok({ action: 'inv_edit', comp: xid, fix: { value: '4.7k', package: '0805', volt: '' }, who: 'Hal' });
  assert.strictEqual(moved.group.key, 'R|4.7k|0805'); assert.strictEqual(moved.group.comps[0].descr, 'RES 4.7K OHM 1% 1/10W 0805');
  assert.ok(!(await ok({ action: 'inv_load' })).groups.some(g => g.key === 'R|2.2k|0603'), 'the old group is gone');
  assert.ok((await ok({ action: 'inv_hist', comp: xid })).some(x => x.kind === 'edit' && /R\|2.2k\|0603 to R\|4.7k\|0805/.test(x.note)));

  // an inductor has no standard package: whatever the person types is the package (also for resistors and capacitors)
  const ind = { supplier: 'Mouser', mpn: 'IND-1', manufacturer: 'X', description: 'Fixed Inductors 10uH 2A', categoryPath: 'Fixed Inductors', category: 'Inductors', value: '10uH', package: '', sp: { cur: '2A' }, spec: '2A', missing: ['package'], groupKey: 'P|ind1' };
  e2 = await call({ action: 'inv_add', rec: ind, qty: 3, box: box.id, who: 'Hal' }); assert.ok(!e2.ok && /package/.test(e2.error), 'an inductor still needs a package');
  const il = await ok({ action: 'inv_add', rec: ind, qty: 3, box: box.id, fix: { package: '7x7 shielded' }, who: 'Hal' });
  assert.strictEqual(il.group.key, 'L|10uH|7x7 shielded'); assert.strictEqual(il.group.comps[0].descr, 'FIXED IND 10uH 2A 7x7 shielded'); assert.strictEqual(il.group.cat, 301);
  const ie = await ok({ action: 'inv_edit', comp: il.group.comps[0].id, fix: { package: 'Other' }, who: 'Hal' }); assert.strictEqual(ie.group.key, 'L|10uH|Other');

  // ---- category by type, and the migration that re-files an old database (Chip / Through Hole were retired)
  const sch = await import(base + '/lib/schema.js');
  const cf = o => sch.categoryFor(o);
  assert.strictEqual(cf({ path: 'Thick Film Resistors - SMD', descr: 'RES 2.2K 1% 0402', spec: '1%', value: '2.2k' }), 106);
  assert.strictEqual(cf({ path: 'Thin Film Resistors - SMD', descr: '', spec: '0.1%', value: '10k' }), 107, 'thin film = precision');
  assert.strictEqual(cf({ path: 'Resistors > Chip Resistor - Surface Mount', descr: 'RES 10K 0.05% 0603', spec: '0.05%', value: '10k' }), 107, 'tolerance 0.1% or better = precision');
  assert.strictEqual(cf({ path: 'Current Sense Resistors - SMD', descr: '', spec: '1%', value: '10m' }), 108);
  assert.strictEqual(cf({ path: 'Resistors > Chip Resistor - Surface Mount', descr: 'RES 0 OHM JUMPER 1/16W 0402', spec: '', value: '0' }), 109);
  assert.strictEqual(cf({ path: 'Resistor Networks & Arrays', descr: '', spec: '', value: '' }), 103);
  assert.strictEqual(cf({ path: 'Wirewound Resistors', descr: '', spec: '5%', value: '1' }), 110);
  assert.strictEqual(cf({ path: 'Capacitors > Ceramic Capacitors', descr: 'CAP CER 100NF 50V X7R 0402', spec: '', value: '100nF' }), 201);
  assert.strictEqual(cf({ path: 'Aluminum Electrolytic Capacitors - SMD', descr: '', spec: '', value: '' }), 202);
  assert.strictEqual(cf({ path: 'Capacitors > Tantalum - Polymer Capacitors', descr: '', spec: '', value: '' }), 203);
  assert.strictEqual(cf({ path: 'Integrated Circuits (ICs) > Power Management (PMIC) > Voltage Regulators', descr: '', spec: '' }), 601);
  assert.strictEqual(cf({ path: 'Something unknown', descr: '', spec: '' }), 1400);
  const sensor = (path, descr) => cf({ path: 'Sensors, Transducers > ' + path, descr: descr || '' });
  assert.strictEqual(sensor('Accelerometers'), 1101); assert.strictEqual(sensor('Motion Sensors - IMUs (Inertial Measurement Units)'), 1101); assert.strictEqual(sensor('Gyroscopes'), 1101);
  assert.strictEqual(sensor('Magnetic Sensors - Linear, Compass (ICs)'), 1102); assert.strictEqual(sensor('Temperature Sensors - Analog and Digital Output'), 1103); assert.strictEqual(sensor('Humidity, Moisture Sensors'), 1103);
  assert.strictEqual(sensor('Current Sensors'), 1104); assert.strictEqual(sensor('Pressure Sensors, Transducers'), 1105); assert.strictEqual(sensor('Optical Sensors - Ambient Light, IR, UV Sensors'), 1106); assert.strictEqual(sensor('Proximity Sensors'), 1106); assert.strictEqual(sensor('Something else'), 1107);

  const old = makeD1(), oldEnv = { DB: old };
  for (const [sql, args] of sch.MIGRATIONS[0]) await old.prepare(sql).bind(...(args || [])).run();   // the v0.9.0 database
  await old.prepare("INSERT INTO meta (k, v) VALUES ('schema', '1')").run();
  const ins = (sql, ...a) => old.prepare(sql).bind(...a).run();
  await ins("INSERT INTO grp (id, gkey, cat, label) VALUES (1, 'R|0|0402', 101, 'Resistor 0 0402'), (2, 'R|10k|0603', 101, 'Resistor 10k 0603'), (3, 'R|1k|axial', 102, 'x'), (4, 'C|100nF|0402', 201, 'Capacitor'), (5, 'P|mpu6050', 1100, 'MPU6050')");
  await ins("INSERT INTO comp (id, grp, mkey, mpn, descr, path, spec, src, cat) VALUES (1, 1, 'a', 'A', 'RES 0 OHM JUMPER 1/16W 0402', 'Resistors > Chip Resistor - Surface Mount', '', 1, NULL), (2, 2, 'b', 'B', 'RES 10K 0.1% 0603', 'Resistors > Chip Resistor - Surface Mount', '0.1%', 1, 101), (3, 3, 'c', 'C', 'RES 1K', 'Through Hole Resistors', '5%', 2, NULL), (4, 4, 'd', 'D', 'CAP', 'Ceramic Capacitors', '', 1, NULL), (5, 5, 'e', 'MPU6050', 'IMU', 'Sensors, Transducers > Motion Sensors - IMUs', '', 1, NULL)");
  await ins("INSERT INTO catmap (src, path, cat) VALUES (1, 'Resistors > Chip Resistor - Surface Mount', 101), (1, 'Integrated Circuits (ICs) > Power Management (PMIC)', 601)");
  inv.resetSchema_(); await inv.ensureSchema(oldEnv);
  const g = Object.fromEntries((await old.rows('SELECT id, cat FROM grp')).map(r => [r.id, r.cat]));
  assert.deepStrictEqual(g, { 1: 109, 2: 107, 3: 106, 4: 201, 5: 1101 }, 'groups re-filed by type (sensors too); others untouched');
  assert.strictEqual((await old.rows('SELECT cat FROM comp WHERE id = 2'))[0].cat, 106, 'hand override on a retired sub-category moves to General Purpose');
  assert.deepStrictEqual((await old.rows('SELECT cat FROM catmap')).map(r => r.cat), [601], 'coarse passive mappings forgotten, others kept');
  const names = (await old.rows('SELECT name FROM cat')).map(r => r.name);
  assert.ok(!names.includes('Chip') && !names.includes('Through Hole') && names.includes('MLCC') && names.includes('Precision'));
  assert.strictEqual((await old.rows("SELECT v FROM meta WHERE k = 'schema'"))[0].v, '3');
  assert.ok(names.includes('Magnetic') && names.includes('Current'), 'sensor sub-categories exist');
  inv.resetSchema_(); await inv.ensureSchema(oldEnv);   // running again changes nothing
  console.log('inventory ok');
})().catch(e => { console.error(e); process.exit(1); });
