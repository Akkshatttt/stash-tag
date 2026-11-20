// D1 schema for the inventory. Small integers instead of text for anything with a few values:
//   src: 0 other, 1 digikey, 2 mouser | packet.st: 0 live, 1 empty (archived), 2 removed | txn.kind: see KIND in inv.js.
// Times are unix seconds. Text lives once (description on comp, not on packets). `parts` (the supplier record cache, see functions/api.js) is a different table.
// Migrations are appended to MIGRATIONS and never edited; meta.schema holds how many ran. A migration may carry an `after(env)` step (data work SQL cannot do).

// The category list as seeded by migration 1 (positional ids: top = (i+1)*100, sub = top + j + 1). Frozen: later changes are migrations.
const TAXONOMY_V1 = [
  ['Resistors', ['Chip', 'Through Hole', 'Networks', 'Potentiometers', 'Other']],
  ['Capacitors', ['Ceramic', 'Electrolytic', 'Tantalum', 'Film', 'Other']],
  ['Inductors & Ferrites', ['Inductors', 'Ferrite Beads', 'Transformers']],
  ['Diodes', ['Rectifiers & Schottky', 'Zener', 'TVS & ESD', 'Other']],
  ['Transistors', ['MOSFET', 'BJT', 'Other']],
  ['ICs', ['Power Management', 'Interface & Transceivers', 'Microcontrollers & Processors', 'Amplifiers & Analog', 'Memory', 'Logic', 'Other ICs']],
  ['Connectors', ['Headers & Sockets', 'USB', 'Terminal Blocks', 'FFC / FPC', 'RF & Coax', 'Other']],
  ['Crystals & Oscillators', []],
  ['Switches & Relays', []],
  ['LEDs & Optoelectronics', []],
  ['Sensors', []],
  ['Modules & Boards', []],
  ['Hardware & Cables', []],
  ['Unsorted', []]
];

// The category list as it is now: [id, parent, name]. Resistors and capacitors are split by type (nearly all of them are chip parts, so "chip" says nothing);
// package stays a filter inside the group. Ids of kept entries never change.
export const CATS = [
  [100, null, 'Resistors'], [106, 100, 'General Purpose'], [107, 100, 'Precision'], [108, 100, 'Current Sense'], [109, 100, 'Zero-Ohm Jumpers'], [103, 100, 'Arrays & Networks'],
  [104, 100, 'Potentiometers & Trimmers'], [110, 100, 'High Power / Wirewound'], [105, 100, 'Other'],
  [200, null, 'Capacitors'], [201, 200, 'MLCC'], [202, 200, 'Aluminum Electrolytic'], [203, 200, 'Tantalum & Polymer'], [204, 200, 'Film'], [206, 200, 'Supercapacitors'],
  [207, 200, 'Trimmer / Variable'], [205, 200, 'Other']
].concat(TAXONOMY_V1.slice(2).reduce((a, [top, subs], i) => {
  const id = (i + 3) * 100;
  a.push([id, null, top]);
  subs.forEach((s, j) => a.push([id + j + 1, id, s]));
  return a;
}, []));

/** Taxonomy id of a top (and optional sub) category name; Unsorted if unknown. */
export const UNSORTED = 1400;
export function catId(top, sub) {
  const t = CATS.find(c => !c[1] && c[2] === top);
  if (!t) return UNSORTED;
  const s = sub && CATS.find(c => c[1] === t[0] && c[2] === sub);
  return s ? s[0] : t[0];
}
export const topOf = id => (CATS.find(c => c[0] === id) || [])[1] || id;
export const isPassiveTop = id => { const t = topOf(id); return t === 100 || t === 200; };

/** Supplier category text -> top category (and a sub where the text alone settles it); first match wins. No match = Unsorted (never "Misc").
 *  Resistors and capacitors get their sub-category from categoryFor(), which also reads the description and the value. */
