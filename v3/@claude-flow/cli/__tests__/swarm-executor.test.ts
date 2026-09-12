/**
 * ADR-385 streaming swarm execution — unit tests.
 *
 * Two layers:
 *  1. Pure pieces (prompt decomposition, NDJSON reshaping, redaction, the
 *     overview builder) — no subprocess.
 *  2. The spawn/stream/deadline engine, driven against tiny node fixture
 *     scripts standing in for `claude` (the injectable-binary seam), so the
 *     security guard (objective never hits a shell/argv), live streaming,
 *     error surfacing, and timeout group-kill are all exercised model-free.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  buildWorkerSpecs,
  buildWorkerPrompt,
  shapeStreamLine,
  redact,
  buildOverview,
  renderOverviewCard,
  artifactsFromEvents,
  type SwarmEvent,
} from '../src/services/swarm-executor-events.js';
import {
  spawnWorker,
  runSwarmExecution,
  appendGuidance,
  readGuidance,
  sessionDirFor,
  detectGitArtifacts,
  DEFAULT_ALLOWED_TOOLS,
} from '../src/services/swarm-executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'claude-stream-json.ndjson');

// ---------------------------------------------------------------------------
// Pure: prompt decomposition
// ---------------------------------------------------------------------------
describe('buildWorkerSpecs / buildWorkerPrompt', () => {
  const plan = [
    { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Orchestrate' },
    { role: 'Coder', type: 'coder', count: 3, purpose: 'Implement' },
    { role: 'Tester', type: 'tester', count: 2, purpose: 'QA' },
  ];

  it('expands counts into uniquely-named per-role workers', () => {
    const specs = buildWorkerSpecs('build a thing', plan, { maxAgents: 99, model: 'haiku' });
    expect(specs.map((s) => s.name)).toEqual([
      'coordinator', 'coder-1', 'coder-2', 'coder-3', 'tester-1', 'tester-2',
    ]);
    expect(specs.every((s) => s.model === 'haiku')).toBe(true);
  });

  it('caps the roster at maxAgents, preserving plan order (coordinator survives)', () => {
    const specs = buildWorkerSpecs('build a thing', plan, { maxAgents: 2, model: 'sonnet' });
    expect(specs.map((s) => s.name)).toEqual(['coordinator', 'coder-1']);
  });

  it('embeds the objective as literal prompt text, and gives each role a distinct instruction', () => {
    const coord = buildWorkerPrompt('SHIP THE FEATURE', 'coordinator', 'Orchestrate', { index: 1, total: 1 });
    const coder = buildWorkerPrompt('SHIP THE FEATURE', 'coder', 'Implement', { index: 1, total: 1 });
    expect(coord).toContain('SHIP THE FEATURE');
    expect(coder).toContain('SHIP THE FEATURE');
    expect(coord).toContain('Decompose');
    expect(coder).toContain('Implement the objective directly');
    expect(coord).not.toBe(coder);
  });
});

// ---------------------------------------------------------------------------
// Pure: NDJSON reshaping against a REAL captured stream-json fixture
// ---------------------------------------------------------------------------
describe('shapeStreamLine (against real claude stream-json capture)', () => {
  const fixed = () => '2026-01-01T00:00:00.000Z';
  const lines = readFileSync(FIXTURE, 'utf-8').split('\n').filter(Boolean);

  it('maps system:init to a status event', () => {
    const initLine = lines.find((l) => l.includes('"subtype":"init"'))!;
    const evs = shapeStreamLine(initLine, 'coder', 'coder', fixed);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe('status');
  });

  it('maps assistant text to token and tool_use to tool, capturing file_path artifacts', () => {
    const all: SwarmEvent[] = lines.flatMap((l) => shapeStreamLine(l, 'coder', 'coder', fixed));
    expect(all.some((e) => e.kind === 'token')).toBe(true);
    const toolWithFile = all.find((e) => e.kind === 'tool' && e.file);
    expect(toolWithFile).toBeDefined();
    expect(toolWithFile!.file).toContain('/tmp/');
    expect(artifactsFromEvents(all).length).toBeGreaterThanOrEqual(1);
  });

  it('maps the result line to a result event', () => {
    const resultLine = lines.find((l) => l.includes('"type":"result"'))!;
    const evs = shapeStreamLine(resultLine, 'coder', 'coder', fixed);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe('result');
  });

  it('is_error result becomes an error event', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom' });
    const evs = shapeStreamLine(line, 'coder', 'coder', fixed);
    expect(evs[0].kind).toBe('error');
    expect(evs[0].data).toBe('boom');
  });

  it('never silently swallows a non-JSON line (surfaces as status)', () => {
    const evs = shapeStreamLine('not json at all', 'coder', 'coder', fixed);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe('status');
  });

  it('every shaped event carries agent, role, kind, ts', () => {
    const all = lines.flatMap((l) => shapeStreamLine(l, 'tester', 'tester', fixed));
    for (const e of all) {
      expect(e.agent).toBe('tester');
      expect(e.role).toBe('tester');
      expect(e.ts).toBe('2026-01-01T00:00:00.000Z');
      expect(typeof e.kind).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Pure: redaction (applied to every streamed byte)
// ---------------------------------------------------------------------------
describe('redact', () => {
  it('strips Anthropic/OpenAI keys, bearer tokens, and KEY=val secrets', () => {
    expect(redact('key sk-ant-abc123def456ghi here')).not.toContain('sk-ant-abc123');
    expect(redact('OPENAI_API_KEY=sk-1234567890abcdef1234')).toContain('[REDACTED]');
    expect(redact('Authorization: Bearer abcdef123456ghijkl')).toContain('[REDACTED]');
    expect(redact('token=ghp_0123456789abcdefghij0123456789abcdef')).toContain('[REDACTED]');
  });
  it('leaves ordinary text untouched', () => {
    expect(redact('created /tmp/x/hello.txt with HELLO-SWARM')).toBe('created /tmp/x/hello.txt with HELLO-SWARM');
  });
  it('is applied by shapeStreamLine to token data', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'my key is sk-ant-supersecretvalue99' }] } });
    const evs = shapeStreamLine(line, 'a', 'a', () => 'ts');
    expect(evs[0].data).not.toContain('supersecret');
  });
});

// ---------------------------------------------------------------------------
// Pure: overview builder
// ---------------------------------------------------------------------------
describe('buildOverview / renderOverviewCard', () => {
  const workers = [
    { name: 'coder', role: 'coder', model: 'haiku', status: 'ok' as const, summary: 'done', files: ['/tmp/e2e/hello.txt'], costUsd: 0.2 },
    { name: 'tester', role: 'tester', model: 'haiku', status: 'failed' as const, summary: '', files: [], costUsd: null, error: 'exit 1' },
  ];
  it('unions worker files with extra artifacts and lists roster + next steps', () => {
    const o = buildOverview({
      objective: 'do X', swarmId: 's1', topology: 'hierarchical', consensus: 'raft', strategy: 'development',
      workers, extraArtifacts: ['/tmp/e2e/extra.md'], transcriptPath: '/t/transcript.ndjson', elapsedMs: 1234, reduce: 'merged',
    });
    expect(o.artifacts).toContain('/tmp/e2e/hello.txt');
    expect(o.artifacts).toContain('/tmp/e2e/extra.md');
    expect(o.roster.map((r) => r.name)).toEqual(['coder', 'tester']);
    expect(o.nextSteps.some((s) => s.includes('failed'))).toBe(true);
    expect(o.transcriptPath).toBe('/t/transcript.ndjson');
  });
  it('ADR-069 no-key fallback: when all workers fail on auth, next steps point to the defer path', () => {
    const authFailed = [
      { name: 'coordinator', role: 'coordinator', model: 'sonnet', status: 'failed' as const, summary: '', files: [], costUsd: null, error: 'exit code 1: Invalid API key · 401 authentication_error' },
    ];
    const o = buildOverview({
      objective: 'do X', swarmId: 's1', topology: 'hierarchical', consensus: 'raft', strategy: 'development',
      workers: authFailed, elapsedMs: 500, reduce: 'merged',
    });
    expect(o.nextSteps.some((s) => s.includes('No usable model auth'))).toBe(true);
    expect(o.nextSteps.some((s) => s.includes('claude -p') || s.includes('hive-mind') || s.includes('--no-execute'))).toBe(true);
  });

  it('does NOT trigger the no-key fallback when a worker succeeds', () => {
    const o = buildOverview({
      objective: 'do X', swarmId: 's1', topology: 'hierarchical', consensus: 'raft', strategy: 'development',
      workers, elapsedMs: 500, reduce: 'merged', // `workers` has one ok, one non-auth failure
    });
    expect(o.nextSteps.some((s) => s.includes('No usable model auth'))).toBe(false);
  });

  it('renders a human card naming artifacts and worker status', () => {
    const o = buildOverview({
      objective: 'do X', swarmId: 's1', topology: 'hierarchical', consensus: 'raft', strategy: 'development',
      workers, elapsedMs: 1000, reduce: 'merged',
    });
    const card = renderOverviewCard(o);
    expect(card).toContain('/tmp/e2e/hello.txt');
    expect(card).toContain('FAILED');
    expect(card).toContain('do X');
  });
});

// ---------------------------------------------------------------------------
// Engine: spawn against fixture scripts (injectable binary seam)
// ---------------------------------------------------------------------------
function writeFixtureBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

// Emits the captured stream-json fixture line-by-line, then exits 0. Also
// records the received argv and stdin to files in cwd so tests can prove the
// objective/prompt travelled over stdin, never argv (the shell-safety guard).
function streamerScript(): string {
  const fixtureData = readFileSync(FIXTURE, 'utf-8');
  return `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const lines = ${JSON.stringify(fixtureData)}.split('\\n').filter(Boolean);
fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(process.argv.slice(2)));
let chunks = '';
process.stdin.on('data', d => chunks += d);
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), 'stdin.txt'), chunks);
  let i = 0;
  const tick = () => {
    if (i < lines.length) { process.stdout.write(lines[i++] + '\\n'); setTimeout(tick, 5); }
    else process.exit(0);
  };
  tick();
});
`;
}

describe('spawnWorker (executable fixture, full seam)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-exec-'));

  it('SECURITY: a malicious objective reaches the child via stdin, never argv', async () => {
    const sdir = mkdtempSync(join(tmpdir(), 'swarm-sec-'));
    const bin = writeFixtureBin(sdir, 'streamer', streamerScript());
    const events: SwarmEvent[] = [];
    const malicious = '"; rm -rf ~ #';
    const res = await spawnWorker(
      { name: 'coder', role: 'coder', model: 'haiku', prompt: malicious },
      { cwd: sdir, timeoutMs: 10000, allowedTools: DEFAULT_ALLOWED_TOOLS, claudeBin: bin, onEvent: (e) => events.push(e) },
    );
    expect(res.status).toBe('ok');
    // The child recorded exactly what it received: argv has NO objective text,
    // stdin IS the objective verbatim.
    const argv = JSON.parse(readFileSync(join(sdir, 'argv.json'), 'utf-8')) as string[];
    expect(argv).toContain('-p'); // real flags are present…
    expect(JSON.stringify(argv)).not.toContain('rm -rf'); // …but the objective is not
    expect(readFileSync(join(sdir, 'stdin.txt'), 'utf-8')).toBe(malicious);
    // live streaming happened and tool_use file_path artifacts were captured
    expect(events.some((e) => e.kind === 'token')).toBe(true);
    expect(res.files.some((f) => f.includes('/tmp/'))).toBe(true);
  });

  it('surfaces a nonzero exit as a failed result (no silent swallow)', async () => {
    const bin = writeFixtureBin(dir, 'boom', `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => { process.stderr.write('kaboom\\n'); process.exit(3); });
`);
    const events: SwarmEvent[] = [];
    const res = await spawnWorker(
      { name: 'x', role: 'coder', model: 'haiku', prompt: 'p' },
      { cwd: dir, timeoutMs: 10000, allowedTools: DEFAULT_ALLOWED_TOOLS, claudeBin: bin, onEvent: (e) => events.push(e) },
    );
    expect(res.status).toBe('failed');
    expect(res.error).toContain('exit code 3');
  });

  it('kills a hung worker on per-worker timeout and marks it failed', async () => {
    const bin = writeFixtureBin(dir, 'hang', `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000); // never exits
`);
    const events: SwarmEvent[] = [];
    const start = Date.now();
    const res = await spawnWorker(
      { name: 'h', role: 'coder', model: 'haiku', prompt: 'p' },
      { cwd: dir, timeoutMs: 700, allowedTools: DEFAULT_ALLOWED_TOOLS, claudeBin: bin, onEvent: (e) => events.push(e) },
    );
    expect(Date.now() - start).toBeLessThan(9000);
    expect(res.status).toBe('failed');
    expect(events.some((e) => e.kind === 'error' && e.data.includes('timed out'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine: full run — bounded concurrency + overview + transcript + guidance
// ---------------------------------------------------------------------------
describe('runSwarmExecution (fixture binary)', () => {
  it('runs the roster, streams events, writes a transcript, and emits an overview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-run-'));
    const bin = writeFixtureBin(dir, 'streamer', streamerScript());
    const specs = buildWorkerSpecs('do a task', [
      { role: 'Coder', type: 'coder', count: 2, purpose: 'Implement' },
    ], { maxAgents: 2, model: 'haiku' });
    const events: SwarmEvent[] = [];
    const sessionDir = sessionDirFor(dir, 'swarm-test');
    const { overview, workers } = await runSwarmExecution({
      objective: 'do a task', swarmId: 'swarm-test', specs, cwd: dir,
      topology: 'hierarchical', consensus: 'raft', strategy: 'development',
      maxParallel: 2, deadlineSecs: 30, allowedTools: DEFAULT_ALLOWED_TOOLS,
      claudeBin: bin, sessionDir, onEvent: (e) => events.push(e),
    });
    expect(workers).toHaveLength(2);
    expect(workers.every((w) => w.status === 'ok')).toBe(true);
    // terminal overview event on the stream
    const ovEvent = events.find((e) => e.kind === 'overview');
    expect(ovEvent).toBeDefined();
    expect(ovEvent!.overview!.roster).toHaveLength(2);
    expect(overview.reduce).toContain('2 ok');
    // transcript written
    expect(existsSync(join(sessionDir, 'transcript.ndjson'))).toBe(true);
  });

  it('injects operator guidance from the inbox into worker prompts (I3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-guide-'));
    const sessionDir = sessionDirFor(dir, 'g1');
    appendGuidance(sessionDir, 'prioritize the auth module');
    expect(readGuidance(sessionDir)).toContain('prioritize the auth module');

    // The streamer records the prompt it received on stdin; assert the
    // guidance text was actually merged into that prompt.
    const bin = writeFixtureBin(dir, 'streamer', streamerScript());
    const specs = buildWorkerSpecs('do a task', [
      { role: 'Coder', type: 'coder', count: 1, purpose: 'Implement' },
    ], { maxAgents: 1, model: 'haiku' });
    const events: SwarmEvent[] = [];
    await runSwarmExecution({
      objective: 'do a task', swarmId: 'g1', specs, cwd: dir,
      topology: 'hierarchical', consensus: 'raft', strategy: 'development',
      maxParallel: 1, deadlineSecs: 30, claudeBin: bin, sessionDir,
      onEvent: (e) => events.push(e),
    });
    const stdinSeen = readFileSync(join(dir, 'stdin.txt'), 'utf-8');
    expect(stdinSeen).toContain('OPERATOR GUIDANCE');
    expect(stdinSeen).toContain('prioritize the auth module');
    expect(readFileSync(join(sessionDir, 'transcript.ndjson'), 'utf-8').length).toBeGreaterThan(0);
  });
});

describe('detectGitArtifacts', () => {
  it('returns [] outside a git repo without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-nogit-'));
    expect(detectGitArtifacts(dir)).toEqual([]);
  });
});
