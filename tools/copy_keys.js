// Copies a one-off Apps Script snippet to the clipboard that stores the DigiKey and Mouser keys as Script properties.
//   npm run keys     (then paste into the Apps Script editor, run tmpSetKeys once, delete the snippet)
// Reads the keys from the sibling altium project's private/ folder. They are never printed; they only go to the clipboard.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', '..', 'altium_pcb_schematics_automation', 'private');
const dk = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).digikey;
const mouser = (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(fs.readFileSync(path.join(dir, 'mouser_key.md'), 'utf8')) || [])[0];
if (!dk || !dk.client_id || !dk.client_secret || !mouser) { console.error('Could not find all three keys.'); process.exit(1); }

const snippet = 'function tmpSetKeys() {\n  PropertiesService.getScriptProperties().setProperties(' +
  JSON.stringify({ DIGIKEY_CLIENT_ID: dk.client_id, DIGIKEY_CLIENT_SECRET: dk.client_secret, MOUSER_KEY: mouser }) + ');\n}\n';
const r = spawnSync('clip', [], { input: snippet, shell: true });
if (r.status !== 0) { console.error('clip failed'); process.exit(1); }
console.log('Snippet copied. In the Apps Script editor: new file, paste, run tmpSetKeys, then delete that file.');
