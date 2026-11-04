// Sheet I/O and caches. The only file that touches cells or CacheService.
// Latency rules (every Google call costs 100-500 ms, so a click must never read a whole sheet):
//   - a part is found with TextFinder on one column and only that row is read or written;
//   - product lookups hit CacheService first, then the hidden Cache sheet, and only then DigiKey/Mouser;
//   - the full inventory is read once (CacheService snapshot), sent to the page, and searched in the browser.

var ss_ = null;   // one spreadsheet handle per execution (openById is slow on standalone scripts)

function getSs() {
  if (ss_) return ss_;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = prop_('SHEET_ID');
    if (!id) throw new Error('Set Script property SHEET_ID to the spreadsheet id (Project Settings > Script properties), or bind the script to the sheet.');
    ss = SpreadsheetApp.openById(id);
  }
  return (ss_ = ss);
}

function sheetOf_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup() first.');
  return sh;
}

function rowObj_(cols, v, r) {
  var o = { _row: r };
  cols.forEach(function (c, j) { o[c.key] = c.type === 'num' ? (v[j] === '' ? 0 : Number(v[j])) : (v[j] == null ? '' : String(v[j])); });
  return o;
}

/** All rows of a sheet (used only to rebuild the inventory snapshot). */
function readRows_(sh, cols) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map(function (v, i) { return rowObj_(cols, v, i + 2); });
}

/** Sheet row number whose cell in column `col` (1-based) equals value exactly (case-sensitive: 1M and 1m differ), or 0. One call, no data read. */
function findRow_(sh, col, value) {
  if (sh.getLastRow() < 2) return 0;
  var f = sh.getRange(2, col, sh.getLastRow() - 1, 1).createTextFinder(value).matchEntireCell(true).matchCase(true).findNext();
  return f ? f.getRow() : 0;
}

function readRow_(sh, cols, r) { return rowObj_(cols, sh.getRange(r, 1, 1, cols.length).getValues()[0], r); }

/** Pre-format `n` rows from `start` as text/number, so writes need no format call (part numbers stay text, '=' can never start a formula). */
function formatBlock_(sh, cols, start, n) {
  var fmt = cols.map(function (c) { return c.type === 'num' ? '0' : '@'; });
  sh.getRange(start, 1, n, cols.length).setNumberFormats(Array.from({ length: n }, function () { return fmt; }));
}

/** Writes row objects (all new, or one existing with _row) in a single setValues. New rows go after the last row. */
function writeRows_(sh, cols, rows) {
  var r = rows[0]._row || sh.getLastRow() + 1;
  if (r + rows.length - 1 > sh.getMaxRows()) {
    var from = sh.getMaxRows() + 1;
    sh.insertRowsAfter(sh.getMaxRows(), Math.max(500, rows.length));
    formatBlock_(sh, cols, from, sh.getMaxRows() - from + 1);
  }
  sh.getRange(r, 1, rows.length, cols.length).setValues(rows.map(function (row) { return cols.map(function (c) { return row[c.key] == null ? '' : row[c.key]; }); }));
  rows[0]._row = r;
}

function locked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nowStr_(ss) { return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'); }

// ---- product cache: CacheService (fast, 6 h) in front of the hidden "Cache" sheet (permanent). A record is stored under every
// part number it is known by (manufacturer PN, DigiKey PN, Mouser PN), so scanning a Mouser bag finds a part first seen on DigiKey.
var CACHE_TTL = 21600;

function productGet_(ss, keys) {
  var cs = CacheService.getScriptCache(), hit = cs.getAll(keys.map(function (k) { return 'p:' + k; }));
  for (var i = 0; i < keys.length; i++) if (hit['p:' + keys[i]]) return JSON.parse(hit['p:' + keys[i]]);
  var sh = sheetOf_(ss, 'Cache');
  for (var j = 0; j < keys.length; j++) {
    var r = findRow_(sh, 1, keys[j]);
    if (r) {
      var json = sh.getRange(r, 2).getValue();
      cs.put('p:' + keys[j], json, CACHE_TTL);
      try { return JSON.parse(json); } catch (e) { /* corrupt row: fall through to the API */ }
    }
  }
  return null;
}

function productPut_(ss, rec, queried) {
  var slim = Object.assign({}, rec); delete slim.params; delete slim.detail;
  slim.fetched = nowStr_(ss);   // when the API was last asked; a later stock check can refresh records older than this
  var json = JSON.stringify(slim), keys = {};
  [rec.mpn, rec.dkPn, rec.mouserPn].concat(queried || []).forEach(function (p) { if (normPn(p)) keys[normPn(p)] = 1; });
  var names = Object.keys(keys), put = {};
  names.forEach(function (k) { put['p:' + k] = json; });
  CacheService.getScriptCache().putAll(put, CACHE_TTL);
  var sh = sheetOf_(ss, 'Cache'), fresh = names.filter(function (k) { return !findRow_(sh, 1, k); });
  if (fresh.length) writeRows_(sh, CACHE_COLUMNS, fresh.map(function (k) { return { key: k, json: json, time: slim.fetched }; }));
}

// ---- inventory snapshot: all category rows as page-ready objects, in CacheService chunks (a value is capped at 100 KB).
var CHUNK = 40000;

function publicRow_(r, category) {
  var o = { category: category || r._category };
  COLUMNS.forEach(function (c) { o[c.key] = r[c.key]; });
  return o;
}

function snapshotGet_() {
  var cs = CacheService.getScriptCache(), n = +cs.get('inv:n');
  if (!n) return null;
  var keys = []; for (var i = 0; i < n; i++) keys.push('inv:' + i);
  var got = cs.getAll(keys), s = '';
  for (var j = 0; j < n; j++) { if (got['inv:' + j] == null) return null; s += got['inv:' + j]; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function snapshotPut_(rows) {
  var s = JSON.stringify(rows), put = {}, n = Math.ceil(s.length / CHUNK) || 1;
  for (var i = 0; i < n; i++) put['inv:' + i] = s.slice(i * CHUNK, (i + 1) * CHUNK);
  put['inv:n'] = String(n);
  CacheService.getScriptCache().putAll(put, CACHE_TTL);
}

/** The whole inventory. Fast path: the snapshot. Slow path (first open, or after 6 h): one read per category sheet. */
function loadInventory_(ss) {
  var rows = snapshotGet_();
  if (rows) return rows;
  rows = [];
  CATEGORIES.forEach(function (cat) { readRows_(sheetOf_(ss, cat), COLUMNS).forEach(function (r) { rows.push(publicRow_(r, cat)); }); });
  snapshotPut_(rows);
  return rows;
}

/** After a write, keep the snapshot current instead of dropping it (the next phone to open the page would pay for a rebuild). */
function snapshotPatch_(pub) {
  var rows = snapshotGet_();
  if (!rows) return;
  var i = rows.findIndex(function (r) { return r.category === pub.category && r.groupKey === pub.groupKey; });
  if (i >= 0) rows[i] = pub; else rows.push(pub);
  snapshotPut_(rows);
}
