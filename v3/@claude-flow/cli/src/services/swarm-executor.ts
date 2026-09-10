/**
 * Swarm executor — streaming multi-agent execution engine (ADR-385).
 *
 * `swarm start --execute` builds a roster from the strategy plan, spawns each
 * planned worker as a real headless `claude -p` subprocess, and interleaves
 * their reshaped output as NDJSON events on a single sink. A bounded pool and
 * a global deadline keep fan-out finite; the process group is killed on
 * timeout. After the workers finish (or the deadline fires) a deterministic
 * reduce summarizes, and a terminal `overview` event says what was done,
 * where the artifacts are, and how to run/deploy them.
 *
 * SECURITY: the objective is untrusted text. It reaches the model only as a
 * prompt piped over the child's stdin (never a shell string, never a
 * positional argv token), so a `"; rm -rf ~"` objective is inert. Subprocesses
 * spawn with an argv array and `shell:false`. Capability is bounded by
 * `--allowedTools`; there is no `--dangerously-skip-permissions` here. Secrets
 * are redacted from every streamed byte (see swarm-executor-events.ts).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  type SwarmEvent,
  type WorkerSpec,
  type WorkerResult,
  type WorkerStatus,
  type SwarmOverview,
  buildOverview,
  shapeStreamLine,
} from './swarm-executor-events.js';

export type { SwarmEvent, WorkerSpec, WorkerResult, SwarmOverview } from './swarm-executor-events.js';
// Re-export the pure helpers so callers have a single import surface.
export { buildWorkerSpecs, buildWorkerPrompt, renderOverviewCard, redact, shapeStreamLine } from './swarm-executor-events.js';

/** Default headless capability grant. Bounded, not skip-permissions. */
export const DEFAULT_ALLOWED_TOOLS = 'Read,Write,Edit,Bash,Glob,Grep';

export interface SpawnWorkerOptions {
  cwd: string;
  timeoutMs: number;
  allowedTools: string;
  /** Injectable binary — tests point this at a fixture script. */
  claudeBin?: string;
  /** Called for every reshaped event as it arrives (live streaming). */
  onEvent: (e: SwarmEvent) => void;
  /** External abort (global deadline) — resolves the worker as partial. */
  signal?: AbortSignal;
}

/**
 * Spawn one headless worker and stream its reshaped output. Never rejects —
 * every failure is surfaced as a `kind:"error"` event and a WorkerResult with
 * status `failed`/`partial` (COROLLARY 7: no silent swallow).
 */
