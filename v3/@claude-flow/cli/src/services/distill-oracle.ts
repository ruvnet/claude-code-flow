/**
 * distill-oracle.ts — Tiered `resolved` oracle for distill / weight-EFT SFT data.
 *
 * THE PROBLEM: weight-EFT's SFT data wants a gold `resolved: boolean` per
 * trajectory. Ruflo has no SWE-bench oracle, so today `resolved` is
 * structural-confidence — a proxy that risks distilling plausible-but-wrong
 * completions. This module replaces that single proxy with a TIERED labeler,
 * where every label carries HONEST PROVENANCE (ADR-169 reporting integrity — a
 * proxy is never presented as ground truth).
 *
 * ── TIERS (tried in order, per trajectory) ──────────────────────────────────
 *   TIER 1 — MECHANICAL ORACLE  (provenance `oracle:test-exec`, real ground truth)
 *     When a trajectory carries a test spec (SWE-bench FAIL_TO_PASS shape) or
 *     maps to a metaharness/darwin bench-suite case, EXECUTE the real eval and
 *     set resolved = tests-pass. This needs Docker/compute, so it runs on a
 *     REMOTE host over SSH (host parameterized via `remote` / env
 *     RUFLO_DISTILL_REMOTE — never hard-coded). DRY-RUN by default: it prints
 *     the ssh/darwin-bench/eval commands + a preflight plan and does NOT touch
 *     the network; only `execute: true` runs the real eval (with a wrapped,
 *     non-fatal preflight probe first).
 *
 *   TIER 2 — FABLE JUDGE  (provenance `judge:fable`, smarter proxy)
 *     For trajectories with no mechanical spec, judge via the cost-disciplined
 *     headless Fable harness (fable-harness.ts). Opt-in and OFF by default;
 *     spends nothing unless `fableJudge: true` AND a `maxBudgetUsd` cap is set.
 *
 *   TIER 3 — STRUCTURAL PROXY  (provenance `proxy:structural`, weakest)
 *     The existing output-verifier structural confidence. Always available,
 *     $0, no external calls. Explicitly the weakest signal, clearly labeled.
 *
 * DEFAULT (no opts): dry-run oracle preflight + structural-proxy fallback.
 * ZERO spend, no SSH exec, no Fable call. Everything degrades gracefully
 * (ADR-150) — a missing remote or a failed probe is reported, never fatal.
 *
 * @module services/distill-oracle
 */

import { spawn } from 'child_process';
import { verifyAndEscalate, type VerifyTaskKind } from '../ruvector/output-verifier.js';
import {
  FableHarness,
  type JudgeItem,
  type JudgeResult,
  type ReflectItem,
  type ReflectResult,
} from './fable-harness.js';

// Pinned @metaharness/darwin version for the Tier-1 mechanical oracle's `npx`
// invocations. Bare `npx --yes @metaharness/darwin` floats to whatever npm
// `latest` is, so a breaking darwin release could silently change eval
// behavior mid-run (the #142 pin-drift failure mode). Pin it, and let
// scripts/check-metaharness-pins.mjs watch this constant for drift. Kept in
// lock-step with the optionalDependencies pin in package.json and the plugin
// darwin cache (versioned by the plugin's own `~0.8.0` pin in _darwin.mjs).
export const MH_DARWIN_PIN = '0.10.2';

// ── Provenance ─────────────────────────────────────────────────────────────

export type ResolvedProvenance = 'oracle:test-exec' | 'judge:fable' | 'proxy:structural';

// ── Trajectory / spec shapes ────────────────────────────────────────────────

/** SWE-bench-shaped / bench-suite-mapped test spec that Tier 1 can execute. */
export interface TestSpec {
  /** SWE-bench FAIL_TO_PASS tests — must go red→green for `resolved`. */
  failToPass?: string[];
  /** SWE-bench PASS_TO_PASS tests — must stay green (no regressions). */
  passToPass?: string[];
  /** Repo identifier (for the remote checkout). */
  repo?: string;
  /** Base commit the patch applies onto. */
  baseCommit?: string;
  /** Candidate patch/diff to apply before evaluating. */
  patch?: string;
  /** An explicit eval command that returns 0 iff the task is resolved. */
  evalCommand?: string;
  /** metaharness/darwin bench-suite this case belongs to. */
  benchSuite?: string;
  /** Case id within the bench suite. */
  benchCase?: string;
  /** Working directory on the remote host (default derived). */
  workdir?: string;
}

