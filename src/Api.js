// DigiKey (Product Information v4) and Mouser (Search v1) lookups. Ported from the altium_pcb_schematics_automation Python tools
// (mouser_lookup.py, test_digikey.py, test_digikey_xlsx.py). Keys live in Script properties and are never logged or returned:
//   DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET, MOUSER_KEY

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

/** UrlFetchApp with HTTP errors returned (not thrown) and a short backoff on 429/5xx. -> {code, body (parsed JSON or null), text} */
function fetchJson_(url, opts) {
  opts = Object.assign({ muteHttpExceptions: true }, opts);
  var r, text;
  for (var i = 0; i < 3; i++) {
    r = UrlFetchApp.fetch(url, opts);
    var c = r.getResponseCode();
    if (c !== 429 && c < 500) break;
    Utilities.sleep(1000 * Math.pow(2, i));
  }
  text = r.getContentText();
  var body = null;
  try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { code: r.getResponseCode(), body: body, text: text };
}

// ---- DigiKey
function dkToken_() {
  var cache = CacheService.getScriptCache(), t = cache.get('DK_TOKEN');
  if (t) return t;
  var id = prop_('DIGIKEY_CLIENT_ID'), secret = prop_('DIGIKEY_CLIENT_SECRET');
  if (!id || !secret) throw new Error('DigiKey keys missing: set DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET in Script properties.');
  var r = fetchJson_('https://api.digikey.com/v1/oauth2/token', { method: 'post', payload: { client_id: id, client_secret: secret, grant_type: 'client_credentials' } });
  if (r.code !== 200 || !r.body || !r.body.access_token) throw new Error('DigiKey token failed (HTTP ' + r.code + '). Check the keys and that the app has Product Information v4.');
  cache.put('DK_TOKEN', r.body.access_token, Math.max(60, Math.min(r.body.expires_in || 600, 21000) - 60));
  return r.body.access_token;
}

function dkCall_(path, payload) {
  var headers = { Authorization: 'Bearer ' + dkToken_(), 'X-DIGIKEY-Client-Id': prop_('DIGIKEY_CLIENT_ID'),
    'X-DIGIKEY-Locale-Site': SETTINGS.dkSite, 'X-DIGIKEY-Locale-Language': SETTINGS.dkLanguage, 'X-DIGIKEY-Locale-Currency': SETTINGS.dkCurrency };
  var o = payload ? { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), headers: headers } : { headers: headers };
  var r = fetchJson_('https://api.digikey.com/products/v4/search/' + path, o);
  if (r.code === 401) { CacheService.getScriptCache().remove('DK_TOKEN'); throw new Error('DigiKey 401: bad token or app not subscribed to Product Information v4.'); }
  return r;
}

/** pn = manufacturer PN or DigiKey PN. productdetails first; on 404 a keyword search that must match the PN (also minus a -T/-TR/-TRL suffix). null if not found. */
function dkLookup_(pn) {
  var r = dkCall_(encodeURIComponent(pn) + '/productdetails');
  if (r.code === 200 && r.body && r.body.Product) return fromDigikey_(r.body.Product);
  if (r.code !== 404) throw new Error('DigiKey HTTP ' + r.code + ' for ' + pn);
  var want = [normPn(pn), normPn(pn.replace(/-(T|TR|TRL)$/i, ''))];
  var queries = [pn]; if (want[1] !== want[0]) queries.push(pn.replace(/-(T|TR|TRL)$/i, ''));
  for (var i = 0; i < queries.length; i++) {
    var k = dkCall_('keyword', { Keywords: queries[i], Limit: 10 });
    var hits = ((k.body && k.body.Products) || []).filter(function (p) { return want.indexOf(normPn(p.ManufacturerProductNumber)) >= 0; });
    if (hits.length) return fromDigikey_(hits[0]);
  }
  return null;
}

// ---- Mouser
function mouserLookup_(pn) {
  var key = prop_('MOUSER_KEY');
  if (!key) throw new Error('Mouser key missing: set MOUSER_KEY in Script properties.');
  var r = fetchJson_('https://api.mouser.com/api/v1/search/partnumber?apiKey=' + encodeURIComponent(key),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: pn, partSearchOptions: 'Exact' } }) });
  if (r.code !== 200 || !r.body) throw new Error('Mouser HTTP ' + r.code + ' for ' + pn);
  if (r.body.Errors && r.body.Errors.length) throw new Error('Mouser: ' + r.body.Errors[0].Message);
  var want = normPn(pn);
  var parts = (r.body.SearchResults && r.body.SearchResults.Parts) || [];
  var hit = parts.filter(function (p) { return normPn(p.ManufacturerPartNumber) === want || normPn(p.MouserPartNumber) === want; })[0];
  return hit ? fromMouser_(hit) : null;
}

/** Cache first (by any of the label's part numbers), then the label's supplier, then the other. cacheGet(keys) -> rec|null; cachePut(rec, queriedPns).
 *  -> {rec, source, warnings}; rec null if nothing found. Only a cache miss costs an API call. */
function lookupPart_(parsed, cacheGet, cachePut) {
  var cands = [], seen = {};
  var add = function (s, pn) { pn = squash(pn); var k = s + '|' + normPn(pn); if (pn && !seen[k]) { seen[k] = 1; cands.push({ supplier: s, pn: pn }); } };
  var first = parsed.supplier || 'DigiKey', other = first === 'DigiKey' ? 'Mouser' : 'DigiKey';
  add(first, parsed.supplierPn); add(first, parsed.mpn); add(other, parsed.mpn);
  var keys = [], warnings = [];
  cands.forEach(function (c) { var k = normPn(c.pn); if (keys.indexOf(k) < 0) keys.push(k); });
  var hit = cacheGet(keys);
  if (hit) return { rec: hit, source: 'cache', warnings: warnings };
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i], rec;
    try { rec = c.supplier === 'DigiKey' ? dkLookup_(c.pn) : mouserLookup_(c.pn); } catch (e) { warnings.push(c.supplier + ': ' + e.message); continue; }
    if (rec) { cachePut(rec, keys); return { rec: rec, source: c.supplier, warnings: warnings }; }
  }
  return { rec: null, source: '', warnings: warnings };
}
