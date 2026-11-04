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
