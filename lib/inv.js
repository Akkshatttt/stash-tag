// Inventory on D1: parts (comp) grouped (grp), physical packets with their own qty and box, and a transaction log. Used by functions/api.js.
// Rules: a packet label seen before (same fingerprint) is never added twice; stock never goes negative; an emptied packet is archived, not deleted,
// so its fingerprint stays blocked; every change is logged with who made it; a packet needs a box and a part needs its critical fields before it is added.
// D1 has no interactive transactions: guarded UPDATEs and batches stand in.
import { normPn, describeRec_, describePassive_, specText_, parseValue_, pkgOf_ } from './shared.js';
import { MIGRATIONS, categoryFor, isPassiveTop, topOf, UNSORTED } from './schema.js';

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
    await env.DB.batch(MIGRATIONS[i].map(([sql, args]) => env.DB.prepare(sql).bind(...(args || []))));
    if (MIGRATIONS[i].after) await MIGRATIONS[i].after(env);   // data work after the statements; both are safe to run twice if a crash lands between them and the version
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").bind(String(i + 1)).run();
  }
  migrated = true;
}

// ---- chip passives: kind, secondary parameters, description, group ----------------------------------------------------------------------------------
const passiveKind = cat => { const t = topOf(cat); return t === 100 ? 'R' : t === 200 ? 'C' : cat === 301 ? 'L' : ''; };
const SP_KEYS = ['diel', 'volt', 'pow', 'cur', 'tol'];
const KIND_CATEGORY = { R: 'Resistors', C: 'Capacitors', L: 'Inductors' };
/** "X7R 50V 1/10W 1%" -> {diel, volt, pow, cur, tol}, for parts stored before the parameters were kept separately. */
function parseSpec(spec) {
  const s = String(spec || ''), m = re => (re.exec(s) || [])[0] || '';
  return { diel: m(/\b(?:X7R|X5R|X6S|X7S|X7T|C0G|Y5V|Z5U)\b/), volt: m(/\b\d+(?:\.\d+)?V\b/), pow: m(/\b\d+\/\d+W\b|\b\d*\.?\d+W\b/), cur: m(/\b\d+(?:\.\d+)?m?A\b/), tol: m(/\b\d+(?:\.\d+)?%/) };
}
export function describe(rec) { return text(describeRec_(rec), 200); }
function groupLabel(rec) {
  const m = /^([RCL])\|([^|]*)\|(.*)$/.exec(rec.groupKey || '');
  return m ? text([{ R: 'Resistor', C: 'Capacitor', L: 'Inductor' }[m[1]], m[2], m[3]].filter(Boolean).join(' '), 80) : text(rec.mpn, 80);
}
/** What a typed fix changes: {value, package, sp} from the current values and a {value, package, tol, pow, volt, diel, cur} object. Malformed input is refused. */
function normFix(kind, fix, base) {
  const out = { value: base.value, package: base.package, sp: Object.assign({}, base.sp) }, f = fix || {}, filled = k => f[k] != null && String(f[k]).trim() !== '';
  if (filled('value')) {
    const s = text(f.value, 20), v = parseValue_(s, kind, true) || parseValue_(s + { R: 'R', C: 'F', L: 'H' }[kind], kind, true);
    if (!v) throw new Refuse('Value "' + s + '" is not understood. Write it like ' + { R: '2.2k', C: '100nF', L: '4.7uH' }[kind] + '.');
    out.value = v;
  }
  if (filled('package')) { out.package = pkgOf_(String(f.package)) || text(String(f.package), 20).replace(/[|]/g, '/'); }   // a standard case size, or whatever the maker calls it (inductors rarely have a standard one)
  SP_KEYS.forEach(k => { if (filled(k)) out.sp[k] = text(f[k], 12); });
  return out;
}
/** A new part's record with the person's fixes applied (passives only: value, package, secondary parameters), group key and spec recomputed. */
function applyFix(rec, fix, cat) {
  const kind = passiveKind(cat), r = Object.assign({}, rec, { sp: Object.assign({}, rec.sp || {}) });
  if (!kind) return r;
  const n = normFix(kind, fix, { value: rec.value || '', package: rec.package || '', sp: r.sp });
  r.fixed = n.value !== (rec.value || '') || n.package !== (rec.package || '') || SP_KEYS.some(k => (n.sp[k] || '') !== ((rec.sp || {})[k] || ''));
  Object.assign(r, { value: n.value, package: n.package, sp: n.sp, spec: specText_(n.sp), category: KIND_CATEGORY[kind] });
  r.groupKey = n.value && n.package ? kind + '|' + n.value + '|' + n.package : 'P|' + normPn(r.mpn);
  return r;
}
/** A request id the page makes for each click: the same one twice is refused, so a repeated or replayed request cannot add or take twice. */
async function once(env, rid) {
  if (!rid) return;
  const r = await env.DB.prepare('INSERT OR IGNORE INTO rid (rid, ts) VALUES (?, ?)').bind(text(rid, 40), now()).run();
  if (!r.meta.changes) throw new Refuse('Already done: that request was received twice.');
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rid WHERE ts < ?').bind(now() - 86400).run();
}