export const RULES = [
  [/modules?\b|evaluation|development board|eval board/i, 'Modules & Boards'],
  [/\bled\b|led indicat|optoelectronic|displays?\b|photo|opto/i, 'LEDs & Optoelectronics'],
  [/crystal|oscillator|resonator/i, 'Crystals & Oscillators'],
  [/switch|relay|pushbutton/i, 'Switches & Relays'],
  [/sensor|transducer/i, 'Sensors'],
  [/resistor|potentiometer|rheostat/i, 'Resistors'],
  [/capacitor|ceramic|mlcc|tantalum|electrolytic|supercap|edlc/i, 'Capacitors'],
  [/ferrite/i, 'Inductors & Ferrites', 'Ferrite Beads'], [/transformer/i, 'Inductors & Ferrites', 'Transformers'],
  [/inductor|choke|coil/i, 'Inductors & Ferrites', 'Inductors'],
  [/tvs|esd/i, 'Diodes', 'TVS & ESD'], [/zener/i, 'Diodes', 'Zener'], [/rectifier|schottky/i, 'Diodes', 'Rectifiers & Schottky'], [/diode/i, 'Diodes', 'Other'],
  [/mosfet|fet\b/i, 'Transistors', 'MOSFET'], [/bipolar|bjt/i, 'Transistors', 'BJT'], [/transistor|igbt/i, 'Transistors', 'Other'],
  [/usb/i, 'Connectors', 'USB'], [/terminal block/i, 'Connectors', 'Terminal Blocks'], [/ffc|fpc/i, 'Connectors', 'FFC / FPC'],
  [/coax|\brf\b.*connector|connector.*\brf\b/i, 'Connectors', 'RF & Coax'], [/header|socket|receptacle|pin strip/i, 'Connectors', 'Headers & Sockets'], [/connector/i, 'Connectors', 'Other'],
  [/microcontroller|\bmcu\b|processor|fpga|embedded|\bsoc\b/i, 'ICs', 'Microcontrollers & Processors'],
  [/power management|pmic|regulator|converter|\bldo\b|voltage reference|battery (charg|manage)|gate driver|motor driver|load switch|supervisor|power switch/i, 'ICs', 'Power Management'],
  [/interface|transceiver|rs-?485|rs-?232|\bcan\b|\blin\b|\buart\b|ethernet|isolator|i2c|serial/i, 'ICs', 'Interface & Transceivers'],
  [/amplifier|comparator|\badc\b|\bdac\b|analog|data acquisition|op amp/i, 'ICs', 'Amplifiers & Analog'],
  [/memory|eeprom|flash|sram|dram/i, 'ICs', 'Memory'], [/logic|gate|buffer|inverter|latch|flip.?flop|shift register/i, 'ICs', 'Logic'],
  [/integrated circuit|\bics?\b/i, 'ICs', 'Other ICs'],
  [/cable|wire|hardware|fastener|spacer|standoff|enclosure|heat ?sink|\bfan\b/i, 'Hardware & Cables']
];
export function catFromPath(path) {
  const t = String(path || '');
  for (const r of RULES) if (r[0].test(t)) return catId(r[1], r[2]);
  return UNSORTED;
}
/** The category a part belongs in: o = {path (supplier category text), descr, value ('2.2k'), spec ('1/10W 1%')}. Passives are split by type using all four. */
export function categoryFor(o) {
  const base = catFromPath(o.path), t = (String(o.path || '') + ' ' + String(o.descr || '')).toLowerCase();
  if (topOf(base) === 100) {
    const tol = parseFloat((/(\d+(?:\.\d+)?)\s*%/.exec(o.spec || '') || [])[1]);
    if (/network|array|rnet/.test(t)) return 103;
    if (/potentiometer|trimmer|rheostat|variable/.test(t)) return 104;
    if (/current sense|shunt|sense resistor/.test(t)) return 108;
    if (String(o.value) === '0' || /jumper|zero.?ohm|\b0 ?ohm/.test(t)) return 109;
    if (/wirewound|chassis|power resistor|metal oxide|high power|power film/.test(t)) return 110;
    if (/thin film|metal foil|precision/.test(t) || tol <= 0.1) return 107;
    return 106;
  }
  if (topOf(base) === 200) {
    if (/supercap|edlc|double layer|ultracap/.test(t)) return 206;
    if (/trimmer|variable|tuning/.test(t)) return 207;
    if (/tantalum|polymer|niobium/.test(t)) return 203;
    if (/aluminum|aluminium|electrolytic/.test(t)) return 202;
    if (/film|polypropylene|polyester/.test(t)) return 204;
    if (/ceramic|mlcc|cap cer|c0g|x7r|x5r|np0/.test(t)) return 201;
    return 205;
  }
  return base;
}

const seed = [];
TAXONOMY_V1.forEach(([top, subs], i) => {
  seed.push(['INSERT OR IGNORE INTO cat (id, parent, name) VALUES (?, NULL, ?)', [(i + 1) * 100, top]]);
  subs.forEach((s, j) => seed.push(['INSERT OR IGNORE INTO cat (id, parent, name) VALUES (?, ?, ?)', [(i + 1) * 100 + j + 1, (i + 1) * 100, s]]));
});

