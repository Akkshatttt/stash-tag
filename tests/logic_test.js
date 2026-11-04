// Run: node tests/logic_test.js
// Pure logic (label parsing, normalising, grouping, search) plus the API layer against a fake UrlFetchApp. No network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadSrc } = require('./load');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
let failed = 0;
function t(name, fn) { try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); } }

// ---- fake Apps Script services, swapped per test
let fetches = [], responder = () => ({ code: 404, text: '{}' });
const props = { DIGIKEY_CLIENT_ID: 'id', DIGIKEY_CLIENT_SECRET: 'sec', MOUSER_KEY: 'mk' };
const cacheStore = {};
const S = loadSrc({
  UrlFetchApp: { fetch: (url, o) => { fetches.push({ url, o }); const r = responder(url, o); return { getResponseCode: () => r.code, getContentText: () => r.text }; } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
  CacheService: { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) },
  Utilities: { sleep: () => {} }
});
const run = code => require('vm').runInContext(code, S);

// ---- barcode
t('parses a DigiKey-style 2D label', () => {
  const label = '[)>\x1e06\x1dP296-TPS7A4700RGWR-ND\x1d1PTPS7A4700RGWR\x1d30P296-TPS7A4700RGWR-ND\x1dK\x1d1K1234567\x1d11K1\x1d9D2425\x1d1TLOT77\x1d4LMY\x1dQ250\x1e\x04';
  const p = S.parseLabel_(label);
  assert.strictEqual(p.mpn, 'TPS7A4700RGWR'); assert.strictEqual(p.supplierPn, '296-TPS7A4700RGWR-ND');
  assert.strictEqual(p.qty, 250); assert.strictEqual(p.lot, 'LOT77'); assert.strictEqual(p.supplier, 'DigiKey');
});
t('parses a Mouser-style label (Mouser PN in P)', () => {
  const p = S.parseLabel_('[)>\x1e06\x1dP595-TPS7A4700RGWR\x1d1PTPS7A4700RGWR\x1dQ10\x1e\x04');
  assert.strictEqual(p.supplier, 'Mouser'); assert.strictEqual(p.supplierPn, '595-TPS7A4700RGWR'); assert.strictEqual(p.qty, 10);
});
t('accepts <GS> text markers and plain part numbers', () => {
  assert.strictEqual(S.parseLabel_('[)>\x1e06<GS>1PABC123<GS>Q5').mpn, 'ABC123');
  const p = S.parseLabel_('  AC0402FR-072K2L ');
  assert.strictEqual(p.mpn, 'AC0402FR-072K2L'); assert.strictEqual(p.qty, 0);
  assert.strictEqual(S.parseLabel_('').mpn, '');
});

// ---- values
t('values normalise to one spelling', () => {
  assert.strictEqual(S.parseValue_('2.2 kOhms', 'R'), '2.2k');
  assert.strictEqual(S.parseValue_('RES 1K OHM 1%', 'R'), '1k');
  assert.strictEqual(S.parseValue_('10000 pF', 'C'), '10nF');
  assert.strictEqual(S.parseValue_('0.1uF', 'C'), '100nF');
  assert.strictEqual(S.parseValue_('100nF', 'C'), '100nF');
  assert.strictEqual(S.parseValue_('4.7 µH', 'L'), '4.7uH');
  assert.strictEqual(S.parseValue_('0 Ohms', 'R'), '0');
  assert.strictEqual(S.parseValue_('20k', 'R', true), '20k');
  assert.strictEqual(S.parseValue_('20', 'C', true), '');
});

// ---- records from the cached real responses
t('DigiKey resistor -> Resistors, grouped by value+package', () => {
  const r = S.fromDigikey_(fx('dk_AC0402FR-072K2L.json').Product);
  assert.strictEqual(r.category, 'Resistors'); assert.strictEqual(r.groupKey, 'R|2.2k|0402'); assert.strictEqual(r.dkPn, 'YAG3467CT-ND');
  assert.ok(/1%/.test(r.spec), r.spec);
});
t('Mouser version of the same resistor lands on the same Group Key', () => {
  const r = S.fromMouser_(fx('mouser_AC0402FR-072K2L.json')[0]);
  assert.strictEqual(r.groupKey, 'R|2.2k|0402'); assert.strictEqual(r.mouserPn, '603-AC0402FR-072K2L');
});
t('DigiKey capacitor -> Capacitors with dielectric and voltage', () => {
  const r = S.fromDigikey_(fx('dk_C0402C103K5RACTU.json').Product);
  assert.strictEqual(r.groupKey, 'C|10nF|0402'); assert.ok(/X7R/.test(r.spec) && /50V/.test(r.spec), r.spec);
});
t('transceiver goes to Transceivers and keys on its own part number', () => {
  const r = S.fromDigikey_(fx('dk_ADM3067EBRZ.json').Product);
  assert.strictEqual(r.category, 'Transceivers'); assert.strictEqual(r.groupKey, 'P|adm3067ebrz');
});
t('unknown category falls to Misc', () => assert.strictEqual(S.categoryFor_('Connectors > Headers'), 'Misc'));