export function spawnWorker(spec: WorkerSpec, opts: SpawnWorkerOptions): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolve) => {
    const files = new Set<string>();
    let lastResult = '';
    let hadOutput = false;
    let sawError = false;
    let stderr = '';
    let costUsd: number | null = null;
    let settled = false;

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_CODE_HEADLESS: 'true',
      CLAUDE_ENTRYPOINT: 'worker',
    };
    // Drop parent-session markers so the child doesn't detect a nested session
    // and exit immediately (headless-worker-executor.ts:1354-1362).
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_PARENT_SESSION_ID;

    const bin = opts.claudeBin ?? 'claude';
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', spec.model,
      '--allowedTools', opts.allowedTools,
    ];

    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onEvent({ agent: spec.name, role: spec.role, kind: 'error', data: `spawn failed: ${msg}`, ts: new Date().toISOString() });
      resolve({ name: spec.name, role: spec.role, model: spec.model, status: 'failed', summary: '', files: [], costUsd: null, error: msg });
      return;
    }

    // Prompt via stdin — untrusted objective never touches a shell or argv.
    try {
      child.stdin?.end(spec.prompt);
    } catch {
      /* stdin already closed; the error/close handler surfaces the cause */
    }

    const killTree = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
      }
      try { child.kill(signal); } catch { /* already dead */ }
    };

    let timedOut = false;
    let aborted = false;
    const finishTimers: NodeJS.Timeout[] = [];
    const hardKill = () => {
      const t = setTimeout(() => { if (!child.killed) killTree('SIGKILL'); }, 5000);
      finishTimers.push(t);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      opts.onEvent({ agent: spec.name, role: spec.role, kind: 'error', data: `timed out after ${Math.round(opts.timeoutMs / 1000)}s`, ts: new Date().toISOString() });
      killTree('SIGTERM');
      hardKill();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      opts.onEvent({ agent: spec.name, role: spec.role, kind: 'error', data: 'global deadline reached — terminating', ts: new Date().toISOString() });
      killTree('SIGTERM');
      hardKill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const events = shapeStreamLine(line, spec.name, spec.role);
      for (const e of events) {
        hadOutput = true;
        if (e.file) files.add(e.file);
        if (e.kind === 'result') lastResult = e.data;
        if (e.kind === 'error') sawError = true;
        opts.onEvent(e);
      }
      // Capture cost from the raw result line (not exposed on the shaped event).
      const t = line.trim();
      if (t.startsWith('{') && t.includes('"total_cost_usd"')) {
        try {
          const j = JSON.parse(t);
          if (typeof j.total_cost_usd === 'number') costUsd = j.total_cost_usd;
        } catch { /* ignore */ }
      }
    });

    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const t of finishTimers) clearTimeout(t);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      rl.close();

      let status: WorkerStatus;
      let error: string | undefined;
      if (timedOut || aborted) {
        status = hadOutput ? 'partial' : 'failed';
        error = timedOut ? 'timed out' : 'global deadline reached';
      } else if (code === 0 && !sawError) {
        status = 'ok';
      } else {
        status = hadOutput && !sawError ? 'partial' : 'failed';
        error = sawError ? 'worker reported an error event' : `exit code ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`;
      }
      resolve({
        name: spec.name,
        role: spec.role,
        model: spec.model,
        status,
        summary: lastResult,
        files: [...files],
        costUsd,
        error,
      });
    };

    child.on('close', done);
    child.on('error', (err) => {
      opts.onEvent({ agent: spec.name, role: spec.role, kind: 'error', data: `process error: ${err.message}`, ts: new Date().toISOString() });
      done(null);
    });
  });
}

export interface RunSwarmOptions {
  objective: string;
  swarmId: string;
  specs: WorkerSpec[];
  cwd: string;
  topology: string;
  consensus: string;
  strategy: string;
  maxParallel: number;
  deadlineSecs: number;
  perWorkerTimeoutSecs?: number;
  allowedTools?: string;
  claudeBin?: string;
  /** Session dir for transcript + guidance inbox (I3). */
  sessionDir?: string;
  onEvent: (e: SwarmEvent) => void;
}

export interface RunSwarmResult {
  overview: SwarmOverview;
  workers: WorkerResult[];
}

/**
 * Run the roster with bounded concurrency and a global deadline, streaming
 * every reshaped event live via `onEvent`, then reduce into an overview.
 */
