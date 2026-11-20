// Pure: DigiKey / Mouser responses -> one internal record, plus the Group Key that decides which inventory row a part joins.
// Passives (R, C, L) group on kind|value|package only, so 1k 0402 resistors from different makers and tolerances share a row.
// Everything else groups on its own part number.

var PREFIX = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
var KIND_OF = { Resistors: 'R', Capacitors: 'C', Inductors: 'L' };
var KIND_UNIT = { R: '(?:[Oo][Hh][Mm][Ss]?|Ω|R)', C: 'F', L: 'H' };
var KIND_SYM = { R: '', C: 'F', L: 'H' };

/** "2.2 kOhms" | "10000 pF" | "0.1uF" | "4.7 µH" -> "2.2k" | "10nF" | "100nF" | "4.7uH". lenient (search words): whole word, unit optional but a prefix or unit is required ("20k", "100n", "0.1uF"). '' if none. */
function parseValue_(text, kind, lenient) {
  var s = String(text == null ? '' : text), m;
  if (lenient) m = new RegExp('^\\s*(\\d+(?:\\.\\d+)?)\\s*([pnuµμmkKMG]?)\\s*(' + KIND_UNIT[kind] + ')?\\s*$').exec(s);
  else m = new RegExp('(\\d+(?:\\.\\d+)?)\\s*([pnuµμmkKMG]?)\\s*' + KIND_UNIT[kind] + '(?![A-Za-z])').exec(s);
  if (!m || (lenient && !m[2] && !m[3])) return '';   // a bare number is not a value
  return eng_(parseFloat(m[1]) * PREFIX[m[2]], KIND_SYM[kind]);
}

function eng_(v, sym) {
  if (v === 0) return '0' + sym;
  var steps = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']];
  for (var i = 0; i < steps.length; i++) if (v >= steps[i][0] * 0.999999) return String(+(v / steps[i][0]).toPrecision(4)) + steps[i][1] + sym;
  return String(v) + sym;
}

function categoryFor_(path) {
  for (var i = 0; i < CATEGORY_RULES.length; i++) if (CATEGORY_RULES[i][1].test(path || '')) return CATEGORY_RULES[i][0];
  return 'Misc';
}

/** DigiKey Category is nested: {Name, ChildCategories:[{Name, ChildCategories}]}. -> "Integrated Circuits (ICs) > Power Management (PMIC)" */
function catPath_(c) {
  var names = [];
  while (c) { if (c.Name) names.push(c.Name); c = c.ChildCategories && c.ChildCategories[0]; }
  return names.join(' > ');
}

function pkgOf_(text) {
  var m = /\b(01005|0201|0402|0603|0805|1008|1206|1210|1806|1812|2010|2220|2512)\b/.exec(text || '');
  return m ? m[1] : '';
}

/** The secondary parameters of a passive as separate strings ('' = not known): {diel, volt, pow, cur, tol}. */
function specParts_(kind, P, D) {
  var tol = /(\d+(?:\.\d+)?)\s*%/.exec(P.Tolerance || D);
  var volt = /(\d+(?:\.\d+)?)\s*V(?:DC)?\b/.exec(P['Voltage - Rated'] || D);
  var diel = /\b(X7R|X5R|X6S|X7S|X7T|C0G|NP0|Y5V|Z5U)\b/i.exec(P['Temperature Coefficient'] || D);
  var pow = /\d+\/\d+\s*W/.exec(P['Power (Watts)'] || D) || /\d*\.?\d+\s*W\b/.exec(P['Power (Watts)'] || D);
  var cur = /(\d+(?:\.\d+)?)\s*m?A\b/.exec(P['Current Rating (Amps)'] || '');
  return { diel: kind === 'C' && diel ? (diel[1].toUpperCase() === 'NP0' ? 'C0G' : diel[1].toUpperCase()) : '', volt: kind === 'C' && volt ? volt[1] + 'V' : '',
    pow: kind === 'R' && pow ? pow[0].replace(/\s+/g, '') : '', cur: kind === 'L' && cur ? cur[0].replace(/\s+/g, '') : '', tol: tol && kind !== 'L' ? tol[1] + '%' : '' };
}
/** Spec text of a passive, in the stored order: dielectric, voltage, power, current, tolerance. */
function specOf_(kind, P, D) { return specText_(specParts_(kind, P, D)); }
function specText_(sp) { return [sp.diel, sp.volt, sp.pow, sp.cur, sp.tol].filter(Boolean).join(' '); }

