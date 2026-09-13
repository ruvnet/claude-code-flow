import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseElfInterpreter, runtimeSymlinkArguments,
  inspectRuntimeLayoutForTest, parseElfDynamic, validateRuntimeLayout, RUNTIME_LAYOUT_HASH } from './runtime-layout.mjs';

const layoutPath = '/layout.json';
const layoutBytes = readFileSync(new URL('./executor-runtime-layout.json', import.meta.url));
const layout = () => JSON.parse(layoutBytes);
const NODE = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node';
const LIMIT = '/usr/bin/prlimit';
const LINK = '/usr/lib64/ld-linux-x86-64.so.2';
const LOADER = '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2';
const INTERP = '/lib64/ld-linux-x86-64.so.2';

function elf(interpreters = [INTERP], options = {}) {
  const dynamic = options.dynamic ?? { needed: [], soname: null, rpath: [], runpath: [] };
  const names = [...dynamic.needed, ...(dynamic.soname ? [dynamic.soname] : []),
    ...(dynamic.rpath ?? []), ...(dynamic.runpath ?? [])];
  const stringOffsets = new Map(); let stringSize = 1;
  for (const name of names) if (!stringOffsets.has(name)) { stringOffsets.set(name, stringSize); stringSize += Buffer.byteLength(name) + 1; }
  const headerCount = interpreters.length + 2;
  const headers = 64 + 56 * headerCount;
  const interpreterBytes = interpreters.map(value => Buffer.from(value + '\0'));
  const stringOffset = headers + interpreterBytes.reduce((sum, value) => sum + value.length, 0);
  const dynamicEntries = dynamic.needed.length + (dynamic.soname ? 1 : 0) +
    (dynamic.rpath?.length ?? 0) + (dynamic.runpath?.length ?? 0) + 3;
  const dynamicOffset = stringOffset + stringSize;
  const out = Buffer.alloc(dynamicOffset + dynamicEntries * 16);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(out);
  out[4] = options.class ?? 2; out[5] = options.endian ?? 1; out[6] = 1;
  out.writeUInt16LE(options.machine ?? 62, 18);
  out.writeBigUInt64LE(64n, 32); out.writeUInt16LE(64, 52);
  out.writeUInt16LE(56, 54); out.writeUInt16LE(headerCount, 56);
  let at = headers;
  interpreterBytes.forEach((value, index) => {
    const ph = 64 + index * 56;
    out.writeUInt32LE(3, ph); out.writeBigUInt64LE(BigInt(at), ph + 8);
    out.writeBigUInt64LE(BigInt(value.length), ph + 32); value.copy(out, at); at += value.length;
  });
  const load = 64 + interpreters.length * 56;
  out.writeUInt32LE(1, load); out.writeBigUInt64LE(0n, load + 8);
  out.writeBigUInt64LE(0n, load + 16); out.writeBigUInt64LE(BigInt(out.length), load + 32);
  const dynamicHeader = load + 56;
  out.writeUInt32LE(2, dynamicHeader); out.writeBigUInt64LE(BigInt(dynamicOffset), dynamicHeader + 8);
  out.writeBigUInt64LE(BigInt(dynamicOffset), dynamicHeader + 16);
  out.writeBigUInt64LE(BigInt(dynamicEntries * 16), dynamicHeader + 32);
  for (const [name, offset] of stringOffsets) out.write(name + '\0', stringOffset + offset);
  const entries = [
    ...dynamic.needed.map(name => [1n, stringOffsets.get(name)]),
    ...(dynamic.soname ? [[14n, stringOffsets.get(dynamic.soname)]] : []),
    ...(dynamic.rpath ?? []).map(name => [15n, stringOffsets.get(name)]),
    ...(dynamic.runpath ?? []).map(name => [29n, stringOffsets.get(name)]),
    [5n, stringOffset], [10n, stringSize], [0n, 0],
  ];
  entries.forEach(([tag, value], index) => {
    const offset = dynamicOffset + index * 16;
    out.writeBigInt64LE(tag, offset); out.writeBigUInt64LE(BigInt(value), offset + 8);
  });
  return out;
}

function stat(kind, size = 1) {
  return { size, isFile: () => kind === 'file', isSymbolicLink: () => kind === 'symlink' };
}

