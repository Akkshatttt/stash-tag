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

/** Which supplier printed the label, from the label itself (there is no scan-mode switch). Mouser's 2D code has the line item 14K (or a manufacturer
 *  1V and nothing DigiKey-like); DigiKey's has its own part number 30P or a -ND number; with no 2D code a bar like 511-XXXX is Mouser, XXXX-ND DigiKey. */
function detectSupplier_(out, hasTwo, bars) {
  var f = out.fields || {};
  if (hasTwo) return f['14K'] ? 'Mouser' : f['30P'] || /-ND$/i.test(f.P || '') ? 'DigiKey' : f['1V'] && !f['1P'] ? 'Mouser' : '';
  var pn = bars.map(squash);
  return pn.some(function (t) { return /^\d{2,4}-\S+$/.test(t); }) ? 'Mouser' : pn.some(function (t) { return /-ND$/i.test(t); }) ? 'DigiKey' : '';
}

/** Several barcodes from one photo or video frame -> one parsed label. The 2D code (starts with "[)>") gives the fields; the bare 1D texts fill in
 *  a missing part number: Mouser prints one 1D bar per field (PO, line, Mouser PN, MFG PN, qty, country, invoice) and its 2D code may lack the PN. */
function mergeLabels_(texts, hint) {   // hint: 'DigiKey' or 'Mouser' from the page's scan mode
  texts = (texts || []).map(function (t) { return String(t == null ? '' : t); }).filter(squash);
  var two = texts.filter(function (t) { return t.indexOf('[)>') >= 0; }), one = texts.filter(function (t) { return t.indexOf('[)>') < 0; });
  var out = parseLabel_(two[0] || (one.length === 1 ? one[0] : ''));
  hint = hint || detectSupplier_(out, two.length, one);
  if (hint === 'Mouser' || hint === 'DigiKey') out.supplier = hint === 'Mouser' && /-ND$/i.test(out.supplierPn) ? 'DigiKey' : hint;
  if (!two.length && one.length === 1) return out;   // a single plain barcode: already handled as a typed part number
  var skip = {};
  Object.keys(out.fields).forEach(function (k) { skip[out.fields[k]] = 1; });
  var alts = [];
  one.map(squash).forEach(function (t) {
    if (!t || skip[t] || /^\d+$/.test(t) || t.length < 3 || /\s/.test(t) && t.length > 40) return;   // order/line/qty/invoice digits, country codes
    if (hint === 'Mouser' && !/^\d{2,3}-/.test(t) && /^\d{2,3}[A-Z0-9]{3,4}$/.test(t)) return;   // Mouser's vertical label code (467MRL, 43EX5W)
    if (/^\d{2,4}-\S+$/.test(t) && !out.supplierPn) { out.supplierPn = t; out.supplier = out.supplier || 'Mouser'; }
    else if (/[A-Za-z]/.test(t) && /\d/.test(t) && t.length >= 4 && !/\s/.test(t) && !out.mpn) { out.mpn = t; if (hint === 'Mouser') out.loose = true; }   // loose: a bar guessed to be the MPN; the page asks the user to check it
    else alts.push(t);
  });
  out.alts = alts.slice(0, 2);
  if (!out.supplier) guessSupplier_(out, out.supplierPn || out.mpn);
  return out;
}

/** What to tell the user when a scan has nothing to search (shared by Apps Script and the Cloudflare Function). */
function noPartWarning_(parsed) {
  return parsed.fields && (parsed.fields.Q || parsed.fields['1V'])
    ? 'This 2D code has no part number (Mouser labels never do). Scan the part-number barcode on the label, or type the part number.' + (parsed.fields['1V'] ? ' Manufacturer: ' + parsed.fields['1V'] + '.' : '')
    : 'Nothing readable in that scan. Type the part number instead.';
}

/** Parsed label -> lookup candidates in the order to try, and the normalised cache keys. Shared by Apps Script and the page (the page sends
 *  the keys to the Cloudflare part cache). */
function partKeys_(parsed) {
  var cands = [], seen = {}, keys = [];
  var add = function (s, pn) { pn = squash(pn); var k = s + '|' + normPn(pn); if (pn && !seen[k]) { seen[k] = 1; cands.push({ supplier: s, pn: pn }); } };
  // Order = cheapest and most certain first; the lookup stops at the first hit, so a good label costs one API call. The supplier's own part
  // number is exact; the manufacturer PN is tried on the same supplier, then on the other one (a real MPN; a bar only guessed to be one, or a
  // leftover bar, is never sent to the other supplier).
  var first = parsed.supplier || 'DigiKey', other = first === 'DigiKey' ? 'Mouser' : 'DigiKey';
  add(first, parsed.supplierPn); add(first, parsed.mpn); if (!parsed.loose) add(other, parsed.mpn);
  (parsed.alts || []).forEach(function (p) { add(first, p); });
  cands.forEach(function (c) { var k = normPn(c.pn); if (keys.indexOf(k) < 0) keys.push(k); });
  return { cands: cands, keys: keys };
}

/** Stable id of one physical packet, read from its 2D label ('' when the label has no order data, so the packet cannot be recognised again).
 *  DigiKey: invoice, sales order, packing list, PO, lot, date code + part number + qty. Mouser: invoice + line + PO + qty (its 2D code has no part
 *  number, and an invoice line is one part). There is no per-packet serial on either label: two identical bags of one order line collide. */
function fingerprint_(parsed) {
  var f = parsed.fields || {}, q = squash(f.Q || '');
  var pick = function (ks) { return ks.map(function (k) { return squash(f[k] || ''); }); };
  if (parsed.supplier === 'Mouser') {
    var m = pick(['11K', '14K', 'K']);
    return m[0] && m[1] ? 'M|' + m.join('|') + '|' + q : '';
  }
  if (parsed.supplier === 'DigiKey') {
    var d = pick(['10K', '1K', '11K', 'K', '1T', '9D']), pn = normPn(parsed.supplierPn || parsed.mpn);
    return (d[0] || d[1] || d[2]) && pn ? 'D|' + pn + '|' + d.join('|') + '|' + q : '';
  }
  return '';
}
