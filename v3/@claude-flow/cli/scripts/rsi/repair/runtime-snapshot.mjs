/** Content-addressed, read-only staging for the reviewed executor runtime. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRuntimeLayout, RUNTIME_LAYOUT_HASH } from './runtime-layout.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(ROOT, 'executor-runtime-layout.json');
const MAX_FILE_BYTES = 134217728;
const OWNED_SNAPSHOTS = new WeakSet();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stableHash = value => digest(Buffer.from(JSON.stringify(value)));

function confined(path, root, label) {
  assert(isAbsolute(path), `${label} absolute path`);
  const rel = relative(root, path);
  assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `${label} escapes root`);
  return rel;
}

function safeLinkTarget(path, target, root) {
  assert(typeof target === 'string' && target.length > 0 && !isAbsolute(target), 'relative symlink target required');
  const resolved = resolve(dirname(path), target);
  confined(resolved, root, 'symlink target');
  return target;
}

function ensureParents(root, destination) {
  const rel = confined(destination, root, 'snapshot destination');
  const parts = dirname(rel).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const stat = lstatSync(cursor);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'snapshot parent directory');
  }
}

function copyPinnedFile(root, item) {
  const destination = join(root, item.path.slice(1));
  ensureParents(root, destination);
  const sourceStat = lstatSync(item.source);
  assert(sourceStat.isFile() && !sourceStat.isSymbolicLink(), 'snapshot source regular file');
  assert(sourceStat.size > 0 && sourceStat.size <= MAX_FILE_BYTES, 'snapshot source size bound');
  const sourceFd = openSync(item.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try { bytes = readFileSync(sourceFd); } finally { closeSync(sourceFd); }
  assert.equal(bytes.length, sourceStat.size, 'snapshot source changed during read');
  assert.equal(digest(bytes), item.sha256, 'snapshot source SHA-256 mismatch');
  const destinationFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, item.mode);
  try { writeFileSync(destinationFd, bytes); fsyncSync(destinationFd); } finally { closeSync(destinationFd); }
  chmodSync(destination, item.mode);
  const written = readFileSync(destination);
  assert.equal(digest(written), item.sha256, 'snapshot destination SHA-256 mismatch');
  return { path: item.path, type: 'file', mode: item.mode, size: bytes.length, sha256: item.sha256 };
}

function createPinnedLink(root, item) {
  const destination = join(root, item.path.slice(1));
  ensureParents(root, destination);
  safeLinkTarget(destination, item.target, root);
  symlinkSync(item.target, destination);
  assert(lstatSync(destination).isSymbolicLink(), 'snapshot symlink');
  assert.equal(readlinkSync(destination), item.target, 'snapshot symlink target');
  return { path: item.path, type: 'symlink', target: item.target };
}

function freezeDirectories(root) {
  const directories = new Set(['/']);
  function addParents(path) {
    let current = dirname(path);
    while (current !== '.' && current !== '/') { directories.add(`/${current.replace(/^\/+/, '')}`); current = dirname(current); }
  }
  return entries => {
    for (const entry of entries) addParents(entry.path);
    [...directories].sort((a, b) => b.length - a.length).forEach(path => chmodSync(path === '/' ? root : join(root, path.slice(1)), 0o555));
  };
}

function stage(parent, specification) {
  assert(isAbsolute(parent) && existsSync(parent), 'snapshot parent must exist');
  const parentStat = lstatSync(parent);
  assert(parentStat.isDirectory() && !parentStat.isSymbolicLink() && realpathSync(parent) === parent, 'canonical snapshot parent');
  assert(specification && specification.runtimeLayoutVerified === true, 'verified runtime specification required');
  assert.equal(specification.candidateExecutionEnabled, false);
  const paths = [...specification.files.map(item => item.path), ...specification.links.map(item => item.path)];
  assert.equal(new Set(paths).size, paths.length, 'duplicate snapshot path');
  assert(paths.every(path => isAbsolute(path) && path !== '/'), 'absolute non-root snapshot paths');
  const work = join(parent, `.partial-${process.pid}-${Date.now()}`);
  assert(!existsSync(work), 'new snapshot work directory required');
  mkdirSync(work, { mode: 0o700 });
  try {
    const entries = [
      ...specification.files.map(item => copyPinnedFile(work, item)),
      ...specification.links.map(item => createPinnedLink(work, item)),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const identity = { schema: 'ruflo.repair-runtime-snapshot/v1', runtimeLayoutHash: specification.runtimeLayoutHash, entries };
    const snapshotHash = stableHash(identity);
    const destination = join(parent, snapshotHash);
    assert(!existsSync(destination), 'content-addressed snapshot already exists; explicit reuse validation required');
    const freeze = freezeDirectories(work); freeze(entries);
    renameSync(work, destination);
    const parentFd = openSync(parent, 'r'); try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    const snapshot = { ...identity, snapshotHash, root: destination, readOnlyStaged: true,
      privilegedParentImmutabilityClaimed: false, candidateExecutionEnabled: false };
    OWNED_SNAPSHOTS.add(snapshot);
    return snapshot;
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

function productionSpecification() {
  const observation = inspectRuntimeLayout();
  assert.equal(observation.runtimeLayoutHash, RUNTIME_LAYOUT_HASH);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const files = new Map();
  const add = (path, source, sha256, mode) => {
    const prior = files.get(path);
    const value = { path, source, sha256, mode };
    if (prior) assert.deepEqual(prior, value, 'conflicting snapshot file'); else files.set(path, value);
  };
  add(manifest.node.path, realpathSync(manifest.node.path), manifest.node.sha256, 0o555);
  add(manifest.prlimit.path, realpathSync(manifest.prlimit.path), manifest.prlimit.sha256, 0o555);
  for (const library of manifest.sharedLibraries) {
    add(library.canonicalPath, library.canonicalPath, library.sha256,
      library.soname === 'ld-linux-x86-64.so.2' ? 0o555 : 0o444);
  }
  const links = [];
  const addLink = (path, target) => { if (path !== realpathSync(path)) links.push({ path, target }); };
  addLink(manifest.allowedInterpreter.path, manifest.allowedInterpreter.linkTarget);
  for (const library of manifest.sharedLibraries) if (library.linkTarget) addLink(library.path, library.linkTarget);
  return { runtimeLayoutHash: observation.runtimeLayoutHash, runtimeLayoutVerified: true,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    links: links.sort((a, b) => a.path.localeCompare(b.path)), candidateExecutionEnabled: false };
}

export function stageRuntimeSnapshot(parent) { return stage(parent, productionSpecification()); }

export function stageRuntimeSnapshotForTest(parent, specification) {
  assert(process.env.NODE_TEST_CONTEXT, 'test-only snapshot specification');
  return stage(parent, specification);
}

export function validateRuntimeSnapshot(snapshot) {
  assert(snapshot?.schema === 'ruflo.repair-runtime-snapshot/v1', 'snapshot schema');
  assert.equal(snapshot.snapshotHash, stableHash({ schema: snapshot.schema,
    runtimeLayoutHash: snapshot.runtimeLayoutHash, entries: snapshot.entries }), 'snapshot identity hash');
  assert.equal(snapshot.root, join(dirname(snapshot.root), snapshot.snapshotHash), 'content-addressed snapshot path');
  assert.equal(lstatSync(snapshot.root).mode & 0o777, 0o555, 'snapshot root mode');
  const observed = [], observedDirectories = ['/'];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        assert.equal(stat.mode & 0o777, 0o555, 'snapshot directory mode');
        observedDirectories.push(`/${relative(snapshot.root, path).split(sep).join('/')}`);
        walk(path);
      }
      else observed.push(`/${relative(snapshot.root, path).split(sep).join('/')}`);
    }
  }
  walk(snapshot.root);
  assert.deepEqual(observed.sort(), snapshot.entries.map(entry => entry.path).sort(), 'snapshot exact path inventory');
  const expectedDirectories = new Set(['/']);
  for (const entry of snapshot.entries) {
    let current = dirname(entry.path);
    while (current !== '.' && current !== '/') { expectedDirectories.add(current); current = dirname(current); }
  }
  assert.deepEqual(observedDirectories.sort(), [...expectedDirectories].sort(), 'snapshot exact directory inventory');
  for (const entry of snapshot.entries) {
    const path = join(snapshot.root, entry.path.slice(1)), stat = lstatSync(path);
    if (entry.type === 'file') {
      assert(stat.isFile() && !stat.isSymbolicLink(), 'snapshot regular file');
      assert.equal(stat.mode & 0o777, entry.mode, 'snapshot file mode');
      assert.equal(stat.size, entry.size, 'snapshot file size');
      assert.equal(digest(readFileSync(path)), entry.sha256, 'snapshot file SHA-256');
    } else {
      assert.equal(entry.type, 'symlink'); assert(stat.isSymbolicLink(), 'snapshot symlink type');
      assert.equal(readlinkSync(path), entry.target, 'snapshot link target');
      safeLinkTarget(path, entry.target, snapshot.root);
    }
  }
  assert.equal(snapshot.readOnlyStaged, true);
  assert.equal(snapshot.privilegedParentImmutabilityClaimed, false);
  assert.equal(snapshot.candidateExecutionEnabled, false);
  return { snapshotHash: snapshot.snapshotHash, runtimeLayoutHash: snapshot.runtimeLayoutHash,
    exactInventoryVerified: true, candidateExecutionEnabled: false };
}

export function snapshotMounts(snapshot) {
  validateRuntimeSnapshot(snapshot);
  assert(isAbsolute(snapshot.root) && realpathSync(snapshot.root) === snapshot.root, 'canonical snapshot root');
  const usr = join(snapshot.root, 'usr');
  const node = join(snapshot.root, 'opt/codex/runtimes/codex-primary-runtime/dependencies/node');
  for (const path of [usr, node]) {
    const stat = lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink(), 'snapshot mount directory');
  }
  return [{ source: usr, target: '/usr' },
    { source: node, target: '/opt/codex/runtimes/codex-primary-runtime/dependencies/node' }];
}

export function discardRuntimeSnapshot(snapshot, parent) {
  assert(OWNED_SNAPSHOTS.has(snapshot), 'module-owned snapshot required');
  assert(/^[a-f0-9]{64}$/.test(snapshot.snapshotHash) && snapshot.schema === 'ruflo.repair-runtime-snapshot/v1', 'snapshot identity required');
  assert.equal(snapshot.snapshotHash, stableHash({ schema: snapshot.schema,
    runtimeLayoutHash: snapshot.runtimeLayoutHash, entries: snapshot.entries }), 'snapshot identity hash');
  assert(snapshot.root === join(parent, snapshot.snapshotHash), 'owned snapshot required');
  assert(realpathSync(parent) === parent && realpathSync(snapshot.root) === snapshot.root, 'canonical owned snapshot');
  function thaw(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) thaw(join(path, name)); }
    else chmodSync(path, 0o600);
  }
  thaw(snapshot.root);
  rmSync(snapshot.root, { recursive: true, force: false });
  OWNED_SNAPSHOTS.delete(snapshot);
}
