// Explicit disposable network-none image fixture; no shared mounts or provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const hash = b => createHash('sha256').update(b).digest('hex');
assert.equal(process.cwd(), '/data');
assert.equal(process.env.AUTHORITY_SNAPSHOT_DISPOSABLE, '1');
const base = '/app/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js';
const context = JSON.parse(readFileSync('/opt/protected-bridge/context-receipt.json'));
assert.equal(hash(readFileSync(base)), context.overlayFiles['overlay/cli/dist/src/memory/memory-bridge.js']);
const candidate = '/candidate/authority-snapshot.js';
const { readAuthoritySnapshot } = await import(candidate);
const bridge = await import(base);
process.env.RUFLO_HIERARCHICAL_PROTECTED_RETENTION = JSON.stringify({ prefixes: [{ tier: 'semantic', keyPrefix: 'ruclip:company:fixture' }], maxEntries: 20 });
const registry = await bridge.getControllerRegistry('/data/snapshot.sqlite');
const db = registry.getAgentDB().database;
assert(bridge.ensureBridgeSchema(db));
const require = createRequire('/app/node_modules/agentdb/package.json');
const Database = require('better-sqlite3'); assert(db instanceof Database);
const ns = 'ruclip-api-whatsapp-group-spend';
const key = 'ruclip:whatsapp-group-spend:fixture:group_a';
const alias = 'ruclip:whatsapp-group-spend:fixture:group:a';
const insert = db.prepare('INSERT INTO memory_entries(id,key,namespace,content,created_at,updated_at,status) VALUES(?,?,?,?,1,1,\'active\')');
insert.run('fixture-a', key, ns, '{"version":1}');
insert.run('fixture-alias', alias, ns, '{"version":999}');
assert.equal((await bridge.bridgeGetEntry({ namespace: ns, key: alias })).entry.content, '{"version":999}');
assert.equal((await bridge.bridgeGetEntry({ namespace: ns, key })).entry.content, '{"version":999}');
const input = { companyId: 'fixture', selectors: [{ kind: 'spend', groupId: 'group_a' }] };
const before = readAuthoritySnapshot(registry, input); assert(before.success);
assert.equal(before.records[0].value, '{"version":1}'); assert.equal(before.records[0].key, key);
db.prepare('UPDATE memory_entries SET content=? WHERE key=? AND namespace=?').run('{"version":2}', key, ns);
assert.equal((await bridge.bridgeGetEntry({ namespace: ns, key })).entry.content, '{"version":999}');
assert.equal(readAuthoritySnapshot(registry, input).records[0].value, '{"version":2}');
const hm = registry.get('hierarchicalMemory');
assert.equal(hm.createIfAbsent('ruclip:company:fixture', '{"status":"active"}', 'semantic').status, 'created');
const other = new Database('/data/snapshot.sqlite');
const prepare = db.prepare.bind(db); let changed = false;
db.prepare = sql => {
 const stmt = prepare(sql);
 if (sql.startsWith('SELECT length') && sql.includes('tiered_memory')) {
  const all = stmt.all.bind(stmt);
  stmt.all = (...args) => {
   const rows = all(...args);
   if (!changed) { changed = true; assert(db.inTransaction); other.prepare('UPDATE memory_entries SET content=? WHERE key=?').run('{"version":3}', key); }
   return rows;
  };
 }
 return stmt;
};
const joined = { companyId: 'fixture', selectors: [{ kind: 'company' }, ...input.selectors] };
const consistent = readAuthoritySnapshot(registry, joined);
assert(consistent.success); assert.equal(consistent.records[1].value, '{"version":2}');
assert.equal(readAuthoritySnapshot(registry, joined).records[1].value, '{"version":3}');
db.prepare = prepare; other.close();
assert.equal(db.inTransaction, false);
assert.equal(db.prepare('select sqlite_version() as v').get().v, '3.51.3');
assert.equal(db.pragma('synchronous', { simple: true }), 2);
assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
const started = performance.now(); for (let i = 0; i < 20; i++) assert(readAuthoritySnapshot(registry, joined).success);
console.log('SNAPSHOT_RECEIPT ' + JSON.stringify({ ok: true, baselineSource: context.protectedSourceCommit,
 baselineBridgeSha256: hash(readFileSync(base)), candidateModuleSha256: hash(readFileSync(candidate)),
 baselineAliasWrongRow: true, baselineStaleRead: true, candidateExactCurrentTuple: true,
 actualIndependentConnectionSnapshotConsistency: true, sameRegistryHandle: true,
 sqlite: '3.51.3', wal: true, synchronousFull: true, counts: consistent.counts,
 twentyTwoRecordSnapshotsMs: performance.now() - started, providerCalls: 0, exposedMcpTool: false }));
process.exit(0);
