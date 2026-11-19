// Cloudflare Pages Function at POST /api. Body {token, req}, answer {ok, data} or {ok:false, error} (same as Apps Script doPost).
// A scan is answered here without Google: the label is parsed (lib/shared.js, built from src/), the D1 part cache is asked, and on a miss
// DigiKey/Mouser are called directly (lib/lookup.js) and the part is stored in D1 under every part number it has. Apps Script is only used for
// load and confirm (the sheet is the source of truth), and as the fallback for a scan when the supplier secrets are not set.
// Bindings (Pages project settings): D1 database as DB; secrets TOKEN (same as the Script property) and EXEC_URL (the /exec URL), PASSWORD (optional),
// and for the direct lookup DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET, MOUSER_KEY.
// ponytail: records never refresh here; a stock-check feature can overwrite rows when it lands.
import { mergeLabels_, partKeys_, normPn, noPartWarning_ } from '../lib/shared.js';
import { haveKeys, lookupPart } from '../lib/lookup.js';

const reply = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });

async function forward(env, body) {
  const r = await fetch(env.EXEC_URL, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, error: 'Apps Script answered ' + r.status + ' (not JSON)' }; }
}

// Constant-time string compare (hash both sides so lengths match).
async function same(a, b) {
  const h = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
  const [x, y] = await Promise.all([h(a), h(b)]);
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(x, y) : x.every((v, i) => v === y[i]);
}

export async function onRequestPost({ request, env, waitUntil }) {
  let body;
  try { body = await request.json(); } catch (e) { return reply({ ok: false, error: 'bad request' }, 400); }
  // With the secret PASSWORD set, only the shared admin password unlocks the API (a saved #t= token no longer does); without it, the token.
  // The token is what goes on to Apps Script. ponytail: one shared password, no rate limit on wrong guesses; per-user logins come later.
  const allowed = env.TOKEN && (env.PASSWORD ? body.password && await same(body.password, env.PASSWORD) : body.token && await same(body.token, env.TOKEN));
  if (!allowed) return reply({ ok: false, error: 'forbidden' }, 403);
  const req = body.req || {};
  body = { token: env.TOKEN, req };
  if (req.action !== 'scan') return reply(await forward(env, body));

  const texts = [].concat(req.texts || req.text || []).map(String).slice(0, 40), parsed = mergeLabels_(texts, req.supplier);
  if (!parsed.mpn && !parsed.supplierPn) return reply({ ok: true, data: { parsed, rec: null, warnings: [noPartWarning_(parsed)] } });
  const keys = partKeys_(parsed).keys.slice(0, 20);
  const hit = await cached(env, keys);
  if (hit && hit.rec) return reply({ ok: true, data: { parsed, rec: hit.rec, source: 'cloud cache', warnings: [] } });
  if (hit) return reply({ ok: true, data: { parsed, rec: null, source: 'cloud cache', warnings: ['Looked up a moment ago and not found at DigiKey or Mouser, so no new request was made. Check the part number, or try again later.'] } });

  if (!haveKeys(env)) {   // no supplier secrets here: Apps Script looks it up
    const out = await forward(env, body);
    if (out.ok && out.data && out.data.rec) store(env, waitUntil, out.data.rec, keys);
    return reply(out);
  }
  const found = await lookupPart(env, parsed);
  if (found.rec) store(env, waitUntil, found.rec, keys);
  else if (found.clean) miss(env, waitUntil, keys);   // remember a clean "not found" so rescanning the same packet costs no API call
  return reply({ ok: true, data: { parsed, rec: found.rec, source: found.source, warnings: found.warnings } });
}

// D1 part cache. The table is created on first use (the first read fails once on a fresh database), not on every cold isolate.
const TABLE = 'CREATE TABLE IF NOT EXISTS parts (key TEXT PRIMARY KEY, rec TEXT NOT NULL, time TEXT)';
async function cached(env, keys) {
  if (!keys.length) return null;
  const q = () => env.DB.prepare(`SELECT key, rec, time FROM parts WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
  let res;
  try { res = await q(); } catch (e) { await env.DB.prepare(TABLE).run(); res = await q(); }
  const byKey = Object.fromEntries((res.results || []).map(r => [r.key, r])), k = keys.find(x => byKey[x] && byKey[x].rec !== MISS);
  if (k) return { rec: JSON.parse(byKey[k].rec) };
  const fresh = r => r && r.rec === MISS && Date.now() - Date.parse(r.time) < MISS_MS;
  return keys.every(x => fresh(byKey[x])) ? { rec: null } : null;   // every key a recent miss: do not ask the suppliers again
}
const MISS = 'null', MISS_MS = 6 * 3600 * 1000;
function miss(env, waitUntil, keys) {
  const time = new Date().toISOString(), stmt = env.DB.prepare('INSERT OR REPLACE INTO parts (key, rec, time) VALUES (?, ?, ?)');
  waitUntil(env.DB.batch(keys.map(k => stmt.bind(k, MISS, time))));
}
function store(env, waitUntil, rec, keys) {
  const all = [...new Set([rec.mpn, rec.dkPn, rec.mouserPn].map(normPn).concat(keys).filter(Boolean))];
  const json = JSON.stringify(rec), time = new Date().toISOString(), stmt = env.DB.prepare('INSERT OR REPLACE INTO parts (key, rec, time) VALUES (?, ?, ?)');
  waitUntil(env.DB.batch(all.map(k => stmt.bind(k, json, time))));
}