/** EIA / manufacturer value code -> canonical value text. Resistors: 4R7, 2K2, 402K, 0R, 1002 (3 or 4 digits, the last is the power of ten). */
function resCode_(s) {
  s = String(s || '').toUpperCase();
  var m = /^(\d*)([RKM])(\d*)$/.exec(s);
  if (m) return eng_(parseFloat((m[1] || '0') + '.' + (m[3] || '0')) * { R: 1, K: 1e3, M: 1e6 }[m[2]], '');
  m = /^(\d{3,4})$/.exec(s);
  return m ? eng_(parseInt(m[1].slice(0, -1), 10) * Math.pow(10, +m[1].slice(-1)), '') : '';
}
/** Capacitors: 3-character pF code, 104 = 100 nF, 1R5 = 1.5 pF. */
function capCode_(s) {
  var m = /^(\d)(\d|R)(\d)$/.exec(String(s || '').toUpperCase());
  if (!m) return '';
  return m[2] === 'R' ? eng_(parseFloat(m[1] + '.' + m[3]) * 1e-12, 'F') : eng_(parseInt(m[1] + m[2], 10) * Math.pow(10, +m[3]) * 1e-12, 'F');
}
var TOL_LETTER = { B: '0.1%', C: '0.25%', D: '0.5%', F: '1%', G: '2%', J: '5%', K: '10%', M: '20%' };
var CASE_BY_SIZE = { '03': '0201', '05': '0402', '10': '0603', '15': '0402', '18': '0603', '21': '0805', '31': '1206', '32': '1210' };
var CASE_BY_METRIC = { '0603': '0201', '1005': '0402', '1608': '0603', '2012': '0805', '3216': '1206', '3225': '1210' };
// Manufacturer part-number series: [regex, function(match) -> {kind, package, value, tol}]. One line per series; an unknown series simply gives nothing.
var MPN_SERIES = [
  [/^CRCW(\d{4})(\d*[RKM]\d*|\d{3,4})([BCDFGJ])/, function (m) { return { kind: 'R', package: m[1], value: resCode_(m[2]), tol: TOL_LETTER[m[3]] }; }],   // Vishay Dale CRCW0603402KFKEA
  [/^(?:RC|AC|RT)(\d{4})([BDFGJ])R-(?:07|13|10|7)(\d*[RKM]\d*|\d{3,4})L$/, function (m) { return { kind: 'R', package: m[1], value: resCode_(m[3]), tol: TOL_LETTER[m[2]] }; }],   // Yageo RC0402FR-072K2L
  [/^ERJ-?(1GE|2|3|6|8)/, function (m) { return { kind: 'R', package: { '1GE': '0201', 2: '0402', 3: '0603', 6: '0805', 8: '1206' }[m[1]] }; }],   // Panasonic ERJ-3EKF1002V
  [/^RK73[HBZ](1E|1J|2A|2B)/, function (m) { return { kind: 'R', package: { '1E': '0402', '1J': '0603', '2A': '0805', '2B': '1206' }[m[1]] }; }],   // KOA RK73H1JTTD1002F
  [/^CL(03|05|10|21|31|32)[A-Z](\d{2}[\dR])/, function (m) { return { kind: 'C', package: CASE_BY_SIZE[m[1]], value: capCode_(m[2]) }; }],   // Samsung CL10B104KB8NNNC
  [/^GRM(03|15|18|21|31|32)[0-9A-Z][0-9A-Z]{2}[0-9A-Z]{2}(\d{2}[\dR])/, function (m) { return { kind: 'C', package: CASE_BY_SIZE[m[1]], value: capCode_(m[2]) }; }],   // Murata GRM155R71C104KA88D
  [/^C(1005|1608|2012|3216|3225)(?:X[5-8][RSTUP]|C0G|NP0)[0-9][A-Z](\d{2}[\dR])/, function (m) { return { kind: 'C', package: CASE_BY_METRIC[m[1]], value: capCode_(m[2]) }; }],   // TDK C1608X7R1H104K080AA
  [/^C(0201|0402|0603|0805|1206|1210)[A-Z](\d{2}[\dR])/, function (m) { return { kind: 'C', package: m[1], value: capCode_(m[2]) }; }]   // KEMET C0402C103K5RACTU
];
/** What the part number itself says about a chip passive: {kind, package, value, tol} (fields it cannot tell are ''), or null for an unknown series. */
function fromMpn_(mpn) {
  var t = String(mpn || '').toUpperCase().replace(/\s+/g, '');
  for (var i = 0; i < MPN_SERIES.length; i++) {
    var m = MPN_SERIES[i][0].exec(t);
    if (m) { var r = MPN_SERIES[i][1](m); return { kind: r.kind, package: r.package || '', value: r.value || '', tol: r.tol || '' }; }
  }
  return null;
}

