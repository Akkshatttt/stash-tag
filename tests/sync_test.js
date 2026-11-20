// Run: node tests/sync_test.js
// The Google Sheet mirror (src/Sync.js): the pure table builder, the debounce (writes only after 15 quiet minutes), the write of each tab, and the hint from the app.
const assert = require('assert');
const { loadSrc } = require('./load');

const props = {};
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) };
const triggers = [];
const ScriptApp = { getProjectTriggers: () => triggers, newTrigger: fn => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { triggers.push({ getHandlerFunction: () => fn }); } }) }) }) };
let lockBusy = false;
const LockService = { getScriptLock: () => ({ tryLock: () => !lockBusy, releaseLock() {} }) };
const fetched = []; let exportAnswer;
const UrlFetchApp = { fetch: (url, o) => { fetched.push({ url, body: JSON.parse(o.payload) }); const a = typeof exportAnswer === 'function' ? exportAnswer() : exportAnswer; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(a) }; } };

// a fake spreadsheet that records what is written
const sheets = {}, writes = [];
function fakeSheet(name) {
  const sh = { name, grid: null, formats: [], frozen: 0, maxRows: 1000, maxCols: 26,
    clear() { sh.grid = null; sh.formats = []; sh.cleared = true; }, getMaxRows: () => sh.maxRows, getMaxColumns: () => sh.maxCols, insertRowsAfter(a, n) { sh.maxRows += n; }, insertColumnsAfter(a, n) { sh.maxCols += n; }, setFrozenRows(n) { sh.frozen = n; },
    getRange: (r, c, nr, nc) => ({ setNumberFormat: f => { sh.formats.push([r, c, nr, nc, f]); }, setValues: v => { sh.grid = v; writes.push(name); }, setFontWeight() {}, setValue: v => { sh.note = v; } }) };
  return sh;
}
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = fakeSheet(n)) };
const S = loadSrc({ PropertiesService, ScriptApp, LockService, UrlFetchApp, Utilities: { formatDate: (d) => d.toISOString().slice(0, 16).replace('T', ' ') }, Session: { getScriptTimeZone: () => 'UTC' } });
S.getSs = () => ss;   // the sheet handle of Store.js, replaced

const eq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, m);   // objects made inside the vm have another Array prototype
const fmt = ts => ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
const pk = (id, qty, box, extra) => Object.assign({ id, qty, box, lot: '', dc: '', made: 1700000000, upd: 1700003600, by: 'Asha' }, extra);
const comp = (id, mpn, cat, packets, extra) => Object.assign({ id, mpn, mfr: 'YAGEO', dkpn: 'X-ND', mopn: '', descr: 'D-' + mpn, spec: '1%', sp: {}, src: 1, cat, ds: '', by: 'Asha', ts: 1700003600, packets }, extra);
const data = () => ({
  cats: [{ id: 100, parent: null, name: 'Resistors' }, { id: 106, parent: 100, name: 'General Purpose' }, { id: 600, parent: null, name: 'ICs' }, { id: 601, parent: 600, name: 'Power Management' }, { id: 1400, parent: null, name: 'Unsorted' }],
  boxes: [{ id: 1, name: 'B12' }, { id: 2, name: 'B13' }],
  groups: [{ id: 1, key: 'R|2.2k|0402', label: 'Resistor 2.2k 0402', cat: 106, comps: [comp(10, 'AC0402FR-072K2L', 106, [pk(100, 50, 1, { lot: 'L1' }), pk(101, 25, 2)]), comp(11, 'RC0402FR-072K2L', 106, [])] },
    { id: 2, key: 'P|lm', label: 'LM3940', cat: 601, comps: [comp(20, '=LM3940', 601, [pk(200, 7, 1)], { src: 2, dkpn: '' })] }],
  log: [{ ts: 1700003600, mpn: 'LM3940', kind: 'take', delta: -2, after: 7, by: 'Asha', note: null }], changed: 1700003600
});

