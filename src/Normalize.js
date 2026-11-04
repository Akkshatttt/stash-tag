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

function specOf_(kind, P, D) {
  var tol = /(\d+(?:\.\d+)?)\s*%/.exec(P.Tolerance || D);
  var volt = /(\d+(?:\.\d+)?)\s*V\b/.exec(P['Voltage - Rated'] || D);
  var diel = /\b(X7R|X5R|X6S|X7S|X7T|C0G|NP0|Y5V|Z5U)\b/i.exec(P['Temperature Coefficient'] || D);
  var pow = /\d+\/\d+\s*W/.exec(P['Power (Watts)'] || D) || /\d*\.?\d+\s*W\b/.exec(P['Power (Watts)'] || D);
  var cur = /(\d+(?:\.\d+)?)\s*m?A\b/.exec(P['Current Rating (Amps)'] || '');
  var parts = [];
  if (kind === 'C' && diel) parts.push(diel[1].toUpperCase() === 'NP0' ? 'C0G' : diel[1].toUpperCase());
  if (kind === 'C' && volt) parts.push(volt[1] + 'V');
  if (kind === 'R' && pow) parts.push(pow[0].replace(/\s+/g, ''));
  if (kind === 'L' && cur) parts.push(cur[0].replace(/\s+/g, ''));
  if (tol && kind !== 'L') parts.push(tol[1] + '%');
  return parts.join(' ');
}

/** Fills category, value, package, spec, groupKey on a record that has mpn, description, categoryPath and optionally params {name: text}. */
function classify_(rec) {
  var P = rec.params || {}, D = squash(rec.description + ' ' + (rec.detail || ''));
  rec.category = categoryFor_(rec.categoryPath);
  var kind = KIND_OF[rec.category];
  rec.value = rec.package = rec.spec = '';
  if (kind) {
    rec.value = parseValue_(P.Resistance || P.Capacitance || P.Inductance || '', kind) || parseValue_(D, kind);
    rec.package = pkgOf_(P['Package / Case']) || pkgOf_(P['Supplier Device Package']) || pkgOf_(D);
    rec.spec = specOf_(kind, P, D);
  }
  rec.groupKey = kind && rec.value ? kind + '|' + rec.value + '|' + rec.package : 'P|' + normPn(rec.mpn);
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
function fromMouser_(p) {
  return classify_({
    supplier: 'Mouser', mpn: p.ManufacturerPartNumber || '', manufacturer: p.Manufacturer || '', description: p.Description || '', detail: '',
    datasheet: p.DataSheetUrl || '', dkPn: '', mouserPn: p.MouserPartNumber || '', categoryPath: p.Category || '', params: {}
  });
}
