// Run: node tests/cloud_test.js
// Drives functions/api.js (Cloudflare Pages Function) with a fake D1 and a fake Apps Script behind fetch.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rows = {};   // fake D1 table parts: key -> {rec, time}
const DB = {
  prepare(sql) {
    const st = { sql, args: [], bind(...a) { return Object.assign({}, st, { args: a }); },
      async run() { if (/^INSERT/.test(sql)) rows[this.args[0]] = { rec: this.args[1], time: this.args[2] }; return {}; },
      async all() { return { results: this.args.filter(k => rows[k]).map(k => ({ key: k, rec: rows[k].rec })) }; } };
    return st;
  },
  async batch(list) { for (const s of list) await s.run(); }
};
const sent = [];
global.fetch = async (url, o) => { sent.push(JSON.parse(o.body)); const a = answer(JSON.parse(o.body).req); return { status: 200, text: async () => JSON.stringify(a) }; };
let answer = () => ({ ok: true, data: { rows: [] } });
const env = { DB, TOKEN: 'tok', EXEC_URL: 'https://exec' };

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'api.js'), 'utf8');
  const { onRequestPost } = await import('data:text/javascript,' + encodeURIComponent(src));
  const waits = [];
  const call = async body => { const r = await onRequestPost({ request: { json: async () => body }, env, waitUntil: p => waits.push(p) }); await Promise.all(waits); return { status: r.status, body: await r.json() }; };

  let r = await call({ token: 'bad', req: { action: 'load' } });
  assert.strictEqual(r.status, 403); assert.strictEqual(sent.length, 0);

  r = await call({ token: 'tok', req: { action: 'load' } });
  assert.deepStrictEqual(r.body, { ok: true, data: { rows: [] } }); assert.strictEqual(sent.length, 1, 'load goes to Apps Script');

  const rec = { mpn: 'AC0402FR-072K2L', dkPn: '311-2.20KLRCT-ND', mouserPn: '', groupKey: 'R|2.2k|0402' };
  answer = () => ({ ok: true, data: { parsed: { qty: 5 }, rec, source: 'DigiKey', warnings: [] } });
  r = await call({ token: 'tok', req: { action: 'scan', texts: ['AC0402FR-072K2L'], keys: ['ac0402fr072k2l'] } });
  assert.strictEqual(r.body.data.source, 'DigiKey'); assert.strictEqual(sent.length, 2, 'miss is forwarded');
  assert.deepStrictEqual(Object.keys(rows).sort(), ['311220klrctnd', 'ac0402fr072k2l'], 'stored under every part number');

  r = await call({ token: 'tok', req: { action: 'scan', texts: ['311-2.20KLRCT-ND'], keys: ['311220klrctnd'] } });
  assert.strictEqual(sent.length, 2, 'DigiKey PN of a part first seen by MPN is a hit');
  r = await call({ token: 'tok', req: { action: 'scan', texts: ['x'], keys: ['nothing', 'ac0402fr072k2l'] } });
  assert.strictEqual(sent.length, 2, 'hit answered without Apps Script');
  assert.deepStrictEqual(r.body, { ok: true, data: { rec, source: 'cloud cache', warnings: [] } });

  answer = () => ({ ok: true, data: { parsed: {}, rec: null, warnings: ['none'] } });
  r = await call({ token: 'tok', req: { action: 'scan', texts: ['zz'], keys: ['zz'] } });
  assert.strictEqual(r.body.data.rec, null); assert.ok(!rows.zz, 'a miss is not cached');

  answer = () => ({ ok: true, data: { row: {}, isNew: true } });
  r = await call({ token: 'tok', req: { action: 'confirm', qty: 1 } });
  assert.strictEqual(sent.at(-1).req.action, 'confirm'); assert.strictEqual(sent.at(-1).token, 'tok');
  console.log('cloud ok');
})().catch(e => { console.error(e); process.exit(1); });
