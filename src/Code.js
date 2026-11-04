// Entry points. Plain GET = health check; ?page=app&t=<token> = the phone web app. The page calls invCall() through google.script.run.
// Server work per click: load = 1 cache read; scan = 1 cache read (API only on a miss); confirm = 1 find + 1 read + 2 writes. Search runs in the page.

function doGet(e) {
  var q = (e && e.parameter) || {};
  if (q.page !== 'app') return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'inventory' })).setMimeType(ContentService.MimeType.JSON);
  var tok = prop_('TOKEN');
  if (!tok || q.t !== tok) return ContentService.createTextOutput('forbidden');
  var tpl = HtmlService.createTemplateFromFile('src/AppPage');   // clasp keeps the src/ folder in file names
  tpl.token = q.t;
  tpl.categories = CATEGORIES;
  tpl.lib = clientLib_();
  return tpl.evaluate().setTitle('Inventory').addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** The pure search code, copied into the page so typing in Search needs no server call (one source of truth, also tested in Node). */
function clientLib_() {
  var vars = { PREFIX: PREFIX, KIND_UNIT: KIND_UNIT, KIND_SYM: KIND_SYM };
  return Object.keys(vars).map(function (n) { return 'var ' + n + '=' + JSON.stringify(vars[n]) + ';'; }).join('\n') + '\n' +
    [squash, eng_, parseValue_, searchRows_].map(String).join('\n');
}

/** Called by the page. Names ending in _ are hidden from the page. */
function invCall(token, req) {
  var tok = prop_('TOKEN');
  if (!tok || token !== tok) throw new Error('forbidden');
  var ss = getSs();
  if (req.action === 'load') return { rows: loadInventory_(ss) };
  if (req.action === 'scan') return scan_(ss, req.text);
  if (req.action === 'confirm') return locked_(function () { return confirm_(ss, req); });
  throw new Error('unknown action');
}

/** Parse the scanned text and look the part up (cache, then APIs). Writes nothing but the product cache. The page knows what is already stocked. */
function scan_(ss, text) {
  var parsed = parseLabel_(text);
  if (!parsed.mpn && !parsed.supplierPn) return { parsed: parsed, rec: null, warnings: ['Nothing readable in that scan. Type the part number instead.'] };
  var found = lookupPart_(parsed, function (keys) { return productGet_(ss, keys); }, function (rec, queried) { productPut_(ss, rec, queried); });
  return { parsed: parsed, rec: found.rec, source: found.source, warnings: found.warnings };
}

var REC_FIELDS = ['supplier', 'mpn', 'manufacturer', 'description', 'datasheet', 'dkPn', 'mouserPn', 'categoryPath', 'category', 'value', 'package', 'spec', 'groupKey'];

/** Adds stock. The page sends back the record from scan (so a wrong category can be fixed by hand); only known fields are kept, as plain strings. */
function confirm_(ss, req) {
  var rec = {};
  REC_FIELDS.forEach(function (k) { rec[k] = squash(req.rec && req.rec[k]); });
  var qty = Math.floor(num(req.qty));
  if (!(qty >= 1) || qty > 1000000) throw new Error('Quantity must be a whole number of at least 1.');
  if (CATEGORIES.indexOf(rec.category) < 0) throw new Error('Unknown category.');
  if (!rec.groupKey || !rec.mpn) throw new Error('Missing part data. Scan again.');
  var sh = sheetOf_(ss, rec.category), now = nowStr_(ss), at = findRow_(sh, 1, rec.groupKey);
  var rows = at ? [readRow_(sh, COLUMNS, at)] : [];
  var row = upsertRow_(rows, rec, qty, squash(req.location), now);
  writeRows_(sh, COLUMNS, [row]);
  writeRows_(sheetOf_(ss, 'Log'), LOG_COLUMNS, [{ time: now, category: rec.category, groupKey: rec.groupKey, mpn: rec.mpn, supplier: rec.supplier, delta: qty,
    location: squash(req.location), lot: squash(req.lot), note: 'scan add' }]);
  var pub = publicRow_(row, rec.category);
  snapshotPatch_(pub);
  return { row: pub, isNew: !!row._new };
}

// ---- one-time setup (run from the editor). Idempotent: safe to run again after a release that adds columns.
function setup() {
  var ss = getSs();
  CATEGORIES.forEach(function (c) { ensureSheet_(ss, c, COLUMNS); });
  ensureSheet_(ss, 'Log', LOG_COLUMNS);
  ensureSheet_(ss, 'Cache', CACHE_COLUMNS).hideSheet();
  var tok = prop_('TOKEN');
  if (!tok) { tok = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); PropertiesService.getScriptProperties().setProperty('TOKEN', tok); }
  Logger.log('Setup done. Open the web app with ?page=app&t=<TOKEN> (TOKEN is in Project Settings > Script properties).');
}

function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c.label; })]).setFontWeight('bold');
  sh.setFrozenRows(1);
  formatBlock_(sh, cols, 2, sh.getMaxRows() - 1);
  cols.forEach(function (c, i) { if (c.width) sh.setColumnWidth(i + 1, c.width); });
  return sh;
}
