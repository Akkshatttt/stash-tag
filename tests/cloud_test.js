// Run: node tests/cloud_test.js
// Drives functions/api.js (Cloudflare Pages Function) with a fake D1, a fake Apps Script and fake DigiKey/Mouser behind fetch.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildShared } = require('../tools/build_web');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const { makeD1 } = require('./d1');
const DB = makeD1();
const keys = async () => (await DB.rows('SELECT key FROM parts')).map(r => r.key).sort();   // keys in the part cache
const clear = t => DB.exec('DELETE FROM ' + t);
const use = async (day, p) => { const r = await DB.rows('SELECT n FROM usage WHERE day = ? AND provider = ?', day, p); return r.length ? r[0].n : undefined; };
const sent = [], supplier = [];   // calls to Apps Script, calls to DigiKey/Mouser
let answer = () => ({ ok: true, data: { rows: [] } }), dkProduct = () => ({ code: 200, body: fx('dk_AC0402FR-072K2L.json') }), mouser = () => ({ code: 200, body: { Errors: [], SearchResults: { Parts: fx('mouser_AC0402FR-072K2L.json') } } });
const res = (code, body) => ({ status: code, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
global.fetch = async (url, o) => {
  if (url === 'https://exec') { sent.push(JSON.parse(o.body)); return res(200, answer(JSON.parse(o.body).req)); }
  supplier.push({ url, o });
  if (url.includes('oauth2')) return res(200, { access_token: 'tok-dk', expires_in: 600 });
  if (url.includes('digikey.com')) { const r = dkProduct(url, o); return res(r.code, r.body || ''); }
  if (url.includes('mouser.com')) { const r = mouser(url, o); return res(r.code, r.body || ''); }
  throw new Error('unexpected fetch ' + url);
};
const env = { DB, TOKEN: 'tok', EXEC_URL: 'https://exec' };

(async () => {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'lib', 'shared.js'), 'utf8').split('\r\n').join('\n'), buildShared(), 'lib/shared.js is out of date: run node tools/build_web.js');
  const { onRequestPost } = await import(pathToFileURL(path.join(__dirname, '..', 'functions', 'api.js')).href);
  const waits = [];
  const call = async body => { const r = await onRequestPost({ request: { json: async () => body }, env, waitUntil: p => waits.push(p) }); await Promise.all(waits); return { status: r.status, body: await r.json() }; };
  const scan = (texts, extra) => call({ token: 'tok', req: Object.assign({ action: 'scan', texts }, extra) });

  let r = await call({ token: 'bad', req: { action: 'load' } });
  assert.strictEqual(r.status, 403); assert.strictEqual(sent.length, 0);

  r = await call({ token: 'tok', req: { action: 'load' } });
  assert.deepStrictEqual(r.body, { ok: true, data: { rows: [] } }); assert.strictEqual(sent.length, 1, 'load goes to Apps Script');
  env.PASSWORD = 'pw';   // admin password set: only the password works, the token alone is refused
  r = await call({ token: 'tok', req: { action: 'load' } });
  assert.strictEqual(r.status, 403, 'token alone refused once PASSWORD is set');
  r = await call({ password: 'nope', req: { action: 'load' } });
  assert.strictEqual(r.status, 403); assert.strictEqual(sent.length, 1, 'wrong password stops here');
  r = await call({ password: 'pw', req: { action: 'load' } });
  assert.strictEqual(r.body.ok, true); assert.deepStrictEqual(sent.pop(), { token: 'tok', req: { action: 'load' } }, 'password swapped for the token, never forwarded');
  delete env.PASSWORD;
  sent.length = 0;

  // ---- no supplier secrets: a miss is forwarded to Apps Script and stored in D1
  const rec = { mpn: 'AC0402FR-072K2L', dkPn: '311-2.20KLRCT-ND', mouserPn: '', groupKey: 'R|2.2k|0402' };
  answer = () => ({ ok: true, data: { parsed: { qty: 5 }, rec, source: 'DigiKey', warnings: [] } });
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(r.body.data.source, 'DigiKey'); assert.strictEqual(sent.length, 1, 'miss is forwarded');
  assert.ok((await DB.rows("SELECT name FROM sqlite_master WHERE name = 'parts'")).length, 'the table is created when the first read finds none');
  assert.deepStrictEqual(await keys(), ['311220klrctnd', 'ac0402fr072k2l'], 'stored under every part number');

  r = await scan(['311-2.20KLRCT-ND']);
  assert.strictEqual(sent.length, 1, 'DigiKey PN of a part first seen by MPN is a hit');
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(sent.length, 1, 'hit answered without Apps Script');
  assert.strictEqual(r.body.data.source, 'cloud cache'); assert.strictEqual(r.body.data.rec.mpn, rec.mpn); assert.strictEqual(r.body.data.rec.dkPn, rec.dkPn);   // an old cached record is re-classified on the way out assert.strictEqual(r.body.data.parsed.mpn, 'AC0402FR-072K2L');

  answer = () => ({ ok: true, data: { parsed: {}, rec: null, warnings: ['none'] } });
  r = await scan(['zz']);
  assert.strictEqual(r.body.data.rec, null); assert.ok(!(await keys()).includes('zz'), 'a miss is not cached');
  r = await scan(['[)>06K3999721814K001POEPS070090 #IA-1265Q1951VHirose']);
  assert.strictEqual(r.body.data.rec, null); assert.ok(/no part number/.test(r.body.data.warnings[0]), 'a Mouser 2D code with no PN is answered here, no lookup');
  const forwarded = sent.length;

  // ---- with supplier secrets: Apps Script is not involved in a scan at all
  Object.assign(env, { DIGIKEY_CLIENT_ID: 'dkid', DIGIKEY_CLIENT_SECRET: 'dksecret-XYZ', MOUSER_KEY: 'mouser-KEY-123' });
  await clear('parts');
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(sent.length, forwarded, 'direct lookup never calls Apps Script');
  assert.strictEqual(r.body.data.source, 'DigiKey'); assert.strictEqual(r.body.data.rec.category, 'Resistors');
  assert.ok((await keys()).includes('ac0402fr072k2l'), 'new part stored in D1');
  const dkCall = supplier.find(c => /productdetails/.test(c.url));
  assert.strictEqual(dkCall.o.headers.Authorization, 'Bearer tok-dk'); assert.strictEqual(dkCall.o.headers['X-DIGIKEY-Locale-Site'], 'IN');
  const n1 = supplier.length;
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(supplier.length, n1, 'second scan is a D1 hit, no supplier call'); assert.strictEqual(r.body.data.source, 'cloud cache');

  // DigiKey 404 for a Mouser-style part: keyword search, then the other supplier; candidates run side by side
  await clear('parts'); supplier.length = 0;
  dkProduct = url => url.includes('productdetails') ? { code: 404 } : { code: 200, body: { Products: [] } };
  r = await scan(['603-AC0402FR-072K2L'], { supplier: 'Mouser' });
  assert.strictEqual(r.body.data.source, 'Mouser'); assert.strictEqual(r.body.data.rec.mouserPn, '603-AC0402FR-072K2L');
  assert.ok(supplier.some(c => c.url.includes('mouser.com')));

  // API economy: a Mouser label whose bar gives the Mouser PN costs exactly one Mouser call and none to DigiKey; a supplier hint is not needed
  await clear('parts'); supplier.length = 0; dkProduct = () => ({ code: 404 });
  const mdm = '[)>\x1e06\x1dK1\x1d14K001\x1dPCUST\x1dQ6\x1d1VYageo';
  r = await scan([mdm, '603-AC0402FR-072K2L']);
  assert.strictEqual(r.body.data.source, 'Mouser'); assert.strictEqual(supplier.filter(c => c.url.includes('mouser.com')).length, 1);
  assert.strictEqual(supplier.filter(c => c.url.includes('digikey.com')).length, 0, 'no DigiKey call for a Mouser label that was found');
  // a clean miss is remembered: the same packet again costs nothing, a different part number still asks
  await clear('parts'); supplier.length = 0; mouser = () => ({ code: 200, body: { Errors: [], SearchResults: { Parts: [] } } });
  r = await scan(['ZZ-NOPE-1']);
  assert.strictEqual(r.body.data.rec, null); const asked = supplier.length; assert.ok(asked > 0);
  r = await scan(['ZZ-NOPE-1']);
  assert.strictEqual(supplier.length, asked, 'rescan of a part just reported missing makes no API call'); assert.ok(/not found/.test(r.body.data.warnings[0]));
  r = await scan(['ZZ-OTHER-2']);
  assert.ok(supplier.length > asked, 'a different number is looked up');
  mouser = () => ({ code: 200, body: { Errors: [], SearchResults: { Parts: fx('mouser_AC0402FR-072K2L.json') } } });
  // API call counter: every product request sent to a supplier is counted per provider per UTC day (token requests are not); the debug panel reads it
  const day = new Date().toISOString().slice(0, 10), real = p => supplier.filter(c => c.url.includes(p) && !c.url.includes('oauth2')).length;
  await clear('usage'); await clear('parts'); supplier.length = 0;
  dkProduct = () => ({ code: 200, body: fx('dk_AC0402FR-072K2L.json') });
  await scan(['AC0402FR-072K2L']);   // one DigiKey product request (the token request is not counted)
  assert.strictEqual(await use(day, 'DigiKey'), 1); assert.strictEqual(real('digikey.com'), 1); assert.strictEqual(await use(day, 'Mouser'), undefined);
  await scan(['AC0402FR-072K2L']);   // D1 hit: no new call
  assert.strictEqual(await use(day, 'DigiKey'), 1, 'a cache hit is not counted');
  const total = { DigiKey: (await use(day, 'DigiKey')) || 0, Mouser: (await use(day, 'Mouser')) || 0 };
  assert.strictEqual(total.DigiKey + total.Mouser > 0, true, 'calls were counted');
  r = await call({ token: 'tok', req: { action: 'usage' } });
  assert.strictEqual(r.body.data.day, day); assert.strictEqual(r.body.data.DigiKey, total.DigiKey); assert.strictEqual(r.body.data.Mouser, total.Mouser);
  await DB.prepare("INSERT INTO usage VALUES ('1999-01-01', 'DigiKey', 500)").run();
  r = await call({ token: 'tok', req: { action: 'usage' } });
  assert.strictEqual(r.body.data.DigiKey, total.DigiKey, 'another UTC day is not mixed in');
  // a Mouser passive with no size in the API, the text or the part number: one DigiKey lookup by MPN fills what is missing, it is counted, and the merged record is cached
  await clear('parts'); await clear('usage'); supplier.length = 0;
  mouser = () => ({ code: 200, body: { Errors: [], SearchResults: { Parts: [{ ManufacturerPartNumber: 'XYZ-9', MouserPartNumber: '603-XYZ-9', Manufacturer: 'X', Description: 'Thick Film Resistors - SMD 2.2 kOhms 1%', Category: 'Thick Film Resistors - SMD' }] } } });
  dkProduct = url => url.includes('productdetails') ? { code: 200, body: fx('dk_AC0402FR-072K2L.json') } : { code: 404 };
  r = await scan(['603-XYZ-9']);
  assert.strictEqual(r.body.data.source, 'Mouser'); assert.strictEqual(r.body.data.rec.package, '0402'); assert.strictEqual(r.body.data.rec.groupKey, 'R|2.2k|0402'); assert.deepStrictEqual(r.body.data.rec.missing, []);
  assert.strictEqual(supplier.filter(c => /productdetails/.test(c.url)).length, 1, 'exactly one DigiKey lookup'); assert.strictEqual(await use(day, 'DigiKey'), 1, 'counted');
  const nCross = supplier.length; r = await scan(['603-XYZ-9']); assert.strictEqual(supplier.length, nCross, 'merged record is cached');
  mouser = () => ({ code: 200, body: { Errors: [], SearchResults: { Parts: fx('mouser_AC0402FR-072K2L.json') } } });
  dkProduct = () => ({ code: 200, body: fx('dk_AC0402FR-072K2L.json') });
  // errors become warnings and never carry a key; a 429 is retried once
  await clear('parts'); supplier.length = 0;
  let n429 = 0;
  dkProduct = () => ++n429 === 1 ? { code: 429 } : { code: 200, body: fx('dk_AC0402FR-072K2L.json') };
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(r.body.data.source, 'DigiKey'); assert.strictEqual(n429, 2, 'one retry after 429');
  await clear('parts');
  dkProduct = () => ({ code: 500 }); mouser = () => ({ code: 200, body: { Errors: [{ Message: 'Invalid key mouser-KEY-123' }] } });
  r = await scan(['NOPE-1']);
  assert.strictEqual(r.body.data.rec, null); assert.ok(r.body.data.warnings.length >= 1);
  const out = JSON.stringify(r.body);
  ['dksecret-XYZ', 'mouser-KEY-123', 'tok-dk'].forEach(k => assert.ok(!out.includes(k), 'a secret leaked into the answer: ' + k));
  assert.ok(!(await keys()).includes('nope1'), 'a miss is not cached');

  answer = () => ({ ok: true, data: { row: {}, isNew: true } });
  r = await call({ token: 'tok', req: { action: 'confirm', qty: 1 } });
  assert.strictEqual(sent.at(-1).req.action, 'confirm'); assert.strictEqual(sent.at(-1).token, 'tok');
  console.log('cloud ok');
})().catch(e => { console.error(e); process.exit(1); });
