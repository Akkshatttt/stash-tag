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
const real = s => s.replace(/<rs>/g, '').replace(/<gs>/g, '').replace(/<eot>/g, '');
t('real DigiKey labels (DigiKey forum, oeps fixtures)', () => {
  let p = S.parseLabel_(real('[)><rs>06<gs>PC1,C3,C5-7<gs>1P860010672008<gs>30P732-8660-1-ND<gs>K<gs>1K86761783<gs>10K104669300<gs>9D1437<gs>1T317510011436695<gs>11K1<gs>4LCN<gs>Q1<gs>11ZPICK<gs>12Z5728615<gs>13Z999999<gs>20Z000'));
  assert.deepStrictEqual([p.mpn, p.supplierPn, p.customerRef, p.qty, p.lot, p.dateCode, p.supplier], ['860010672008', '732-8660-1-ND', 'C1,C3,C5-7', 1, '317510011436695', '1437', 'DigiKey']);
  p = S.parseLabel_(real('[)><rs>06<gs>P1727-6369-6-ND<gs>1P74LVC4245AD,118<gs>K<gs>1K69457592<gs>Q200<gs>20Z00'));   // no 30P: P is the DigiKey PN
  assert.deepStrictEqual([p.mpn, p.supplierPn, p.customerRef, p.qty], ['74LVC4245AD,118', '1727-6369-6-ND', '', 200]);
  p = S.parseLabel_(real('[)><rs>06<gs>POEPS080126 P-831 IA-1247<gs>1PSN74LVC4245APWR<gs>30P296-12183-1-ND<gs>9D2625+5<gs>Q3<rs><eot>'));
  assert.deepStrictEqual([p.mpn, p.supplierPn, p.customerRef], ['SN74LVC4245APWR', '296-12183-1-ND', 'OEPS080126 P-831 IA-1247']);
});
t('real Mouser 2D labels carry no part number; customer PN is never searched', () => {
  let p = S.parseLabel_(real('[)><rs>06<gs>K39997218<gs>14K001<gs>POEPS070090 #IA-1265<gs>Q195<gs>11K091714519<gs>4LJP<gs>1VHirose<rs><eot>'));
  assert.deepStrictEqual([p.mpn, p.supplierPn, p.customerRef, p.qty, p.manufacturer], ['', '', 'OEPS070090 #IA-1265', 195, 'Hirose']);
  p = S.parseLabel_(real('>[)>06<gs>K10033990<gs>14K008<gs>1P929974-4<gs>Q5<gs>11K052636800<gs>4LDE<gs>1VTE Connectivity'));   // stray ">" and no RS
  assert.deepStrictEqual([p.mpn, p.qty, p.manufacturer], ['929974-4', 5, 'TE Connectivity']);
});
t('several barcodes from one photo merge into one label (Mouser prints one 1D bar per field)', () => {
  const two = real('[)><rs>06<gs>K11672779<gs>14K015<gs>Q4<gs>11K043415811<gs>4LUS<gs>1VVishay<rs><eot>');   // 2D without a part number
  const bars = ['11672779', '015', '71-RN60D-F-392', 'RN60D3920FB14', '4', 'US', '043415811'];
  let p = S.mergeLabels_([two].concat(bars));
  assert.deepStrictEqual([p.supplierPn, p.mpn, p.supplier, p.qty, p.manufacturer], ['71-RN60D-F-392', 'RN60D3920FB14', 'Mouser', 4, 'Vishay']);
  p = S.mergeLabels_(['004783209', real('[)><rs>06<gs>PC1<gs>1P860010672008<gs>30P732-8660-1-ND<gs>Q1')]);   // DigiKey: oLPN bar is ignored
  assert.deepStrictEqual([p.mpn, p.supplierPn, p.alts.length], ['860010672008', '732-8660-1-ND', 0]);
  p = S.mergeLabels_(['AC0402FR-072K2L']);   // one plain barcode = typed part number
  assert.strictEqual(p.mpn, 'AC0402FR-072K2L');
  assert.strictEqual(S.parseLabel_('[)>␞06␝PQ1045-ND␝1P364019-01␝K12432␠TRAVIS␠FOSS␝Q3').fields.K, '12432 TRAVIS FOSS', 'zxing-wasm control-char symbols');
});
t('Mouser mode: customer P/N in the 2D code, vertical label code and field bars are never the part number', () => {
  const two = '[)>␞06␝K37412632␝14K024␝PIC1␝Q6␝11K087334555␝4LPH␝1VSTMicro␞␄';   // real label: P = customer P/N, no 1P
  let p = S.mergeLabels_([two, '37412632', '024', 'IC1', '6', 'PH', '467DPD']);
  assert.strictEqual(p.mpn, '467DPD', 'without the hint the vertical code is mistaken for the MPN (the old bug)');
  p = S.mergeLabels_([two, '37412632', '024', 'IC1', '6', 'PH', '467DPD'], 'Mouser');
  assert.deepStrictEqual([p.mpn, p.supplierPn, p.supplier, p.qty], ['', '', 'Mouser', 6], 'no part number: the page shows the pick list');
  p = S.mergeLabels_([two, '467DPD', '511-STM32H755ZIT6', 'IC1'], 'Mouser');
  assert.deepStrictEqual([p.mpn, p.supplierPn, p.supplier], ['', '511-STM32H755ZIT6', 'Mouser']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S.partKeys_(p).cands[0])), { supplier: 'Mouser', pn: '511-STM32H755ZIT6' }, 'Mouser is asked first');
  p = S.mergeLabels_(['[)>␞06␝KEPS␠PD␠V2␝14K008␝1PBSC030P03NS3GAUMA1␝Q44␝11K086097937␝4LAT␝1VInfineon␞␄'], 'Mouser');
  assert.deepStrictEqual([p.mpn, p.qty, p.supplier], ['BSC030P03NS3GAUMA1', 44, 'Mouser'], '2D with 1P is enough');
  assert.strictEqual(S.mergeLabels_(['[)>␞06␝P1-ND␝1PX␝30P1-ND'], 'Mouser').supplier, 'DigiKey', 'a DigiKey label in Mouser mode stays DigiKey');
});
t('labelStrip_ samples a rotated strip along the 2D code axes', () => {
  const W = 40, H = 40, d = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x === 20) { const o = (y * W + x) * 4; d[o] = d[o + 1] = d[o + 2] = 0; }   // one vertical black line
  const strip = S.labelStrip_({ width: W, height: H, data: d }, { x: 30, y: 10 }, 0, 4, 0, 1);   // u from -5.8s: x 6.8..30.8
  assert.strictEqual(strip.width, 24); assert.ok(strip.height >= 4);
  const dark = []; for (let i = 0; i < strip.width; i++) if (strip.data[i * 4] < 128) dark.push(i);
  assert.deepStrictEqual(dark, [13], 'the line at x=20 lands at u index 13');
});
t('sortRows_: value by size, empty last, qty both ways, relevance keeps order', () => {
  const rows = [{ category: 'Capacitors', value: '1uF', qty: 5, mpns: 'B' }, { category: 'Capacitors', value: '100nF', qty: 50, mpns: 'A' }, { category: 'Resistors', value: '2.2k', qty: 7, mpns: 'C' },
    { category: 'Power ICs', value: '', qty: 1, mpns: 'D' }, { category: 'Resistors', value: '1M', qty: 9, mpns: 'E' }, { category: 'Capacitors', value: '4.7uF', qty: 2, mpns: 'F' }];
  const ids = (k, d) => S.sortRows_(rows, k, d).map(r => r.mpns).join('');
  assert.strictEqual(ids('', 'desc'), 'BACDEF', 'relevance keeps order');
  assert.strictEqual(ids('value', 'asc'), 'ABFCED', '100nF < 1uF < 4.7uF < 2.2k < 1M, empty last');
  assert.strictEqual(ids('value', 'desc'), 'ECFBAD', 'empty stays last when descending');
  assert.strictEqual(ids('qty', 'desc'), 'AECBFD', 'qty high to low');
  assert.strictEqual(ids('qty', 'asc'), 'DFBCEA');
  assert.strictEqual(ids('category', 'asc'), 'ABFDCE', 'category, ties by value then part');
  assert.strictEqual(rows[0].mpns, 'B', 'input not mutated');
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
