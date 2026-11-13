// Pure: turn the text a scanner/decoder returned into part fields.
// DigiKey and Mouser labels are ISO 15434 / MH10.8.2 Data Matrix: "[)>" RS "06" GS <id><value> GS <id><value> ... RS EOT
// Common data identifiers: P customer/supplier PN, 1P manufacturer PN, 30P DigiKey PN, Q quantity, 1T lot, 9D date code, 4L country, 1V manufacturer.
// Checked against real decoded strings in samples/ (see samples/NOTES.md). Mouser's 2D code has no part number at all (only PO, qty, manufacturer, invoice).

var GS = '\x1d', RS = '\x1e';

function parseLabel_(text) {
  var raw = String(text == null ? '' : text);
  raw = raw.replace(/<GS>|\{GS\}|\\x1d|\\u001d|␝/gi, GS).replace(/<RS>|\{RS\}|\\x1e|␞/gi, RS).replace(/<EOT>|\x04|␄/gi, '').replace(/␠/g, ' ');   // zxing-wasm prints control chars as symbols
  var out = { raw: raw, fields: {}, mpn: '', supplierPn: '', supplier: '', qty: 0, lot: '', dateCode: '', manufacturer: '' };
  var t = squash(raw.replace(/[\x1d\x1e]/g, ' '));
  if (!t) return out;
  var at = raw.indexOf('[)>');   // Mouser has been seen as ">[)>06": ignore anything before the header
  if (at > 0) { raw = raw.slice(at); out.raw = raw; }
  if (at < 0) {   // not a 2D label: a plain part number (1D barcode or typed)
    out.mpn = t;
    guessSupplier_(out, t);
    return out;
  }
  raw.replace(/^\[\)>\x1e?\d{2}/, '').split(/[\x1d\x1e]/).forEach(function (el) {
    var m = /^(\d{0,2}[A-Z])([\s\S]*)$/.exec(el.trim());
    if (m && m[2] !== '') out.fields[m[1]] = m[2].trim();
  });
  var f = out.fields;
  out.mpn = f['1P'] || '';
  out.supplierPn = f['30P'] || (looksLikeSupplierPn_(f.P) ? f.P : '');   // P is usually the buyer's own reference (Mouser always), not a PN
  out.customerRef = f.P && f.P !== out.supplierPn ? f.P : '';
  out.qty = f.Q ? parseInt(f.Q, 10) || 0 : 0;
  out.lot = f['1T'] || '';
  out.dateCode = f['9D'] || f['10D'] || '';
  out.manufacturer = f['1V'] || '';
  if (!out.mpn) { out.mpn = out.supplierPn; out.supplierPn = ''; }   // only one PN on the label: search with it
  guessSupplier_(out, out.supplierPn || out.mpn);
  return out;
}

function looksLikeSupplierPn_(s) { return /-ND$/i.test(s || '') || /^\d{2,3}-\S+/.test(s || ''); }

/** DigiKey PNs end in -ND (or -ND with a package code); Mouser PNs start with a 2-3 digit prefix and a dash, e.g. 595-TPS7A4700RGWR. */
function guessSupplier_(out, pn) {
  if (/-ND$/i.test(pn) || out.fields['30P']) out.supplier = 'DigiKey';
  else if (/^\d{2,3}-\S+/.test(pn)) out.supplier = 'Mouser';
}

/** Several barcodes from one photo or video frame -> one parsed label. The 2D code (starts with "[)>") gives the fields; the bare 1D texts fill in
 *  a missing part number: Mouser prints one 1D bar per field (PO, line, Mouser PN, MFG PN, qty, country, invoice) and its 2D code may lack the PN. */
function mergeLabels_(texts, hint) {   // hint: 'DigiKey' or 'Mouser' from the page's scan mode
  texts = (texts || []).map(function (t) { return String(t == null ? '' : t); }).filter(squash);
  var two = texts.filter(function (t) { return t.indexOf('[)>') >= 0; }), one = texts.filter(function (t) { return t.indexOf('[)>') < 0; });
  var out = parseLabel_(two[0] || (one.length === 1 ? one[0] : ''));
  if (hint === 'Mouser' || hint === 'DigiKey') out.supplier = hint === 'Mouser' && /-ND$/i.test(out.supplierPn) ? 'DigiKey' : hint;
  if (!two.length && one.length === 1) return out;   // a single plain barcode: already handled as a typed part number
  var skip = {};
  Object.keys(out.fields).forEach(function (k) { skip[out.fields[k]] = 1; });
  var alts = [];
  one.map(squash).forEach(function (t) {
    if (!t || skip[t] || /^\d+$/.test(t) || t.length < 3 || /\s/.test(t) && t.length > 40) return;   // order/line/qty/invoice digits, country codes
    if (hint === 'Mouser' && !/^\d{2,3}-/.test(t) && /^\d{2,3}[A-Z0-9]{3,4}$/.test(t)) return;   // Mouser's vertical label code (467MRL, 43EX5W)
    if (/^\d{2,3}-\S+/.test(t) && !out.supplierPn) { out.supplierPn = t; out.supplier = out.supplier || 'Mouser'; }
    else if (/[A-Za-z]/.test(t) && /\d/.test(t) && !out.mpn) out.mpn = t;
    else alts.push(t);
  });
  out.alts = alts.slice(0, 2);
  if (!out.supplier) guessSupplier_(out, out.supplierPn || out.mpn);
  return out;
}

/** Parsed label -> lookup candidates in the order to try, and the normalised cache keys. Shared by Apps Script and the page (the page sends
 *  the keys to the Cloudflare part cache). */
function partKeys_(parsed) {
  var cands = [], seen = {}, keys = [];
  var add = function (s, pn) { pn = squash(pn); var k = s + '|' + normPn(pn); if (pn && !seen[k]) { seen[k] = 1; cands.push({ supplier: s, pn: pn }); } };
  var first = parsed.supplier || 'DigiKey', other = first === 'DigiKey' ? 'Mouser' : 'DigiKey';
  add(first, parsed.supplierPn); add(first, parsed.mpn); add(other, parsed.mpn);
  (parsed.alts || []).forEach(function (p) { add(first, p); add(other, p); });   // leftover 1D bars, tried last
  cands.forEach(function (c) { var k = normPn(c.pn); if (keys.indexOf(k) < 0) keys.push(k); });
  return { cands: cands, keys: keys };
}
