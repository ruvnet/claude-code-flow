/** Exact, read-only ELF/runtime admission for the fixed Linux x64 executor. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { arch, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readBoundRegularFile } from './bounded-file.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_LAYOUT_HASH = 'ccf90161f686638f6409a6f187631e5848713ed2f5174df47466018c5c5ae8f8';
const MAX_ELF_BYTES = 134217728;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys, label) => assert(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label} fields`);

function safeInteger(value, label) {
  assert(value <= BigInt(Number.MAX_SAFE_INTEGER), `${label} exceeds safe integer`);
  return Number(value);
}

function checkedAdd(label, ...values) {
  assert(values.every(Number.isSafeInteger), `${label} operands must be safe integers`);
  const result = values.reduce((sum, value) => sum + BigInt(value), 0n);
  return safeInteger(result, label);
}

function programHeaders(bytes) {
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
  assert(checkedAdd('program header end', headerOffset, headerSize * headerCount) <= bytes.length,
    'ELF program headers in bounds');
  const headers = [];
  for (let index = 0; index < headerCount; index++) {
    const at = headerOffset + index * headerSize;
    headers.push({ type: bytes.readUInt32LE(at),
      offset: safeInteger(bytes.readBigUInt64LE(at + 8), 'segment offset'),
      virtualAddress: safeInteger(bytes.readBigUInt64LE(at + 16), 'segment virtual address'),
      fileSize: safeInteger(bytes.readBigUInt64LE(at + 32), 'segment file size') });
  }
  for (const header of headers) assert(checkedAdd('segment end', header.offset, header.fileSize) <= bytes.length,
    'ELF segment in bounds');
  return headers;
}

export function parseElfInterpreter(bytes) {
  let interpreter = null;
  for (const header of programHeaders(bytes)) {
    if (header.type !== 3) continue; // PT_INTERP
    assert.equal(interpreter, null, 'one ELF interpreter required');
    assert(header.fileSize > 1 && header.fileSize <= 4096, 'bounded ELF interpreter');
    const value = bytes.subarray(header.offset, checkedAdd('interpreter end', header.offset, header.fileSize));
    assert.equal(value.at(-1), 0, 'NUL-terminated ELF interpreter');
    assert(!value.subarray(0, -1).includes(0), 'single ELF interpreter string');
    interpreter = value.subarray(0, -1).toString('utf8');
  }
  assert(interpreter && isAbsolute(interpreter), 'absolute PT_INTERP required');
  return interpreter;
}

function dynamicString(bytes, stringTableOffset, stringTableSize, offset, label) {
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset < stringTableSize, `${label} offset in bounds`);
  const start = checkedAdd(`${label} start`, stringTableOffset, offset);
  const limit = checkedAdd(`${label} limit`, stringTableOffset, stringTableSize);
  const end = bytes.indexOf(0, start);
  assert(end >= start && end < limit, `${label} NUL terminated`);
  const value = bytes.subarray(start, end).toString('utf8');
  assert(value && !value.includes('\ufffd') && !/[\u0000-\u001f]/.test(value), `${label} valid UTF-8 string`);
  return value;
}

export function parseElfDynamic(bytes) {
  const headers = programHeaders(bytes);
  const dynamicSegments = headers.filter(header => header.type === 2); // PT_DYNAMIC
  assert.equal(dynamicSegments.length, 1, 'one PT_DYNAMIC required');
  const segment = dynamicSegments[0];
  assert(segment.fileSize >= 16 && segment.fileSize % 16 === 0 && segment.fileSize / 16 <= 4096,
    'bounded ELF dynamic entries');
  const entries = [];
  let terminated = false;
  const dynamicEnd = checkedAdd('dynamic segment end', segment.offset, segment.fileSize);
  for (let offset = segment.offset; offset < dynamicEnd; offset += 16) {
    const tag = bytes.readBigInt64LE(offset);
    const value = safeInteger(bytes.readBigUInt64LE(offset + 8), 'dynamic value');
    if (tag === 0n) { terminated = true; break; }
    entries.push({ tag, value });
  }
  assert(terminated, 'DT_NULL required');
  const uniqueValue = (tag, label) => {
    const values = entries.filter(entry => entry.tag === tag).map(entry => entry.value);
    assert.equal(values.length, 1, `one ${label} required`);
    return values[0];
  };
  const stringAddress = uniqueValue(5n, 'DT_STRTAB');
  const stringSize = uniqueValue(10n, 'DT_STRSZ');
  assert(stringSize > 0 && stringSize <= bytes.length, 'bounded dynamic string table');
  const stringAddressEnd = checkedAdd('dynamic string virtual end', stringAddress, stringSize);
  const loads = headers.filter(header => header.type === 1 && stringAddress >= header.virtualAddress &&
    stringAddressEnd <= checkedAdd('load virtual end', header.virtualAddress, header.fileSize));
  assert.equal(loads.length, 1, 'dynamic string table maps to one PT_LOAD');
  const stringOffset = checkedAdd('dynamic string offset', loads[0].offset, stringAddress - loads[0].virtualAddress);
  assert(checkedAdd('dynamic string end', stringOffset, stringSize) <= bytes.length, 'dynamic string table in bounds');
  const strings = (tag, label) => entries.filter(entry => entry.tag === tag)
    .map(entry => dynamicString(bytes, stringOffset, stringSize, entry.value, label));
  const sonames = strings(14n, 'DT_SONAME');
  assert(sonames.length <= 1, 'at most one DT_SONAME');
  const needed = strings(1n, 'DT_NEEDED');
  assert.equal(new Set(needed).size, needed.length, 'unique DT_NEEDED entries');
  return { needed, soname: sonames[0] ?? null, rpath: strings(15n, 'DT_RPATH'),
    runpath: strings(29n, 'DT_RUNPATH') };
}

export function validateRuntimeLayout(layout) {
  exact(layout, ['schema','platform','architecture','node','prlimit','allowedInterpreter',
    'sharedLibraries','syntheticSymlinks','candidateExecutionEnabled','boundedRsiEvidenceAccepted'], 'runtime layout');
  assert.equal(digest(JSON.stringify(layout)), RUNTIME_LAYOUT_HASH, 'runtime layout hash mismatch');
  assert.equal(layout.schema, 'ruflo.repair-executor-runtime-layout/v2');
  assert.equal(layout.platform, 'linux');
  assert.equal(layout.architecture, 'x64');
  assert.deepEqual(layout.node, {
    path: '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node',
    version: 'v24.19.0', sha256: 'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12',
    interpreter: '/lib64/ld-linux-x86-64.so.2',
    needed: ['libdl.so.2','libstdc++.so.6','libm.so.6','libgcc_s.so.1','libpthread.so.0','libc.so.6','ld-linux-x86-64.so.2'],
  });
  assert.deepEqual(layout.prlimit, { path: '/usr/bin/prlimit',
    sha256: '17064f67e650d6152a6902b013aab496b54c87587c8eea6f5023aafee6154069',
    interpreter: '/lib64/ld-linux-x86-64.so.2',
    needed: ['libsmartcols.so.1','libc.so.6'] });
  assert.deepEqual(layout.allowedInterpreter, {
    path: '/usr/lib64/ld-linux-x86-64.so.2',
    linkTarget: '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    canonicalPath: '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    sha256: '6222a16be7f2d458d6870efe6e715fc0c8d45766fb79cf7dcc3125538d703e28', root: '/usr',
  });
  assert.deepEqual(layout.syntheticSymlinks, [
    { target: 'usr/lib', link: '/lib' }, { target: 'usr/lib64', link: '/lib64' },
  ]);
  assert(Array.isArray(layout.sharedLibraries) && layout.sharedLibraries.length > 0, 'shared library closure required');
  const sonames = [];
  for (const library of layout.sharedLibraries) {
    exact(library, ['soname','path','canonicalPath','linkTarget','sha256','needed'], 'shared library');
    assert(/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,127}$/.test(library.soname), 'safe shared library soname');
    assert(isAbsolute(library.path) && isAbsolute(library.canonicalPath), 'absolute shared library paths');
    assert(/^[a-f0-9]{64}$/.test(library.sha256), 'shared library SHA-256');
    assert(Array.isArray(library.needed) && library.needed.every(value => typeof value === 'string'), 'shared library dependencies');
    sonames.push(library.soname);
  }
  assert.deepEqual(sonames, [...sonames].sort(), 'shared libraries sorted by soname');
  assert.equal(new Set(sonames).size, sonames.length, 'unique shared library sonames');
  const closure = new Set(sonames);
  for (const needed of [layout.node.needed, layout.prlimit.needed,
    ...layout.sharedLibraries.map(library => library.needed)]) {
    assert(needed.every(soname => closure.has(soname)), 'complete declared dependency closure');
  }
  const reachable = new Set();
  const bySoname = new Map(layout.sharedLibraries.map(library => [library.soname, library]));
  const visit = soname => { if (reachable.has(soname)) return; reachable.add(soname);
    for (const child of bySoname.get(soname).needed) visit(child); };
  for (const root of [...layout.node.needed, ...layout.prlimit.needed]) visit(root);
  assert.equal(reachable.size, closure.size, 'no unused shared library declarations');
  assert.equal(layout.candidateExecutionEnabled, false);
  assert.equal(layout.boundedRsiEvidenceAccepted, false);
  return { runtimeLayoutHash: RUNTIME_LAYOUT_HASH, candidateExecutionEnabled: false };
}

const defaultIo = {
  exists: existsSync, lstat: lstatSync,
  read: path => readBoundRegularFile(path, MAX_ELF_BYTES, 'runtime admission').bytes,
  readlink: readlinkSync, realpath: realpathSync,
  digest, platform, arch, execPath: process.execPath, nodeVersion: process.version,
};

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function readBoundedElf(io, path, stat, label) {
  assert(Number.isSafeInteger(stat.size) && stat.size >= 64 && stat.size <= MAX_ELF_BYTES,
    `${label} ELF size out of bounds`);
  const bytes = io.read(path);
  assert(Buffer.isBuffer(bytes) && bytes.length === stat.size, `${label} ELF read size mismatch`);
  return bytes;
}

function inspect(layoutPath, io) {
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
    const bytes = readBoundedElf(io, executable.path, stat, role);
    assert.equal(io.digest(bytes), executable.sha256, `${role} SHA-256 mismatch`);
    assert.equal(parseElfInterpreter(bytes), executable.interpreter, `${role} PT_INTERP mismatch`);
    const dynamic = parseElfDynamic(bytes);
    assert.deepEqual(dynamic.needed, executable.needed, `${role} DT_NEEDED mismatch`);
    assert.deepEqual(dynamic.rpath, [], `${role} DT_RPATH forbidden`);
    assert.deepEqual(dynamic.runpath, [], `${role} DT_RUNPATH forbidden`);
    identities[role] = { path: executable.path, canonicalPath: io.realpath(executable.path), sha256: io.digest(bytes),
      interpreter: executable.interpreter, needed: dynamic.needed };
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
  const interpreterBytes = readBoundedElf(io, allowed.canonicalPath, canonicalStat, 'interpreter');
  assert.equal(io.digest(interpreterBytes), allowed.sha256, 'interpreter SHA-256 mismatch');
  identities.interpreter = { path: allowed.path, linkTarget: allowed.linkTarget,
    canonicalPath: allowed.canonicalPath, sha256: io.digest(interpreterBytes) };

  identities.sharedLibraries = [];
  for (const library of layout.sharedLibraries) {
    assert(io.exists(library.path), `${library.soname} missing`);
    const pathStat = io.lstat(library.path);
    if (library.linkTarget === null) {
      assert(pathStat.isFile() && !pathStat.isSymbolicLink(), `${library.soname} must be a regular file`);
    } else {
      assert(pathStat.isSymbolicLink(), `${library.soname} must be the declared symlink`);
      assert.equal(io.readlink(library.path), library.linkTarget, `${library.soname} link target mismatch`);
    }
    assert.equal(io.realpath(library.path), library.canonicalPath, `${library.soname} canonical path mismatch`);
    assert(inside(allowed.root, library.canonicalPath), `${library.soname} escapes allowed runtime root`);
    const canonical = io.lstat(library.canonicalPath);
    assert(canonical.isFile() && !canonical.isSymbolicLink(), `${library.soname} canonical file required`);
    const bytes = readBoundedElf(io, library.canonicalPath, canonical, library.soname);
    assert.equal(io.digest(bytes), library.sha256, `${library.soname} SHA-256 mismatch`);
    const dynamic = parseElfDynamic(bytes);
    assert.equal(dynamic.soname, library.soname, `${library.soname} DT_SONAME mismatch`);
    assert.deepEqual(dynamic.needed, library.needed, `${library.soname} DT_NEEDED mismatch`);
    assert.deepEqual(dynamic.rpath, [], `${library.soname} DT_RPATH forbidden`);
    assert.deepEqual(dynamic.runpath, [], `${library.soname} DT_RUNPATH forbidden`);
    identities.sharedLibraries.push({ soname: library.soname, path: library.path,
      canonicalPath: library.canonicalPath, linkTarget: library.linkTarget,
      sha256: io.digest(bytes), needed: dynamic.needed });
  }

  for (const link of layout.syntheticSymlinks) {
    assert(isAbsolute(link.link) && !isAbsolute(link.target) && !link.target.split('/').includes('..'), 'safe synthetic symlink');
    const resolved = resolve(dirname(link.link), link.target);
    assert(inside(allowed.root, resolved), 'synthetic symlink escapes /usr');
    assert(io.exists(resolved), 'synthetic symlink target missing');
  }
  return { schema: 'ruflo.repair-runtime-layout-observation/v2', ...check,
    platform: layout.platform, architecture: layout.architecture, nodeVersion: layout.node.version,
    identities, syntheticSymlinks: layout.syntheticSymlinks,
    runtimeLayoutVerified: true, candidateExecutionEnabled: false };
}

export function inspectRuntimeLayout() {
  return inspect(resolve(ROOT, 'executor-runtime-layout.json'), defaultIo);
}

export function inspectRuntimeLayoutForTest(layoutPath, io) {
  assert(process.env.NODE_TEST_CONTEXT, 'test-only runtime inspection');
  return inspect(layoutPath, io);
}

export function runtimeSymlinkArguments(observation) {
  assert.equal(observation?.schema, 'ruflo.repair-runtime-layout-observation/v2');
  assert.equal(observation.runtimeLayoutHash, RUNTIME_LAYOUT_HASH);
  assert.equal(observation.runtimeLayoutVerified, true);
  assert.equal(observation.candidateExecutionEnabled, false);
  assert.deepEqual(observation.syntheticSymlinks, [
    { target: 'usr/lib', link: '/lib' }, { target: 'usr/lib64', link: '/lib64' },
  ]);
  return ['--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64'];
}