// ---- reading -------------------------------------------------------------------------------------------------------------------------------------
const SELECT = `SELECT g.id gid, g.gkey, g.label, g.cat gcat, c.id cid, c.mpn, c.mfr, c.dkpn, c.mopn, c.descr, c.spec, c.sp, c.src, c.cat ccat, c.ds, c.last_by, c.last_ts,
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
      c = ci[r.cid] = { id: r.cid, mpn: r.mpn, mfr: r.mfr || '', dkpn: r.dkpn || '', mopn: r.mopn || '', descr: r.descr || '', spec: r.spec || '', sp: r.sp ? JSON.parse(r.sp) : parseSpec(r.spec),
        src: r.src, cat: r.ccat || r.gcat, ds: r.ds || '', by: r.last_by || '', ts: r.last_ts || 0, packets: [] };
      g.comps.push(c);
    }
    if (r.pid) c.packets.push({ id: r.pid, qty: r.qty, box: r.box, lot: r.lot || '', dc: r.dc || '', made: r.made, upd: r.upd, by: r.by || '' });
  }
  return groups;
}

export async function loadAll(env) {
  const [rows, cats, boxes] = await Promise.all([
    env.DB.prepare(SELECT + ' ORDER BY g.id, c.id, p.id').all(), env.DB.prepare("SELECT id, parent, name FROM cat ORDER BY COALESCE(parent, id), parent IS NOT NULL, name LIKE 'Other%', name").all(), env.DB.prepare('SELECT id, name FROM box ORDER BY name').all()]);
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
/** The category a new part of this supplier category would get: a learned override first, then the rules. */
export async function suggestCat(env, rec) {
  const path = text(rec.categoryPath, 300), learned = path && await env.DB.prepare('SELECT cat FROM catmap WHERE src = ? AND path = ?').bind(srcOf(rec.supplier), path).first();
  return learned ? learned.cat : categoryFor({ path, descr: rec.description, value: rec.value, spec: rec.spec });
}
export async function findComp(env, rec) {
  const k = normPn(rec && rec.mpn);
  const c = k && await env.DB.prepare('SELECT id FROM comp WHERE mkey = ?').bind(k).first();
  return c ? compView(env, c.id) : null;
}

// ---- writing -------------------------------------------------------------------------------------------------------------------------------------
async function learn(env, src, path, cat) {   // the next new part from that supplier category lands here (not for resistors and capacitors: one supplier category holds several types)
  if (path && !isPassiveTop(cat)) await env.DB.prepare('INSERT OR REPLACE INTO catmap (src, path, cat) VALUES (?, ?, ?)').bind(src, path, cat).run();
}
async function insertComp(env, rec, cat, sug, descr) {
  const mkey = normPn(rec.mpn), src = srcOf(rec.supplier), path = text(rec.categoryPath, 300), gkey = rec.groupKey || 'P|' + mkey;
  await env.DB.prepare('INSERT OR IGNORE INTO grp (gkey, cat, label) VALUES (?, ?, ?)').bind(gkey, cat, groupLabel(rec)).run();
  const g = await env.DB.prepare('SELECT id, cat FROM grp WHERE gkey = ?').bind(gkey).first(), auto = describe(rec), typed = descr && descr !== auto;
  const r = await env.DB.prepare('INSERT INTO comp (grp, mkey, mpn, mfr, dkpn, mopn, descr, edited, cat, path, spec, sp, src, ds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(g.id, mkey, text(rec.mpn, 80), text(rec.manufacturer, 80), text(rec.dkPn, 80), text(rec.mouserPn, 80), descr || auto, typed ? 1 : 0, g.cat !== cat ? cat : null, path,
      text(rec.spec, 80), JSON.stringify(rec.sp || {}), src, text(rec.datasheet, 300)).run();
  if (cat !== sug) await learn(env, src, path, cat);
  return r.meta.last_row_id;
}

async function log(env, compId, packetId, kind, delta, after, who, note) {
  await env.DB.prepare('INSERT INTO txn (comp, packet, kind, delta, after, by, ts, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(compId, packetId, kind, delta, after, who, now(), note || null).run();
  if (kind !== KIND.edit) await env.DB.prepare('UPDATE comp SET last_by = ?, last_ts = ? WHERE id = ?').bind(who, now(), compId).run();
}
const qtyOf = (v, min) => { const n = Math.floor(+v); if (!(n >= min && n <= 10000000)) throw new Refuse('Quantity must be a whole number' + (min ? ' of at least ' + min : '') + '.'); return n; };
const who_ = v => text(v, 40) || 'unknown';
const boxOk = async (env, id) => !!(id && await env.DB.prepare('SELECT id FROM box WHERE id = ?').bind(+id).first());

/** Adds a new packet. A fingerprint already in the database is not added: {dup} (the existing packet and its part) comes back instead. A box is required; a
 *  new part also needs a description, a category other than Unsorted and, for a chip passive, value and package (a.fix fills or corrects them). */
export async function addPacket(env, a) {
  const rec0 = a.rec || {}, qty = qtyOf(a.qty, 1), who = who_(a.who), fp = text(a.fp, 200) || null, mkey = normPn(rec0.mpn);
  if (fp) { const dup = await findByFp(env, fp); if (dup) return { dup }; }
  if (!mkey) throw new Refuse('This part has no part number.');
  const known = await env.DB.prepare('SELECT id FROM comp WHERE mkey = ?').bind(mkey).first(), miss = [];
  if (!(await boxOk(env, a.box))) miss.push('box');
  let rec = rec0, cat = 0, sug = 0, descr = text(a.descr, 200);
  if (!known) {
    sug = await suggestCat(env, rec0); cat = +a.cat || sug;
    if (cat === UNSORTED || !(await env.DB.prepare('SELECT id FROM cat WHERE id = ?').bind(cat).first())) miss.push('category');
    rec = applyFix(rec0, a.fix, cat);
    if (passiveKind(cat)) { if (!rec.value) miss.push('value'); if (!rec.package) miss.push('package'); }
    if (!(descr || describe(rec))) miss.push('description');
  }
  if (miss.length) throw new Refuse('Fill in first: ' + miss.join(', ') + '.');
  await once(env, a.rid);
  let compId;
  if (known) {   // known part: only fill supplier numbers it did not have yet
    compId = known.id;
    await env.DB.prepare("UPDATE comp SET dkpn = CASE WHEN dkpn IS NULL OR dkpn = '' THEN ? ELSE dkpn END, mopn = CASE WHEN mopn IS NULL OR mopn = '' THEN ? ELSE mopn END WHERE id = ?").bind(rec.dkPn || '', rec.mouserPn || '', compId).run();
  } else compId = await insertComp(env, rec, cat, sug, descr);
  let r;
  try {
    r = await env.DB.prepare('INSERT INTO packet (comp, box, qty, fp, lot, dc, made, upd, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(compId, +a.box, qty, fp, text(a.lot, 40) || null, text(a.dc, 20) || null, now(), now(), who).run();
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
    if (!(await boxOk(env, a.box))) throw new Refuse('Choose a box.');
    await once(env, a.rid);
    await env.DB.prepare('UPDATE packet SET box = ?, upd = ?, by = ? WHERE id = ?').bind(+a.box, t, who, id).run();
    await log(env, p.comp, id, KIND.move, 0, p.qty, who, 'box ' + (p.box || '-') + ' to ' + (+a.box));
  } else if (a.mode === 'take') {
    const n = qtyOf(a.qty, 1);
    if (env.REQUIRE_REASON === '1' && !note) throw new Refuse('Say what the parts are for.');
    await once(env, a.rid);
    const r = await env.DB.prepare('UPDATE packet SET qty = qty - ?1, st = CASE WHEN qty - ?1 = 0 THEN 1 ELSE 0 END, upd = ?2, by = ?3 WHERE id = ?4 AND st = 0 AND qty >= ?1').bind(n, t, who, id).run();
    if (!r.meta.changes) throw new Refuse(p.st ? 'That packet is empty.' : 'Only ' + p.qty + ' left in that packet.');
    await log(env, p.comp, id, KIND.take, -n, p.qty - n, who, note);
  } else if (a.mode === 'add' || a.mode === 'set') {
    const n = qtyOf(a.qty, a.mode === 'add' ? 1 : 0), after = a.mode === 'add' ? p.qty + n : n;
    if (after > 10000000) throw new Refuse('Quantity too large.');
    await once(env, a.rid);
    await env.DB.prepare('UPDATE packet SET qty = ?, st = ?, upd = ?, by = ? WHERE id = ?').bind(after, after ? 0 : 1, t, who, id).run();
    await log(env, p.comp, id, a.mode === 'add' ? KIND.add : KIND.correct, after - p.qty, after, who, note);
  } else throw new Refuse('Unknown change.');
  return compView(env, p.comp);
}

/** Cycle count: [{packet, counted}]. Differences are logged as audit corrections; every counted packet gets its audit time. */
export async function audit(env, a) {
  const who = who_(a.who), items = (a.items || []).slice(0, 500), comps = new Set();
  for (const it of items) qtyOf(it.counted, 0);   // refuse bad input before anything is written
  await once(env, a.rid);
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
  const comp = await env.DB.prepare('SELECT path, src FROM comp WHERE id = ?').bind(compId).first();
  await env.DB.prepare('UPDATE comp SET cat = ? WHERE id = ?').bind(cat, compId).run();
  if (comp) await learn(env, comp.src, comp.path, cat);
}
/** Override a part's description, category and, for a chip passive, value / package / secondary parameters (a.fix; the part moves to the matching group). Logged. */
export async function editComp(env, a) {
  const id = +a.comp, who = who_(a.who);
  const comp = await env.DB.prepare('SELECT c.id, c.mpn, c.descr, c.edited, c.spec, c.sp, c.cat, c.grp, g.gkey, g.cat gcat FROM comp c JOIN grp g ON g.id = c.grp WHERE c.id = ?').bind(id).first();
  if (!comp) throw new Refuse('Unknown part.');
  const newCat = a.cat != null ? +a.cat : null;
  if (newCat != null && !(await env.DB.prepare('SELECT id FROM cat WHERE id = ?').bind(newCat).first())) throw new Refuse('Unknown category.');
  const d = a.descr != null ? text(a.descr, 200) : null;
  if (d === '') throw new Refuse('The description cannot be empty.');
  const kind = passiveKind(newCat != null ? newCat : comp.cat || comp.gcat), m = /^([RCL])\|([^|]*)\|(.*)$/.exec(comp.gkey);
  let fix = null;
  if (a.fix && kind) {
    const base = { value: m ? m[2] : '', package: m ? m[3] : '', sp: comp.sp ? JSON.parse(comp.sp) : parseSpec(comp.spec) }, n = normFix(kind, a.fix, base);
    if (!n.value || !n.package) throw new Refuse('A chip part needs its value and package.');
    if (n.value !== base.value || n.package !== base.package || specText_(n.sp) !== specText_(base.sp)) fix = { n, gkey: kind + '|' + n.value + '|' + n.package };
  }
  await once(env, a.rid);
  if (fix) {
    await env.DB.prepare('INSERT OR IGNORE INTO grp (gkey, cat, label) VALUES (?, ?, ?)').bind(fix.gkey, comp.gcat, groupLabel({ groupKey: fix.gkey })).run();
    const g = await env.DB.prepare('SELECT id FROM grp WHERE gkey = ?').bind(fix.gkey).first();
    await env.DB.prepare('UPDATE comp SET grp = ?, spec = ?, sp = ? WHERE id = ?').bind(g.id, specText_(fix.n.sp), JSON.stringify(fix.n.sp), id).run();
    if (!comp.edited && d == null) await env.DB.prepare('UPDATE comp SET descr = ? WHERE id = ?').bind(text(describePassive_(kind, fix.n.value, fix.n.package, fix.n.sp), 200), id).run();
    if (g.id !== comp.grp) await env.DB.prepare('DELETE FROM grp WHERE id = ? AND NOT EXISTS (SELECT 1 FROM comp WHERE grp = ?)').bind(comp.grp, comp.grp).run();
    await log(env, id, null, KIND.edit, 0, null, who, 'value/package/specs: ' + comp.gkey + ' to ' + fix.gkey);
  }
  if (d != null && d !== comp.descr) { await env.DB.prepare('UPDATE comp SET descr = ?, edited = 1 WHERE id = ?').bind(d, id).run(); await log(env, id, null, KIND.edit, 0, null, who, 'description'); }
  if (newCat != null) { await setCategory(env, id, newCat); await log(env, id, null, KIND.edit, 0, null, who, 'category ' + newCat); }
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
