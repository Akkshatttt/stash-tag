// Inventory on D1: parts (comp) grouped (grp), physical packets with their own qty and box, and a transaction log. Used by functions/api.js.
// Rules: a packet label seen before (same fingerprint) is never added twice; stock never goes negative; an emptied packet is archived, not deleted,
// so its fingerprint stays blocked; every change is logged with who made it. D1 has no interactive transactions: guarded UPDATEs and batches stand in.
import { normPn } from './shared.js';
import { MIGRATIONS, catFromPath, UNSORTED } from './schema.js';

export const KIND = { add: 0, take: 1, correct: 2, move: 3, audit: 4, sync: 5, edit: 6 };
const KIND_NAME = ['add', 'take', 'correct', 'move', 'audit', 'sync', 'edit'];
const srcOf = s => /^digi/i.test(s || '') ? 1 : /^mouser/i.test(s || '') ? 2 : 0;
const now = () => Math.floor(Date.now() / 1000);
const text = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
export class Refuse extends Error {}   // a message meant for the person, answered as {ok:false, error}

let migrated = false;
export function resetSchema_() { migrated = false; }   // tests use a fresh database each time
export async function ensureSchema(env) {
  if (migrated) return;
  let have = 0;
  try { const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'schema'").first(); have = r ? +r.v : 0; } catch (e) { /* no meta table yet */ }
  for (let i = have; i < MIGRATIONS.length; i++) {
    const st = MIGRATIONS[i].map(([sql, args]) => env.DB.prepare(sql).bind(...(args || [])));
    st.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").bind(String(i + 1)));
    await env.DB.batch(st);
  }
  migrated = true;
}

/** DigiKey keeps its own wording for passives (the preferred style); Mouser's, and anything the parser could not fill, gets the same pattern from the parsed
 *  fields. ICs and connectors keep the supplier text, to be edited by hand while adding. */
export function describe(rec) {
  const kind = /^([RCL])\|/.exec(rec.groupKey || '');
  if (!kind) return text(rec.description, 200);
  if (/^digikey$/i.test(rec.supplier) && rec.description) return text(rec.description, 200);
  return text([{ R: 'RES', C: 'CAP', L: 'IND' }[kind[1]], rec.value, rec.package, rec.spec].filter(Boolean).join(' ') || rec.description, 200);
}
function groupLabel(rec) {
  const m = /^([RCL])\|([^|]*)\|(.*)$/.exec(rec.groupKey || '');
  return m ? text([{ R: 'Resistor', C: 'Capacitor', L: 'Inductor' }[m[1]], m[2], m[3]].filter(Boolean).join(' '), 80) : text(rec.mpn, 80);
}

// ---- reading -------------------------------------------------------------------------------------------------------------------------------------
const SELECT = `SELECT g.id gid, g.gkey, g.label, g.cat gcat, c.id cid, c.mpn, c.mfr, c.dkpn, c.mopn, c.descr, c.spec, c.src, c.cat ccat, c.ds, c.last_by, c.last_ts,
  p.id pid, p.qty, p.box, p.lot, p.dc, p.made, p.upd, p.by
  FROM comp c JOIN grp g ON g.id = c.grp LEFT JOIN packet p ON p.comp = c.id AND p.st = 0`;

/** Joined rows -> groups [{id, key, label, cat, comps: [{id, mpn, ..., packets: [{id, qty, box, ...}]}]}], the shape the page keeps in memory. */
export function nest(rows) {
  const groups = [], gi = {}, ci = {};
  for (const r of rows) {
    let g = gi[r.gid];
    if (!g) { g = gi[r.gid] = { id: r.gid, key: r.gkey, label: r.label, cat: r.gcat, comps: [] }; groups.push(g); }
    let c = ci[r.cid];
    if (!c) {
      c = ci[r.cid] = { id: r.cid, mpn: r.mpn, mfr: r.mfr || '', dkpn: r.dkpn || '', mopn: r.mopn || '', descr: r.descr || '', spec: r.spec || '', src: r.src, cat: r.ccat || r.gcat,
        ds: r.ds || '', by: r.last_by || '', ts: r.last_ts || 0, packets: [] };
      g.comps.push(c);
    }
    if (r.pid) c.packets.push({ id: r.pid, qty: r.qty, box: r.box, lot: r.lot || '', dc: r.dc || '', made: r.made, upd: r.upd, by: r.by || '' });
  }
  return groups;
}

export async function loadAll(env) {
  const [rows, cats, boxes] = await Promise.all([
    env.DB.prepare(SELECT + ' ORDER BY g.id, c.id, p.id').all(), env.DB.prepare('SELECT id, parent, name FROM cat ORDER BY id').all(), env.DB.prepare('SELECT id, name FROM box ORDER BY name').all()]);
  return { groups: nest(rows.results), cats: cats.results, boxes: boxes.results, requireReason: env.REQUIRE_REASON === '1' };
}
/** One part with its live packets and its group, to patch into the page after a change: {group: {..., comps: [comp]}}. */
export async function compView(env, compId) {
  const rows = await env.DB.prepare(SELECT + ' WHERE c.id = ? ORDER BY p.id').bind(compId).all();
  return rows.results.length ? { group: nest(rows.results)[0] } : null;
}
/** The packet carrying this fingerprint (live, empty or removed), with its part; null if none. */
export async function findByFp(env, fp) {
  if (!fp) return null;
  const p = await env.DB.prepare('SELECT id, comp, qty, st, box FROM packet WHERE fp = ?').bind(fp).first();
  return p ? Object.assign({ packetId: p.id, st: p.st, qty: p.qty, box: p.box }, await compView(env, p.comp)) : null;
}
export async function findComp(env, rec) {
  const k = normPn(rec && rec.mpn);
  const c = k && await env.DB.prepare('SELECT id FROM comp WHERE mkey = ?').bind(k).first();
  return c ? compView(env, c.id) : null;
}

// ---- writing -------------------------------------------------------------------------------------------------------------------------------------
async function ensureComp(env, rec, o) {
  const mkey = normPn(rec.mpn);
  if (!mkey) throw new Refuse('This part has no part number.');
  const have = await env.DB.prepare('SELECT id FROM comp WHERE mkey = ?').bind(mkey).first();
  if (have) {   // known part: only fill supplier numbers it did not have yet
    await env.DB.prepare("UPDATE comp SET dkpn = CASE WHEN dkpn IS NULL OR dkpn = '' THEN ? ELSE dkpn END, mopn = CASE WHEN mopn IS NULL OR mopn = '' THEN ? ELSE mopn END WHERE id = ?")
      .bind(rec.dkPn || '', rec.mouserPn || '', have.id).run();
    return have.id;
  }
  const src = srcOf(rec.supplier), path = text(rec.categoryPath, 300);
  let cat = UNSORTED;
  const learned = path && await env.DB.prepare('SELECT cat FROM catmap WHERE src = ? AND path = ?').bind(src, path).first();
  cat = learned ? learned.cat : catFromPath(path);
  const gkey = rec.groupKey || 'P|' + mkey;
  await env.DB.prepare('INSERT OR IGNORE INTO grp (gkey, cat, label) VALUES (?, ?, ?)').bind(gkey, cat, groupLabel(rec)).run();
  const g = await env.DB.prepare('SELECT id FROM grp WHERE gkey = ?').bind(gkey).first();
  const typed = text(o.descr, 200), r = await env.DB.prepare('INSERT INTO comp (grp, mkey, mpn, mfr, dkpn, mopn, descr, edited, path, spec, src, ds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(g.id, mkey, text(rec.mpn, 80), text(rec.manufacturer, 80), text(rec.dkPn, 80), text(rec.mouserPn, 80), typed || describe(rec), typed ? 1 : 0, path, text(rec.spec, 80), src, text(rec.datasheet, 300)).run();
  const id = r.meta.last_row_id;
  if (o.cat && +o.cat !== cat) await setCategory(env, id, +o.cat);
  return id;
}

async function log(env, compId, packetId, kind, delta, after, who, note) {
  await env.DB.prepare('INSERT INTO txn (comp, packet, kind, delta, after, by, ts, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(compId, packetId, kind, delta, after, who, now(), note || null).run();
  if (kind !== KIND.edit) await env.DB.prepare('UPDATE comp SET last_by = ?, last_ts = ? WHERE id = ?').bind(who, now(), compId).run();
}
const qtyOf = (v, min) => { const n = Math.floor(+v); if (!(n >= min && n <= 10000000)) throw new Refuse('Quantity must be a whole number' + (min ? ' of at least ' + min : '') + '.'); return n; };
const who_ = v => text(v, 40) || 'unknown';

/** Adds a new packet. A fingerprint already in the database is not added: {dup} (the existing packet and its part) comes back instead. */
export async function addPacket(env, a) {
  const rec = a.rec || {}, qty = qtyOf(a.qty, 1), who = who_(a.who), fp = text(a.fp, 200) || null;
  if (fp) { const dup = await findByFp(env, fp); if (dup) return { dup }; }
  const compId = await ensureComp(env, rec, a);
  let r;
  try {
    r = await env.DB.prepare('INSERT INTO packet (comp, box, qty, fp, lot, dc, made, upd, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(compId, a.box ? +a.box : null, qty, fp, text(a.lot, 40) || null, text(a.dc, 20) || null, now(), now(), who).run();
  } catch (e) {
    if (/UNIQUE/i.test(e.message) && fp) return { dup: await findByFp(env, fp) };   // two phones added the same label at once
    throw e;
  }
  await log(env, compId, r.meta.last_row_id, KIND.add, qty, qty, who, null);
  return Object.assign({ packetId: r.meta.last_row_id }, await compView(env, compId));
}

/** One quantity or place change on a packet. mode: add (+qty), take (-qty), set (absolute count), move (box). */
export async function packetTxn(env, a) {
  const id = +a.packet, who = who_(a.who), note = text(a.note, 120) || null;
  const p = await env.DB.prepare('SELECT id, comp, qty, st, box FROM packet WHERE id = ?').bind(id).first();
  if (!p || p.st === 2) throw new Refuse('That packet no longer exists.');
  const t = now();
  if (a.mode === 'move') {
    const box = a.box ? +a.box : null;
    await env.DB.prepare('UPDATE packet SET box = ?, upd = ?, by = ? WHERE id = ?').bind(box, t, who, id).run();
    await log(env, p.comp, id, KIND.move, 0, p.qty, who, 'box ' + (p.box || '-') + ' to ' + (box || '-'));
  } else if (a.mode === 'take') {
    const n = qtyOf(a.qty, 1);
    if (env.REQUIRE_REASON === '1' && !note) throw new Refuse('Say what the parts are for.');
    const r = await env.DB.prepare('UPDATE packet SET qty = qty - ?1, st = CASE WHEN qty - ?1 = 0 THEN 1 ELSE 0 END, upd = ?2, by = ?3 WHERE id = ?4 AND st = 0 AND qty >= ?1').bind(n, t, who, id).run();
    if (!r.meta.changes) throw new Refuse(p.st ? 'That packet is empty.' : 'Only ' + p.qty + ' left in that packet.');
    await log(env, p.comp, id, KIND.take, -n, p.qty - n, who, note);
  } else if (a.mode === 'add' || a.mode === 'set') {
    const n = qtyOf(a.qty, a.mode === 'add' ? 1 : 0), after = a.mode === 'add' ? p.qty + n : n;
    if (after > 10000000) throw new Refuse('Quantity too large.');
    await env.DB.prepare('UPDATE packet SET qty = ?, st = ?, upd = ?, by = ? WHERE id = ?').bind(after, after ? 0 : 1, t, who, id).run();
    await log(env, p.comp, id, a.mode === 'add' ? KIND.add : KIND.correct, after - p.qty, after, who, note);
  } else throw new Refuse('Unknown change.');
  return compView(env, p.comp);
}

/** Cycle count: [{packet, counted}]. Differences are logged as audit corrections; every counted packet gets its audit time. */
export async function audit(env, a) {
  const who = who_(a.who), items = (a.items || []).slice(0, 500), comps = new Set();
  for (const it of items) {
    const p = await env.DB.prepare('SELECT id, comp, qty, st FROM packet WHERE id = ?').bind(+it.packet).first();
    if (!p || p.st === 2) continue;
    const n = qtyOf(it.counted, 0), t = now();
    await env.DB.prepare('UPDATE packet SET qty = ?, st = ?, upd = ?, aud = ?, by = ? WHERE id = ?').bind(n, n ? 0 : 1, t, t, who, p.id).run();
    if (n !== p.qty || p.st) await log(env, p.comp, p.id, KIND.audit, n - p.qty, n, who, 'cycle count');
    comps.add(p.comp);
  }
  return { comps: await Promise.all([...comps].map(c => compView(env, c))) };
}

async function setCategory(env, compId, cat) {
  const c = await env.DB.prepare('SELECT id FROM cat WHERE id = ?').bind(cat).first();
  if (!c) throw new Refuse('Unknown category.');
  const comp = await env.DB.prepare('SELECT path, src FROM comp WHERE id = ?').bind(compId).first();
  await env.DB.prepare('UPDATE comp SET cat = ? WHERE id = ?').bind(cat, compId).run();
  if (comp && comp.path) await env.DB.prepare('INSERT OR REPLACE INTO catmap (src, path, cat) VALUES (?, ?, ?)').bind(comp.src, comp.path, cat).run();   // the next new part from that supplier category lands here
}
/** Override description and/or category of one part (logged). */
export async function editComp(env, a) {
  const id = +a.comp, who = who_(a.who), comp = await env.DB.prepare('SELECT id, descr FROM comp WHERE id = ?').bind(id).first();
  if (!comp) throw new Refuse('Unknown part.');
  if (a.descr != null) {
    const d = text(a.descr, 200);
    if (!d) throw new Refuse('The description cannot be empty.');
    if (d !== comp.descr) { await env.DB.prepare('UPDATE comp SET descr = ?, edited = 1 WHERE id = ?').bind(d, id).run(); await log(env, id, null, KIND.edit, 0, null, who, 'description'); }
  }
  if (a.cat != null) { await setCategory(env, id, +a.cat); await log(env, id, null, KIND.edit, 0, null, who, 'category ' + (+a.cat)); }
  return compView(env, id);
}
export async function addBox(env, name) {
  const n = text(name, 30);
  if (!n) throw new Refuse('Give the box a name.');
  await env.DB.prepare('INSERT OR IGNORE INTO box (name) VALUES (?)').bind(n).run();
  return env.DB.prepare('SELECT id, name FROM box WHERE name = ?').bind(n).first();
}
export async function addCategory(env, a) {
  const n = text(a.name, 40), parent = a.parent ? +a.parent : null;
  if (!n) throw new Refuse('Give the category a name.');
  if (parent && !(await env.DB.prepare('SELECT id FROM cat WHERE id = ? AND parent IS NULL').bind(parent).first())) throw new Refuse('Unknown parent category.');
  const dup = await env.DB.prepare('SELECT id FROM cat WHERE name = ? AND parent IS ?').bind(n, parent).first();
  if (dup) return dup;
  const r = await env.DB.prepare('INSERT INTO cat (id, parent, name) VALUES ((SELECT MAX(10000, MAX(id) + 1) FROM cat), ?, ?)').bind(parent, n).run();
  return { id: r.meta.last_row_id };
}
export async function history(env, compId) {
  const r = await env.DB.prepare('SELECT packet, kind, delta, after, by, ts, note FROM txn WHERE comp = ? ORDER BY id DESC LIMIT 100').bind(+compId).all();
  return r.results.map(x => Object.assign(x, { kind: KIND_NAME[x.kind] }));
}
