import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectRuntimeLayout, parseElfInterpreter, runtimeSymlinkArguments,
  validateRuntimeLayout, RUNTIME_LAYOUT_HASH } from './runtime-layout.mjs';

const layoutPath = '/layout.json';
const layoutBytes = readFileSync(new URL('./executor-runtime-layout.json', import.meta.url));
const layout = () => JSON.parse(layoutBytes);
const NODE = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node';
const LIMIT = '/usr/bin/prlimit';
const LINK = '/usr/lib64/ld-linux-x86-64.so.2';
const LOADER = '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2';
const INTERP = '/lib64/ld-linux-x86-64.so.2';

function elf(interpreters = [INTERP], options = {}) {
  const strings = interpreters.map(value => Buffer.from(value + '\0'));
  const headers = 64 + 56 * strings.length;
  const out = Buffer.alloc(headers + strings.reduce((sum, value) => sum + value.length, 0));
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(out);
  out[4] = options.class ?? 2; out[5] = options.endian ?? 1; out[6] = 1;
  out.writeUInt16LE(options.machine ?? 62, 18);
  out.writeBigUInt64LE(64n, 32); out.writeUInt16LE(64, 52);
  out.writeUInt16LE(56, 54); out.writeUInt16LE(strings.length, 56);
  let at = headers;
  strings.forEach((value, index) => {
    const ph = 64 + index * 56;
    out.writeUInt32LE(3, ph); out.writeBigUInt64LE(BigInt(at), ph + 8);
    out.writeBigUInt64LE(BigInt(value.length), ph + 32); value.copy(out, at); at += value.length;
  });
  return out;
}

function stat(kind) {
  return { isFile: () => kind === 'file', isSymbolicLink: () => kind === 'symlink' };
}

function fakeIo(changes = {}) {
  const values = {
    nodeBytes: elf(), limitBytes: elf(), loaderBytes: Buffer.from('fixed-loader'),
    nodeReal: NODE, limitReal: LIMIT, loaderReal: LOADER,
    linkTarget: '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    missing: new Set(), canonicalKind: 'file', platform: 'linux', arch: 'x64',
    execPath: NODE, nodeVersion: 'v24.19.0', ...changes,
  };
  return {
    exists: path => !values.missing.has(path),
    lstat: path => path === LINK ? stat('symlink') :
      path === LOADER ? stat(values.canonicalKind) : stat('file'),
    read: path => path === layoutPath ? layoutBytes : path === NODE ? values.nodeBytes :
      path === LIMIT ? values.limitBytes : path === LOADER ? values.loaderBytes :
      assert.fail(`unexpected read ${path}`),
    readlink: path => path === LINK ? values.linkTarget : assert.fail('unexpected readlink'),
    realpath: path => path === NODE ? values.nodeReal : path === LIMIT ? values.limitReal :
      path === LINK || path === LOADER ? values.loaderReal : path,
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

test('runtime inspection binds both executables and the canonical loader', () => {
  const result = inspectRuntimeLayout(layoutPath, fakeIo());
  assert.equal(result.runtimeLayoutVerified, true);
  assert.match(result.identities.node.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.identities.prlimit.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.identities.interpreter.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.candidateExecutionEnabled, false);
});

test('both executables must use the exact same declared interpreter', () => {
  assert.throws(() => inspectRuntimeLayout(layoutPath,
    fakeIo({ limitBytes: elf(['/lib/ld-linux-aarch64.so.1']) })), /prlimit PT_INTERP/);
});

test('pinned Node version, executable and platform cannot drift', () => {
  assert.throws(() => inspectRuntimeLayout(layoutPath, fakeIo({ nodeVersion: 'v24.18.0' })), /Node version/);
  assert.throws(() => inspectRuntimeLayout(layoutPath, fakeIo({ execPath: '/usr/bin/node' })), /pinned Node/);
  assert.throws(() => inspectRuntimeLayout(layoutPath, fakeIo({ arch: 'arm64' })), /architecture/);
});

test('canonical Node and prlimit paths cannot escape allowed roots', () => {
  assert.throws(() => inspectRuntimeLayout(layoutPath,
    fakeIo({ nodeReal: '/opt/codex/runtimes/codex-primary-runtime/dependencies/node-evil/bin/node' })), /Node escapes/);
  assert.throws(() => inspectRuntimeLayout(layoutPath, fakeIo({ limitReal: '/usr-evil/bin/prlimit' })), /prlimit escapes/);
});

test('loader link, canonical path and regular file are exact', () => {
  assert.throws(() => inspectRuntimeLayout(layoutPath, fakeIo({ linkTarget: '../../etc/passwd' })), /link target/);
  assert.throws(() => inspectRuntimeLayout(layoutPath, fakeIo({ loaderReal: '/usr-evil/loader' })), /canonical interpreter/);
  assert.throws(() => inspectRuntimeLayout(layoutPath, fakeIo({ canonicalKind: 'symlink' })), /regular file/);
});

test('missing executable, loader or synthetic target fails closed', () => {
  for (const path of [NODE, LIMIT, LINK, '/usr/lib', '/usr/lib64']) {
    assert.throws(() => inspectRuntimeLayout(layoutPath, fakeIo({ missing: new Set([path]) })), /missing/);
  }
});

test('launcher symlink arguments are exact constants', () => {
  const observation = inspectRuntimeLayout(layoutPath, fakeIo());
  assert.deepEqual(runtimeSymlinkArguments(observation),
    ['--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64']);
  observation.syntheticSymlinks[0].target = 'usr/lib64';
  assert.throws(() => runtimeSymlinkArguments(observation));
});