// ---- the pure builder
let t = S.syncTables_(data(), fmt);
eq(t.order, ['ICs', 'Resistors', 'Packets', 'Log'], 'a tab per top category that has parts, then Packets and Log');
const res = t.tabs.Resistors.rows;
eq(res[0].slice(0, 3), ['Group', 'Part number', 'Manufacturer']); assert.strictEqual(res.length, 3, 'header + one row per part number');
eq(res[1].slice(0, 10), ['Resistor 2.2k 0402', 'AC0402FR-072K2L', 'YAGEO', 'D-AC0402FR-072K2L', 'General Purpose', '2.2k', '0402', '1%', 75, 'B12, B13'], 'value and package from the group key, total qty, boxes');
assert.strictEqual(res[2][8], 0, 'a part with no packets is listed with 0');
assert.strictEqual(t.tabs.ICs.rows[1][12], 'Mouser'); assert.strictEqual(t.tabs.ICs.rows[1][1], '=LM3940');
const pkts = t.tabs.Packets.rows; assert.strictEqual(pkts.length, 4); eq(pkts[1].slice(0, 6), ['=LM3940', 'D-=LM3940', 'ICs > Power Management', 7, 'B12', '']);
assert.ok(pkts.some(r => r[0] === 'AC0402FR-072K2L' && r[3] === 50 && r[5] === 'L1'));
eq(t.tabs.Log.rows[1], ['2023-11-14 23:13', 'LM3940', 'take', -2, 7, 'Asha', '']);
assert.ok(t.legacy.includes('Misc') && t.legacy.includes('Power ICs') && !t.legacy.includes('Resistors'), 'old tabs with no new equivalent are listed');

// ---- hint: remembers the address and the time, makes the trigger once
props.TOKEN = 'tok'; S.props_ = null;   // the token the app and this script share (prop_ caches per run)
assert.throws(() => S.invCall('wrong', { action: 'sync_hint', origin: 'https://a.pages.dev' }), /forbidden/);
eq(S.invCall('tok', { action: 'sync_hint', origin: 'https://a.pages.dev' }), { ok: true });
assert.strictEqual(props.CF_URL, 'https://a.pages.dev'); assert.strictEqual(props.SYNC_PENDING, '1'); assert.ok(+props.SYNC_AT > 0); assert.strictEqual(triggers.length, 1, 'trigger made');
S.invCall('tok', { action: 'sync_hint', origin: 'https://a.pages.dev' }); assert.strictEqual(triggers.length, 1, 'only one trigger');
S.invCall('tok', { action: 'sync_hint', origin: 'http://evil.example' }); assert.strictEqual(props.CF_URL, 'https://a.pages.dev', 'only an https origin is accepted');

// ---- the tick: nothing before 15 quiet minutes, then one write
exportAnswer = { ok: true, data: data() };
props.SYNC_AT = String(Date.now() - 14 * 60 * 1000); S.syncTick(); assert.strictEqual(fetched.length, 0, '14 minutes after the last change: not yet');
props.SYNC_AT = String(Date.now() - 16 * 60 * 1000); S.syncTick();
assert.strictEqual(fetched.length, 1); assert.deepStrictEqual(fetched[0], { url: 'https://a.pages.dev/api', body: { token: 'tok', req: { action: 'inv_export' } } });
assert.deepStrictEqual(Array.from(new Set(writes)).sort(), ['ICs', 'Log', 'Packets', 'Resistors']); assert.strictEqual(props.SYNC_PENDING, '0'); assert.ok(props.SYNC_LAST); assert.ok(!props.SYNC_ERR);
const sh = sheets.Resistors; assert.strictEqual(sh.grid.length, 3); assert.strictEqual(sh.frozen, 1); assert.ok(sh.formats.some(f => f[4] === '@') && sh.formats.some(f => f[4] === '0' && f[1] === 9), 'text everywhere, a number format on the quantity column');
S.syncTick(); assert.strictEqual(fetched.length, 1, 'nothing pending: no second write');
// old-layout tabs are cleared and marked, not deleted
sheets.Misc = fakeSheet('Misc'); sheets.Misc.grid = [['old']]; props.SYNC_PENDING = '1'; props.SYNC_AT = String(Date.now() - 20 * 60 * 1000); S.syncTick();
assert.ok(sheets.Misc.cleared && /no longer updated/.test(sheets.Misc.note) && sheets.Misc.grid === null);
// a change that arrives during the write keeps it pending
props.SYNC_PENDING = '1'; props.SYNC_AT = String(Date.now() - 20 * 60 * 1000); exportAnswer = () => { props.SYNC_AT = String(Date.now()); return { ok: true, data: data() }; }; S.syncTick();
assert.strictEqual(props.SYNC_PENDING, '1', 'a newer change is not marked done');
// failures are recorded and retried; a busy lock skips the run
exportAnswer = { ok: false, error: 'forbidden' }; props.SYNC_PENDING = '1'; props.SYNC_AT = String(Date.now() - 20 * 60 * 1000); S.syncTick();
assert.ok(/Export refused: forbidden/.test(props.SYNC_ERR) && props.SYNC_PENDING === '1', 'kept pending after an error');
const n = fetched.length; lockBusy = true; S.syncTick(); lockBusy = false; assert.strictEqual(fetched.length, n, 'a run already in progress is not doubled');
// no address yet
delete props.CF_URL; props.SYNC_PENDING = '1'; props.SYNC_AT = '1'; S.syncTick(); assert.ok(/No Cloudflare address/.test(props.SYNC_ERR));
console.log('sync ok');