/**
 * Minimal trajectory contract. Extra fields are preserved verbatim on output
 * (the labeler spreads `...trajectory`). `task`/`output` feed the fable judge
 * and structural proxy; `testSpec` (when present) unlocks Tier 1.
 */
export interface Trajectory {
  id: string;
  task?: string;
  output?: string;
  testSpec?: TestSpec;
  /** Hint for the structural verifier's task-kind detection. */
  taskKind?: VerifyTaskKind;
  [key: string]: unknown;
}

// ── Options / results ───────────────────────────────────────────────────────

export interface LabelOptions {
  /** SSH host for Tier-1 execution. Falls back to env RUFLO_DISTILL_REMOTE. Never hard-coded. */
  remote?: string;
  /** Run the REAL Tier-1 eval over SSH. Default false → dry-run preflight only. */
  execute?: boolean;
  /** Enable the Tier-2 Fable judge. Default false. Requires maxBudgetUsd to spend. */
  fableJudge?: boolean;
  /** Hard budget cap (USD) for the Fable tier. No cap ⇒ no Fable spend. */
  maxBudgetUsd?: number;
  /** Items per Fable call (default 20 — see FABLE_COST_MODEL). */
  fableBatchSize?: number;
  /** Structural verifier: min score to call a trajectory resolved (default: strict — confident only). */
  minStructuralConfidence?: number;
  /** Injected Tier-1 runner (tests). Defaults to a real SSH command runner. */
  runner?: OracleRunner;
  /** Injected Tier-2 harness (tests). Defaults to a real FableHarness. */
  harness?: FableHarness;
}

/** A trajectory with its resolved label + honest provenance. */
export type LabeledTrajectory<T extends Trajectory = Trajectory> = T & {
  resolved: boolean;
  resolvedBy: ResolvedProvenance;
  resolvedConfidence?: number;
  resolvedReason?: string;
  /** Present for trajectories that had a mechanical spec — the Tier-1 plan/outcome. */
  oraclePreflight?: OraclePreflight;
};

// ── Tier-1 oracle plan / runner ──────────────────────────────────────────────

export type OracleKind = 'ssh-darwin-bench' | 'ssh-swebench-eval' | 'ssh-eval' | 'local-eval';

/** The concrete command plan for executing a trajectory's eval on the remote. */
export interface OraclePlan {
  kind: OracleKind;
  /** Resolved remote host, or null when none is configured. */
  remote: string | null;
  /** Preflight probe commands (reachability, docker/darwin presence). */
  probeCommands: string[];
  /** The eval commands whose success ⇒ resolved. */
  evalCommands: string[];
  /** Human note describing how the resolved boolean is derived. */
  parseHint: string;
}

/** Preflight/dry-run record attached to labeled trajectories that had a spec. */
export interface OraclePreflight {
  /** True when nothing was executed (default path). */
  dryRun: boolean;
  plan: OraclePlan;
  /** Probe outcome when executed (execute:true); absent in dry-run. */
  probe?: { ok: boolean; reason: string };
  /** Why Tier 1 did not produce the final label (e.g. dry-run, no remote, probe failed). */
  fellThroughBecause?: string;
}

/** Outcome of a real Tier-1 eval. */
export interface OracleOutcome {
  resolved: boolean;
  reason: string;
}

/** Result of a shelled command. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Injectable command executor (tests mock this instead of touching SSH). */
export type CommandExec = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<CommandResult>;

