// Cloudflare Pages Function at POST /api. Body {token, req}, answer {ok, data} or {ok:false, error} (same as Apps Script doPost).
// A scan is answered here without Google: the label is parsed (lib/shared.js, built from src/), the D1 part cache is asked, and on a miss
// DigiKey/Mouser are called directly (lib/lookup.js) and the part is stored in D1 under every part number it has. Apps Script is only used for
// load and confirm (the sheet is the source of truth), and as the fallback for a scan when the supplier secrets are not set.
// Bindings (Pages project settings): D1 database as DB; secrets TOKEN (same as the Script property) and EXEC_URL (the /exec URL), PASSWORD (optional),
// and for the direct lookup DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET, MOUSER_KEY.
// ponytail: records never refresh here; a stock-check feature can overwrite rows when it lands.
import { mergeLabels_, partKeys_, normPn, noPartWarning_, fingerprint_, classify_ } from '../lib/shared.js';
import { haveKeys, lookupPart } from '../lib/lookup.js';
import { Refuse, ensureSchema, loadAll, addPacket, packetTxn, editComp, audit, addBox, addCategory, history, findByFp, findComp, suggestCat, describe, exportAll } from '../lib/inv.js';

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
  // The Sheet mirror (Apps Script) holds the token, never the password: with the token it may read the export and nothing else.
  const tokenOk = !!(env.TOKEN && body.token && await same(body.token, env.TOKEN));
  const allowed = env.TOKEN && ((env.PASSWORD ? body.password && await same(body.password, env.PASSWORD) : tokenOk) || (tokenOk && (body.req || {}).action === 'inv_export'));
  if (!allowed) return reply({ ok: false, error: 'forbidden' }, 403);
  const req = body.req || {};
  body = { token: env.TOKEN, req };
  if (req.action === 'usage') return reply({ ok: true, data: await usage(env) });
  if (String(req.action).startsWith('inv_')) {
    const out = await inventory(env, req);
    if (out.ok && MUTATING.includes(req.action)) syncHint(env, waitUntil, request);
    return reply(out);
  }
  if (req.action !== 'scan') return reply(await forward(env, body));

  // A scan: first the packet itself (a label already in stock is recognised without any lookup), then the part (D1 cache, then the suppliers).
  const texts = [].concat(req.texts || req.text || []).map(String).slice(0, 40), parsed = mergeLabels_(texts, req.supplier);
  await ensureSchema(env);
  const fp = fingerprint_(parsed), dup = await findByFp(env, fp);
  if (dup) return reply({ ok: true, data: { parsed, fp, dup, rec: null, source: 'inventory', warnings: [] } });
  const done = async data => { if (data.rec && !data.rec.sp) classify_(data.rec); return reply({ ok: true, data: Object.assign({ parsed, fp: fp || null, comp: data.rec ? await findComp(env, data.rec) : null, cat: data.rec ? await suggestCat(env, data.rec) : null, descr: data.rec ? describe(data.rec) : null }, data) }); };
  if (!parsed.mpn && !parsed.supplierPn) return done({ rec: null, warnings: [noPartWarning_(parsed)] });
  const keys = partKeys_(parsed).keys.slice(0, 20);
  const hit = await cached(env, keys);
  if (hit && hit.rec) return done({ rec: hit.rec, source: 'cloud cache', warnings: [] });
  if (hit) return done({ rec: null, source: 'cloud cache', warnings: ['Looked up a moment ago and not found at DigiKey or Mouser, so no new request was made. Check the part number, or try again later.'] });

  if (!haveKeys(env)) {   // no supplier secrets here: Apps Script looks it up
    const out = await forward(env, body);
    if (out.ok && out.data && out.data.rec) store(env, waitUntil, out.data.rec, keys);
    return out.ok && out.data ? done(out.data) : reply(out);
  }
  const found = await lookupPart(env, parsed);
  countCalls(env, waitUntil, found.calls);
  if (found.rec) store(env, waitUntil, found.rec, keys);
  else if (found.clean) miss(env, waitUntil, keys);   // remember a clean "not found" so rescanning the same packet costs no API call
  return done({ rec: found.rec, source: found.source, warnings: found.warnings });
}

// A change tells Apps Script (the Sheet mirror) that the inventory moved; Apps Script writes the Sheet once things have been quiet for 15 minutes. Fire and forget:
// the answer to the person never waits for it and a failure here changes nothing.
const MUTATING = ['inv_add', 'inv_txn', 'inv_edit', 'inv_audit'];
function syncHint(env, waitUntil, request) {
  if (!env.EXEC_URL || !env.TOKEN) return;
  let origin; try { origin = new URL(request.url).origin; } catch (e) { return; }
  waitUntil(fetch(env.EXEC_URL, { method: 'POST', body: JSON.stringify({ token: env.TOKEN, req: { action: 'sync_hint', origin } }), redirect: 'follow' }).catch(() => {}));
}

// Inventory actions (D1 is the source of truth). Errors meant for the person are thrown as Refuse and answered as {ok:false, error}.
async function inventory(env, req) {
  try {
    await ensureSchema(env);
    const who = { who: req.who };
    switch (req.action) {
      case 'inv_load': return { ok: true, data: await loadAll(env) };
      case 'inv_add': return { ok: true, data: await addPacket(env, req) };
      case 'inv_txn': return { ok: true, data: await packetTxn(env, req) };
      case 'inv_edit': return { ok: true, data: await editComp(env, req) };
      case 'inv_audit': return { ok: true, data: await audit(env, req) };
      case 'inv_box': return { ok: true, data: await addBox(env, req.name) };
      case 'inv_cat': return { ok: true, data: await addCategory(env, req) };
      case 'inv_hist': return { ok: true, data: await history(env, req.comp) };
      case 'inv_export': return { ok: true, data: await exportAll(env) };
      default: return { ok: false, error: 'unknown action' };
    }
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: 'Server error' };
  }
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
// API calls per provider per UTC day, so the debug panel can show how much of each daily allowance (DigiKey and Mouser: about 1000) is gone.
const USAGE_TABLE = 'CREATE TABLE IF NOT EXISTS usage (day TEXT, provider TEXT, n INTEGER NOT NULL, PRIMARY KEY (day, provider))';
const utcDay = () => new Date().toISOString().slice(0, 10);
function countCalls(env, waitUntil, calls) {
  const day = utcDay(), list = Object.keys(calls || {}).filter(p => calls[p] > 0);
  if (!list.length) return;
  const write = () => env.DB.batch(list.map(p => env.DB.prepare('INSERT INTO usage (day, provider, n) VALUES (?, ?, ?) ON CONFLICT (day, provider) DO UPDATE SET n = n + excluded.n').bind(day, p, calls[p])));
  waitUntil(write().catch(() => env.DB.prepare(USAGE_TABLE).run().then(write)).catch(() => {}));   // a missing table is created once; counting must never break a scan
}
async function usage(env) {
  const day = utcDay(), out = { day, DigiKey: 0, Mouser: 0 };
  try { ((await env.DB.prepare('SELECT provider, n FROM usage WHERE day = ?').bind(day).all()).results || []).forEach(r => { out[r.provider] = r.n; }); } catch (e) { /* no table yet: nothing counted */ }
  return out;
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