const M1 = [
  ['CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'],
  ['CREATE TABLE IF NOT EXISTS cat (id INTEGER PRIMARY KEY, parent INTEGER, name TEXT NOT NULL)'],
  ['CREATE TABLE IF NOT EXISTS catmap (src INTEGER NOT NULL, path TEXT NOT NULL, cat INTEGER NOT NULL, PRIMARY KEY (src, path))'],
  ['CREATE TABLE IF NOT EXISTS grp (id INTEGER PRIMARY KEY, gkey TEXT NOT NULL UNIQUE, cat INTEGER NOT NULL, label TEXT NOT NULL)'],
  // comp = one manufacturer part number. cat NULL = the group's category; path = the supplier's category text (for learning overrides).
  ['CREATE TABLE IF NOT EXISTS comp (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, mkey TEXT NOT NULL UNIQUE, mpn TEXT NOT NULL, mfr TEXT, dkpn TEXT, mopn TEXT, descr TEXT, edited INTEGER NOT NULL DEFAULT 0, cat INTEGER, path TEXT, spec TEXT, src INTEGER NOT NULL DEFAULT 0, ds TEXT, last_by TEXT, last_ts INTEGER)'],
  ['CREATE INDEX IF NOT EXISTS comp_grp ON comp (grp)'],
  ['CREATE TABLE IF NOT EXISTS box (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)'],
  // fp NULL = no order data on the label (typed part, old label): such a packet cannot be recognised again. UNIQUE allows many NULLs.
  ['CREATE TABLE IF NOT EXISTS packet (id INTEGER PRIMARY KEY, comp INTEGER NOT NULL, box INTEGER, qty INTEGER NOT NULL, fp TEXT UNIQUE, st INTEGER NOT NULL DEFAULT 0, lot TEXT, dc TEXT, made INTEGER NOT NULL, upd INTEGER NOT NULL, by TEXT, aud INTEGER)'],
  ['CREATE INDEX IF NOT EXISTS packet_comp ON packet (comp, st)'],
  ['CREATE TABLE IF NOT EXISTS txn (id INTEGER PRIMARY KEY, comp INTEGER NOT NULL, packet INTEGER, kind INTEGER NOT NULL, delta INTEGER NOT NULL DEFAULT 0, after INTEGER, by TEXT, ts INTEGER NOT NULL, note TEXT)'],
  ['CREATE INDEX IF NOT EXISTS txn_comp ON txn (comp, ts)']
].concat(seed);

// Migration 2 (v0.10.0): resistors and capacitors split by type instead of chip / through hole; request ids for the double-tap guard.
const M2 = [
  ['UPDATE cat SET name = ? WHERE id = ?', ['Arrays & Networks', 103]], ['UPDATE cat SET name = ? WHERE id = ?', ['Potentiometers & Trimmers', 104]],
  ['UPDATE cat SET name = ? WHERE id = ?', ['MLCC', 201]], ['UPDATE cat SET name = ? WHERE id = ?', ['Aluminum Electrolytic', 202]], ['UPDATE cat SET name = ? WHERE id = ?', ['Tantalum & Polymer', 203]]
].concat(CATS.filter(c => [106, 107, 108, 109, 110, 206, 207].includes(c[0])).map(c => ['INSERT OR IGNORE INTO cat (id, parent, name) VALUES (?, ?, ?)', c]),
  [['CREATE TABLE IF NOT EXISTS rid (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL)'],
   // what the supplier category used to teach was too coarse for passives (one path holds general and precision parts): forget it
   ['DELETE FROM catmap WHERE cat BETWEEN 100 AND 299']]);
/** Re-file what the old Chip / Through Hole sub-categories held, then drop them. Hand overrides that pointed there move to General Purpose. Idempotent. */
M2.after = async env => {
  try { await env.DB.prepare('ALTER TABLE comp ADD COLUMN sp TEXT').run(); } catch (e) { /* already there (a rerun) */ }   // secondary parameters as JSON; older rows are read from the spec text
  const rows = (await env.DB.prepare('SELECT g.id gid, g.gkey, c.path, c.descr, c.spec FROM grp g JOIN comp c ON c.grp = g.id WHERE g.cat IN (101, 102) GROUP BY g.id').all()).results;
  const st = rows.map(r => env.DB.prepare('UPDATE grp SET cat = ? WHERE id = ?').bind(categoryFor({ path: r.path, descr: r.descr, spec: r.spec, value: (r.gkey.split('|')[1] || '') }), r.gid));
  st.push(env.DB.prepare('UPDATE grp SET cat = 106 WHERE cat IN (101, 102)'), env.DB.prepare('UPDATE comp SET cat = 106 WHERE cat IN (101, 102)'),
    env.DB.prepare('DELETE FROM cat WHERE id IN (101, 102)'));
  await env.DB.batch(st);
};

export const MIGRATIONS = [M1, M2];
