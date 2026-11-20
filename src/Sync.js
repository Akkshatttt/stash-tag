// Google Sheet mirror of the inventory (one way: Cloudflare D1 -> Sheet). The app keeps its data in D1; this writes a readable copy.
// How it runs: every change in the app sends a "sync_hint" to doPost (see Code.js invCall), which notes the time and the Cloudflare address. A time trigger
// (syncTick, every 5 minutes) writes the Sheet once 15 minutes have passed with no further change. Each run rewrites its tabs completely:
//   one tab per top category (a row per part number), "Packets" (a row per live packet), "Log" (the last 1000 changes).
// Tabs of the old layout that have no new equivalent are cleared and marked, not deleted.
// Set-up, once: open the script editor, run syncSetup (it asks for permission and creates the trigger). syncNow runs the mirror at once.

var SYNC_QUIET_MS = 15 * 60 * 1000;
var SYNC_COLS = ['Group', 'Part number', 'Manufacturer', 'Description', 'Sub-category', 'Value', 'Package', 'Spec', 'Total qty', 'Boxes', 'DigiKey PN', 'Mouser PN', 'Source', 'Last change by', 'Last change'];
var SYNC_PACKET_COLS = ['Part number', 'Description', 'Category', 'Qty', 'Box', 'Lot', 'Date code', 'Added', 'Updated', 'By'];
var SYNC_LOG_COLS = ['Time', 'Part number', 'Kind', 'Change', 'Qty after', 'By', 'Note'];

/** Pure: the export {groups, cats, boxes, log} -> {order: [tab names], tabs: {name: {rows: [header, ...], num: [numeric column indexes]}}, legacy: [tab names]}.
 *  fmt(unixSeconds) -> text (the caller supplies the time zone). */
function syncTables_(data, fmt) {
  var cats = {}, boxes = {}, out = { order: [], tabs: {}, legacy: [] }, topName = function (id) { var c = cats[id]; return c ? (c.parent ? (cats[c.parent] || {}).name : c.name) : 'Unsorted'; };
  data.cats.forEach(function (c) { cats[c.id] = c; });
  data.boxes.forEach(function (b) { boxes[b.id] = b.name; });
  var byTop = {}, packets = [];
  data.groups.forEach(function (g) {
    var m = /^([RCL])\|([^|]*)\|(.*)$/.exec(g.key);
    g.comps.forEach(function (c) {
      var tot = 0, bx = {}, cat = cats[c.cat] || {}, top = topName(c.cat), where = cat.parent ? top + ' > ' + cat.name : top;
      c.packets.forEach(function (p) { tot += p.qty; if (boxes[p.box]) bx[boxes[p.box]] = 1; packets.push([c.mpn, c.descr, where, p.qty, boxes[p.box] || '', p.lot || '', p.dc || '', fmt(p.made), fmt(p.upd), p.by || '']); });
      (byTop[top] = byTop[top] || []).push({ sort: [cat.parent ? cat.name : '', g.label, c.mpn], row: [g.label, c.mpn, c.mfr, c.descr, cat.parent ? cat.name : '', m ? m[2] : '', m ? m[3] : '', c.spec, tot, Object.keys(bx).join(', '),
        c.dkpn, c.mopn, c.src === 1 ? 'DigiKey' : c.src === 2 ? 'Mouser' : 'other', c.by || '', c.ts ? fmt(c.ts) : ''] });
    });
  });
  Object.keys(byTop).sort().forEach(function (top) {
    var rows = byTop[top].sort(function (a, b) { return a.sort.join('\u0001') < b.sort.join('\u0001') ? -1 : 1; }).map(function (x) { return x.row; });
    out.order.push(top); out.tabs[top] = { rows: [SYNC_COLS].concat(rows), num: [8] };
  });
  packets.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  out.order.push('Packets'); out.tabs.Packets = { rows: [SYNC_PACKET_COLS].concat(packets), num: [3] };
  out.order.push('Log'); out.tabs.Log = { rows: [SYNC_LOG_COLS].concat((data.log || []).map(function (l) { return [fmt(l.ts), l.mpn, l.kind, l.delta, l.after == null ? '' : l.after, l.by || '', l.note || '']; })), num: [3, 4] };
  // tabs of the old layout (one per old category) that the new layout does not write
  (typeof CATEGORIES !== 'undefined' ? CATEGORIES : []).forEach(function (n) { if (!out.tabs[n]) out.legacy.push(n); });
  return out;
}

