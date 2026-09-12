import { spawn } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// No shell, inherited credentials, home mount, or network. Kill the complete group.
export function boundedProcess(command, args, { cwd, timeoutMs = 30_000, maxOutputBytes = 65_536, input } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, failure;
    const kill = (reason) => { failure ||= reason; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => kill('process timeout'), timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { size += chunk.length; if (size > maxOutputBytes) kill('output limit exceeded'); else output += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (failure) reject(new Error(failure)); else resolveResult({ exitCode: code, output }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

function bwrapArgs(cwd, argv) {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', cwd, '/work', '--chdir', '/work', '--', ...argv];
}
export async function detectBwrapSandbox() {
  try {
    const result = await boundedProcess('/usr/bin/bwrap', bwrapArgs('/tmp', ['/usr/bin/true']), { timeoutMs: 3000 });
    return { available: result.exitCode === 0, reason: result.exitCode === 0 ? null : result.output.trim() };
  } catch (error) { return { available: false, reason: error.message }; }
}
// Namespace isolation alone does not bound fork bombs or memory consumption.
// Require finite limits on this process's cgroup v2 before running repository code.
export async function detectBwrapResourceLimits() {
  try {
    const membership = await readFile('/proc/self/cgroup', 'utf8');
    const path = membership.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!path || path.split('/').includes('..')) throw new Error('cgroup v2 membership unavailable');
    const root = resolve('/sys/fs/cgroup', '.' + path);
    if (!root.startsWith('/sys/fs/cgroup')) throw new Error('Invalid cgroup path');
    const [memory, pids, cpu] = await Promise.all(['memory.max', 'pids.max', 'cpu.max'].map(name => readFile(resolve(root, name), 'utf8')));
    const [quota, period] = cpu.trim().split(/\s+/).map(Number);
    if (!(Number(memory) > 0 && Number(memory) <= 1_073_741_824 && Number(pids) > 0 && Number(pids) <= 128 && quota > 0 && period > 0 && quota / period <= 2)) throw new Error('Require cgroup memory <= 1 GiB, pids <= 128, CPU <= 2 cores');
    return { available: true, memoryBytes: Number(memory), pids: Number(pids), cpuCores: quota / period };
  } catch (error) { return { available: false, reason: error.message }; }
}
export function createBwrapSandbox() {
  return { kind: 'bwrap', async run({ cwd, policy }) {
    const resources = await detectBwrapResourceLimits();
    if (!resources.available) throw new Error(`Resource isolation unavailable: ${resources.reason}`);
    const capability = await detectBwrapSandbox();
    if (!capability.available) throw new Error(`Sandbox unavailable: ${capability.reason}`);
    const results = [];
    for (const { argv } of policy.commands) {
      const result = await boundedProcess('/usr/bin/bwrap', bwrapArgs(cwd, argv), { timeoutMs: policy.timeoutMs, maxOutputBytes: policy.maxOutputBytes });
      results.push(result);
      if (result.exitCode !== 0) throw new Error(`Verification command failed: ${result.output}`);
    }
    return { sandbox: 'bwrap', results };
  } };
}

// Bounded data-only evaluator, never imports or executes repository code.
// Trusted policy command: ['json-equals', 'fixture.json', 'key', '<JSON value>'].
export function createDeclarativeSandbox() {
  return { kind: 'declarative-json', async run({ cwd, policy }) {
    const root = await realpath(cwd), results = [];
    for (const { argv } of policy.commands) {
      if (argv.length !== 4 || argv[0] !== 'json-equals' || !/^[A-Za-z0-9_./-]+$/.test(argv[1])) throw new Error('Unsupported declarative test');
      const file = resolve(root, argv[1]);
      if (!file.startsWith(root + sep) || !(await lstat(file)).isFile() || !(await realpath(file)).startsWith(root + sep)) throw new Error('Unsafe fixture path');
      if ((await lstat(file)).size > 65_536) throw new Error('Fixture too large');
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (!Object.hasOwn(value, argv[2]) || !isDeepStrictEqual(value[argv[2]], JSON.parse(argv[3]))) throw new Error('Declarative assertion failed');
      results.push({ exitCode: 0, output: `json-equals ${argv[1]} ${argv[2]} passed` });
    }
    return { sandbox: 'declarative-json', results };
  } };
}