function fakeIo(changes = {}) {
  const manifest = layout();
  const librariesByPath = new Map(manifest.sharedLibraries.map(library => [library.path, library]));
  const libraryBytes = new Map(manifest.sharedLibraries.map(library => [library.canonicalPath,
    elf([], { dynamic: { needed: library.needed, soname: library.soname, rpath: [], runpath: [] } })]));
  const values = {
    nodeBytes: elf([INTERP], { dynamic: { needed: manifest.node.needed, soname: null, rpath: [], runpath: [] } }),
    limitBytes: elf([INTERP], { dynamic: { needed: manifest.prlimit.needed, soname: null, rpath: [], runpath: [] } }),
    libraryBytes,
    nodeReal: NODE, limitReal: LIMIT, loaderReal: LOADER,
    linkTarget: '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    missing: new Set(), sizeOverrides: new Map(), canonicalKind: 'file', platform: 'linux', arch: 'x64',
    execPath: NODE, nodeVersion: 'v24.19.0', ...changes,
  };
  const bytesAt = path => path === NODE ? values.nodeBytes : path === LIMIT ? values.limitBytes :
    values.libraryBytes.get(path);
  const expectedHash = bytes => {
    if (bytes === values.nodeBytes) return manifest.node.sha256;
    if (bytes === values.limitBytes) return manifest.prlimit.sha256;
    for (const library of manifest.sharedLibraries) {
      if (bytes === values.libraryBytes.get(library.canonicalPath)) return library.sha256;
    }
    return '0'.repeat(64);
  };
  return {
    exists: path => !values.missing.has(path),
    lstat: path => path === LINK || path === '/usr/lib/x86_64-linux-gnu/libstdc++.so.6' ||
      path === '/usr/lib/x86_64-linux-gnu/libsmartcols.so.1' ? stat('symlink') :
      path === LOADER ? stat(values.canonicalKind, values.sizeOverrides.get(path) ?? bytesAt(path).length) :
      stat('file', values.sizeOverrides.get(path) ?? bytesAt(path)?.length ?? 1),
    read: path => path === layoutPath ? layoutBytes : path === NODE ? values.nodeBytes :
      path === LIMIT ? values.limitBytes : values.libraryBytes.has(path) ? values.libraryBytes.get(path) :
      assert.fail(`unexpected read ${path}`),
    readlink: path => path === LINK ? values.linkTarget :
      librariesByPath.get(path)?.linkTarget ?? assert.fail(`unexpected readlink ${path}`),
    realpath: path => path === NODE ? values.nodeReal : path === LIMIT ? values.limitReal :
      path === LINK || path === LOADER ? values.loaderReal : librariesByPath.get(path)?.canonicalPath ?? path,
    digest: values.digest ?? expectedHash,
    platform: () => values.platform, arch: () => values.arch,
    execPath: values.execPath, nodeVersion: values.nodeVersion,
  };
}

test('runtime manifest is exact, hash pinned and cannot open execution', () => {
  const result = validateRuntimeLayout(layout());
  assert.equal(result.runtimeLayoutHash, RUNTIME_LAYOUT_HASH);
  assert.equal(result.candidateExecutionEnabled, false);
  for (const mutate of [v => { v.node.version = 'v25.0.0'; },
    v => { v.syntheticSymlinks[0].target = '../etc'; },
    v => { v.candidateExecutionEnabled = true; }]) {
    const changed = layout(); mutate(changed);
    assert.throws(() => validateRuntimeLayout(changed), /hash/);
  }
});

test('ELF parser returns the sole absolute interpreter', () => {
  assert.equal(parseElfInterpreter(elf()), INTERP);
});

test('ELF parser rejects wrong class, byte order and machine', () => {
  assert.throws(() => parseElfInterpreter(elf([INTERP], { class: 1 })), /ELF64/);
  assert.throws(() => parseElfInterpreter(elf([INTERP], { endian: 2 })), /little-endian/);
  assert.throws(() => parseElfInterpreter(elf([INTERP], { machine: 183 })), /x86_64/);
});

test('ELF parser rejects absent, duplicate and relative interpreters', () => {
  const absent = elf(); absent.writeUInt32LE(1, 64);
  assert.throws(() => parseElfInterpreter(absent), /PT_INTERP/);
  assert.throws(() => parseElfInterpreter(elf([INTERP, INTERP])), /one ELF interpreter/);
  assert.throws(() => parseElfInterpreter(elf(['relative-loader'])), /absolute PT_INTERP/);
});

test('dynamic parser returns exact needed, soname and search-path metadata', () => {
  const result = parseElfDynamic(elf([], { dynamic: {
    needed: ['libc.so.6','ld-linux-x86-64.so.2'], soname: 'libfixture.so.1',
    rpath: ['/forbidden-rpath'], runpath: ['/forbidden-runpath'],
  } }));
  assert.deepEqual(result, { needed: ['libc.so.6','ld-linux-x86-64.so.2'],
    soname: 'libfixture.so.1', rpath: ['/forbidden-rpath'], runpath: ['/forbidden-runpath'] });
});

test('dynamic parser requires one bounded segment and one mapped string table', () => {
  const absent = elf(); absent.writeUInt32LE(1, 64 + 2 * 56);
  assert.throws(() => parseElfDynamic(absent), /one PT_DYNAMIC/);
  const duplicate = elf(); duplicate.writeUInt32LE(2, 64 + 56);
  assert.throws(() => parseElfDynamic(duplicate), /one PT_DYNAMIC/);
});