export async function runSwarmExecution(opts: RunSwarmOptions): Promise<RunSwarmResult> {
  const start = Date.now();
  const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const deadlineMs = Math.max(1, opts.deadlineSecs) * 1000;
  const perWorkerMs = Math.max(1, opts.perWorkerTimeoutSecs ?? opts.deadlineSecs) * 1000;
  const maxParallel = Math.max(1, Math.floor(opts.maxParallel));

  // Global deadline: one controller aborts every in-flight worker.
  const controller = new AbortController();
  const globalTimer = setTimeout(() => controller.abort(), deadlineMs);

  // Transcript sink (append each event as raw NDJSON).
  let transcriptPath: string | null = null;
  let transcriptStream: fs.WriteStream | null = null;
  if (opts.sessionDir) {
    try {
      fs.mkdirSync(opts.sessionDir, { recursive: true });
      transcriptPath = path.join(opts.sessionDir, 'transcript.ndjson');
      transcriptStream = fs.createWriteStream(transcriptPath, { flags: 'a' });
    } catch { transcriptPath = null; }
  }

  // Guidance inbox (I3): accumulated lines injected into each worker prompt.
  const guidance = opts.sessionDir ? readGuidance(opts.sessionDir) : [];

  const emit = (e: SwarmEvent) => {
    try { transcriptStream?.write(JSON.stringify(e) + '\n'); } catch { /* best-effort */ }
    opts.onEvent(e);
  };

  const results: WorkerResult[] = [];
  const queue = [...opts.specs];
  let cursor = 0;

  const runOne = async (): Promise<void> => {
    while (cursor < queue.length && !controller.signal.aborted) {
      const spec = queue[cursor++];
      // Inject any guidance present at dispatch time (polled "between turns").
      const fresh = opts.sessionDir ? readGuidance(opts.sessionDir) : guidance;
      const withGuidance = fresh.length
        ? { ...spec, prompt: `${spec.prompt}\n\nOPERATOR GUIDANCE (incorporate this):\n${fresh.map((g) => `- ${g}`).join('\n')}` }
        : spec;
      emit({ agent: spec.name, role: spec.role, kind: 'status', data: 'dispatched', ts: new Date().toISOString() });
      const res = await spawnWorker(withGuidance, {
        cwd: opts.cwd,
        timeoutMs: perWorkerMs,
        allowedTools,
        claudeBin: opts.claudeBin,
        onEvent: emit,
        signal: controller.signal,
      });
      results.push(res);
    }
  };

  const pool = Array.from({ length: Math.min(maxParallel, queue.length) }, () => runOne());
  await Promise.all(pool);
  clearTimeout(globalTimer);

  // Deterministic reduce (I1). An LLM coordinator reduce is deferred (I1.5).
  const ok = results.filter((r) => r.status === 'ok').length;
  const partial = results.filter((r) => r.status === 'partial').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const reduce = `deterministic merge — ${ok} ok, ${partial} partial, ${failed} failed of ${results.length}`;

  const gitArtifacts = detectGitArtifacts(opts.cwd);

  const overview = buildOverview({
    objective: opts.objective,
    swarmId: opts.swarmId,
    topology: opts.topology,
    consensus: opts.consensus,
    strategy: opts.strategy,
    workers: results,
    extraArtifacts: gitArtifacts,
    transcriptPath,
    elapsedMs: Date.now() - start,
    reduce,
  });

  emit({ agent: 'coordinator', role: 'coordinator', kind: 'overview', data: reduce, ts: new Date().toISOString(), overview });

  try { transcriptStream?.end(); } catch { /* ignore */ }

  return { overview, workers: results };
}

/**
 * Absolute paths of files changed in the cwd's git working tree since the run
 * (best-effort; unioned with tool_use-derived paths in buildOverview). Returns
 * [] when cwd is not a git repo.
 */
export function detectGitArtifacts(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'], // silence "not a git repository" on stderr
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^.{1,2}\s+/, '').replace(/^"|"$/g, ''))
      .map((rel) => path.resolve(cwd, rel));
  } catch {
    return [];
  }
}

// --- guidance inbox (I3) ---------------------------------------------------

/** Append an operator guidance message to a session's inbox. */
export function appendGuidance(sessionDir: string, message: string): void {
  fs.mkdirSync(sessionDir, { recursive: true });
  const entry = { ts: new Date().toISOString(), message };
  fs.appendFileSync(path.join(sessionDir, 'inbox.jsonl'), JSON.stringify(entry) + '\n');
}

/** Read all guidance messages from a session's inbox (empty if none). */
export function readGuidance(sessionDir: string): string[] {
  const p = path.join(sessionDir, 'inbox.jsonl');
  try {
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try { return String(JSON.parse(l).message ?? ''); } catch { return ''; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Path of a swarm session directory under `.swarm/sessions/<id>`. */
export function sessionDirFor(cwd: string, swarmId: string): string {
  return path.join(cwd, '.swarm', 'sessions', swarmId);
}