// ---- inventory
t('different part numbers of one value merge into one row', () => {
  const a = S.fromDigikey_(fx('dk_AC0402FR-072K2L.json').Product), b = S.fromMouser_(fx('mouser_AC0402FR-072K2L.json')[0]);
  b.mpn = 'RC0402FR-072K2L'; b.spec = '5%';
  const rows = [];
  S.upsertRow_(rows, a, 100, 'A1', 't1');
  const r = S.upsertRow_(rows, b, 50, 'A1', 't2');
  assert.strictEqual(rows.length, 1); assert.strictEqual(r.qty, 150);
  assert.strictEqual(r.mpns, 'AC0402FR-072K2L, RC0402FR-072K2L'); assert.strictEqual(r.location, 'A1');
  assert.ok(/ \| /.test(r.spec));
  S.upsertRow_(rows, a, 1, 'B2', 't3');
  assert.strictEqual(rows[0].location, 'A1 / B2'); assert.strictEqual(rows[0].mpns.split(', ').length, 2);
});
t('search ANDs words and understands value spellings', () => {
  const rows = [], a = S.fromDigikey_(fx('dk_C0402C103K5RACTU.json').Product), b = S.fromDigikey_(fx('dk_AC0402FR-072K2L.json').Product);
  S.upsertRow_(rows, a, 5, '', 't'); S.upsertRow_(rows, b, 5, '', 't');
  assert.strictEqual(S.searchRows_(rows, '0402 10n').length, 1);
  assert.strictEqual(S.searchRows_(rows, '0402 2.2k').length, 1);
  assert.strictEqual(S.searchRows_(rows, '0402').length, 2);
  assert.strictEqual(S.searchRows_(rows, '0402 nothing').length, 0);
});

// ---- API layer
const tokenReply = { code: 200, text: JSON.stringify({ access_token: 'tok', expires_in: 600 }) };
t('DigiKey: token cached, productdetails parsed, keys not in the URL', () => {
  fetches = []; Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
  responder = url => url.includes('oauth2') ? tokenReply : { code: 200, text: JSON.stringify(fx('dk_AC0402FR-072K2L.json')) };
  const a = S.dkLookup_('AC0402FR-072K2L'), b = S.dkLookup_('AC0402FR-072K2L');
  assert.strictEqual(a.groupKey, 'R|2.2k|0402'); assert.strictEqual(b.mpn, 'AC0402FR-072K2L');
  assert.strictEqual(fetches.filter(f => f.url.includes('oauth2')).length, 1);
  assert.ok(!fetches.some(f => f.url.includes('sec')));
});
t('DigiKey: 404 falls back to keyword search and strips -T', () => {
  fetches = []; Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
  const prod = fx('dk_AC0402FR-072K2L.json').Product;
  responder = (url, o) => url.includes('oauth2') ? tokenReply : url.includes('productdetails') ? { code: 404, text: '{}' }
    : { code: 200, text: JSON.stringify({ Products: JSON.parse(o.payload).Keywords === 'AC0402FR-072K2L' ? [prod] : [] }) };
  const r = S.dkLookup_('AC0402FR-072K2L-T');
  assert.ok(r && r.mpn === 'AC0402FR-072K2L');
});
t('DigiKey: 429 is retried, 401 raises a readable error', () => {
  Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
  let n = 0;
  responder = url => url.includes('oauth2') ? tokenReply : (++n < 3 ? { code: 429, text: '' } : { code: 200, text: JSON.stringify(fx('dk_AC0402FR-072K2L.json')) });
  assert.ok(S.dkLookup_('X'));
  responder = url => url.includes('oauth2') ? tokenReply : { code: 401, text: '' };
  assert.throws(() => S.dkLookup_('X'), /401/);
});
t('Mouser: exact match only', () => {
  responder = () => ({ code: 200, text: JSON.stringify({ Errors: [], SearchResults: { Parts: fx('mouser_AC0402FR-072K2L.json') } }) });
  assert.strictEqual(S.mouserLookup_('AC0402FR-072K2L').mouserPn, '603-AC0402FR-072K2L');
  assert.strictEqual(S.mouserLookup_('SOMETHING-ELSE'), null);
});
t('lookupPart_: cache first by any label number, label supplier next, errors become warnings, hits are stored', () => {
  Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
  props.MOUSER_KEY = '';
  fetches = []; responder = () => ({ code: 404, text: '{}' });
  const mem = {}, get = ks => ks.map(k => mem[k]).filter(Boolean)[0] || null, put = (r, ks) => ks.forEach(k => { mem[k] = r; });
  const miss = S.lookupPart_(S.parseLabel_('NOPE123'), get, put);
  assert.strictEqual(miss.rec, null); assert.ok(miss.warnings.some(w => /Mouser key missing/.test(w)));
  mem['ac0402fr072k2l'] = { mpn: 'AC0402FR-072K2L' }; fetches = [];
  const hit = S.lookupPart_(S.parseLabel_('[)>06P603-OTHER1PAC0402FR-072K2L'), get, put);
  assert.strictEqual(hit.source, 'cache'); assert.strictEqual(fetches.length, 0);
  props.MOUSER_KEY = 'mk';
  Object.keys(cacheStore).forEach(k => delete cacheStore[k]);
  responder = url => url.includes('oauth2') ? tokenReply : { code: 200, text: JSON.stringify(fx('dk_AC0402FR-072K2L.json')) };
  const got = S.lookupPart_(S.parseLabel_('AC0402FR-072K2L'), () => null, put);
  assert.strictEqual(got.source, 'DigiKey'); assert.ok(mem['ac0402fr072k2l'].groupKey);
});
t('client library carries the search code', () => {
  const lib = S.clientLib_(), ctx = require('vm').createContext({});
  require('vm').runInContext(lib, ctx);
  assert.strictEqual(ctx.searchRows_([{ value: '100nF', package: '0402' }], '0.1uF').length, 1);
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
