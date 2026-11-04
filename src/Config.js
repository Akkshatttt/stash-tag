// Single source of truth: categories, sheet columns, settings.

// One sheet per category; same columns on all of them. Order here = order of the tabs.
var CATEGORIES = ['Resistors', 'Capacitors', 'Inductors', 'Power ICs', 'Transceivers', 'Misc'];

// Which supplier category text lands in which sheet. First match wins; no match = Misc.
// Fix a wrong placement by adding the supplier's category name to the right pattern.
var CATEGORY_RULES = [
  ['Resistors', /resistor/i],
  ['Capacitors', /capacitor/i],
  ['Inductors', /inductor|choke|coil/i],
  ['Transceivers', /transceiver|interface|rs-?485|rs-?232|\bcan\b|\blin\b|\buart\b/i],
  ['Power ICs', /power management|pmic|regulator|converter|\bldo\b|voltage reference|battery (charg|manage)|gate driver|motor driver/i]
];

// Columns of every category sheet. type: 'num' is a number, everything else is plain text.
var COLUMNS = [
  { key: 'groupKey', label: 'Group Key', width: 130 },
  { key: 'value', label: 'Value', width: 80 },
  { key: 'package', label: 'Package', width: 70 },
  { key: 'spec', label: 'Spec', width: 150 },
  { key: 'qty', label: 'Qty', type: 'num', width: 60 },
  { key: 'location', label: 'Location', width: 100 },
  { key: 'mpns', label: 'Part Numbers', width: 220 },
  { key: 'manufacturers', label: 'Manufacturers', width: 140 },
  { key: 'dkPns', label: 'DigiKey PN', width: 140 },
  { key: 'mouserPns', label: 'Mouser PN', width: 140 },
  { key: 'description', label: 'Description', width: 300 },
  { key: 'categoryPath', label: 'Category Path', width: 200 },
  { key: 'datasheet', label: 'Datasheet', width: 200 },
  { key: 'updated', label: 'Updated', width: 130 }
];

// Append-only movement log. One row per scan/confirm; take/add tracking will reuse it.
var LOG_COLUMNS = [
  { key: 'time', label: 'Time' }, { key: 'category', label: 'Category' }, { key: 'groupKey', label: 'Group Key' },
  { key: 'mpn', label: 'Part Number' }, { key: 'supplier', label: 'Supplier' }, { key: 'delta', label: 'Change', type: 'num' },
  { key: 'location', label: 'Location' }, { key: 'lot', label: 'Lot' }, { key: 'note', label: 'Note' }
];

// Lookup cache (hidden): one row per supplier|pn, the normalised record as JSON. Saves API calls (DigiKey 1000/day, Mouser 1000/day).
var CACHE_COLUMNS = [{ key: 'key', label: 'Key' }, { key: 'json', label: 'Record' }, { key: 'time', label: 'Time' }];

var SETTINGS = {
  dkSite: 'IN', dkLanguage: 'en', dkCurrency: 'INR',   // locale headers that worked in the altium project
  searchLimit: 100
};