/** Tier-1 runner contract: probe the remote, then run the eval. */
export interface OracleRunner {
  preflight(plan: OraclePlan): Promise<{ ok: boolean; reason: string }>;
  runEval(plan: OraclePlan, spec: TestSpec): Promise<OracleOutcome>;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Label each trajectory with `resolved` + honest provenance, trying the tiers
 * in order per trajectory. See the module header for tier semantics and the
 * zero-spend default guarantee.
 */
export async function labelResolved<T extends Trajectory>(
  trajectories: T[],
  opts: LabelOptions = {},
): Promise<Array<LabeledTrajectory<T>>> {
  const results: Array<LabeledTrajectory<T> | undefined> = new Array(trajectories.length);
  const preflights = new Map<number, OraclePreflight>();

  const remote = resolveRemote(opts.remote);
  const fableActive = Boolean(opts.fableJudge) && Number(opts.maxBudgetUsd) > 0;

  // ── Tier 1: mechanical oracle (real exec only under execute:true) ──────────
  const fableQueue: Array<{ index: number; item: JudgeItem }> = [];

  for (let i = 0; i < trajectories.length; i++) {
    const t = trajectories[i];
    if (hasMechanicalSpec(t)) {
      const plan = buildOraclePlan(t.testSpec!, remote);
      if (opts.execute) {
        const runner = opts.runner ?? createSshOracleRunner();
        // Wrapped probe: a failure is REPORTED, not thrown.
        const probe = await safeProbe(runner, plan);
        if (probe.ok) {
          const outcome = await safeRunEval(runner, plan, t.testSpec!);
          results[i] = {
            ...t,
            resolved: outcome.resolved,
            resolvedBy: 'oracle:test-exec',
            resolvedConfidence: 1,
            resolvedReason: outcome.reason,
            oraclePreflight: { dryRun: false, plan, probe },
          };
          continue;
        }
        // Probe failed → report and fall through to next tier.
        preflights.set(i, {
          dryRun: false,
          plan,
          probe,
          fellThroughBecause: `preflight failed: ${probe.reason}`,
        });
      } else {
        // DRY-RUN: emit the plan/commands, touch nothing, fall through.
        preflights.set(i, {
          dryRun: true,
          plan,
          fellThroughBecause: remote
            ? 'dry-run (pass execute:true to run the real eval over SSH)'
            : 'dry-run and no remote configured (set remote / RUFLO_DISTILL_REMOTE)',
        });
      }
    }

    // ── Route to Tier 2 (batched later) or Tier 3 now ──
    if (fableActive) {
      fableQueue.push({ index: i, item: toJudgeItem(t) });
    } else {
      results[i] = await proxyLabel(t, opts, preflights.get(i));
    }
  }

  // ── Tier 2: batched Fable judge for queued items ──────────────────────────
  if (fableActive && fableQueue.length > 0) {
    const harness =
      opts.harness ??
      new FableHarness({ maxBudgetUsd: opts.maxBudgetUsd, batchSize: opts.fableBatchSize });
    let verdicts: JudgeResult[] = [];
    try {
      verdicts = await harness.judgeBatch(fableQueue.map((q) => q.item));
    } catch {
      verdicts = []; // graceful: any harness failure ⇒ proxy fallback for all
    }
    const byId = new Map(verdicts.map((v) => [v.id, v]));
    for (const { index, item } of fableQueue) {
      const v = byId.get(item.id);
      const t = trajectories[index];
      if (v) {
        results[index] = {
          ...t,
          resolved: v.resolved,
          resolvedBy: 'judge:fable',
          resolvedConfidence: v.confidence,
          resolvedReason: v.reason,
          ...(preflights.has(index) ? { oraclePreflight: preflights.get(index) } : {}),
        };
      } else {
        // Model omitted this id / budget exhausted → Tier-3 proxy fallback.
        results[index] = await proxyLabel(t, opts, preflights.get(index));
      }
    }
  }

  // ── Safety net: nothing should be undefined, but fall back to proxy if so ──
  for (let i = 0; i < results.length; i++) {
    if (results[i] === undefined) {
      results[i] = await proxyLabel(trajectories[i], opts, preflights.get(i));
    }
  }

  return results as Array<LabeledTrajectory<T>>;
}

/**
 * Reflective failure analysis (GEPA/evolve mutation input). Thin, cost-
 * disciplined pass-through to the Fable harness. Opt-in: returns [] unless a
 * harness with a budget cap is provided/configured.
 */
export async function reflectFailures(
  items: ReflectItem[],
  opts: { maxBudgetUsd?: number; fableBatchSize?: number; harness?: FableHarness } = {},
): Promise<ReflectResult[]> {
  const harness =
    opts.harness ??
    new FableHarness({ maxBudgetUsd: opts.maxBudgetUsd, batchSize: opts.fableBatchSize });
  if (!harness.isEnabled()) return [];
  return harness.reflectFailures(items);
}

// ── Tier-3 structural proxy ──────────────────────────────────────────────

async function proxyLabel<T extends Trajectory>(
  t: T,
  opts: LabelOptions,
  preflight?: OraclePreflight,
): Promise<LabeledTrajectory<T>> {
  const verdict = await verifyAndEscalate({
    task: t.task ?? '',
    output: t.output ?? '',
    taskKind: t.taskKind,
  });
  const threshold = opts.minStructuralConfidence;
  const resolved =
    typeof threshold === 'number' ? verdict.score >= threshold : verdict.confident;
  return {
    ...t,
    resolved,
    resolvedBy: 'proxy:structural',
    resolvedConfidence: verdict.score,
    resolvedReason: verdict.confident
      ? 'structural signals confident'
      : `structural signals weak: ${verdict.reasons.slice(0, 3).join('; ')}`,
    ...(preflight ? { oraclePreflight: preflight } : {}),
  };
}

// ── Tier-1 planning ──────────────────────────────────────────────────────

/** A trajectory can be mechanically evaluated iff it carries an actionable spec. */
export function hasMechanicalSpec(t: Trajectory): boolean {
  const s = t.testSpec;
  if (!s) return false;
  return Boolean(
    (s.failToPass && s.failToPass.length > 0) ||
      s.evalCommand ||
      s.benchSuite ||
      s.benchCase,
  );
}

/** Resolve the remote host from opts → env, never a hard-coded host. */
export function resolveRemote(remote?: string): string | null {
  const r = (remote ?? process.env.RUFLO_DISTILL_REMOTE ?? '').trim();
  return r.length > 0 ? r : null;
}

/**
 * Build the concrete command plan for a spec. Pure — constructs command strings
 * only; executes nothing. `remote` is always substituted from the parameter,
 * never hard-coded.
 */
export function buildOraclePlan(spec: TestSpec, remote: string | null): OraclePlan {
  const host = remote; // may be null; commands render `<remote>` placeholder then
  const r = host ?? '<remote>';
  const sshLocal = host ? `ssh ${host} ` : `ssh <remote> `;
  const workdir = spec.workdir ?? (spec.repo ? `~/ruflo-distill/${sanitize(spec.repo)}` : '~/ruflo-distill/work');

  // Preflight probes — reachability + the tools Tier-1 needs on the remote.
  const probeCommands = [
    `ssh -o BatchMode=yes -o ConnectTimeout=8 ${r} 'echo ok'`,
    `${sshLocal}'command -v docker >/dev/null 2>&1 && echo docker-present || echo docker-missing'`,
    `${sshLocal}'command -v darwin >/dev/null 2>&1 || npx --yes @metaharness/darwin@${MH_DARWIN_PIN} --version'`,
  ];

  let kind: OracleKind;
  const evalCommands: string[] = [];
  let parseHint: string;

  if (spec.benchSuite || spec.benchCase) {
    kind = 'ssh-darwin-bench';
    const suite = spec.benchSuite ? `--suite ${shq(spec.benchSuite)}` : '';
    const kase = spec.benchCase ? `--case ${shq(spec.benchCase)}` : '';
    evalCommands.push(
      `${sshLocal}'cd ${workdir} && npx --yes @metaharness/darwin@${MH_DARWIN_PIN} bench run ${suite} ${kase} --json'`.replace(/\s+/g, ' ').trim(),
    );
    parseHint = 'resolved = darwin bench run reports the case scored PASS (exit 0, json.passed=true)';
  } else if (spec.evalCommand) {
    kind = 'ssh-eval';
    evalCommands.push(`${sshLocal}'cd ${workdir} && ${spec.evalCommand}'`);
    parseHint = 'resolved = evalCommand exits 0';
  } else {
    kind = 'ssh-swebench-eval';
    if (spec.patch) {
      evalCommands.push(`${sshLocal}'cd ${workdir} && git apply - <<"PATCH"\n${spec.patch}\nPATCH'`);
    }
    const f2p = (spec.failToPass ?? []).map(shq).join(' ');
    const p2p = (spec.passToPass ?? []).map(shq).join(' ');
    evalCommands.push(
      `${sshLocal}'cd ${workdir} && npx --yes @metaharness/darwin@${MH_DARWIN_PIN} swebench-eval` +
        `${spec.repo ? ` --repo ${shq(spec.repo)}` : ''}` +
        `${spec.baseCommit ? ` --base ${shq(spec.baseCommit)}` : ''}` +
        `${f2p ? ` --fail-to-pass ${f2p}` : ''}` +
        `${p2p ? ` --pass-to-pass ${p2p}` : ''} --json'`,
    );
    parseHint = 'resolved = all FAIL_TO_PASS now pass AND all PASS_TO_PASS still pass';
  }

  return { kind, remote: host, probeCommands, evalCommands, parseHint };
}

// ── Default SSH runner (real exec; injectable for tests) ─────────────────────

/**
 * Default command executor: shells out, piping any heredoc/stdin via argv only
 * (commands are self-contained strings run through `sh -c`). Never invoked on
 * the default (dry-run) path.
 */
export const defaultCommandExec: CommandExec = (cmd, args, opts) =>
  new Promise<CommandResult>((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: CommandResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* dead */ }
      finish({ stdout, stderr: stderr || `timed out after ${opts.timeoutMs}ms`, code: null });
    }, opts.timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => finish({ stdout, stderr: e.message, code: null }));
    child.on('close', (code: number | null) => finish({ stdout, stderr, code }));
  });