test('dynamic parser rejects duplicate string tables and missing terminators', () => {
  const duplicateTable = elf([], { dynamic: { needed: ['libc.so.6'], soname: null, rpath: [], runpath: [] } });
  const dynamicHeader = 64 + 56;
  const dynamicOffset = Number(duplicateTable.readBigUInt64LE(dynamicHeader + 8));
  duplicateTable.writeBigInt64LE(5n, dynamicOffset);
  assert.throws(() => parseElfDynamic(duplicateTable), /one DT_STRTAB/);

  const noNull = elf([], { dynamic: { needed: [], soname: null, rpath: [], runpath: [] } });
  const noNullOffset = Number(noNull.readBigUInt64LE(dynamicHeader + 8));
  noNull.writeBigInt64LE(1n, noNullOffset + 32);
  assert.throws(() => parseElfDynamic(noNull), /DT_NULL/);

  const overflow = elf();
  const overflowHeader = 64 + 2 * 56;
  overflow.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER), overflowHeader + 8);
  assert.throws(() => parseElfDynamic(overflow), /segment end exceeds safe integer/);
});

test('runtime inspection binds both executables and the canonical loader', () => {
  const result = inspectRuntimeLayoutForTest(layoutPath, fakeIo());
  assert.equal(result.runtimeLayoutVerified, true);
  assert.match(result.identities.node.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.identities.prlimit.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.identities.interpreter.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.identities.sharedLibraries.length, 8);
  assert.deepEqual(result.identities.sharedLibraries.map(library => library.soname),
    layout().sharedLibraries.map(library => library.soname));
  assert.equal(result.candidateExecutionEnabled, false);
});

test('executable dependency drift and loader search paths fail closed', () => {
  const manifest = layout();
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({
    nodeBytes: elf([INTERP], { dynamic: { needed: manifest.node.needed.slice(1), soname: null, rpath: [], runpath: [] } }),
  })), /node DT_NEEDED/);
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({
    limitBytes: elf([INTERP], { dynamic: { needed: manifest.prlimit.needed, soname: null,
      rpath: [], runpath: ['/tmp/injected'] } }),
  })), /prlimit DT_RUNPATH forbidden/);
});

test('each declared shared library must exist with exact identity and dependencies', () => {
  const missing = layout().sharedLibraries[2].path;
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ missing: new Set([missing]) })), /missing/);
  const io = fakeIo();
  const originalRead = io.read, originalLstat = io.lstat, originalDigest = io.digest;
  const wrong = elf([], { dynamic: { needed: [], soname: 'libwrong.so.1', rpath: [], runpath: [] } });
  io.read = path => path === '/usr/lib/x86_64-linux-gnu/libdl.so.2'
    ? wrong
    : originalRead(path);
  io.lstat = path => path === '/usr/lib/x86_64-linux-gnu/libdl.so.2' ? stat('file', wrong.length) : originalLstat(path);
  io.digest = bytes => bytes === wrong ? layout().sharedLibraries.find(x => x.soname === 'libdl.so.2').sha256 : originalDigest(bytes);
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, io), /libdl.so.2 DT_SONAME/);
});

test('reviewed hashes and bounded ELF sizes are admission criteria', () => {
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath,
    fakeIo({ digest: () => '0'.repeat(64) })), /node SHA-256 mismatch/);
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath,
    fakeIo({ sizeOverrides: new Map([[NODE, 134217729]]) })), /node ELF size out of bounds/);
});

test('both executables must use the exact same declared interpreter', () => {
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath,
    fakeIo({ limitBytes: elf(['/lib/ld-linux-aarch64.so.1']) })), /prlimit PT_INTERP/);
});

test('pinned Node version, executable and platform cannot drift', () => {
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ nodeVersion: 'v24.18.0' })), /Node version/);
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ execPath: '/usr/bin/node' })), /pinned Node/);
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ arch: 'arm64' })), /architecture/);
});

test('canonical Node and prlimit paths cannot escape allowed roots', () => {
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath,
    fakeIo({ nodeReal: '/opt/codex/runtimes/codex-primary-runtime/dependencies/node-evil/bin/node' })), /Node escapes/);
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ limitReal: '/usr-evil/bin/prlimit' })), /prlimit escapes/);
});

test('loader link, canonical path and regular file are exact', () => {
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ linkTarget: '../../etc/passwd' })), /link target/);
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ loaderReal: '/usr-evil/loader' })), /canonical interpreter/);
  assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ canonicalKind: 'symlink' })), /regular file/);
});

test('missing executable, loader or synthetic target fails closed', () => {
  for (const path of [NODE, LIMIT, LINK, '/usr/lib', '/usr/lib64']) {
    assert.throws(() => inspectRuntimeLayoutForTest(layoutPath, fakeIo({ missing: new Set([path]) })), /missing/);
  }
});

test('launcher symlink arguments are exact constants', () => {
  const observation = inspectRuntimeLayoutForTest(layoutPath, fakeIo());
  assert.deepEqual(runtimeSymlinkArguments(observation),
    ['--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64']);
  observation.syntheticSymlinks[0].target = 'usr/lib64';
  assert.throws(() => runtimeSymlinkArguments(observation));
});
