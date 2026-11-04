// Pure helpers. No Apps Script APIs here, so Node tests can load this file.

function squash(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

/** Lowercase alphanumerics only, for comparing part numbers across spelling differences. */
function normPn(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** "1,234" | 12 | "12 pcs" -> number (NaN if none). */
function num(s) {
  if (typeof s === 'number') return s;
  var t = String(s == null ? '' : s).replace(/[^\d.\-]/g, '');
  return t === '' || t === '-' ? NaN : parseFloat(t);
}