/** Writes one tab completely: clears it, sets text format (a part number can never turn into a formula), then the values. */
function syncWrite_(ss, name, table) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name), rows = table.rows, n = rows.length, w = rows[0].length;
  sh.clear();
  if (sh.getMaxRows() < n) sh.insertRowsAfter(sh.getMaxRows(), n - sh.getMaxRows());
  if (sh.getMaxColumns() < w) sh.insertColumnsAfter(sh.getMaxColumns(), w - sh.getMaxColumns());
  var all = sh.getRange(1, 1, n, w);
  all.setNumberFormat('@');
  table.num.forEach(function (j) { sh.getRange(1, j + 1, n, 1).setNumberFormat('0'); });
  all.setValues(rows);
  sh.getRange(1, 1, 1, w).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function syncFmt_(ts) { return ts ? Utilities.formatDate(new Date(ts * 1000), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : ''; }

/** Fetches the export from Cloudflare (the token only opens that one action) and rewrites the tabs. -> {tabs, parts, packets} */
function syncNow_() {
  var p = PropertiesService.getScriptProperties(), url = p.getProperty('CF_URL'), tok = p.getProperty('TOKEN');
  if (!url || !tok) throw new Error('No Cloudflare address yet: it arrives with the first change made in the app.');
  var r = UrlFetchApp.fetch(url + '/api', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify({ token: tok, req: { action: 'inv_export' } }) });
  var body; try { body = JSON.parse(r.getContentText()); } catch (e) { throw new Error('Export answered HTTP ' + r.getResponseCode() + ' (not JSON)'); }
  if (!body.ok) throw new Error('Export refused: ' + body.error);
  var t = syncTables_(body.data, syncFmt_), ss = getSs();
  t.order.forEach(function (name) { syncWrite_(ss, name, t.tabs[name]); });
  t.legacy.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) { sh.clear(); sh.getRange(1, 1).setValue('Old layout: no longer updated (the inventory now lives in the app and the tabs named after the top categories). Safe to delete this tab.'); }
  });
  var parts = 0; Object.keys(t.tabs).forEach(function (k) { if (k !== 'Packets' && k !== 'Log') parts += t.tabs[k].rows.length - 1; });
  return { tabs: t.order.length, parts: parts, packets: t.tabs.Packets.rows.length - 1 };
}

/** Time trigger, every 5 minutes: writes the Sheet when a change is pending and 15 minutes have passed since the last one. */
function syncTick() {
  var p = PropertiesService.getScriptProperties(), at = +p.getProperty('SYNC_AT') || 0;
  if (p.getProperty('SYNC_PENDING') !== '1' || Date.now() - at < SYNC_QUIET_MS) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    syncNow_();
    if ((+p.getProperty('SYNC_AT') || 0) === at) p.setProperty('SYNC_PENDING', '0');   // a change that arrived meanwhile keeps it pending
    p.setProperty('SYNC_LAST', String(Date.now())); p.deleteProperty('SYNC_ERR');
  } catch (e) { p.setProperty('SYNC_ERR', String(e && e.message || e)); }   // tried again at the next tick
  finally { lock.releaseLock(); }
}

/** From invCall: the app changed something. Remember when, and the Cloudflare address to fetch from. */
function syncHint_(req) {
  var p = PropertiesService.getScriptProperties();
  if (/^https:\/\/[^\/\s]+$/.test(req.origin || '')) p.setProperty('CF_URL', req.origin);
  p.setProperty('SYNC_AT', String(Date.now())); p.setProperty('SYNC_PENDING', '1');
  try { syncTrigger_(false); } catch (e) { /* not authorised yet: run syncSetup once in the editor */ }
  return { ok: true };
}
function syncTrigger_() {
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncTick'; })) ScriptApp.newTrigger('syncTick').timeBased().everyMinutes(5).create();
}
/** Run once in the script editor: asks for permission and creates the 5-minute trigger. */
function syncSetup() { syncTrigger_(); return 'The Sheet mirror trigger is set (every 5 minutes; writes 15 minutes after the last change).'; }
/** Run from the editor to write the Sheet right now. */
function syncNow() { return syncNow_(); }