/** Fills category, value, package, spec, groupKey on a record that has mpn, description, categoryPath and optionally params {name: text}. */
function classify_(rec) {
  var P = rec.params || {}, D = squash(rec.description + ' ' + (rec.detail || ''));
  rec.category = categoryFor_(rec.categoryPath);
  var kind = KIND_OF[rec.category];
  rec.value = rec.package = rec.spec = '';
  rec.sp = {}; rec.missing = []; rec.from = [];
  if (kind) {
    rec.value = parseValue_(P.Resistance || P.Capacitance || P.Inductance || '', kind) || parseValue_(D, kind);
    rec.package = pkgOf_(P['Package / Case']) || pkgOf_(P['Supplier Device Package']) || pkgOf_(D);
    rec.sp = specParts_(kind, P, D);
    var m = fromMpn_(rec.mpn);   // Mouser text often omits the size; the part number of a known series still says it
    if (m && m.kind === kind) {
      if (!rec.package && m.package) { rec.package = m.package; rec.from.push('package'); }
      if (!rec.value && m.value) { rec.value = m.value; rec.from.push('value'); }
      if (!rec.sp.tol && m.tol && kind !== 'L') { rec.sp.tol = m.tol; rec.from.push('tolerance'); }
    }
    rec.spec = specText_(rec.sp);
    if (!rec.value) rec.missing.push('value');
    if (!rec.package) rec.missing.push('package');
  }
  rec.groupKey = kind && rec.value && rec.package ? kind + '|' + rec.value + '|' + rec.package : 'P|' + normPn(rec.mpn);
  return rec;
}

/** DigiKey Product (productdetails -> .Product, keyword -> .Products[i]). Prefers the Cut Tape DigiKey PN, as the altium project does. */
function fromDigikey_(p) {
  var params = {};
  (p.Parameters || []).forEach(function (x) { params[x.ParameterText] = x.ValueText; });
  var vars = p.ProductVariations || [];
  var cut = vars.filter(function (v) { return /cut tape/i.test((v.PackageType && v.PackageType.Name) || ''); })[0] || vars[0] || {};
  var d = p.Description || {};
  return classify_({
    supplier: 'DigiKey', mpn: p.ManufacturerProductNumber || '', manufacturer: (p.Manufacturer && p.Manufacturer.Name) || '',
    description: d.ProductDescription || '', detail: d.DetailedDescription || '', datasheet: p.DatasheetUrl || '',
    dkPn: cut.DigiKeyProductNumber || '', mouserPn: '', categoryPath: catPath_(p.Category), params: params
  });
}

