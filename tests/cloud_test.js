// Run: node tests/cloud_test.js
// Drives functions/api.js (Cloudflare Pages Function) with a fake D1, a fake Apps Script and fake DigiKey/Mouser behind fetch.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildShared } = require('../tools/build_web');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const rows = {};   // fake D1 table parts: key -> {rec, time}
const usageRows = {};   // fake D1 table usage: 'day|provider' -> n
let tableMade = false, dbFailsOnce = true;   // a fresh database has no table: the first read fails and the Function creates it
const DB = {
  prepare(sql) {
    const st = { sql, args: [], bind(...a) { return Object.assign({}, st, { args: a }); },
      async run() {
        if (/^CREATE TABLE IF NOT EXISTS parts/.test(sql)) tableMade = true;
        if (/INTO usage/.test(sql)) { const k = this.args[0] + '|' + this.args[1]; usageRows[k] = (usageRows[k] || 0) + this.args[2]; }
        else if (/^INSERT/.test(sql)) rows[this.args[0]] = { rec: this.args[1], time: this.args[2] };
        return {};
      },
      async all() {
        if (/FROM usage/.test(sql)) return { results: Object.keys(usageRows).filter(k => k.startsWith(this.args[0] + '|')).map(k => ({ provider: k.split('|')[1], n: usageRows[k] })) }; if (!tableMade && dbFailsOnce) { dbFailsOnce = false; throw new Error('no such table: parts'); } return { results: this.args.filter(k => rows[k]).map(k => ({ key: k, rec: rows[k].rec, time: rows[k].time })) }; } };
    return st;
  },
  async batch(list) { for (const s of list) await s.run(); }
};
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
  assert.ok(tableMade, 'the table is created when the first read finds none');
  assert.deepStrictEqual(Object.keys(rows).sort(), ['311220klrctnd', 'ac0402fr072k2l'], 'stored under every part number');

  r = await scan(['311-2.20KLRCT-ND']);
  assert.strictEqual(sent.length, 1, 'DigiKey PN of a part first seen by MPN is a hit');
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(sent.length, 1, 'hit answered without Apps Script');
  assert.strictEqual(r.body.data.source, 'cloud cache'); assert.deepStrictEqual(r.body.data.rec, rec); assert.strictEqual(r.body.data.parsed.mpn, 'AC0402FR-072K2L');

  answer = () => ({ ok: true, data: { parsed: {}, rec: null, warnings: ['none'] } });
  r = await scan(['zz']);
  assert.strictEqual(r.body.data.rec, null); assert.ok(!rows.zz, 'a miss is not cached');
  r = await scan(['[)>06K3999721814K001POEPS070090 #IA-1265Q1951VHirose']);
  assert.strictEqual(r.body.data.rec, null); assert.ok(/no part number/.test(r.body.data.warnings[0]), 'a Mouser 2D code with no PN is answered here, no lookup');
  const forwarded = sent.length;

  // ---- with supplier secrets: Apps Script is not involved in a scan at all
  Object.assign(env, { DIGIKEY_CLIENT_ID: 'dkid', DIGIKEY_CLIENT_SECRET: 'dksecret-XYZ', MOUSER_KEY: 'mouser-KEY-123' });
  Object.keys(rows).forEach(k => delete rows[k]);
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(sent.length, forwarded, 'direct lookup never calls Apps Script');
  assert.strictEqual(r.body.data.source, 'DigiKey'); assert.strictEqual(r.body.data.rec.category, 'Resistors');
  assert.ok(Object.keys(rows).includes('ac0402fr072k2l'), 'new part stored in D1');
  const dkCall = supplier.find(c => /productdetails/.test(c.url));
  assert.strictEqual(dkCall.o.headers.Authorization, 'Bearer tok-dk'); assert.strictEqual(dkCall.o.headers['X-DIGIKEY-Locale-Site'], 'IN');
  const n1 = supplier.length;
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(supplier.length, n1, 'second scan is a D1 hit, no supplier call'); assert.strictEqual(r.body.data.source, 'cloud cache');

  // DigiKey 404 for a Mouser-style part: keyword search, then the other supplier; candidates run side by side
  Object.keys(rows).forEach(k => delete rows[k]); supplier.length = 0;
  dkProduct = url => url.includes('productdetails') ? { code: 404 } : { code: 200, body: { Products: [] } };
  r = await scan(['603-AC0402FR-072K2L'], { supplier: 'Mouser' });
  assert.strictEqual(r.body.data.source, 'Mouser'); assert.strictEqual(r.body.data.rec.mouserPn, '603-AC0402FR-072K2L');
  assert.ok(supplier.some(c => c.url.includes('mouser.com')));

  // API economy: a Mouser label whose bar gives the Mouser PN costs exactly one Mouser call and none to DigiKey; a supplier hint is not needed
  Object.keys(rows).forEach(k => delete rows[k]); supplier.length = 0; dkProduct = () => ({ code: 404 });
  const mdm = '[)>\x1e06\x1dK1\x1d14K001\x1dPCUST\x1dQ6\x1d1VYageo';
  r = await scan([mdm, '603-AC0402FR-072K2L']);
  assert.strictEqual(r.body.data.source, 'Mouser'); assert.strictEqual(supplier.filter(c => c.url.includes('mouser.com')).length, 1);
  assert.strictEqual(supplier.filter(c => c.url.includes('digikey.com')).length, 0, 'no DigiKey call for a Mouser label that was found');
  // a clean miss is remembered: the same packet again costs nothing, a different part number still asks
  Object.keys(rows).forEach(k => delete rows[k]); supplier.length = 0; mouser = () => ({ code: 200, body: { Errors: [], SearchResults: { Parts: [] } } });
  r = await scan(['ZZ-NOPE-1']);
  assert.strictEqual(r.body.data.rec, null); const asked = supplier.length; assert.ok(asked > 0);
  r = await scan(['ZZ-NOPE-1']);
  assert.strictEqual(supplier.length, asked, 'rescan of a part just reported missing makes no API call'); assert.ok(/not found/.test(r.body.data.warnings[0]));
  r = await scan(['ZZ-OTHER-2']);
  assert.ok(supplier.length > asked, 'a different number is looked up');
  mouser = () => ({ code: 200, body: { Errors: [], SearchResults: { Parts: fx('mouser_AC0402FR-072K2L.json') } } });
  // API call counter: every product request sent to a supplier is counted per provider per UTC day (token requests are not); the debug panel reads it
  const day = new Date().toISOString().slice(0, 10), real = p => supplier.filter(c => c.url.includes(p) && !c.url.includes('oauth2')).length;
  Object.keys(usageRows).forEach(k => delete usageRows[k]); Object.keys(rows).forEach(k => delete rows[k]); supplier.length = 0;
  dkProduct = () => ({ code: 200, body: fx('dk_AC0402FR-072K2L.json') });
  await scan(['AC0402FR-072K2L']);   // one DigiKey product request (the token request is not counted)
  assert.strictEqual(usageRows[day + '|DigiKey'], 1); assert.strictEqual(real('digikey.com'), 1); assert.strictEqual(usageRows[day + '|Mouser'], undefined);
  await scan(['AC0402FR-072K2L']);   // D1 hit: no new call
  assert.strictEqual(usageRows[day + '|DigiKey'], 1, 'a cache hit is not counted');
  const total = { DigiKey: 0, Mouser: 0 }; Object.keys(usageRows).forEach(k => { total[k.split('|')[1]] += usageRows[k]; });
  assert.strictEqual(total.DigiKey + total.Mouser > 0, true, 'calls were counted');
  r = await call({ token: 'tok', req: { action: 'usage' } });
  assert.strictEqual(r.body.data.day, day); assert.strictEqual(r.body.data.DigiKey, total.DigiKey); assert.strictEqual(r.body.data.Mouser, total.Mouser);
  usageRows['1999-01-01|DigiKey'] = 500;
  r = await call({ token: 'tok', req: { action: 'usage' } });
  assert.strictEqual(r.body.data.DigiKey, total.DigiKey, 'another UTC day is not mixed in');
  // errors become warnings and never carry a key; a 429 is retried once
  Object.keys(rows).forEach(k => delete rows[k]); supplier.length = 0;
  let n429 = 0;
  dkProduct = () => ++n429 === 1 ? { code: 429 } : { code: 200, body: fx('dk_AC0402FR-072K2L.json') };
  r = await scan(['AC0402FR-072K2L']);
  assert.strictEqual(r.body.data.source, 'DigiKey'); assert.strictEqual(n429, 2, 'one retry after 429');
  Object.keys(rows).forEach(k => delete rows[k]);
  dkProduct = () => ({ code: 500 }); mouser = () => ({ code: 200, body: { Errors: [{ Message: 'Invalid key mouser-KEY-123' }] } });
  r = await scan(['NOPE-1']);
  assert.strictEqual(r.body.data.rec, null); assert.ok(r.body.data.warnings.length >= 1);
  const out = JSON.stringify(r.body);
  ['dksecret-XYZ', 'mouser-KEY-123', 'tok-dk'].forEach(k => assert.ok(!out.includes(k), 'a secret leaked into the answer: ' + k));
  assert.ok(!rows.nope1, 'a miss is not cached');

  answer = () => ({ ok: true, data: { row: {}, isNew: true } });
  r = await call({ token: 'tok', req: { action: 'confirm', qty: 1 } });
  assert.strictEqual(sent.at(-1).req.action, 'confirm'); assert.strictEqual(sent.at(-1).token, 'tok');
  console.log('cloud ok');
})().catch(e => { console.error(e); process.exit(1); });
