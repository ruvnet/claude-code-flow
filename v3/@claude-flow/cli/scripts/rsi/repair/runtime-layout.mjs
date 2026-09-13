/** Exact, read-only ELF/runtime admission for the fixed Linux x64 executor. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { arch, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_LAYOUT_HASH = '6bcfdb29967558abbcff13c5cb4b3cbad9adeab85f6c15d3cd69de05e4c9b439';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys, label) => assert(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label} fields`);

function safeInteger(value, label) {
  assert(value <= BigInt(Number.MAX_SAFE_INTEGER), `${label} exceeds safe integer`);
  return Number(value);
}

export function parseElfInterpreter(bytes) {
  assert(Buffer.isBuffer(bytes), 'ELF bytes required');
  assert(bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'ELF magic');
  assert.equal(bytes[4], 2, 'ELF64 required');
  assert.equal(bytes[5], 1, 'little-endian ELF required');
  assert.equal(bytes[6], 1, 'current ELF version required');
  assert.equal(bytes.readUInt16LE(18), 62, 'x86_64 ELF machine required');
  const headerOffset = safeInteger(bytes.readBigUInt64LE(32), 'program header offset');
  const headerSize = bytes.readUInt16LE(54);
  const headerCount = bytes.readUInt16LE(56);
  assert(headerSize >= 56 && headerCount > 0 && headerCount <= 256, 'bounded ELF program headers');
  assert(headerOffset + headerSize * headerCount <= bytes.length, 'ELF program headers in bounds');
  let interpreter = null;
  for (let index = 0; index < headerCount; index++) {
    const at = headerOffset + index * headerSize;
    if (bytes.readUInt32LE(at) !== 3) continue; // PT_INTERP
    assert.equal(interpreter, null, 'one ELF interpreter required');
    const offset = safeInteger(bytes.readBigUInt64LE(at + 8), 'interpreter offset');
    const size = safeInteger(bytes.readBigUInt64LE(at + 32), 'interpreter size');
    assert(size > 1 && size <= 4096 && offset + size <= bytes.length, 'bounded ELF interpreter');
    const value = bytes.subarray(offset, offset + size);
    assert.equal(value.at(-1), 0, 'NUL-terminated ELF interpreter');
    assert(!value.subarray(0, -1).includes(0), 'single ELF interpreter string');
    interpreter = value.subarray(0, -1).toString('utf8');
  }
  assert(interpreter && isAbsolute(interpreter), 'absolute PT_INTERP required');
  return interpreter;
}

export function validateRuntimeLayout(layout) {
  exact(layout, ['schema','platform','architecture','node','prlimit','allowedInterpreter',
    'syntheticSymlinks','candidateExecutionEnabled','boundedRsiEvidenceAccepted'], 'runtime layout');
  assert.equal(digest(JSON.stringify(layout)), RUNTIME_LAYOUT_HASH, 'runtime layout hash mismatch');
  assert.equal(layout.schema, 'ruflo.repair-executor-runtime-layout/v1');
  assert.equal(layout.platform, 'linux');
  assert.equal(layout.architecture, 'x64');
  assert.deepEqual(layout.node, {
    path: '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node',
    version: 'v24.19.0', interpreter: '/lib64/ld-linux-x86-64.so.2',
  });
  assert.deepEqual(layout.prlimit, { path: '/usr/bin/prlimit', interpreter: '/lib64/ld-linux-x86-64.so.2' });
  assert.deepEqual(layout.allowedInterpreter, {
    path: '/usr/lib64/ld-linux-x86-64.so.2',
    linkTarget: '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    canonicalPath: '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', root: '/usr',
  });
  assert.deepEqual(layout.syntheticSymlinks, [
    { target: 'usr/lib', link: '/lib' }, { target: 'usr/lib64', link: '/lib64' },
  ]);
  assert.equal(layout.candidateExecutionEnabled, false);
  assert.equal(layout.boundedRsiEvidenceAccepted, false);
  return { runtimeLayoutHash: RUNTIME_LAYOUT_HASH, candidateExecutionEnabled: false };
}

const defaultIo = {
  exists: existsSync, lstat: lstatSync, read: readFileSync, readlink: readlinkSync, realpath: realpathSync,
  platform, arch, execPath: process.execPath, nodeVersion: process.version,
};

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function inspectRuntimeLayout(layoutPath = resolve(ROOT, 'executor-runtime-layout.json'), io = defaultIo) {
  const layoutBytes = io.read(layoutPath);
  const layout = JSON.parse(layoutBytes);
  const check = validateRuntimeLayout(layout);
  assert.equal(io.platform(), layout.platform, 'runtime platform mismatch');
  assert.equal(io.arch(), layout.architecture, 'runtime architecture mismatch');
  assert.equal(io.nodeVersion, layout.node.version, 'Node version mismatch');
  assert.equal(io.realpath(io.execPath), io.realpath(layout.node.path), 'executor must run under pinned Node');

  const identities = {};
  for (const [role, executable] of Object.entries({ node: layout.node, prlimit: layout.prlimit })) {
    assert(io.exists(executable.path), `${role} executable missing`);
    const stat = io.lstat(executable.path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${role} executable must be a regular file`);
    const bytes = io.read(executable.path);
    assert.equal(parseElfInterpreter(bytes), executable.interpreter, `${role} PT_INTERP mismatch`);
    identities[role] = { path: executable.path, canonicalPath: io.realpath(executable.path), sha256: digest(bytes),
      interpreter: executable.interpreter };
  }
  assert(inside('/opt/codex/runtimes/codex-primary-runtime/dependencies/node', identities.node.canonicalPath),
    'Node escapes pinned runtime root');
  assert(inside('/usr', identities.prlimit.canonicalPath), 'prlimit escapes /usr runtime root');

  const allowed = layout.allowedInterpreter;
  assert(io.exists(allowed.path), 'allowed interpreter missing');
  const interpreterStat = io.lstat(allowed.path);
  assert(interpreterStat.isSymbolicLink(), 'allowed interpreter must be the declared symlink');
  assert.equal(io.readlink(allowed.path), allowed.linkTarget, 'interpreter link target mismatch');
  assert.equal(io.realpath(allowed.path), allowed.canonicalPath, 'canonical interpreter mismatch');
  const canonicalStat = io.lstat(allowed.canonicalPath);
  assert(canonicalStat.isFile() && !canonicalStat.isSymbolicLink(), 'canonical interpreter must be a regular file');
  assert(inside(allowed.root, allowed.canonicalPath), 'interpreter escapes allowed runtime root');
  const interpreterBytes = io.read(allowed.canonicalPath);
  identities.interpreter = { path: allowed.path, linkTarget: allowed.linkTarget,
    canonicalPath: allowed.canonicalPath, sha256: digest(interpreterBytes) };

  for (const link of layout.syntheticSymlinks) {
    assert(isAbsolute(link.link) && !isAbsolute(link.target) && !link.target.split('/').includes('..'), 'safe synthetic symlink');
    const resolved = resolve(dirname(link.link), link.target);
    assert(inside(allowed.root, resolved), 'synthetic symlink escapes /usr');
    assert(io.exists(resolved), 'synthetic symlink target missing');
  }
  return { schema: 'ruflo.repair-runtime-layout-observation/v1', ...check,
    platform: layout.platform, architecture: layout.architecture, nodeVersion: layout.node.version,
    identities, syntheticSymlinks: layout.syntheticSymlinks,
    runtimeLayoutVerified: true, candidateExecutionEnabled: false };
}

export function runtimeSymlinkArguments(observation) {
  assert.equal(observation?.schema, 'ruflo.repair-runtime-layout-observation/v1');
  assert.equal(observation.runtimeLayoutHash, RUNTIME_LAYOUT_HASH);
  assert.equal(observation.runtimeLayoutVerified, true);
  assert.equal(observation.candidateExecutionEnabled, false);
  assert.deepEqual(observation.syntheticSymlinks, [
    { target: 'usr/lib', link: '/lib' }, { target: 'usr/lib64', link: '/lib64' },
  ]);
  return ['--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64'];
}
