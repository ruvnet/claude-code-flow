// Explicitly disposable, network-none compiled-adapter validation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { data, seed, NOW } from './whatsapp-approve-data.mjs';
import { createPrivateWhatsAppApprovalTools } from '/candidate/mcp-tools/private-whatsapp-approval.js';
const hash = b => createHash('sha256').update(b).digest('hex');
assert.equal(process.cwd(), '/data'); assert.equal(process.env.PRIVATE_APPROVAL_DISPOSABLE, '1');
const base = '/app/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js';
const context = JSON.parse(readFileSync('/opt/protected-bridge/context-receipt.json'));
assert.equal(hash(readFileSync(base)), context.overlayFiles['overlay/cli/dist/src/memory/memory-bridge.js']);
const bridge = await import(base);
process.env.RUFLO_HIERARCHICAL_PROTECTED_RETENTION = JSON.stringify({ prefixes: [{ tier: 'semantic', keyPrefix: 'ruclip:company:fixture' }], maxEntries: 20 });
const registry = await bridge.getControllerRegistry('/data/private-approval.sqlite');
const db = registry.getAgentDB().database; assert(bridge.ensureBridgeSchema(db));
const Database = createRequire('/app/node_modules/agentdb/package.json')('better-sqlite3');
assert(db instanceof Database);
Date.now = () => NOW; const f = data(); let config = f.config;
const hm = registry.get('hierarchicalMemory');
for (const [, ns, key, value] of f.records.filter(r => r[0] === 'tiered_memory')) {
  assert.equal(hm.createIfAbsent(key, JSON.stringify(value), ns).status, 'created');
}
seed(db, f.records.filter(r => r[0] === 'memory_entries'));
const [prepare, apply] = createPrivateWhatsAppApprovalTools(registry, () => config);
const p = await prepare.handler({ requestJson: JSON.stringify(f.d) }); assert.equal(p.outcome, 'prepared');
const raw = JSON.stringify({ ...f.d, expectedSnapshotDigest: p.digest }), args = { requestJson: raw, serviceSeal: f.seal(raw) };
const rows = () => db.prepare("SELECT count(*) n FROM memory_entries WHERE namespace IN ('ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti')").get().n;
assert.equal((await apply.handler({ ...args, namespace: 'arbitrary' })).error, 'invalid_request');
assert.equal((await apply.handler({ requestJson: raw }, { serviceSeal: args.serviceSeal })).error, 'invalid_request');
config = { ...f.config, revision: 'rotated' };
assert.equal((await apply.handler(args)).error, 'configuration_changed'); assert.equal(rows(), 0); config = f.config;
db.exec(`CREATE TEMP TRIGGER fail_approval BEFORE INSERT ON memory_entries WHEN NEW.namespace='ruclip-api-whatsapp-group-send-approvals' BEGIN SELECT RAISE(ABORT,'fixture'); END;`);
assert.equal((await apply.handler(args)).outcome, 'denied'); assert.equal(rows(), 0); db.exec('DROP TRIGGER fail_approval');
const result = await apply.handler(args); assert.equal(result.outcome, 'committed'); assert.equal(rows(), 2);
assert.deepEqual(result.approval.originalHumanApproval.assertion, f.assertion);
assert.equal((await apply.handler(args)).error, 'approval_replayed');
// Reset only this disposable fixture's rows to exercise lost acknowledgement.
db.prepare("DELETE FROM memory_entries WHERE namespace IN ('ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti')").run();
const exec = db.exec.bind(db); let commits = 0;
db.exec = sql => { const r = exec(sql); if (sql === 'COMMIT') { commits++; throw Error('lost acknowledgement'); } return r; };
assert.deepEqual(await apply.handler(args), { outcome: 'unknown', error: 'commit_unknown' });
db.exec = exec; assert.equal(commits, 1); assert.equal(rows(), 2);
const restart = new Database('/data/private-approval.sqlite'); restart.pragma('synchronous=FULL');
const reopened = createPrivateWhatsAppApprovalTools({ getAgentDB: () => ({ database: restart }) }, () => f.config);
assert.equal((await reopened[1].handler(args)).error, 'approval_replayed'); restart.close();
assert.equal(db.prepare('SELECT sqlite_version() v').get().v, '3.51.3');
assert.equal(db.pragma('journal_mode', { simple: true }), 'wal'); assert.equal(db.pragma('synchronous', { simple: true }), 2);
const modules = ['mcp-tools/private-whatsapp-approval.js', 'memory/whatsapp-approve.js', 'memory/whatsapp-approve-proof.js', 'memory/whatsapp-approve-state.js', 'memory/authority-snapshot.js'];
console.log(JSON.stringify({ schema: 'private-whatsapp-approval-native.v1', success: true, sqlite: '3.51.3', journal: 'wal', synchronous: 'FULL',
  actualCompiledDescriptors: true, sameOwnedNativeHandle: true, originalProofRetained: true, rollbackBothRows: true,
  configurationRotationDenied: true, contextCannotSupplySeal: true, acknowledgementLossUnknown: true, noRedispatch: commits === 1,
  reopenedReplayDenied: true, counts: result.counts,
  compiledModules: Object.fromEntries(modules.map(p => [p, hash(readFileSync('/candidate/' + p))])),
  authenticatedIngress: false, providerCalls: 0, sharedDeployment: false }));
process.exit(0);
