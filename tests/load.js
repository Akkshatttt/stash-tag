// Loads the Apps Script sources into one Node vm context (they share a global scope there too).
// Fails if two files define the same top-level name: in Apps Script the later file would silently replace the earlier one.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FIRST = ['Util.js', 'Config.js'];

function loadSrc(extra) {
  const files = FIRST.concat(fs.readdirSync(SRC).filter(f => f.endsWith('.js') && !FIRST.includes(f)).sort());
  const seen = {};
  const ctx = vm.createContext(Object.assign({ console }, extra));
  for (const f of files) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of text.matchAll(/^(?:function\s+(\w+)|var\s+(\w+)\s*=)/gm)) {
      const n = m[1] || m[2];
      if (seen[n]) throw new Error(`"${n}" is defined in both ${seen[n]} and ${f}`);
      seen[n] = f;
    }
    vm.runInContext(text, ctx, { filename: f });
  }
  return ctx;
}

module.exports = { loadSrc };
