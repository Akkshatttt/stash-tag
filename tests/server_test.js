// Run: node tests/server_test.js
// setup(), scan, confirm and search against a fake spreadsheet and fake DigiKey. Checks the whole server path without Google.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadSrc } = require('./load');

const dk = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dk_AC0402FR-072K2L.json'), 'utf8'));

function fakeSheet(name) {
  const grid = [];   // grid[r-1][c-1]
  const sh = {
    name, hidden: false, bigReads: 0,
    getLastRow: () => { let n = 0; grid.forEach((row, i) => { if (row && row.some(v => v !== '' && v != null)) n = i + 1; }); return n; },
    getMaxColumns: () => 30, getMaxRows: () => Math.max(1000, grid.length), insertRowsAfter() {}, insertColumnsAfter() {}, setFrozenRows() {}, setColumnWidth() {}, hideSheet() { sh.hidden = true; },
    getRange: (r, c, nr, nc) => ({
      createTextFinder: v => {
        const f = { matchEntireCell: () => f, matchCase: () => f, findNext: () => {
          for (let i = 0; i < nr; i++) if (((grid[r - 1 + i] || [])[c - 1]) === v) return { getRow: () => r + i };
          return null; } };
        return f;
      },
      getValue: () => ((grid[r - 1] || [])[c - 1]) ?? '',
      getValues: () => (nr > 1 && sh.bigReads++, Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((grid[r - 1 + i] || [])[c - 1 + j]) ?? ''))),
      setValues: v => { v.forEach((row, i) => row.forEach((x, j) => { (grid[r - 1 + i] = grid[r - 1 + i] || [])[c - 1 + j] = x; })); return rng(); },
      setNumberFormats: () => rng(), setFontWeight: () => rng()
    }),
    grid
  };
  const rng = () => ({ setFontWeight() {} });
  return sh;
}
const sheets = {};
const ss = {
  getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = fakeSheet(n)), getSpreadsheetTimeZone: () => 'UTC'
};
const mem = {};   // CacheService contents
const props = { DIGIKEY_CLIENT_ID: 'id', DIGIKEY_CLIENT_SECRET: 'sec' };
let dkCalls = 0;
const S = loadSrc({
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => mem[k] ?? null, put: (k, v) => { mem[k] = v; }, remove: k => { delete mem[k]; },
    getAll: ks => Object.fromEntries(ks.filter(k => k in mem).map(k => [k, mem[k]])), putAll: o => Object.assign(mem, o) }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: { sleep() {}, getUuid: () => 'aaaa-bbbb', formatDate: () => '2026-11-04 10:00' },
  Logger: { log() {} },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
  UrlFetchApp: { fetch: url => { dkCalls++; const body = url.includes('oauth2') ? { access_token: 't', expires_in: 600 } : dk; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) }; } }
});

S.setup();
assert.deepStrictEqual(Object.keys(sheets), [...S.CATEGORIES, 'Log', 'Cache']);
assert.ok(sheets.Cache.hidden); assert.ok(props.TOKEN);
assert.throws(() => S.invCall('wrong', { action: 'load' }), /forbidden/);

const T = props.TOKEN;
const bigReads = () => CATEGORIES_AND().reduce((n, k) => n + sheets[k].bigReads, 0);
function CATEGORIES_AND() { return [...S.CATEGORIES, 'Log', 'Cache']; }

assert.strictEqual(S.invCall(T, { action: 'load' }).rows.length, 0, 'empty inventory loads');
// doPost: the JSON API the Cloudflare function forwards to
const post = body => JSON.parse(S.doPost({ postData: { contents: JSON.stringify(body) } }).text);
assert.deepStrictEqual(post({ token: T, req: { action: 'load' } }), { ok: true, data: { rows: [] } });
assert.deepStrictEqual(post({ token: 'wrong', req: { action: 'load' } }), { ok: false, error: 'forbidden' });
assert.strictEqual(JSON.parse(S.doPost({ postData: { contents: 'not json' } }).text).ok, false);
const base = bigReads();

let s = S.invCall(T, { action: 'scan', text: 'AC0402FR-072K2L' });
assert.strictEqual(s.rec.category, 'Resistors'); assert.strictEqual(s.source, 'DigiKey');
const calls1 = dkCalls;
const mz = S.invCall(T, { action: 'scan', text: '[)>06K3999721814K001POEPS070090 #IA-1265Q1951VHirose' });
assert.strictEqual(mz.rec, null); assert.ok(/no part number/.test(mz.warnings[0]) && /Hirose/.test(mz.warnings[0]), 'Mouser 2D code: clear message, customer PN not searched'); assert.strictEqual(dkCalls, calls1);
s = S.invCall(T, { action: 'scan', text: 'AC0402FR-072K2L' });
assert.strictEqual(dkCalls, calls1, 'second scan comes from CacheService'); assert.strictEqual(s.source, 'cache');
s = S.invCall(T, { action: 'scan', text: 'YAG3467CT-ND' });
assert.strictEqual(dkCalls, calls1, 'DigiKey PN is an alias of the same cached record'); assert.strictEqual(s.rec.mpn, 'AC0402FR-072K2L');
Object.keys(mem).forEach(k => { if (k.startsWith('p:')) delete mem[k]; });   // CacheService expired: the Cache sheet still answers
s = S.invCall(T, { action: 'scan', text: 'AC0402FR-072K2L' });
assert.strictEqual(dkCalls, calls1, 'Cache sheet keeps the part for good'); assert.strictEqual(s.source, 'cache');

let r = S.invCall(T, { action: 'confirm', rec: s.rec, qty: '100', location: 'A1', lot: 'L1' });
assert.ok(r.isNew); assert.strictEqual(r.row.qty, 100);
r = S.invCall(T, { action: 'confirm', rec: s.rec, qty: '25', location: 'A1' });
assert.ok(!r.isNew); assert.strictEqual(r.row.qty, 125);
assert.strictEqual(sheets.Resistors.getLastRow(), 2, 'same group stays one row');
assert.strictEqual(sheets.Log.getLastRow(), 3, 'two log lines plus header');
assert.strictEqual(bigReads(), base, 'scan and confirm never read a whole sheet');

assert.throws(() => S.invCall(T, { action: 'confirm', rec: s.rec, qty: '0' }), /Quantity/);
assert.throws(() => S.invCall(T, { action: 'confirm', rec: Object.assign({}, s.rec, { category: 'Nope' }), qty: '1' }), /category/);

let inv = S.invCall(T, { action: 'load' }).rows;
assert.strictEqual(inv.length, 1); assert.strictEqual(inv[0].qty, 125); assert.strictEqual(inv[0].category, 'Resistors');
assert.strictEqual(bigReads(), base, 'load after confirm is served from the patched snapshot');
Object.keys(mem).filter(k => k.startsWith('inv:')).forEach(k => delete mem[k]);
inv = S.invCall(T, { action: 'load' }).rows;
assert.strictEqual(inv[0].qty, 125, 'rebuilt from the sheets when the snapshot expires');
assert.strictEqual(S.searchRows_(inv, '0402 2.2k').length, 1);
console.log('server ok');
