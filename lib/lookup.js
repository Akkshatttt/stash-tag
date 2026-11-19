// DigiKey (Product Information v4) and Mouser (Search v1) lookups for the Cloudflare Function: the same logic as src/Api.js, written with fetch.
// Keys come from Cloudflare Pages secrets DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET, MOUSER_KEY. They are never logged, returned or put in an error
// text (the Mouser key sits in the query string, so every error from that call is scrubbed).
import { SETTINGS, fromDigikey_, fromMouser_, normPn, partKeys_ } from './shared.js';

let dkToken = { value: '', exp: 0 };   // ponytail: per-isolate token cache; a cold isolate asks DigiKey again (about 0.3 s)
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One retry on 429/5xx (a person is waiting). count(), if given, is called once per request actually sent (a retry is a second request: the
 *  suppliers count it too). -> {code, body (parsed JSON or null)} */
async function getJson(url, opts, count) {
  let r;
  for (let i = 0; i < 2; i++) {
    if (count) count();
    r = await fetch(url, opts);
    if (r.status !== 429 && r.status < 500) break;
    if (i === 0) await sleep(700);
  }
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { code: r.status, body };
}

async function token(env) {
  if (dkToken.value && Date.now() < dkToken.exp) return dkToken.value;
  if (!env.DIGIKEY_CLIENT_ID || !env.DIGIKEY_CLIENT_SECRET) throw new Error('DigiKey keys missing: set DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET.');
  const r = await getJson('https://api.digikey.com/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DIGIKEY_CLIENT_ID, client_secret: env.DIGIKEY_CLIENT_SECRET, grant_type: 'client_credentials' }).toString() });
  if (r.code !== 200 || !r.body || !r.body.access_token) throw new Error('DigiKey token failed (HTTP ' + r.code + '). Check the keys and that the app has Product Information v4.');
  dkToken = { value: r.body.access_token, exp: Date.now() + (Math.max(60, Math.min(r.body.expires_in || 600, 21000)) - 60) * 1000 };
  return dkToken.value;
}

async function dkCall(env, path, payload) {
  const headers = { Authorization: 'Bearer ' + await token(env), 'X-DIGIKEY-Client-Id': env.DIGIKEY_CLIENT_ID, 'X-DIGIKEY-Locale-Site': SETTINGS.dkSite,
    'X-DIGIKEY-Locale-Language': SETTINGS.dkLanguage, 'X-DIGIKEY-Locale-Currency': SETTINGS.dkCurrency };
  if (payload) headers['content-type'] = 'application/json';
  const r = await getJson('https://api.digikey.com/products/v4/search/' + path, payload ? { method: 'POST', headers, body: JSON.stringify(payload) } : { headers }, () => env.calls.DigiKey++);
  if (r.code === 401) { dkToken = { value: '', exp: 0 }; throw new Error('DigiKey 401: bad token or app not subscribed to Product Information v4.'); }
  return r;
}

/** pn = manufacturer PN or DigiKey PN; productdetails first, on 404 a keyword search that must match the PN (also minus -T/-TR/-TRL). null if not found. */
async function dkLookup(env, pn) {
  const r = await dkCall(env, encodeURIComponent(pn) + '/productdetails');
  if (r.code === 200 && r.body && r.body.Product) return fromDigikey_(r.body.Product);
  if (r.code !== 404) throw new Error('DigiKey HTTP ' + r.code + ' for ' + pn);
  const stripped = pn.replace(/-(T|TR|TRL)$/i, ''), want = [normPn(pn), normPn(stripped)], queries = [pn];
  if (want[1] !== want[0]) queries.push(stripped);
  for (const q of queries) {
    const k = await dkCall(env, 'keyword', { Keywords: q, Limit: 10 });
    const hits = ((k.body && k.body.Products) || []).filter(p => want.includes(normPn(p.ManufacturerPartNumber)));
    if (hits.length) return fromDigikey_(hits[0]);
  }
  return null;
}

async function mouserLookup(env, pn) {
  if (!env.MOUSER_KEY) throw new Error('Mouser key missing: set MOUSER_KEY.');
  let r;
  try {
    r = await getJson('https://api.mouser.com/api/v1/search/partnumber?apiKey=' + encodeURIComponent(env.MOUSER_KEY),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: pn, partSearchOptions: 'Exact' } }) }, () => env.calls.Mouser++);
  } catch (e) { throw new Error('Mouser request failed'); }   // the URL (with the key) must not leak through an error text
  if (r.code !== 200 || !r.body) throw new Error('Mouser HTTP ' + r.code + ' for ' + pn);
  if (r.body.Errors && r.body.Errors.length) throw new Error('Mouser: ' + String(r.body.Errors[0].Message).replace(env.MOUSER_KEY, '***'));
  const want = normPn(pn), parts = (r.body.SearchResults && r.body.SearchResults.Parts) || [];
  const hit = parts.find(p => normPn(p.ManufacturerPartNumber) === want || normPn(p.MouserPartNumber) === want);
  return hit ? fromMouser_(hit) : null;
}

export const haveKeys = env => !!(env.DIGIKEY_CLIENT_ID && env.DIGIKEY_CLIENT_SECRET && env.MOUSER_KEY);

/** Parsed label -> {rec, source, warnings, keys, clean}. Candidates are tried one at a time, best first, and the first hit stops the search: API calls
 *  are the scarce thing (1000/day each), so nothing runs speculatively. clean = every candidate answered "not found" (no error), safe to remember as a miss. */
export async function lookupPart(env0, parsed) {
  const env = Object.assign({}, env0, { calls: { DigiKey: 0, Mouser: 0 } }), { cands, keys } = partKeys_(parsed), warnings = [];   // calls: requests sent to each supplier by this lookup (the token request is not a product call and is not counted)
  const out = r => Object.assign(r, { calls: env.calls });
  let clean = true;
  for (const c of cands) {
    try {
      const rec = await (c.supplier === 'DigiKey' ? dkLookup(env, c.pn) : mouserLookup(env, c.pn));
      if (rec) return out({ rec, source: c.supplier, warnings, keys, clean });
    } catch (e) { clean = false; warnings.push(c.supplier + ': ' + e.message); }
  }
  return out({ rec: null, source: '', warnings, keys, clean: clean && cands.length > 0 });
}
