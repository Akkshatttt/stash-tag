// Cloudflare Pages Function at POST /api. Body {token, req}, answer {ok, data} or {ok:false, error} (same as Apps Script doPost).
// A scan whose keys are in the D1 part cache is answered here without calling Google. Everything else (and a cache miss) is forwarded to the
// Apps Script /exec URL; a part found there is stored in D1 under every part number it has, so the next scan anywhere is a hit.
// Bindings (Pages project settings): D1 database as DB; secrets TOKEN (same as the Script property) and EXEC_URL (the /exec URL).
// ponytail: records never refresh here; a stock-check feature can overwrite rows when it lands.

let ready = false;   // table created once per isolate
const normPn = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');   // same as src/Util.js normPn
const reply = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });

async function forward(env, body) {
  const r = await fetch(env.EXEC_URL, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, error: 'Apps Script answered ' + r.status + ' (not JSON)' }; }
}

export async function onRequestPost({ request, env, waitUntil }) {
  let body;
  try { body = await request.json(); } catch (e) { return reply({ ok: false, error: 'bad request' }, 400); }
  if (!env.TOKEN || body.token !== env.TOKEN) return reply({ ok: false, error: 'forbidden' }, 403);
  const req = body.req || {};
  if (req.action !== 'scan' || !Array.isArray(req.keys) || !req.keys.length) return reply(await forward(env, body));

  const keys = req.keys.map(normPn).filter(Boolean).slice(0, 20);
  if (!ready) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS parts (key TEXT PRIMARY KEY, rec TEXT NOT NULL, time TEXT)').run(); ready = true; }
  if (keys.length) {
    const { results } = await env.DB.prepare(`SELECT key, rec FROM parts WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
    const byKey = Object.fromEntries((results || []).map(r => [r.key, r.rec]));
    const k = keys.find(x => byKey[x]);
    if (k) return reply({ ok: true, data: { rec: JSON.parse(byKey[k]), source: 'cloud cache', warnings: [] } });
  }

  const out = await forward(env, body);
  const rec = out.ok && out.data && out.data.rec;
  if (rec) {
    const all = [...new Set([rec.mpn, rec.dkPn, rec.mouserPn].map(normPn).concat(keys).filter(Boolean))];
    const json = JSON.stringify(rec), time = new Date().toISOString();
    const stmt = env.DB.prepare('INSERT OR REPLACE INTO parts (key, rec, time) VALUES (?, ?, ?)');
    waitUntil(env.DB.batch(all.map(k => stmt.bind(k, json, time))));
  }
  return reply(out);
}
