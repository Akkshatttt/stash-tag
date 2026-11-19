// Sheet I/O and caches. The only file that touches cells or CacheService.
// Latency rules (every Google call costs 100-500 ms, so a click must never read a whole sheet):
//   - a part's row number is remembered in CacheService; the row is read to verify it, and only on a miss is one key column read;
//   - product lookups hit CacheService first, then the hidden Cache sheet, and only then DigiKey/Mouser;
//   - the full inventory is read once (CacheService, one set of chunks per category), sent to the page, and searched in the browser;
//   - the spreadsheet is opened lazily, only when a sheet is really needed.

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

function sheetOf_(name) {
  var sh = getSs().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup() first.');
  return sh;
}

function rowObj_(cols, v, r) {
  var o = { _row: r };
  cols.forEach(function (c, j) { o[c.key] = c.type === 'num' ? (v[j] === '' ? 0 : Number(v[j])) : (v[j] == null ? '' : String(v[j])); });
  return o;
}

/** All rows of a sheet (used only to rebuild the inventory cache). */
function readRows_(sh, cols) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map(function (v, i) { return rowObj_(cols, v, i + 2); });
}

/** Sheet row number whose cell in column `col` (1-based) equals value exactly (case-sensitive: 1M and 1m differ), or 0. One column read. */
function findRow_(sh, col, value) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  var v = sh.getRange(2, col, n, 1).getValues();
  for (var i = 0; i < n; i++) if (String(v[i][0]) === value) return i + 2;
  return 0;
}

function readRow_(sh, cols, r) { return rowObj_(cols, sh.getRange(r, 1, 1, cols.length).getValues()[0], r); }

/** A group's row number is remembered per category; the caller verifies it by reading the row and comparing the key. */
function rowHint_(cat, key) { var r = +CacheService.getScriptCache().get('r:' + cat + ':' + key); return r > 1 ? r : 0; }
function rowRemember_(cat, key, r) { CacheService.getScriptCache().put('r:' + cat + ':' + key, String(r), CACHE_TTL); }

/** Pre-format `n` rows from `start` as text/number, so writes need no format call (part numbers stay text, '=' can never start a formula). */
function formatBlock_(sh, cols, start, n) {
  var fmt = cols.map(function (c) { return c.type === 'num' ? '0' : '@'; });
  sh.getRange(start, 1, n, cols.length).setNumberFormats(Array.from({ length: n }, function () { return fmt; }));
}

/** Writes row objects (all new, or one existing with _row) in a single setValues. New rows go after the last row. The sheet grows (and the
 *  new block is formatted) only when Sheets refuses the write, so a normal write is one call (plus getLastRow for a new row). */
function writeRows_(sh, cols, rows) {
  var r = rows[0]._row || sh.getLastRow() + 1;
  var vals = rows.map(function (row) { return cols.map(function (c) { return row[c.key] == null ? '' : row[c.key]; }); });
  try { sh.getRange(r, 1, rows.length, cols.length).setValues(vals); }
  catch (e) {
    var last = r + rows.length - 1, max = sh.getMaxRows();
    if (last <= max) throw e;
    var add = Math.max(500, last - max);
    sh.insertRowsAfter(max, add);
    formatBlock_(sh, cols, max + 1, add);
    sh.getRange(r, 1, rows.length, cols.length).setValues(vals);
  }
  rows[0]._row = r;
}

function locked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nowStr_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'); }   // script time zone: no spreadsheet call

// ---- product cache: CacheService (fast, 6 h) in front of the hidden "Cache" sheet (permanent). A record is stored under every
// part number it is known by (manufacturer PN, DigiKey PN, Mouser PN), so scanning a Mouser bag finds a part first seen on DigiKey.
var CACHE_TTL = 21600;

function productGet_(keys) {
  var cs = CacheService.getScriptCache(), hit = cs.getAll(keys.map(function (k) { return 'p:' + k; }));
  for (var i = 0; i < keys.length; i++) if (hit['p:' + keys[i]]) return JSON.parse(hit['p:' + keys[i]]);
  var sh = sheetOf_('Cache'), n = sh.getLastRow() - 1;
  if (n < 1) return null;
  var col = sh.getRange(2, 1, n, 1).getValues();   // key column only (records are long); then one cell
  for (var j = 0; j < keys.length; j++) {
    for (var r = 0; r < n; r++) {
      if (String(col[r][0]) !== keys[j]) continue;
      var json = sh.getRange(r + 2, 2).getValue();
      cs.put('p:' + keys[j], json, CACHE_TTL);
      try { return JSON.parse(json); } catch (e) { /* corrupt row: fall through to the API */ }
    }
  }
  return null;
}