/**
 * Build a real SSH-backed oracle runner. `exec` is injectable so tests assert
 * command construction without ever touching a network. Each plan command is
 * run via `sh -c <command-string>` so the fully-rendered ssh line executes as-is.
 */
export function createSshOracleRunner(exec: CommandExec = defaultCommandExec, timeoutMs = 15 * 60 * 1000): OracleRunner {
  const run = (command: string) => exec('sh', ['-c', command], { timeoutMs });
  return {
    async preflight(plan) {
      if (!plan.remote) return { ok: false, reason: 'no remote configured' };
      for (const c of plan.probeCommands) {
        const res = await run(c);
        if (res.code !== 0) {
          return { ok: false, reason: `probe failed (${c.slice(0, 60)}…): ${(res.stderr || '').slice(0, 120)}` };
        }
      }
      return { ok: true, reason: 'remote reachable; docker/darwin present' };
    },
    async runEval(plan) {
      let lastReason = 'no eval commands';
      for (const c of plan.evalCommands) {
        const res = await run(c);
        if (res.code !== 0) {
          return { resolved: false, reason: `eval failed (exit ${res.code}): ${(res.stderr || res.stdout || '').slice(0, 160)}` };
        }
        lastReason = interpretEvalStdout(res.stdout);
        if (lastReason.startsWith('NOT_RESOLVED')) {
          return { resolved: false, reason: lastReason };
        }
      }
      return { resolved: true, reason: `${plan.parseHint} — ${lastReason}` };
    },
  };
}

/** Interpret an eval command's JSON stdout for an explicit pass/fail signal. */
function interpretEvalStdout(stdout: string): string {
  const trimmed = (stdout ?? '').trim();
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      if (o.passed === false || o.resolved === false) return 'NOT_RESOLVED (json.passed=false)';
      if (o.passed === true || o.resolved === true) return 'json.passed=true';
    } catch { /* fall through to exit-code semantics */ }
  }
  return 'exit 0';
}

// ── small helpers ────────────────────────────────────────────────────────

async function safeProbe(runner: OracleRunner, plan: OraclePlan): Promise<{ ok: boolean; reason: string }> {
  try {
    return await runner.preflight(plan);
  } catch (err) {
    return { ok: false, reason: `probe threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function safeRunEval(runner: OracleRunner, plan: OraclePlan, spec: TestSpec): Promise<OracleOutcome> {
  try {
    return await runner.runEval(plan, spec);
  } catch (err) {
    return { resolved: false, reason: `eval threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toJudgeItem(t: Trajectory): JudgeItem {
  return { id: t.id, task: t.task ?? '', output: t.output ?? '' };
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Single-quote a token for safe interpolation into a shell command string. */
function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export default labelResolved;
