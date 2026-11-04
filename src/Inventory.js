// Pure inventory logic on plain row objects (columns from COLUMNS). Store.js does the sheet I/O.

function splitList_(s) { return String(s || '').split(/\s*[,\n]\s*/).filter(Boolean); }

function addTo_(list, item) {   // comma-separated set, keeps order
  var l = splitList_(list);
  item = squash(item);
  if (item && l.indexOf(item) < 0) l.push(item);
  return l.join(', ');
}

function addUnique_(s, item, sep) {
  var l = s ? String(s).split(sep) : [];
  item = squash(item);
  if (item && l.indexOf(item) < 0) l.push(item);
  return l.join(sep);
}

/** Adds qty of a looked-up part to the matching row (same groupKey) or makes a new one. Mutates and returns the row; row._new tells which. */
function upsertRow_(rows, rec, qty, location, now) {
  var row = rows.filter(function (r) { return r.groupKey === rec.groupKey; })[0];
  if (!row) {
    row = { _new: true, groupKey: rec.groupKey, value: rec.value, package: rec.package, spec: '', qty: 0, location: '', mpns: '', manufacturers: '',
      dkPns: '', mouserPns: '', description: rec.description, categoryPath: rec.categoryPath, datasheet: rec.datasheet };
    rows.push(row);
  }
  row.qty = (+row.qty || 0) + qty;
  row.mpns = addTo_(row.mpns, rec.mpn);
  row.manufacturers = addTo_(row.manufacturers, rec.manufacturer);
  row.dkPns = addTo_(row.dkPns, rec.dkPn);
  row.mouserPns = addTo_(row.mouserPns, rec.mouserPn);
  row.spec = addUnique_(row.spec, rec.spec, ' | ');
  row.location = addUnique_(row.location, location, ' / ');
  if (!row.datasheet) row.datasheet = rec.datasheet;
  row.updated = now;
  return row;
}

/** Every word must appear in the row (AND). A word like "100n" or "20k" also matches the canonical value of that name. */
function searchRows_(rows, query, limit) {
  var words = squash(query).split(' ').filter(Boolean);   // original case: 1M and 1m, 10uF and 10uf differ for parseValue_
  var forms = words.map(function (w) {
    var f = [w.toLowerCase()];
    ['R', 'C', 'L'].forEach(function (k) { var v = parseValue_(w, k, true); if (v) f.push(v.toLowerCase()); });
    return f;
  });
  return rows.filter(function (r) {
    var hay = [r.value, r.package, r.spec, r.mpns, r.manufacturers, r.dkPns, r.mouserPns, r.description, r.location, r.categoryPath, r.category].join(' ').toLowerCase();
    return forms.every(function (f) { return f.some(function (x) { return hay.indexOf(x) >= 0; }); });
  }).slice(0, limit || 100);
}

/** Sorted copy for the Search tab. key: '' (keep order) | category | value | package | qty | location | part | updated. dir: 'asc' | 'desc'.
 *  Values sort by size (100nF < 1uF < 4.7uF, 2.2k < 10k), rows without a value always last. Ties fall back to category, value, part number. */
function sortRows_(rows, key, dir) {
  var out = rows.slice();
  if (!key) return out;
  var sign = dir === 'desc' ? -1 : 1;
  var num = function (r) {
    var m = /^\s*(\d+(?:\.\d+)?)\s*([pnuµμmkKMG]?)/.exec(r.value == null ? '' : String(r.value));
    return m ? parseFloat(m[1]) * PREFIX[m[2]] : null;
  };
  var str = function (s) { return String(s == null ? '' : s).toLowerCase(); };
  var field = {
    category: function (r) { return str(r.category); }, package: function (r) { return str(r.package); }, location: function (r) { return str(r.location); },
    part: function (r) { return str(String(r.mpns || '').split(',')[0]); }, updated: function (r) { return str(r.updated); },
    qty: function (r) { return +r.qty || 0; }, value: num
  }[key];
  if (!field) return out;
  var cmp = function (a, b) { return typeof a === 'number' ? a - b : a < b ? -1 : a > b ? 1 : 0; };
  var tie = function (a, b) { return cmp(str(a.category), str(b.category)) || cmp(num(a) || 0, num(b) || 0) || cmp(str(a.mpns), str(b.mpns)); };
  return out.map(function (r, i) { return { r: r, i: i }; }).sort(function (x, y) {
    var a = field(x.r), b = field(y.r);
    if (a === null || b === null) return a === b ? x.i - y.i : a === null ? 1 : -1;   // missing values last, whatever the direction
    return sign * cmp(a, b) || tie(x.r, y.r) || x.i - y.i;
  }).map(function (o) { return o.r; });
}
