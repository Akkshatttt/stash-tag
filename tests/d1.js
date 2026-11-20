// A D1-shaped wrapper over node:sqlite for tests: prepare().bind().run/all/first and batch (one at a time, in a transaction), like the real binding.
const { DatabaseSync } = require('node:sqlite');

function makeD1() {
  const db = new DatabaseSync(':memory:');
  const st = (sql, args) => ({
    bind: (...a) => st(sql, a),
    runSync() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    async run() { return this.runSync(); },
    async all() { return { results: db.prepare(sql).all(...args).map(r => Object.assign({}, r)) }; },
    async first() { const r = db.prepare(sql).get(...args); return r ? Object.assign({}, r) : null; }
  });
  let q = Promise.resolve();   // D1 runs one batch at a time; background writes (waitUntil) must queue, not nest
  const batch = list => q = q.catch(() => {}).then(() => { db.exec('BEGIN'); try { const o = list.map(s => s.runSync()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } });
  return { prepare: sql => st(sql, []), batch, exec: sql => db.exec(sql), rows: async (sql, ...a) => (await st(sql, a).all()).results };
}
module.exports = { makeD1 };