function productPut_(rec, queried) {
  var slim = Object.assign({}, rec); delete slim.params; delete slim.detail;
  slim.fetched = nowStr_();   // when the API was last asked; a later stock check can refresh records older than this
  var json = JSON.stringify(slim), keys = {};
  [rec.mpn, rec.dkPn, rec.mouserPn].concat(queried || []).forEach(function (p) { if (normPn(p)) keys[normPn(p)] = 1; });
  var names = Object.keys(keys), put = {};
  names.forEach(function (k) { put['p:' + k] = json; });
  CacheService.getScriptCache().putAll(put, CACHE_TTL);
  var sh = sheetOf_('Cache'), have = {}, n = sh.getLastRow() - 1;   // one read of the key column tells which keys are stored already
  if (n > 0) sh.getRange(2, 1, n, 1).getValues().forEach(function (v) { have[String(v[0])] = 1; });
  var fresh = names.filter(function (k) { return !have[k]; });
  if (fresh.length) writeRows_(sh, CACHE_COLUMNS, fresh.map(function (k) { return { key: k, json: json, time: slim.fetched }; }));
}

// ---- inventory cache: all category rows as page-ready objects, one set of CacheService chunks per category (a value is capped at 100 KB),
// so a confirm patches one small category instead of rewriting the whole inventory.
var CHUNK = 40000;

function publicRow_(r, category) {
  var o = { category: category || r._category };
  COLUMNS.forEach(function (c) { o[c.key] = r[c.key]; });
  return o;
}

/** {category: rows or null} from the cache, two cache calls for any number of categories. */
function catGet_(cats) {
  var cs = CacheService.getScriptCache(), ns = cs.getAll(cats.map(function (c) { return 'inv:' + c + ':n'; })), keys = [], out = {};
  cats.forEach(function (c) { for (var i = 0; i < (+ns['inv:' + c + ':n'] || 0); i++) keys.push('inv:' + c + ':' + i); });
  var got = keys.length ? cs.getAll(keys) : {};
  cats.forEach(function (c) {
    var n = +ns['inv:' + c + ':n'] || 0, s = '';
    out[c] = null;
    for (var j = 0; j < n; j++) { if (got['inv:' + c + ':' + j] == null) return; s += got['inv:' + c + ':' + j]; }
    if (!n) return;
    try { out[c] = JSON.parse(s); } catch (e) { /* rebuilt from the sheet */ }
  });
  return out;
}

function catPut_(cat, rows) {
  var s = JSON.stringify(rows), put = {}, n = Math.ceil(s.length / CHUNK) || 1;
  for (var i = 0; i < n; i++) put['inv:' + cat + ':' + i] = s.slice(i * CHUNK, (i + 1) * CHUNK);
  put['inv:' + cat + ':n'] = String(n);
  CacheService.getScriptCache().putAll(put, CACHE_TTL);
}

/** The whole inventory. Fast path: the cached categories. Slow path (first open, or after 6 h): one read per category sheet that is missing. */
function loadInventory_() {
  var got = catGet_(CATEGORIES), rows = [];
  CATEGORIES.forEach(function (cat) {
    var r = got[cat];
    if (!r) { r = readRows_(sheetOf_(cat), COLUMNS).map(function (x) { return publicRow_(x, cat); }); catPut_(cat, r); }
    rows = rows.concat(r);
  });
  return rows;
}

/** After a write, keep that category's cached rows current (the next phone to open the page would otherwise pay for a rebuild). Call inside the lock. */
function snapshotPatch_(pub) {
  var rows = catGet_([pub.category])[pub.category];
  if (!rows) return;
  var i = rows.findIndex(function (r) { return r.groupKey === pub.groupKey; });
  if (i >= 0) rows[i] = pub; else rows.push(pub);
  catPut_(pub.category, rows);
}
