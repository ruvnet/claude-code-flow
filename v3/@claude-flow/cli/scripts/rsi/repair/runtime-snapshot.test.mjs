import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discardRuntimeSnapshot, snapshotMounts, stageRuntimeSnapshotForTest, validateRuntimeSnapshot } from './runtime-snapshot.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ruflo-snapshot-test-'));
  const source = join(root, 'source'), parent = join(root, 'snapshots');
  mkdirSync(source); mkdirSync(parent);
  const node = join(source, 'node'), limit = join(source, 'prlimit'), library = join(source, 'libc.so.6');
  writeFileSync(node, 'node-bytes'); writeFileSync(limit, 'prlimit-bytes'); writeFileSync(library, 'library-bytes');
  const specification = { runtimeLayoutHash: 'a'.repeat(64), runtimeLayoutVerified: true,
    files: [
      { path: '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node', source: node, sha256: hash(Buffer.from('node-bytes')), mode: 0o555 },
      { path: '/usr/bin/prlimit', source: limit, sha256: hash(Buffer.from('prlimit-bytes')), mode: 0o555 },
      { path: '/usr/lib/x86_64-linux-gnu/libc.so.6', source: library, sha256: hash(Buffer.from('library-bytes')), mode: 0o444 },
    ], links: [{ path: '/usr/lib64/ld-linux-x86-64.so.2', target: '../lib/x86_64-linux-gnu/libc.so.6' }],
    candidateExecutionEnabled: false };
  function thaw(path) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
    if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) thaw(join(path, name)); }
    else chmodSync(path, 0o600);
  }
  try { return fn({ root, source, parent, specification }); } finally { thaw(root); rmSync(root, { recursive: true, force: true }); }
}

test('stages only pinned files into a deterministic read-only snapshot', () => fixture(({ parent, specification }) => {
  const result = stageRuntimeSnapshotForTest(parent, specification);
  assert.match(result.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(result.root, join(parent, result.snapshotHash));
  assert.equal(result.readOnlyStaged, true);
  assert.equal(result.privilegedParentImmutabilityClaimed, false);
  assert.equal(readFileSync(join(result.root, 'usr/bin/prlimit'), 'utf8'), 'prlimit-bytes');
  assert.equal(readlinkSync(join(result.root, 'usr/lib64/ld-linux-x86-64.so.2')), '../lib/x86_64-linux-gnu/libc.so.6');
  assert.equal(lstatSync(result.root).mode & 0o777, 0o555);
  assert.equal(lstatSync(join(result.root, 'usr/lib/x86_64-linux-gnu/libc.so.6')).mode & 0o777, 0o444);
  assert.equal(validateRuntimeSnapshot(result).exactInventoryVerified, true);
  assert.deepEqual(snapshotMounts(result).map(x => x.target), ['/usr','/opt/codex/runtimes/codex-primary-runtime/dependencies/node']);
}));

test('post-stage corruption and undeclared files are rejected', () => fixture(({ parent, specification }) => {
  const snapshot = stageRuntimeSnapshotForTest(parent, specification);
  chmodSync(snapshot.root, 0o700); chmodSync(join(snapshot.root, 'usr/bin'), 0o700);
  chmodSync(join(snapshot.root, 'usr/bin/prlimit'), 0o600); writeFileSync(join(snapshot.root, 'usr/bin/prlimit'), 'changed');
  assert.throws(() => validateRuntimeSnapshot(snapshot), /mode|size|SHA-256/);
  writeFileSync(join(snapshot.root, 'usr/bin/extra'), 'undeclared');
  chmodSync(join(snapshot.root, 'usr/bin'), 0o555); chmodSync(snapshot.root, 0o555);
  assert.throws(() => validateRuntimeSnapshot(snapshot), /inventory/);
}));

test('writable, missing and undeclared nested directories are rejected', () => fixture(({ parent, specification }) => {
  const snapshot = stageRuntimeSnapshotForTest(parent, specification);
  chmodSync(join(snapshot.root, 'usr/bin'), 0o777);
  assert.throws(() => validateRuntimeSnapshot(snapshot), /directory mode/);
  chmodSync(join(snapshot.root, 'usr/bin'), 0o555); chmodSync(snapshot.root, 0o755);
  mkdirSync(join(snapshot.root, 'undeclared-empty')); chmodSync(join(snapshot.root, 'undeclared-empty'), 0o555); chmodSync(snapshot.root, 0o555);
  assert.throws(() => validateRuntimeSnapshot(snapshot), /directory inventory/);
}));

test('file-to-symlink substitution is rejected by descriptor-bound validation', () => fixture(({ parent, specification, source }) => {
  const snapshot = stageRuntimeSnapshotForTest(parent, specification);
  const target = join(snapshot.root, 'usr/bin/prlimit');
  chmodSync(snapshot.root, 0o700); chmodSync(join(snapshot.root, 'usr'), 0o700); chmodSync(join(snapshot.root, 'usr/bin'), 0o700);
  unlinkSync(target); symlinkSync(join(source, 'prlimit'), target);
  chmodSync(join(snapshot.root, 'usr/bin'), 0o555); chmodSync(join(snapshot.root, 'usr'), 0o555); chmodSync(snapshot.root, 0o555);
  assert.throws(() => validateRuntimeSnapshot(snapshot), /regular file|ELOOP/);
}));

test('source corruption is rejected and partial snapshot is removed', () => fixture(({ parent, specification }) => {
  specification.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => stageRuntimeSnapshotForTest(parent, specification), /SHA-256/);
  assert.deepEqual(readdirSync(parent), []);
}));

test('duplicate destinations and escaping links fail closed', () => fixture(({ parent, specification }) => {
  specification.files.push({ ...specification.files[0] });
  assert.throws(() => stageRuntimeSnapshotForTest(parent, specification), /duplicate/);
  specification.files.pop(); specification.links[0].target = '../../../../etc/passwd';
  assert.throws(() => stageRuntimeSnapshotForTest(parent, specification), /escapes root/);
}));

test('existing content-addressed snapshot requires explicit validation, never overwrite', () => fixture(({ parent, specification }) => {
  const first = stageRuntimeSnapshotForTest(parent, specification);
  assert(existsSync(first.root));
  assert.throws(() => stageRuntimeSnapshotForTest(parent, specification), /already exists/);
  assert.equal(readFileSync(join(first.root, 'usr/bin/prlimit'), 'utf8'), 'prlimit-bytes');
}));

test('only an exactly owned content-addressed snapshot can be discarded', () => fixture(({ parent, specification }) => {
  const snapshot = stageRuntimeSnapshotForTest(parent, specification);
  const unrelated = join(parent, 'unrelated'); chmodSync(parent, 0o700); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep'), 'keep');
  assert.throws(() => discardRuntimeSnapshot({ ...snapshot, root: unrelated, snapshotHash: 'unrelated' }, parent), /module-owned/);
  assert.equal(readFileSync(join(unrelated, 'keep'), 'utf8'), 'keep');
  discardRuntimeSnapshot(snapshot, parent);
  assert.equal(existsSync(snapshot.root), false);
}));
