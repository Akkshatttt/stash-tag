// D1 schema for the inventory (v1). Small integers instead of text for anything with a few values:
//   src: 0 other, 1 digikey, 2 mouser | packet.st: 0 live, 1 empty (archived), 2 removed | txn.kind: see KIND in inv.js.
// Times are unix seconds. Text lives once (description on comp, not on packets). `parts` (the supplier record cache, see functions/api.js) is a different table.
// Migrations are appended to MIGRATIONS and never edited; meta.schema holds how many ran.

// Category taxonomy: [top, [subs]]. Ids are positional (top = (i+1)*100, sub = top + j + 1), so a seed is reproducible and a new sub is only ever appended.
export const TAXONOMY = [
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

/** Supplier category text -> [top, sub]; first match wins. No match = Unsorted (never "Misc"). Learned overrides (catmap) are tried before these. */
export const RULES = [
  [/modules?\b|evaluation|development board|eval board/i, 'Modules & Boards'],
  [/\bled\b|led indicat|optoelectronic|displays?\b|photo|opto/i, 'LEDs & Optoelectronics'],
  [/crystal|oscillator|resonator/i, 'Crystals & Oscillators'],
  [/switch|relay|pushbutton/i, 'Switches & Relays'],
  [/sensor|transducer/i, 'Sensors'],
  [/networks?.*resistor|resistor.*(network|array)/i, 'Resistors', 'Networks'],
  [/potentiometer|trimmer|variable resistor/i, 'Resistors', 'Potentiometers'],
  [/through.?hole.*resistor|resistors?.*through/i, 'Resistors', 'Through Hole'],
  [/chip resistor|resistors?.*(smd|smt)|thick film|thin film/i, 'Resistors', 'Chip'],
  [/resistor/i, 'Resistors', 'Other'],
  [/ceramic|mlcc/i, 'Capacitors', 'Ceramic'], [/aluminum|electrolytic/i, 'Capacitors', 'Electrolytic'],
  [/tantalum|polymer/i, 'Capacitors', 'Tantalum'], [/film/i, 'Capacitors', 'Film'], [/capacitor/i, 'Capacitors', 'Other'],
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

export const UNSORTED = 1400;
/** Taxonomy id of a top (and optional sub) category name; Unsorted if unknown. */
export function catId(top, sub) {
  const i = TAXONOMY.findIndex(t => t[0] === top);
  if (i < 0) return UNSORTED;
  const j = sub ? TAXONOMY[i][1].indexOf(sub) : -1;
  return (i + 1) * 100 + (j < 0 ? 0 : j + 1);
}
export function catFromPath(path) {
  const t = String(path || '');
  for (const r of RULES) if (r[0].test(t)) return catId(r[1], r[2]);
  return UNSORTED;
}

const seed = [];
TAXONOMY.forEach(([top, subs], i) => {
  seed.push(['INSERT OR IGNORE INTO cat (id, parent, name) VALUES (?, NULL, ?)', [(i + 1) * 100, top]]);
  subs.forEach((s, j) => seed.push(['INSERT OR IGNORE INTO cat (id, parent, name) VALUES (?, ?, ?)', [(i + 1) * 100 + j + 1, (i + 1) * 100, s]]));
});

// Each migration: list of [sql, args?]. Append only.
export const MIGRATIONS = [[
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
].concat(seed)];