/** Mouser SearchResults.Parts[i]. Mouser has no parametrics, so value/package/spec come from the description text. */
/** DigiKey-style description of a chip passive from its parts: "RES 402K OHM 1% 1/10W 0603", "CAP CER 100nF 50V X7R 0402", "FIXED IND 10uH 1A 0603". */
function describePassive_(kind, value, pkg, sp) {
  sp = sp || {};
  if (kind === 'R') return squash(['RES', String(value).replace(/k$/, 'K').replace(/M$/, 'M'), 'OHM', value === '0' ? 'JUMPER' : '', sp.tol, sp.pow, pkg].filter(Boolean).join(' '));
  if (kind === 'C') return squash(['CAP', sp.diel ? 'CER' : '', value, sp.volt, sp.diel, pkg].filter(Boolean).join(' '));
  return squash(['FIXED IND', value, sp.cur, pkg].filter(Boolean).join(' '));
}
/** The description a part is stored with: the supplier text, except for a passive that is not from DigiKey (or was completed by hand), which gets the DigiKey-style
 *  pattern so every resistor and capacitor reads alike. */
function describeRec_(rec) {
  var kind = KIND_OF[rec.category];
  if (!kind || !rec.value || !rec.package || (/^digikey$/i.test(rec.supplier) && !rec.fixed && rec.description)) return squash(rec.description);
  return describePassive_(kind, rec.value, rec.package, rec.sp);
}
/** Group key of a record from its (possibly just completed) kind, value and package: passives group on all three, anything else on its own part number. */
function regroup_(rec) {
  var kind = KIND_OF[rec.category];
  rec.groupKey = kind && rec.value && rec.package ? kind + '|' + rec.value + '|' + rec.package : 'P|' + normPn(rec.mpn);
  return rec;
}
/** Fills what rec still lacks from another record of the same part (the DigiKey one): value, package and secondary parameters. Never overwrites. */
function mergeMissing_(rec, other) {
  ['value', 'package'].forEach(function (k) { if (!rec[k] && other[k]) { rec[k] = other[k]; rec.from.push(k); } });
  rec.sp = rec.sp || {};
  ['diel', 'volt', 'pow', 'cur', 'tol'].forEach(function (k) { if (!rec.sp[k] && other.sp && other.sp[k]) rec.sp[k] = other.sp[k]; });
  rec.spec = specText_(rec.sp);
  if (!rec.dkPn && other.dkPn) rec.dkPn = other.dkPn;
  rec.missing = (rec.missing || []).filter(function (k) { return !rec[k]; });
  rec.viaDigikey = true;
  return regroup_(rec);
}

var MOUSER_ATTR = { 'Case Code - in': 'Package / Case', Resistance: 'Resistance', Capacitance: 'Capacitance', Inductance: 'Inductance', Tolerance: 'Tolerance',
  'Power Rating': 'Power (Watts)', 'Voltage Rating DC': 'Voltage - Rated', 'Voltage Rating': 'Voltage - Rated', Dielectric: 'Temperature Coefficient', 'Temperature Coefficient': 'Temperature Coefficient' };
function fromMouser_(p) {
  var params = {};
  (p.ProductAttributes || []).forEach(function (a) { var k = MOUSER_ATTR[a.AttributeName]; if (k && !params[k]) params[k] = String(a.AttributeValue || ''); });   // most parts list only packaging; some list the case code and values
  return classify_({
    supplier: 'Mouser', mpn: p.ManufacturerPartNumber || '', manufacturer: p.Manufacturer || '', description: p.Description || '', detail: '',
    datasheet: p.DataSheetUrl || '', dkPn: '', mouserPn: p.MouserPartNumber || '', categoryPath: p.Category || '', params: params
  });
}
