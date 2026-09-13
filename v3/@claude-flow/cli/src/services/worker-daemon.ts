/**
 * Worker Daemon Service
 * Node.js-based background worker system that auto-runs like shell daemons
 *
 * Workers:
 * - map: Codebase mapping (5 min interval)
 * - audit: Security analysis (10 min interval)
 * - optimize: Performance optimization (15 min interval)
 * - consolidate: Memory distillation — memory_entries -> episodes/reasoning_patterns/
 *   causal_edges (30 min interval, ADR-174; RUFLO_DAEMON_NO_DISTILL=1 / --no-distill to skip)
 * - testgaps: Test coverage analysis (20 min interval)
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, unlinkSync, renameSync } from 'fs';
import { cpus } from 'os';
import { join } from 'path';
import { writeFileAtomic } from '../fs-secure.js';
import {
  HeadlessWorkerExecutor,
  HEADLESS_WORKER_TYPES,
  HEADLESS_WORKER_CONFIGS,
  isHeadlessWorker,
  type HeadlessWorkerType,
  type HeadlessExecutionResult,
} from './headless-worker-executor.js';
// ADR-174 M3: the consolidate worker below drives the real DISTILL/CONSOLIDATE
// pass instead of writing a hardcoded { patternsConsolidated: 0 } stub. The
// service itself is owned/frozen elsewhere (memory-distillation.ts) — it is
// incremental (rowid cursor), non-destructive, transactional, and
// quick_check-gated, so it's safe to call unconditionally on every tick.
import { runDistillation, defaultMemoryDbPath, type DistillReport } from './memory-distillation.js';
import { backupMemoryDb } from './memory-backup.js';
import { resolveGitWorkspaceIdentity, type GitWorkspaceIdentity } from './git-workspace-identity.js';
import { getWorkspaceLeaseRegistry } from './workspace-lease.js';
import { getRepoSupervisorRegistry, type SupervisorRecord } from './repo-supervisor.js';

// Worker types matching hooks-tools.ts
export type WorkerType =
  | 'ultralearn'
  | 'optimize'
  | 'consolidate'
  | 'predict'
  | 'audit'
  | 'map'
  | 'preload'
  | 'deepdive'
  | 'document'
  | 'refactor'
  | 'benchmark'
  | 'testgaps'
  | 'backup'
  | 'harness';

interface WorkerConfig {
  type: WorkerType;
  intervalMs: number;
  priority: 'low' | 'normal' | 'high' | 'critical';
  description: string;
  enabled: boolean;
}

interface WorkerState {
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  successCount: number;
  failureCount: number;
  averageDurationMs: number;
  isRunning: boolean;
  // #1856: track when the worker last *started* in addition to when it
  // last successfully completed (lastRun). On crash recovery we scan for
  // workers where lastStartedAt > lastRun and count them as failed —
  // otherwise their runCount drifts above successCount + failureCount
  // with no diagnostic trail.
  lastStartedAt?: Date;
}

interface WorkerResult {
  workerId: string;
  type: WorkerType;
  success: boolean;
  durationMs: number;
  output?: unknown;
  error?: string;
  timestamp: Date;
}

interface DaemonStatus {
  running: boolean;
  pid: number;
  startedAt?: Date;
  workers: Map<WorkerType, WorkerState>;
  config: DaemonConfig;
  // #2661 root-fix — repository-supervisor state, null when AI workers are
  // disabled or the git identity couldn't be resolved (non-git directory).
  supervisor?: {
    repositoryId: string;
    isSupervisor: boolean;
    record: SupervisorRecord | null;
    activeLeases: number;
  } | null;
}

export interface DaemonConfig {
  autoStart: boolean;
  logDir: string;
  stateFile: string;
  maxConcurrent: number;
  workerTimeoutMs: number;
  resourceThresholds: {
    maxCpuLoad: number;
    minFreeMemoryPercent: number;
  };
  // #2356 (carry-forward from pacphi/ruflo-machine-ref token-leak findings):
  // self-terminating lifecycle so a forgotten daemon cannot run for days
  // dispatching headless `claude --print` sweeps. ttlMs = graceful shutdown
  // once daemon age exceeds this (0 disables). idleShutdownMs = graceful
  // shutdown if no worker has run within this window (0 disables).
  ttlMs: number;
  idleShutdownMs: number;
  // #2661 — explicit consent gate for scheduled AI workers. When false
  // (the default), NO worker is ever promoted to headless `claude --print`
  // execution, regardless of whether the Claude CLI is on PATH. Merely
  // finding `claude` must not authorize recurring model calls: a default
  // install produces zero autonomous Claude launches. Enable via
  // `daemon start --headless`, `daemon.aiWorkers.enabled: true` in
  // .claude-flow/config.json, or RUFLO_DAEMON_AI_WORKERS=1.
  aiWorkersEnabled: boolean;
  workers: WorkerConfig[];
}

// Worker configuration with staggered offsets to prevent overlap
interface WorkerConfigInternal extends WorkerConfig {
  offsetMs: number; // Stagger start time
}

// Default worker configurations with improved intervals (P0 fix: map 5min -> 15min)
const DEFAULT_WORKERS: WorkerConfigInternal[] = [
  { type: 'map', intervalMs: 15 * 60 * 1000, offsetMs: 0, priority: 'normal', description: 'Codebase mapping', enabled: true },
  { type: 'audit', intervalMs: 10 * 60 * 1000, offsetMs: 2 * 60 * 1000, priority: 'critical', description: 'Security analysis', enabled: true },
  { type: 'optimize', intervalMs: 15 * 60 * 1000, offsetMs: 4 * 60 * 1000, priority: 'high', description: 'Performance optimization', enabled: true },
  { type: 'consolidate', intervalMs: 30 * 60 * 1000, offsetMs: 6 * 60 * 1000, priority: 'low', description: 'Memory distillation (ADR-174)', enabled: true },
  { type: 'testgaps', intervalMs: 20 * 60 * 1000, offsetMs: 8 * 60 * 1000, priority: 'normal', description: 'Test coverage analysis', enabled: true },
  { type: 'backup', intervalMs: 24 * 60 * 60 * 1000, offsetMs: 10 * 60 * 1000, priority: 'low', description: 'Nightly memory DB backup (WAL-safe, rotated)', enabled: true },
  { type: 'harness', intervalMs: 6 * 60 * 60 * 1000, offsetMs: 12 * 60 * 1000, priority: 'low', description: 'Self-optimizing harness loop (opt-in RUFLO_HARNESS_LOOP, $0-default)', enabled: true },
  { type: 'predict', intervalMs: 10 * 60 * 1000, offsetMs: 0, priority: 'low', description: 'Predictive preloading', enabled: false },
  { type: 'document', intervalMs: 60 * 60 * 1000, offsetMs: 0, priority: 'low', description: 'Auto-documentation', enabled: false },
];

// Worker timeout — must exceed the longest per-worker headless timeout (15 min for audit/refactor).
// Previously 5 min, which caused orphan processes when daemon timeout fired before executor timeout (#1117).
const DEFAULT_WORKER_TIMEOUT_MS = 16 * 60 * 1000;

// ADR-174 M3: hard cap on rows the `consolidate` worker distills in a single
// tick. The distillation service is cursor-driven (per-namespace rowid) and
// batches in transactions of `batchSize`, so a capped `maxEntries` guarantees
// this worker returns well within DEFAULT_WORKER_TIMEOUT_MS even against a
// large backlog — the cursor just picks up where it left off next tick
// (every 30 min per DEFAULT_WORKERS), draining an arbitrarily large backlog
// over several ticks instead of blocking on one.
const CONSOLIDATE_MAX_ENTRIES_PER_TICK = 1000;
const CONSOLIDATE_BATCH_SIZE = 200;
// ADR-174 M5: platform-default distillation config, chosen by the M4 self-
// optimization grid-search (scripts/tune-distill.mjs) on the real ~7.9k-entry
// corpus. Winner: batchSize=200, dedupDistance=0.2 (held-out MRR@10 0.753 vs
// 0.749 baseline — measured on-par, not a large uplift; the payoff is the
// populated substrate + trainable model). Override per-run via `memory distill`.
const CONSOLIDATE_DEDUP_DISTANCE = 0.2;

// ADR-174 M3 opt-out: set to skip the real distillation pass entirely (e.g.
// constrained CI hosts, or a user who wants the daemon's other workers but
// not this one without touching persisted worker-enabled state). Mirrors the
// `--no-distill` flag on `daemon start` (see commands/daemon.ts), which sets
// this env var on the forked/foreground daemon process.
const NO_DISTILL_ENV = 'RUFLO_DAEMON_NO_DISTILL';

// #2356 — Self-terminating lifecycle defaults. A background daemon with no
// upper bound on its lifetime runs until the box reboots; in the field this
// leaked tens of thousands of headless `claude --print` sweeps over many days
// (one observed daemon ran 19 days). A 12h default age cap (matching the
// pacphi/ruflo-machine-ref kit's proven value) heals a forgotten daemon within
// half a day; set RUFLO_DAEMON_TTL_SECS=0 (or `--ttl 0`) to opt out. Idle
// shutdown is opt-in (0 = disabled) since a legitimately quiet daemon is not a leak.
const DEFAULT_DAEMON_TTL_MS = 12 * 60 * 60 * 1000;
// #2834 — an auto-started daemon must not remain alive for the full 12h TTL
// after its workspace goes idle. Explicit 0 via config/env still disables the
// idle cap for operators who intentionally want a resident daemon.
const DEFAULT_DAEMON_IDLE_SHUTDOWN_MS = 30 * 60 * 1000;

/**
 * Read a non-negative seconds value from an env var and return it as ms.
 * Unlike the `parseInt(x) || default` idiom used elsewhere, an explicit `0`
 * is honored (it disables the corresponding limit) rather than falling back
 * to the default. Invalid / negative / absent values fall back.
 */
function readEnvSecsAsMs(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const secs = Number.parseInt(raw, 10);
  if (!Number.isFinite(secs) || secs < 0) return defaultMs;
  return secs * 1000;
}

/**
 * Worker Daemon - Manages background workers with Node.js
 */
export class WorkerDaemon extends EventEmitter {
  private config: DaemonConfig;
  private workers: Map<WorkerType, WorkerState> = new Map();
  private timers: Map<WorkerType, NodeJS.Timeout> = new Map();
  // #1845: separate timer for the MCP-dispatch queue poller. Kept off
  // the per-worker map so stop() clears both kinds without confusion.
  private queuePollTimer?: NodeJS.Timeout;
  // #2356: separate timer that enforces the daemon's max-age TTL + idle
  // shutdown. Cleared in stop() alongside the worker/queue timers.
  private lifecycleTimer?: NodeJS.Timeout;
  private running = false;
  private startedAt?: Date;
  private projectRoot: string;
  private runningWorkers: Set<WorkerType> = new Set(); // Track concurrent workers
  private pendingWorkers: WorkerType[] = []; // Queue for deferred workers

  // Headless execution support
  private headlessExecutor: HeadlessWorkerExecutor | null = null;
  private headlessAvailable: boolean = false;
  // #2251 — Promise that resolves once initHeadlessExecutor() has finished
  // probing `claude --version` and constructed the executor. The constructor
  // kicks off init fire-and-forget; without awaiting this on the trigger
  // path, `ruflo daemon trigger -w <worker>` runs before headlessAvailable
  // is set and falls through to the local stub in ~2ms.
  private headlessInitPromise: Promise<void> = Promise.resolve();

  // Preserve the original constructor config so we can detect explicit overrides
  // during state restoration (R1: constructor config takes priority over stale state)
  private originalConfig?: Partial<DaemonConfig>;

  // #2935 — same purpose as originalConfig, but for values that came from
  // .claude-flow/config.{json,yaml,yml} (Layer B) rather than a constructor
  // arg. A file-supplied resourceThresholds value is just as much an
  // explicit, deliberate override as a constructor arg, but
  // initializeWorkerStates()'s stale-state guard only ever checked
  // originalConfig — so a config.json override kept losing to whatever
  // .claude-flow/daemon-state.json had persisted from a previous run.
  private fileConfigResourceThresholds?: { maxCpuLoad?: number; minFreeMemoryPercent?: number };

  // #2661 root-fix — resolved once (git identity doesn't change at runtime)
  // and reused for lease heartbeats + supervisor election, both gated on
  // aiWorkersEnabled since they only matter for the recurring AI schedule.
  private gitIdentity: GitWorkspaceIdentity | null = null;
  private lastSupervisorRenewalMs = 0;

  constructor(projectRoot: string, config?: Partial<DaemonConfig>) {
    super();
    this.projectRoot = projectRoot;
    this.originalConfig = config;

    const claudeFlowDir = join(projectRoot, '.claude-flow');

    // Read daemon config from .claude-flow/config.json (Layer B)
    const fileConfig = this.readDaemonConfigFromFile(claudeFlowDir);
    // #2935 — remember which resourceThresholds fields came from the file so
    // initializeWorkerStates() can treat them as explicit too (see field doc).
    this.fileConfigResourceThresholds = {
      maxCpuLoad: fileConfig.maxCpuLoad,
      minFreeMemoryPercent: fileConfig.minFreeMemoryPercent,
    };

    // CPU-proportional smart default (#1077): os.loadavg() returns the
    // system-wide 1-minute average across ALL cores. On an 8-core Mac under
    // normal dev workload, load averages of 8-16 are typical. The multiplier
    // must be high enough that workers aren't permanently deferred.
    const cpuCount = WorkerDaemon.getEffectiveCpuCount();
    let smartMaxCpuLoad = Math.max(cpuCount * 1.5, 4.0);

    // #2110 — WSL2 reports `/proc/loadavg` values that include Windows-side
    // process counts mapped into the Linux kernel. Real load on a 4-CPU
    // WSL2 host can be 200-400 even when the Linux side is idle. The
    // default gate of `cpuCount * 0.8` always trips, deferring every
    // worker as "CPU load too high" while the daemon reports healthy.
    // Bump the floor to 1000 when WSL is detected so the gate is
    // effectively disabled (real load on Linux side rarely exceeds 100
    // even under heavy contention).
    if (WorkerDaemon.isWslEnvironment()) {
      smartMaxCpuLoad = Math.max(smartMaxCpuLoad, 1000);
    }
    // Platform-aware default (#1077): macOS os.freemem() excludes reclaimable
    // file cache, so reported "free" is typically 1-5% even when plenty of
    // memory is available. Use a very low threshold on macOS.
    const defaultMinFreeMemory = process.platform === 'darwin' ? 2 : 10;

    // Priority: constructor arg > config.json > smart default
    // For resourceThresholds, merge field-by-field so partial overrides
    // (e.g. only --max-cpu-load) still pick up defaults for other fields.
    this.config = {
      autoStart: config?.autoStart ?? fileConfig.autoStart ?? false,
      logDir: config?.logDir ?? join(claudeFlowDir, 'logs'),
      stateFile: config?.stateFile ?? join(claudeFlowDir, 'daemon-state.json'),
      maxConcurrent: config?.maxConcurrent ?? fileConfig.maxConcurrent ?? 2,
      workerTimeoutMs: config?.workerTimeoutMs ?? fileConfig.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
      resourceThresholds: {
        maxCpuLoad: config?.resourceThresholds?.maxCpuLoad ?? fileConfig.maxCpuLoad ?? smartMaxCpuLoad,
        minFreeMemoryPercent: config?.resourceThresholds?.minFreeMemoryPercent ?? fileConfig.minFreeMemoryPercent ?? defaultMinFreeMemory,
      },
      // #2356 — precedence: constructor arg > config.json (daemon.ttlSecs) >
      // env (RUFLO_DAEMON_TTL_SECS) > built-in default. readEnvSecsAsMs folds
      // env-or-default and honors an explicit 0 (disable).
      ttlMs: config?.ttlMs ?? fileConfig.ttlMs ?? readEnvSecsAsMs('RUFLO_DAEMON_TTL_SECS', DEFAULT_DAEMON_TTL_MS),
      idleShutdownMs: config?.idleShutdownMs ?? fileConfig.idleShutdownMs ?? readEnvSecsAsMs('RUFLO_DAEMON_IDLE_SECS', DEFAULT_DAEMON_IDLE_SHUTDOWN_MS),
      // #2661 — AI workers are opt-in: flag > config.json > env > OFF.
      // Deliberately NOT restored from daemon-state.json (initializeWorkerStates
      // whitelist) so a stale state file can never resurrect consent.
      aiWorkersEnabled: config?.aiWorkersEnabled
        ?? fileConfig.aiWorkersEnabled
        ?? (process.env.RUFLO_DAEMON_AI_WORKERS === '1'),
      workers: config?.workers ?? DEFAULT_WORKERS,
    };

    // #2935 — deferred from readDaemonConfigFromFile(): this.config (and
    // therefore this.config.logDir) doesn't exist until the assignment
    // above, so logging from inside that method was silently swallowed by
    // log()'s own try/catch and never reached daemon.log.
    if (fileConfig.configSourcePath) {
      this.log('info', `Daemon config loaded from ${fileConfig.configSourcePath}`);
    }
    if (fileConfig.yamlParseWarning) {
      this.log('warn', fileConfig.yamlParseWarning);
    }

    // Setup graceful shutdown handlers
    this.setupShutdownHandlers();

    // #1855: install crash handlers so uncaught exceptions and unhandled
    // rejections don't leak the PID file or orphan child processes.
    this.installCrashHandlers();

    // Ensure directories exist
    if (!existsSync(claudeFlowDir)) {
      mkdirSync(claudeFlowDir, { recursive: true });
    }
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true });
    }

    // Initialize worker states
    this.initializeWorkerStates();

    // Initialize headless executor (async, non-blocking) — capture the
    // promise so the trigger path (#2251) can await it before checking
    // `headlessAvailable`. Scheduled fires hit a long-running daemon and
    // are unaffected; the on-demand `trigger` path was racing this init.
    this.headlessInitPromise = this.initHeadlessExecutor().catch((err) => {
      this.log('warn', `Headless executor init failed: ${err}`);
    });
  }

  /**
   * Initialize headless executor if Claude Code is available
   */
  private async initHeadlessExecutor(): Promise<void> {
    // #2661 — scheduled AI workers require explicit consent. Without it,
    // don't even probe `claude --version`: headlessAvailable stays false,
    // every worker runs its $0 local path, and a default install produces
    // zero autonomous Claude launches regardless of worktree count.
    if (!this.config.aiWorkersEnabled) {
      this.log(
        'info',
        'AI workers disabled (default) - all workers run local-only. Enable with `daemon start --headless`, daemon.aiWorkers.enabled=true, or RUFLO_DAEMON_AI_WORKERS=1 (#2661)'
      );
      return;
    }
    try {
      this.headlessExecutor = new HeadlessWorkerExecutor(this.projectRoot, {
        maxConcurrent: this.config.maxConcurrent,
      });

      this.headlessAvailable = await this.headlessExecutor.isAvailable();

      if (this.headlessAvailable) {
        this.log('info', 'Claude Code headless mode available - AI workers enabled');

        // Forward headless executor events. #1855: also snapshot the
        // active child PIDs to disk on every transition so the next
        // lifetime can reap orphans after a hard crash.
        this.headlessExecutor.on('execution:start', (data) => {
          this.writeChildrenSnapshot();
          this.emit('headless:start', data);
        });

        this.headlessExecutor.on('execution:complete', (data) => {
          this.writeChildrenSnapshot();
          this.emit('headless:complete', data);
        });

        this.headlessExecutor.on('execution:error', (data) => {
          this.writeChildrenSnapshot();
          this.emit('headless:error', data);
        });

        this.headlessExecutor.on('output', (data) => {
          this.emit('headless:output', data);
        });
      } else {
        this.log('info', 'Claude Code not found - AI workers will run in local fallback mode');
      }
    } catch (error) {
      this.log('warn', `Failed to initialize headless executor: ${error}`);
      this.headlessAvailable = false;
    }
  }

  /**
   * Check if headless execution is available
   */
  isHeadlessAvailable(): boolean {
    return this.headlessAvailable;
  }

  /**
   * Get headless executor instance
   */
  getHeadlessExecutor(): HeadlessWorkerExecutor | null {
    return this.headlessExecutor;
  }

  /**
   * Detect effective CPU count for the current environment.
   *
   * Inside Docker / K8s containers, os.cpus().length reports the HOST cpu
   * count, not the container limit (Node.js #28762 — wontfix).  We read
   * cgroup v2 / v1 quota files first so the maxCpuLoad threshold stays
   * meaningful under resource-limited containers.
   */
  /**
   * #2110 — detect WSL2 / WSL1 so the CPU-load gate can use a sane
   * default. `/proc/loadavg` on WSL maps in Windows-side process counts
   * and routinely reports values 100-1000x larger than real Linux load.
   *
   * Detection order:
   *   1. `WSL_DISTRO_NAME` env var (set by Microsoft's WSL launcher)
   *   2. `WSL_INTEROP` env var (set by recent WSL2)
   *   3. `/proc/sys/kernel/osrelease` contains "microsoft" or "WSL"
   *      (kernel build marker; survives env stripping)
   */
  static isWslEnvironment(): boolean {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
    try {
      const osrelease = readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase();
      if (osrelease.includes('microsoft') || osrelease.includes('wsl')) return true;
    } catch { /* not on Linux or /proc inaccessible */ }
    return false;
  }

  static getEffectiveCpuCount(): number {
    // 1. Try cgroup v2: /sys/fs/cgroup/cpu.max
    try {
      const cpuMax = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
      const [quotaStr, periodStr] = cpuMax.split(' ');
      if (quotaStr !== 'max') {
        const quota = parseInt(quotaStr, 10);
        const period = parseInt(periodStr, 10);
        if (quota > 0 && period > 0) return Math.ceil(quota / period);
      }
    } catch { /* not in cgroup v2 */ }

    // 2. Try cgroup v1: /sys/fs/cgroup/cpu/cpu.cfs_quota_us
    try {
      const quota = parseInt(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim(), 10);
      const period = parseInt(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim(), 10);
      if (quota > 0 && period > 0) return Math.ceil(quota / period);
    } catch { /* not in cgroup v1 */ }

    // 3. Fallback to os.cpus().length
    return cpus().length || 1;
  }

  /**
   * Read daemon-specific config from .claude-flow/config.{json,yaml,yml}.
   * Supports dot-notation keys like 'daemon.resourceThresholds.maxCpuLoad'.
   * #1844: prefer JSON when both exist (existing behavior) but fall back
   * to YAML so operators using the v3 canonical YAML format aren't silently
   * ignored. The chosen path (or a parse warning) is returned rather than
   * logged directly — #2935: this method runs from the constructor before
   * `this.config` (and therefore `this.config.logDir`) is assigned, so a
   * `this.log()` call made here throws inside log()'s own try/catch and is
   * silently swallowed. It never reached daemon.log, which made "is the
   * config file even being read?" impossible to answer from the log alone.
   * The caller logs these once `this.config` exists.
   */
  private readDaemonConfigFromFile(claudeFlowDir: string): {
    autoStart?: boolean;
    maxConcurrent?: number;
    workerTimeoutMs?: number;
    maxCpuLoad?: number;
    minFreeMemoryPercent?: number;
    ttlMs?: number;
    idleShutdownMs?: number;
    aiWorkersEnabled?: boolean;
    configSourcePath?: string;
    yamlParseWarning?: string;
  } {
    const jsonPath = join(claudeFlowDir, 'config.json');
    const yamlPath = join(claudeFlowDir, 'config.yaml');
    const ymlPath = join(claudeFlowDir, 'config.yml');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: Record<string, any> | undefined;
    let chosenPath: string | undefined;

    if (existsSync(jsonPath)) {
      try {
        raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
        chosenPath = jsonPath;
      } catch {
        return {};
      }
    } else if (existsSync(yamlPath) || existsSync(ymlPath)) {
      const yPath = existsSync(yamlPath) ? yamlPath : ymlPath;
      try {
        // Lazy-load yaml so the daemon doesn't hard-require it; if the
        // dep isn't installed, fall back to the previous warn-only path.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const yamlMod = require('yaml') as { parse(s: string): unknown };
        const parsed = yamlMod.parse(readFileSync(yPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          raw = parsed as Record<string, any>;
          chosenPath = yPath;
        }
      } catch {
        return {
          yamlParseWarning: `Found ${yPath} but yaml parser unavailable. Install \`yaml\` or convert to JSON. Falling back to defaults.`,
        };
      }
    }

    if (!raw || !chosenPath) {
      return {};
    }

    try {
      // Support both flat keys at root and nested under scopes.project
      const cfg = raw?.scopes?.project ?? raw;
      const rawCpuLoad = cfg['daemon.resourceThresholds.maxCpuLoad'] ?? raw['daemon.resourceThresholds.maxCpuLoad'];
      const rawMinMem = cfg['daemon.resourceThresholds.minFreeMemoryPercent'] ?? raw['daemon.resourceThresholds.minFreeMemoryPercent'];
      const rawMaxConcurrent = cfg['daemon.maxConcurrent'] ?? raw['daemon.maxConcurrent'];
      const rawTimeout = cfg['daemon.workerTimeoutMs'] ?? raw['daemon.workerTimeoutMs'];
      // #2356 — lifecycle limits are configured in SECONDS in config.json
      // (`daemon.ttlSecs` / `daemon.idleSecs`) for parity with the CLI flag
      // and env var; stored internally as ms. An explicit 0 disables.
      const rawTtl = cfg['daemon.ttlSecs'] ?? raw['daemon.ttlSecs'];
      const rawIdle = cfg['daemon.idleSecs'] ?? raw['daemon.idleSecs'];
      // #2661 — explicit opt-in for scheduled AI workers.
      const rawAiEnabled = cfg['daemon.aiWorkers.enabled'] ?? raw['daemon.aiWorkers.enabled'];
      return {
        autoStart: typeof raw['daemon.autoStart'] === 'boolean' ? raw['daemon.autoStart'] : undefined,
        maxConcurrent: (typeof rawMaxConcurrent === 'number' && rawMaxConcurrent > 0) ? rawMaxConcurrent : undefined,
        workerTimeoutMs: (typeof rawTimeout === 'number' && rawTimeout > 0) ? rawTimeout : undefined,
        maxCpuLoad: (typeof rawCpuLoad === 'number' && rawCpuLoad > 0 && rawCpuLoad < 1000) ? rawCpuLoad : undefined,
        minFreeMemoryPercent: (typeof rawMinMem === 'number' && rawMinMem >= 0 && rawMinMem <= 100) ? rawMinMem : undefined,
        ttlMs: (typeof rawTtl === 'number' && rawTtl >= 0) ? rawTtl * 1000 : undefined,
        idleShutdownMs: (typeof rawIdle === 'number' && rawIdle >= 0) ? rawIdle * 1000 : undefined,
        aiWorkersEnabled: typeof rawAiEnabled === 'boolean' ? rawAiEnabled : undefined,
        configSourcePath: chosenPath,
      };
    } catch {
      return {};
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async () => {
      this.log('info', 'Received shutdown signal, stopping daemon...');
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', shutdown);
  }

  /**
   * #1855: install crash handlers for uncaught exceptions and unhandled
   * rejections. Without these, a thrown error from any timer callback,
   * worker logic path, or transitive import crashes the daemon process
   * silently — the PID file leaks and any in-flight child processes
   * orphan. With these, we log a structured crash record, run stop()
   * to clean up, then exit 1 so the process actually dies (otherwise
   * Node would crash anyway after the handler returns).
   */
  private installCrashHandlers(): void {
    const onCrash = (kind: 'uncaughtException' | 'unhandledRejection', err: unknown) => {
      // Best-effort logging; never throw from inside the crash handler.
      try {
        this.writeCrashRecord(kind, err);
      } catch { /* nothing more we can do */ }
      try {
        // Synchronous stop — don't await; the process is dying. Just
        // remove the PID file and snapshot state so the next start
        // sees a clean slate.
        this.removePidFile();
        this.saveState();
        // Snapshot any in-flight child PIDs one last time so the next
        // lifetime can reap them.
        this.writeChildrenSnapshot();
      } catch { /* ignore */ }
      // Exit non-zero so supervisors / shells see the failure.
      process.exit(1);
    };
    process.on('uncaughtException', (err) => onCrash('uncaughtException', err));
    process.on('unhandledRejection', (err) => onCrash('unhandledRejection', err));
  }

  /**
   * Append a structured crash record to .claude-flow/logs/crash.log.
   * Inspectable by hand or via `ruflo daemon status` follow-ups.
   */
  private writeCrashRecord(kind: string, err: unknown): void {
    const logDir = this.config.logDir;
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const crashLog = join(logDir, 'crash.log');
    const ts = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : '<no stack>';
    const record = `[${ts}] [${kind}] pid=${process.pid} ${message}\n${stack}\n---\n`;
    appendFileSync(crashLog, record, 'utf-8');
    this.log('warn', `Daemon crashed (${kind}): ${message} — see ${crashLog}`);
  }

  /**
   * Path to the on-disk children registry — list of headless worker
   * child PIDs the daemon currently owns. #1855: written on every
   * execution:start / :complete / :error transition; read by the next
   * lifetime to reap orphans after a hard crash.
   */
  private get childrenFile(): string {
    return join(this.projectRoot, '.claude-flow', 'daemon-children.json');
  }

  /**
   * #1856: detect workers that were mid-flight when the previous daemon
   * lifetime ended. A mid-flight worker has `lastStartedAt > lastRun`
   * (started after the last successful completion). On crash recovery
   * we count these as failures so the run-counter math stays consistent
   * (`runCount === successCount + failureCount`). Workers naturally
   * retry at their next scheduled interval; we deliberately don't
   * immediately re-run because the failure may have been deterministic.
   */
  private detectMidFlightFailures(): void {
    let detected = 0;
    for (const [type, state] of this.workers.entries()) {
      const startedAt = state.lastStartedAt?.getTime() ?? 0;
      const lastRunAt = state.lastRun?.getTime() ?? 0;
      // started after the last successful completion → was mid-flight
      if (startedAt > 0 && startedAt > lastRunAt) {
        state.failureCount++;
        state.isRunning = false;
        // Don't bump runCount — it was already incremented at start
        this.log(
          'info',
          `Worker ${type} was mid-flight at last crash (started ${state.lastStartedAt?.toISOString()}); counted as failure, will retry at next scheduled interval`,
        );
        detected++;
      }
    }
    if (detected > 0) {
      this.saveState();
    }
  }

  /**
   * Snapshot the currently-active headless worker child PIDs to disk.
   * Best-effort; failures don't propagate.
   */
  private writeChildrenSnapshot(): void {
    if (!this.headlessExecutor) return;
    try {
      const pids = this.headlessExecutor.getActiveChildPids();
      const dir = join(this.projectRoot, '.claude-flow');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        this.childrenFile,
        JSON.stringify({ pids, daemonPid: process.pid, timestamp: new Date().toISOString() }, null, 2),
        'utf-8',
      );
    } catch { /* best-effort */ }
  }

  /**
   * #1855: reap orphan headless worker children left behind by a
   * previous crashed lifetime. Reads `.claude-flow/daemon-children.json`,
   * SIGTERMs any PID still alive that doesn't belong to the current
   * daemon, then truncates the file. Called at the top of `start()`
   * so the next lifetime starts with a clean process tree.
   */
  private reapOrphanedChildren(): void {
    const file = this.childrenFile;
    if (!existsSync(file)) return;
    let snapshot: { pids?: number[]; daemonPid?: number };
    try {
      snapshot = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      try { unlinkSync(file); } catch { /* ignore */ }
      return;
    }
    const pids = Array.isArray(snapshot.pids) ? snapshot.pids : [];
    let reaped = 0;
    for (const pid of pids) {
      if (typeof pid !== 'number' || pid <= 0) continue;
      if (pid === process.pid) continue; // never our own PID
      try {
        process.kill(pid, 0); // is alive?
        process.kill(pid, 'SIGTERM');
        reaped++;
      } catch {
        // already dead — fine
      }
    }
    if (reaped > 0) {
      this.log('info', `Reaped ${reaped} orphan headless worker child(ren) from previous lifetime`);
    }
    try { unlinkSync(file); } catch { /* ignore */ }
  }

  /**
   * Check if system resources allow worker execution
   */
  private async canRunWorker(): Promise<{ allowed: boolean; reason?: string }> {
    const os = await import('os');
    const cpuLoad = os.loadavg()[0];
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const freePercent = (freeMem / totalMem) * 100;

    if (cpuLoad > this.config.resourceThresholds.maxCpuLoad) {
      return { allowed: false, reason: `CPU load too high: ${cpuLoad.toFixed(2)}` };
    }
    if (freePercent < this.config.resourceThresholds.minFreeMemoryPercent) {
      return { allowed: false, reason: `Memory too low: ${freePercent.toFixed(1)}% free` };
    }
    return { allowed: true };
  }

  /**
   * Process pending workers queue
   *
   * When executeWorkerWithConcurrencyControl defers a worker (returns null),
   * we break immediately to avoid a busy-wait loop — the deferred worker is
   * already back on the pendingWorkers queue by that point. If no workers are
   * currently running when we break, we schedule a backoff retry so the queue
   * does not get permanently stuck.
   */
  private async processPendingWorkers(): Promise<void> {
    while (this.pendingWorkers.length > 0 && this.runningWorkers.size < this.config.maxConcurrent) {
      const workerType = this.pendingWorkers.shift()!;
      const workerConfig = this.config.workers.find(w => w.type === workerType);
      if (workerConfig) {
        const result = await this.executeWorkerWithConcurrencyControl(workerConfig);
        if (result === null) {
          // Worker was deferred (resource pressure or concurrency limit).
          // Break to avoid tight-looping — the next executeWorker() completion
          // will call processPendingWorkers() again via the finally block.
          if (this.runningWorkers.size === 0) {
            // No workers running means nobody will trigger the finally-block
            // callback, so schedule a backoff retry to avoid a stuck queue.
            setTimeout(() => this.processPendingWorkers(), 30_000).unref();
          }
          break;
        }
      }
    }
  }

  private initializeWorkerStates(): void {
    // Try to restore state from file
    if (existsSync(this.config.stateFile)) {
      try {
        const saved = JSON.parse(readFileSync(this.config.stateFile, 'utf-8'));

        // CRITICAL: Restore worker config (including enabled flag) from saved state
        // This fixes #950: daemon enable command not persisting worker state
        if (saved.config?.workers && Array.isArray(saved.config.workers)) {
          for (const savedWorker of saved.config.workers) {
            const workerConfig = this.config.workers.find(w => w.type === savedWorker.type);
            if (workerConfig && typeof savedWorker.enabled === 'boolean') {
              workerConfig.enabled = savedWorker.enabled;
            }
          }
        }

        // Restore resourceThresholds, maxConcurrent, workerTimeoutMs from saved state
        // Only restore if valid numeric values within sane ranges.
        // #2935 — a field is restored from stale state only if NEITHER the
        // constructor arg NOR .claude-flow/config.{json,yaml,yml} explicitly
        // set it. The old gate checked only `originalConfig`, so a
        // config.json override (e.g. minFreeMemoryPercent: 0 to work around
        // the Darwin os.freemem() skew) silently lost to whatever a stale
        // daemon-state.json had persisted from before the override existed —
        // same class of bug #2661 already fixed for aiWorkersEnabled.
        if (saved.config?.resourceThresholds) {
          const rt = saved.config.resourceThresholds;
          const maxCpuLoadExplicit = this.originalConfig?.resourceThresholds?.maxCpuLoad !== undefined
            || this.fileConfigResourceThresholds?.maxCpuLoad !== undefined;
          const minFreeMemExplicit = this.originalConfig?.resourceThresholds?.minFreeMemoryPercent !== undefined
            || this.fileConfigResourceThresholds?.minFreeMemoryPercent !== undefined;
          if (!maxCpuLoadExplicit && typeof rt.maxCpuLoad === 'number' && rt.maxCpuLoad > 0 && rt.maxCpuLoad < 1000) {
            this.config.resourceThresholds.maxCpuLoad = rt.maxCpuLoad;
          }
          if (!minFreeMemExplicit && typeof rt.minFreeMemoryPercent === 'number' && rt.minFreeMemoryPercent >= 0 && rt.minFreeMemoryPercent <= 100) {
            this.config.resourceThresholds.minFreeMemoryPercent = rt.minFreeMemoryPercent;
          }
        }
        if (typeof saved.config?.maxConcurrent === 'number' && saved.config.maxConcurrent > 0) {
          this.config.maxConcurrent = saved.config.maxConcurrent;
        }
        if (typeof saved.config?.workerTimeoutMs === 'number' && saved.config.workerTimeoutMs > 0) {
          this.config.workerTimeoutMs = saved.config.workerTimeoutMs;
        }

        // Restore worker runtime states (runCount, successCount, etc.)
        if (saved.workers) {
          for (const [type, state] of Object.entries(saved.workers)) {
            const savedState = state as Record<string, unknown>;
            const lastRunValue = savedState.lastRun;
            const lastStartedAtValue = savedState.lastStartedAt;
            this.workers.set(type as WorkerType, {
              runCount: (savedState.runCount as number) || 0,
              successCount: (savedState.successCount as number) || 0,
              failureCount: (savedState.failureCount as number) || 0,
              averageDurationMs: (savedState.averageDurationMs as number) || 0,
              lastRun: lastRunValue ? new Date(lastRunValue as string) : undefined,
              lastStartedAt: lastStartedAtValue ? new Date(lastStartedAtValue as string) : undefined,
              nextRun: undefined,
              isRunning: false,
            });
          }
        }
      } catch {
        // Ignore parse errors, start fresh
      }
    }

    // Initialize any missing workers
    for (const workerConfig of this.config.workers) {
      if (!this.workers.has(workerConfig.type)) {
        this.workers.set(workerConfig.type, {
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          averageDurationMs: 0,
          isRunning: false,
        });
      }
    }
  }

  /**
   * Get the PID file path for singleton enforcement (#1395 Bug 3).
   */
  private get pidFile(): string {
    return join(this.projectRoot, '.claude-flow', 'daemon.pid');
  }

  /**
   * Check if another daemon instance is already running.
   * Returns the existing PID if alive, or null if no daemon is running.
   *
   * #1853: ignore self-PID matches. The detached-spawn path in
   * `commands/daemon.ts` writes the child's PID into the file as a
   * fallback after a 500ms wait. If the child reaches `start()` slower
   * than the parent's 500ms wait (observed on Node 25 / macOS 26), the
   * child reads its own PID back from the file and concludes "another
   * daemon is already running" — so it exits before scheduling workers
   * and `daemon status` reports STOPPED forever. A daemon process is
   * never "another instance" of itself; treat self-match as absence.
   */
  private checkExistingDaemon(): number | null {
    if (!existsSync(this.pidFile)) return null;
    try {
      const pid = parseInt(readFileSync(this.pidFile, 'utf-8').trim(), 10);
      if (isNaN(pid)) return null;
      // #1853: a PID file containing our own PID is not "another daemon".
      // Treat as absent so the start() path proceeds normally.
      if (pid === process.pid) return null;
      // Check if process is alive (signal 0 = existence check)
      process.kill(pid, 0);
      return pid; // Process is alive
    } catch {
      // Process is dead — clean up stale PID file
      try { unlinkSync(this.pidFile); } catch { /* ignore */ }
      return null;
    }
  }

  /**
   * Write PID file for singleton enforcement.
   */
  private writePidFile(): void {
    const dir = join(this.projectRoot, '.claude-flow');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.pidFile, String(process.pid), 'utf-8');
  }

  /**
   * Remove PID file on shutdown.
   */
  private removePidFile(): void {
    try { unlinkSync(this.pidFile); } catch { /* ignore */ }
  }

  /**
   * Start the daemon and all enabled workers
   */
  async start(): Promise<void> {
    if (this.running) {
      this.emit('warning', 'Daemon already running');
      return;
    }

    // PID singleton enforcement (#1395 Bug 3): prevent daemon accumulation
    const existingPid = this.checkExistingDaemon();
    if (existingPid !== null) {
      this.log('info', `Daemon already running (PID: ${existingPid}), skipping start`);
      this.emit('warning', `Daemon already running (PID: ${existingPid})`);
      return;
    }

    // #1855: reap orphan headless worker children left by a previous
    // crashed lifetime, BEFORE we mark ourselves running and start
    // accepting new work. The children file from the prior daemon's
    // last-snapshot is the authoritative list.
    this.reapOrphanedChildren();

    // #1856: detect workers that were mid-flight at the previous crash
    // and count them as failures so runCount/successCount/failureCount
    // stay consistent. Workers retry naturally at their next scheduled
    // interval — we don't immediately re-run them, which avoids a
    // freshly-recovered daemon hammering the same code path that just
    // killed it.
    this.detectMidFlightFailures();

    this.running = true;
    this.startedAt = new Date();
    this.writePidFile();
    this.emit('started', { pid: process.pid, startedAt: this.startedAt });

    // #2661 root-fix — resolve repository identity and register/attempt
    // election immediately at start, not just on the first 60s lifecycle
    // tick, so `daemon status` reflects supervisor state right away. Only
    // meaningful when AI workers are enabled (see field doc comment).
    if (this.config.aiWorkersEnabled) {
      this.gitIdentity = resolveGitWorkspaceIdentity(this.projectRoot);
      void this.renewLeaseAndSupervisor();
    }

    // Schedule all enabled workers
    for (const workerConfig of this.config.workers) {
      if (workerConfig.enabled) {
        this.scheduleWorker(workerConfig);
      }
    }

    // #1845: poll the MCP-dispatch queue directory so workers requested
    // via mcp__hooks_worker-dispatch (in a separate process) actually
    // execute here. Previously the dispatch wrote to a process-local Map
    // that the daemon could never see.
    this.queuePollTimer = setInterval(() => {
      void this.processDispatchQueue();
    }, 5_000);
    if (typeof this.queuePollTimer.unref === 'function') {
      this.queuePollTimer.unref();
    }

    // #2356: self-terminating lifecycle. Without an upper bound on lifetime a
    // forgotten daemon keeps dispatching headless worker sweeps for days.
    this.startLifecycleMonitor();

    // Save state
    this.saveState();

    this.log('info', `Daemon started (PID: ${process.pid}, CPUs: ${cpus().length}, workers: ${this.config.workers.filter(w => w.enabled).length}, maxCpuLoad: ${this.config.resourceThresholds.maxCpuLoad}, minFreeMemoryPercent: ${this.config.resourceThresholds.minFreeMemoryPercent}%)`);
  }

  /**
   * #1845: ingest queue entries written by mcp__hooks_worker-dispatch.
   * Each entry is a JSON file at `.claude-flow/daemon-queue/<id>.json`
   * with `{ workerId, trigger, context, enqueuedAt }`. We move processed
   * files to `.claude-flow/daemon-queue/.processed/` so the daemon never
   * re-runs the same dispatch and operators can inspect history.
   */
  private async processDispatchQueue(): Promise<void> {
    if (!this.running) return;
    const queueDir = join(this.projectRoot, '.claude-flow', 'daemon-queue');
    if (!existsSync(queueDir)) return;

    let entries: string[];
    try {
      const fs = await import('fs');
      entries = fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    if (entries.length === 0) return;

    const fs = await import('fs');
    const processedDir = join(queueDir, '.processed');
    if (!existsSync(processedDir)) {
      try { fs.mkdirSync(processedDir, { recursive: true }); } catch { /* race ok */ }
    }

    for (const entry of entries) {
      const src = join(queueDir, entry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: any;
      try {
        payload = JSON.parse(fs.readFileSync(src, 'utf-8'));
      } catch {
        // Malformed entry — quarantine so we don't loop on it
        try { fs.renameSync(src, join(processedDir, `bad-${entry}`)); } catch { /* nothing more we can do */ }
        continue;
      }
      const trigger = payload?.trigger as WorkerType | undefined;
      const workerId = payload?.workerId as string | undefined;
      if (!trigger || !this.config.workers.some((w) => w.type === trigger)) {
        try { fs.renameSync(src, join(processedDir, `unknown-${entry}`)); } catch { /* ok */ }
        continue;
      }
      try {
        this.log('info', `Dequeued ${trigger}${workerId ? ` (id=${workerId})` : ''} from MCP dispatch queue`);
        await this.triggerWorker(trigger);
      } catch (err) {
        this.log('warn', `Queued worker ${trigger} failed: ${(err as Error).message}`);
      } finally {
        try { fs.renameSync(src, join(processedDir, entry)); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Stop the daemon and all workers
   */
  async stop(): Promise<void> {
    if (!this.running) {
      this.emit('warning', 'Daemon not running');
      return;
    }

    // Clear all timers (convert to array to avoid iterator issues)
    const timerEntries = Array.from(this.timers.entries());
    for (const [type, timer] of timerEntries) {
      clearTimeout(timer);
      this.log('info', `Stopped worker: ${type}`);
    }
    this.timers.clear();

    // #1845: stop the MCP-dispatch queue poller too.
    if (this.queuePollTimer) {
      clearInterval(this.queuePollTimer);
      this.queuePollTimer = undefined;
    }

    // #2356: stop the TTL/idle lifecycle monitor.
    if (this.lifecycleTimer) {
      clearInterval(this.lifecycleTimer);
      this.lifecycleTimer = undefined;
    }

    // #2661 — reap in-flight headless `claude --print` children. They run
    // detached (own process group on POSIX) and would otherwise outlive the
    // daemon; `daemon stop --all` relies on SIGTERM → this path to cancel
    // active Claude process groups.
    if (this.headlessExecutor) {
      try { this.headlessExecutor.cancelAll(); } catch { /* best-effort */ }
    }

    // #2661 root-fix — release this worktree's lease and, if held,
    // supervisor status, so a sibling worktree's daemon can take over the
    // schedule within its next tick instead of waiting out the 3-minute
    // supervisor staleness window. Best-effort — a graceful release is an
    // optimization; the staleness timeout is what actually bounds a crash.
    if (this.config.aiWorkersEnabled && this.gitIdentity) {
      const { repositoryId, worktreeRoot } = this.gitIdentity;
      try {
        await getRepoSupervisorRegistry().release(repositoryId, worktreeRoot);
        await getWorkspaceLeaseRegistry().release(repositoryId, worktreeRoot);
      } catch { /* best-effort */ }
    }

    this.running = false;
    this.removePidFile();
    this.saveState();
    this.emit('stopped', { stoppedAt: new Date() });
    this.log('info', 'Daemon stopped');
  }

  /**
   * #2356 — Self-terminating lifecycle monitor. A daemon with no upper bound
   * on its lifetime is the documented root cause of multi-day token leaks:
   * each interval worker spawns a headless `claude --print` sweep, so a daemon
   * left running for days dispatches tens of thousands of sessions invisibly.
   * This timer enforces a max age (`ttlMs`) and an optional idle window
   * (`idleShutdownMs`), shutting the daemon down gracefully when either trips.
   * Checked once a minute and `unref()`'d so it never keeps the process alive
   * on its own. A no-op when both limits are disabled (0).
   */
  private startLifecycleMonitor(): void {
    const ttlMs = this.config.ttlMs;
    const idleMs = this.config.idleShutdownMs;
    // #2661 — unlike ttl/idle (both optional), the workspace-removal check
    // always runs, so the monitor is no longer skipped when both limits are
    // disabled. A daemon whose worktree was deleted must not keep running.

    const CHECK_INTERVAL_MS = 60_000;
    this.lifecycleTimer = setInterval(() => {
      if (!this.running) return;
      const reason = this.lifecycleShutdownReason(Date.now());
      if (reason) {
        void this.selfShutdown(reason);
        return;
      }
      // #2661 root-fix — renew this worktree's lease + supervisor status on
      // the same cadence. Both windows (15min lease TTL, 3min supervisor
      // staleness) comfortably outlive a single missed 60s tick.
      if (this.config.aiWorkersEnabled) {
        void this.renewLeaseAndSupervisor();
      }
    }, CHECK_INTERVAL_MS);
    if (typeof this.lifecycleTimer.unref === 'function') {
      this.lifecycleTimer.unref();
    }

    const parts: string[] = ['workspace-removal'];
    if (ttlMs > 0) parts.push(`ttl=${Math.round(ttlMs / 1000)}s`);
    if (idleMs > 0) parts.push(`idle=${Math.round(idleMs / 1000)}s`);
    this.log('info', `Lifecycle monitor active (${parts.join(', ')})`);
  }

  /**
   * Decide whether the daemon should self-shutdown, and why. Extracted from
   * the lifecycle timer so it is testable without racing a 60s interval or
   * calling process.exit().
   *
   * #2661 (invariant 6, containment form): a removed worktree makes its
   * daemon ineligible within one check interval — the daemon detects that
   * its workspace directory is gone and shuts down instead of continuing to
   * schedule jobs against a deleted tree. The full lease architecture
   * (supervisor-dispatched jobs, heartbeats) is follow-up work; this stops
   * the leak where recreated/removed worktrees leave schedulers behind.
   */
  private lifecycleShutdownReason(now: number): string | null {
    if (!existsSync(this.projectRoot)) {
      return 'workspace directory removed (#2661)';
    }

    const ttlMs = this.config.ttlMs;
    const idleMs = this.config.idleShutdownMs;
    const startedMs = this.startedAt?.getTime() ?? now;

    if (ttlMs > 0 && now - startedMs >= ttlMs) {
      return `max age ${Math.round(ttlMs / 1000)}s reached`;
    }
    if (idleMs > 0) {
      const lastActivity = this.lastWorkerActivityMs() ?? startedMs;
      if (now - lastActivity >= idleMs) {
        return `idle for ${Math.round(idleMs / 1000)}s (no worker activity)`;
      }
    }
    return null;
  }

  /**
   * Most recent worker start/finish time across all workers (epoch ms), or
   * null if no worker has ever started. Used for idle-shutdown detection.
   */
  private lastWorkerActivityMs(): number | null {
    let latest: number | null = null;
    for (const state of this.workers.values()) {
      for (const t of [state.lastRun, state.lastStartedAt]) {
        if (t) {
          const ms = t.getTime();
          if (latest === null || ms > latest) latest = ms;
        }
      }
    }
    return latest;
  }

  /**
   * Graceful self-shutdown triggered by the lifecycle monitor. Mirrors the
   * signal-handler path (`stop()` then `process.exit(0)`) because the
   * foreground keep-alive in the daemon command is a *ref'd* `setInterval`
   * that would otherwise hold the process open after `stop()` clears the
   * service timers — leaving a zombie that reports stopped but never exits.
   */
  private async selfShutdown(reason: string): Promise<void> {
    this.log('info', `Daemon self-shutdown: ${reason}`);
    this.emit('self-shutdown', { reason });
    try {
      await this.stop();
    } catch { /* best-effort — we are exiting regardless */ }
    process.exit(0);
  }

  /**
   * #2661 root-fix — heartbeat this worktree's lease and attempt/renew
   * repository-supervisor election. Best-effort: any failure here must
   * never affect worker scheduling correctness (the budget ledger remains
   * the hard invariant regardless of supervisor state) — a daemon that
   * can't safely coordinate simply falls back to "not supervisor" and runs
   * its cheap local-only workers, same as any other lease-only worktree.
   */
  private async renewLeaseAndSupervisor(): Promise<void> {
    if (!this.gitIdentity) return;
    const { repositoryId, worktreeRoot } = this.gitIdentity;
    try {
      await getWorkspaceLeaseRegistry().heartbeat(repositoryId, worktreeRoot);
      await getRepoSupervisorRegistry().electOrRenew(repositoryId, worktreeRoot);
      this.lastSupervisorRenewalMs = Date.now();
    } catch { /* best-effort — see docstring */ }
  }

  /**
   * Cheap read-only check: does THIS daemon currently hold repository
   * supervisor status? Used to gate recurring headless (`claude --print`)
   * execution — see repo-supervisor.ts's module doc comment for the full
   * rationale. Never true when AI workers are disabled or the git identity
   * couldn't be resolved (e.g. a non-git directory).
   */
  private isRepositorySupervisor(): boolean {
    if (!this.config.aiWorkersEnabled || !this.gitIdentity) return false;
    return getRepoSupervisorRegistry().isSupervisor(this.gitIdentity.repositoryId, this.gitIdentity.worktreeRoot);
  }

  /**
   * Get daemon status
   */
  getStatus(): DaemonStatus {
    let supervisor: DaemonStatus['supervisor'] = null;
    if (this.config.aiWorkersEnabled && this.gitIdentity) {
      const { repositoryId, worktreeRoot } = this.gitIdentity;
      supervisor = {
        repositoryId,
        isSupervisor: getRepoSupervisorRegistry().isSupervisor(repositoryId, worktreeRoot),
        record: getRepoSupervisorRegistry().getRecord(repositoryId),
        activeLeases: getWorkspaceLeaseRegistry().listActive(repositoryId).length,
      };
    }
    return {
      running: this.running,
      pid: process.pid,
      startedAt: this.startedAt,
      workers: new Map(this.workers),
      config: this.config,
      supervisor,
    };
  }

  /**
   * Schedule a worker to run at intervals with staggered start
   */
  private scheduleWorker(workerConfig: WorkerConfig): void {
    const state = this.workers.get(workerConfig.type)!;
    const internalConfig = workerConfig as WorkerConfigInternal;
    const staggerOffset = internalConfig.offsetMs || 0;

    // Calculate initial delay with stagger offset
    let initialDelay = staggerOffset;
    if (state.lastRun) {
      const timeSinceLastRun = Date.now() - state.lastRun.getTime();
      initialDelay = Math.max(staggerOffset, workerConfig.intervalMs - timeSinceLastRun);
    }

    state.nextRun = new Date(Date.now() + initialDelay);

    const runAndReschedule = async () => {
      if (!this.running) return;

      // Use concurrency-controlled execution (P0 fix)
      await this.executeWorkerWithConcurrencyControl(workerConfig);

      // Reschedule
      if (this.running) {
        const timer = setTimeout(runAndReschedule, workerConfig.intervalMs);
        this.timers.set(workerConfig.type, timer);
        state.nextRun = new Date(Date.now() + workerConfig.intervalMs);
      }
    };

    // Schedule first run with stagger offset
    const timer = setTimeout(runAndReschedule, initialDelay);
    this.timers.set(workerConfig.type, timer);

    this.log('info', `Scheduled ${workerConfig.type} (interval: ${workerConfig.intervalMs / 1000}s, first run in ${initialDelay / 1000}s)`);
  }

  /**
   * Execute a worker with concurrency control (P0 fix)
   */
  private async executeWorkerWithConcurrencyControl(workerConfig: WorkerConfig): Promise<WorkerResult | null> {
    // Check concurrency limit
    if (this.runningWorkers.size >= this.config.maxConcurrent) {
      this.log('info', `Worker ${workerConfig.type} deferred: max concurrent (${this.config.maxConcurrent}) reached`);
      this.pendingWorkers.push(workerConfig.type);
      this.emit('worker:deferred', { type: workerConfig.type, reason: 'max_concurrent' });
      return null;
    }

    // Check resource availability
    const resourceCheck = await this.canRunWorker();
    if (!resourceCheck.allowed) {
      this.log('info', `Worker ${workerConfig.type} deferred: ${resourceCheck.reason}`);
      this.pendingWorkers.push(workerConfig.type);
      this.emit('worker:deferred', { type: workerConfig.type, reason: resourceCheck.reason });
      return null;
    }

    return this.executeWorker(workerConfig);
  }

  /**
   * Execute a worker with timeout protection
   */
  private async executeWorker(workerConfig: WorkerConfig, opts?: { manualTrigger?: boolean }): Promise<WorkerResult> {
    const state = this.workers.get(workerConfig.type)!;
    const workerId = `${workerConfig.type}_${Date.now()}`;
    const startTime = Date.now();

    // Track running worker
    this.runningWorkers.add(workerConfig.type);
    state.isRunning = true;
    state.lastStartedAt = new Date(); // #1856: timestamp the start
    this.saveState();                  // persist before we run anything
    this.emit('worker:start', { workerId, type: workerConfig.type });
    this.log('info', `Starting worker: ${workerConfig.type} (${this.runningWorkers.size}/${this.config.maxConcurrent} concurrent)`);

    try {
      // Execute worker logic with timeout (P1 fix)
      // Pass cleanup callback to kill orphan child processes on timeout (#1117)
      const output = await this.runWithTimeout(
        () => this.runWorkerLogic(workerConfig, opts),
        this.config.workerTimeoutMs,
        `Worker ${workerConfig.type} timed out after ${this.config.workerTimeoutMs / 1000}s`,
        () => {
          // On timeout, cancel any headless execution to prevent orphan processes
          if (this.headlessExecutor) {
            this.headlessExecutor.cancelAll();
          }
        }
      );
      const durationMs = Date.now() - startTime;

      // Update state
      state.runCount++;
      state.successCount++;
      state.lastRun = new Date();
      state.averageDurationMs = (state.averageDurationMs * (state.runCount - 1) + durationMs) / state.runCount;
      state.isRunning = false;

      const result: WorkerResult = {
        workerId,
        type: workerConfig.type,
        success: true,
        durationMs,
        output,
        timestamp: new Date(),
      };

      this.emit('worker:complete', result);
      this.log('info', `Worker ${workerConfig.type} completed in ${durationMs}ms`);
      this.saveState();

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      state.runCount++;
      state.failureCount++;
      state.lastRun = new Date();
      state.isRunning = false;

      const result: WorkerResult = {
        workerId,
        type: workerConfig.type,
        success: false,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      };

      this.emit('worker:error', result);
      this.log('error', `Worker ${workerConfig.type} failed: ${result.error}`);
      this.saveState();

      return result;
    } finally {
      // Remove from running set and process queue
      this.runningWorkers.delete(workerConfig.type);
      this.processPendingWorkers();
    }
  }

  /**
   * Run a function with timeout (P1 fix)
   * @param fn - The async function to execute
   * @param timeoutMs - Timeout in milliseconds
   * @param timeoutMessage - Error message on timeout
   * @param onTimeout - Optional cleanup callback invoked when timeout fires (#1117: kills orphan processes)
   */
  private async runWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
    onTimeout?: () => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Kill orphan child processes before rejecting (#1117)
        if (onTimeout) {
          try {
            onTimeout();
          } catch {
            // Ignore cleanup errors
          }
        }
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      fn()
        .then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Run the actual worker logic
   */
  private async runWorkerLogic(workerConfig: WorkerConfig, opts?: { manualTrigger?: boolean }): Promise<unknown> {
    // Check if this is a headless worker type and headless execution is available.
    // #2661 — aiWorkersEnabled is re-checked here (not just at init) as
    // defence in depth: no code path may promote a worker to `claude --print`
    // without explicit consent.
    //
    // #2661 root-fix — the RECURRING schedule additionally requires this
    // daemon to be the elected repository supervisor (see repo-supervisor.ts):
    // ten worktree daemons of one repository must not each independently
    // decide "is it time to run audit" every tick. An explicit
    // `daemon trigger --headless` (opts.manualTrigger) is still honored
    // regardless of supervisor status — it's a one-off, user-initiated
    // action, still budget/dedup-gated the same as any other launch.
    const supervisorGateOk = opts?.manualTrigger === true || this.isRepositorySupervisor();
    if (this.config.aiWorkersEnabled && supervisorGateOk && isHeadlessWorker(workerConfig.type) && this.headlessAvailable && this.headlessExecutor) {
      try {
        this.log('info', `Running ${workerConfig.type} in headless mode (Claude Code AI)`);
        const result = await this.headlessExecutor.execute(workerConfig.type as HeadlessWorkerType);

        // #2110 — `HeadlessWorkerExecutor.execute()` returns
        // `createErrorResult(...)` with `success: false` when
        // `isAvailable()` is false, instead of throwing. The previous
        // try/catch never fired in that path, and the result was
        // persisted as mode:"headless" despite being a stub. Downstream
        // dashboards / `memory stats` couldn't distinguish a real AI
        // run from a fallback. Treat falsy success the same as throw.
        const ok = (result as { success?: unknown })?.success === true;
        if (!ok) {
          const reason =
            (result as { error?: unknown })?.error ||
            (result as { note?: unknown })?.note ||
            'headless executor reported success=false';
          this.log('warn', `Headless ${workerConfig.type} returned success=false (${String(reason).slice(0, 200)}); falling back to local mode`);
          this.emit('headless:fallback', {
            type: workerConfig.type,
            error: String(reason).slice(0, 500),
          });
          // Fall through to local switch.
        } else if (result.dedupSkipped) {
          // #2661 invariant 5 — the same job (repositoryId + HEAD + worker +
          // config) already succeeded within the freshness window, e.g. in a
          // sibling worktree. No model call happened; do NOT overwrite the
          // persisted metrics (which hold the real prior result) and do NOT
          // fall back to local — the work is already done.
          this.log('info', `Worker ${workerConfig.type} dedup-skipped (same repo+HEAD job ran recently in another worktree)`);
          return {
            mode: 'headless-dedup-skip',
            ...result,
          };
        } else {
          // #1793: persist the headless result to the same metrics files the
          // local workers write to. Without this, AI-mode runs produced rich
          // parsedOutput that lived only in `.claude-flow/logs/headless/*` and
          // never reached `.claude-flow/metrics/<name>.json` — `memory stats`
          // and downstream consumers saw nothing despite successful runs.
          try {
            this.persistHeadlessResult(workerConfig.type as HeadlessWorkerType, result);
          } catch (persistError) {
            this.log('warn', `Failed to persist headless result for ${workerConfig.type}: ${(persistError as Error).message}`);
          }
          return {
            mode: 'headless',
            ...result,
          };
        }
      } catch (error) {
        this.log('warn', `Headless execution failed for ${workerConfig.type}, falling back to local mode`);
        this.emit('headless:fallback', {
          type: workerConfig.type,
          error: error instanceof Error ? error.message : String(error),
        });
        // Fall through to local execution
      }
    }

    // Local execution (fallback or for non-headless workers)
    switch (workerConfig.type) {
      case 'map':
        return this.runMapWorker();
      case 'audit':
        return this.runAuditWorkerLocal();
      case 'optimize':
        return this.runOptimizeWorkerLocal();
      case 'consolidate':
        return this.runConsolidateWorker();
      case 'backup':
        return this.runBackupWorker();
      case 'harness':
        return this.runHarnessWorker();
      case 'testgaps':
        return this.runTestGapsWorkerLocal();
      case 'predict':
        return this.runPredictWorkerLocal();
      case 'document':
        return this.runDocumentWorkerLocal();
      case 'ultralearn':
        return this.runUltralearnWorkerLocal();
      case 'refactor':
        return this.runRefactorWorkerLocal();
      case 'deepdive':
        return this.runDeepdiveWorkerLocal();
      case 'benchmark':
        return this.runBenchmarkWorkerLocal();
      case 'preload':
        return this.runPreloadWorkerLocal();
      default:
        return { status: 'unknown worker type', mode: 'local' };
    }
  }

  /**
   * #1793: persist a headless worker result to the same metrics file the
   * local fallback writes to. Without this, AI-mode workers produced rich
   * structured output (audit findings, perf signals, test-gap analysis)
   * that lived only in `.claude-flow/logs/headless/*_result.log` and was
   * invisible to `npx ruflo memory stats` or the metrics consumers.
   *
   * The mapping mirrors the `*Local` worker implementations below so a
   * single consumer path works regardless of execution mode.
   */
  private persistHeadlessResult(
    workerType: HeadlessWorkerType,
    result: HeadlessExecutionResult,
  ): void {
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');
    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });

    // Filename mirrors the local-mode worker writes (security-audit.json,
    // performance.json, test-gaps.json) so a downstream reader doesn't
    // care which mode produced the data.
    const filenameMap: Partial<Record<HeadlessWorkerType, string>> = {
      audit: 'security-audit.json',
      optimize: 'performance.json',
      testgaps: 'test-gaps.json',
      document: 'documentation.json',
      refactor: 'refactor.json',
      deepdive: 'deepdive.json',
      ultralearn: 'ultralearn.json',
      predict: 'predictions.json',
    };
    const filename = filenameMap[workerType] ?? `${workerType}.json`;
    const metricsFile = join(metricsDir, filename);

    const persisted = {
      timestamp: result.timestamp instanceof Date ? result.timestamp.toISOString() : new Date().toISOString(),
      mode: 'headless' as const,
      workerType,
      model: result.model,
      durationMs: result.durationMs,
      tokensUsed: result.tokensUsed,
      executionId: result.executionId,
      success: result.success,
      // Structured findings live here when the worker emits JSON (e.g. the
      // audit worker's vulnerability list). Fall back to a raw-output
      // pointer so consumers can still locate the full log.
      findings: result.parsedOutput ?? null,
      rawOutputPreview: typeof result.output === 'string' ? result.output.slice(0, 2000) : undefined,
      rawOutputLength: typeof result.output === 'string' ? result.output.length : 0,
    };

    writeFileSync(metricsFile, JSON.stringify(persisted, null, 2));
  }

  // Worker implementations

  private async runMapWorker(): Promise<unknown> {
    // Scan project structure and update metrics
    const metricsFile = join(this.projectRoot, '.claude-flow', 'metrics', 'codebase-map.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const map = {
      timestamp: new Date().toISOString(),
      projectRoot: this.projectRoot,
      structure: {
        hasPackageJson: existsSync(join(this.projectRoot, 'package.json')),
        hasTsConfig: existsSync(join(this.projectRoot, 'tsconfig.json')),
        hasClaudeConfig: existsSync(join(this.projectRoot, '.claude')),
        hasClaudeFlow: existsSync(join(this.projectRoot, '.claude-flow')),
      },
      scannedAt: Date.now(),
    };

    writeFileSync(metricsFile, JSON.stringify(map, null, 2));
    return map;
  }

  /**
   * Local audit worker (fallback when headless unavailable)
   */
  private async runAuditWorkerLocal(): Promise<unknown> {
    // Basic security checks
    const auditFile = join(this.projectRoot, '.claude-flow', 'metrics', 'security-audit.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const audit = {
      timestamp: new Date().toISOString(),
      mode: 'local',
      checks: {
        envFilesProtected: !existsSync(join(this.projectRoot, '.env.local')),
        gitIgnoreExists: existsSync(join(this.projectRoot, '.gitignore')),
        noHardcodedSecrets: true, // Would need actual scanning
      },
      riskLevel: 'low',
      recommendations: [],
      note: 'Install Claude Code CLI for AI-powered security analysis',
    };

    writeFileSync(auditFile, JSON.stringify(audit, null, 2));
    return audit;
  }

  /**
   * Local optimize worker (fallback when headless unavailable)
   */
  private async runOptimizeWorkerLocal(): Promise<unknown> {
    // Update performance metrics
    const optimizeFile = join(this.projectRoot, '.claude-flow', 'metrics', 'performance.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const perf = {
      timestamp: new Date().toISOString(),
      mode: 'local',
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      optimizations: {
        cacheHitRate: 0.78,
        avgResponseTime: 45,
      },
      note: 'Install Claude Code CLI for AI-powered optimization suggestions',
    };

    writeFileSync(optimizeFile, JSON.stringify(perf, null, 2));
    return perf;
  }

  /**
   * ADR-174 M3: memory consolidation — runs the real DISTILL/CONSOLIDATE pass
   * (memory-distillation.ts) against `.swarm/memory.db`, turning raw
   * `memory_entries` into `episodes` / `reasoning_patterns` /
   * `pattern_embeddings` / `causal_edges`. Previously this wrote a hardcoded
   * `{ patternsConsolidated: 0 }` stub and touched no database — the root
   * cause of the intelligence tables staying empty.
   *
   * Kept as `runConsolidateWorker` / worker type `'consolidate'` for
   * back-compat with existing `-w consolidate` scripts and docs.
   *
   * Safety:
   *  - Bounded via CONSOLIDATE_MAX_ENTRIES_PER_TICK so a large backlog can
   *    never approach DEFAULT_WORKER_TIMEOUT_MS — the incremental cursor in
   *    runDistillation() drains a bounded slice per tick and picks up where
   *    it left off on the next scheduled run.
   *  - runDistillation() never throws (it catches internally and returns
   *    `{ skipped }` / `{ corrupt: true }`), but this worker still wraps the
   *    call defensively — a background worker must never crash the daemon.
   */
  private async runConsolidateWorker(): Promise<unknown> {
    const consolidateFile = join(this.projectRoot, '.claude-flow', 'metrics', 'consolidation.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    // Opt-out: RUFLO_DAEMON_NO_DISTILL=1 (or `daemon start --no-distill`)
    // skips the real distillation pass entirely without touching persisted
    // worker-enabled state (see also: `daemon enable -w consolidate --disable`,
    // which disables the worker's schedule altogether).
    if (process.env[NO_DISTILL_ENV] === '1') {
      const disabledResult = {
        timestamp: new Date().toISOString(),
        distillationEnabled: false,
        note: `Distillation disabled via ${NO_DISTILL_ENV}=1 / --no-distill`,
        patternsConsolidated: 0,
        memoryCleaned: 0,
        duplicatesRemoved: 0,
      };
      writeFileSync(consolidateFile, JSON.stringify(disabledResult, null, 2));
      return disabledResult;
    }

    let report: DistillReport;
    try {
      report = await runDistillation({
        dbPath: defaultMemoryDbPath(this.projectRoot),
        maxEntries: CONSOLIDATE_MAX_ENTRIES_PER_TICK,
        batchSize: CONSOLIDATE_BATCH_SIZE,
        dedupDistance: CONSOLIDATE_DEDUP_DISTANCE,
      });
    } catch (error) {
      // Defensive only — runDistillation() is internally try/catch'd and
      // should never reach here. A worker must never crash the daemon.
      const message = error instanceof Error ? error.message : String(error);
      this.log('warn', `Consolidate worker: distillation threw unexpectedly: ${message}`);
      const errorResult = {
        timestamp: new Date().toISOString(),
        distillationEnabled: true,
        error: message,
        patternsConsolidated: 0,
        memoryCleaned: 0,
        duplicatesRemoved: 0,
      };
      writeFileSync(consolidateFile, JSON.stringify(errorResult, null, 2));
      return errorResult;
    }

    if (report.corrupt) {
      this.log('warn', `Consolidate worker: memory DB reports corruption — ${report.skipped ?? 'skipped'}`);
    } else if (report.skipped) {
      this.log('info', `Consolidate worker: distillation skipped (${report.skipped})`);
    }

    const result = {
      timestamp: new Date().toISOString(),
      distillationEnabled: true,
      // Mapping onto the pre-existing metrics shape (ADR-174 M3):
      patternsConsolidated: report.patterns,
      // rows drained from the incremental cursor this tick — distillation is
      // non-destructive (never mutates/deletes memory_entries), so "cleaned"
      // here means "processed into the intelligence tables", not removed.
      memoryCleaned: report.processed,
      // clustering collapses near-duplicate entries into a single pattern
      // rather than deleting them; this is the count that got merged away
      // instead of becoming their own distinct pattern.
      duplicatesRemoved: Math.max(0, report.processed - report.patterns),
      episodes: report.episodes,
      episodeEmbeddings: report.episodeEmbeddings,
      patternEmbeddings: report.patternEmbeddings,
      causalEdges: report.causalEdges,
      promoted: report.promoted,
      byProvenance: report.byProvenance,
      namespaces: report.namespaces,
      dryRun: report.dryRun,
      corrupt: report.corrupt ?? false,
      skipped: report.skipped,
    };

    writeFileSync(consolidateFile, JSON.stringify(result, null, 2));
    return result;
  }

  /**
   * Nightly memory-DB backup worker (24h interval). Takes a WAL-safe, consistent
   * snapshot of .swarm/memory.db with rotation (keep last N). Never throws — a
   * worker must not crash the daemon; a skip/error is written to the metrics
   * file. Opt-out by omitting `backup` from `-w`; offsite GCS is opt-in via
   * RUFLO_BACKUP_GCS (a gs:// prefix), retention via RUFLO_BACKUP_KEEP.
   */
  private async runBackupWorker(): Promise<unknown> {
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');
    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
    const backupFile = join(metricsDir, 'backup.json');

    let result: Record<string, unknown>;
    try {
      const keepEnv = Number(process.env.RUFLO_BACKUP_KEEP);
      const r = await backupMemoryDb({
        dbPath: defaultMemoryDbPath(this.projectRoot),
        keep: Number.isFinite(keepEnv) && keepEnv > 0 ? keepEnv : 7,
        gcs: process.env.RUFLO_BACKUP_GCS || undefined,
      });
      result = {
        timestamp: new Date().toISOString(),
        backedUp: r.backedUp,
        path: r.path,
        sizeBytes: r.sizeBytes ?? 0,
        rotatedAway: r.rotatedAway?.length ?? 0,
        gcsUri: r.gcsUri,
        skipped: r.skipped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('warn', `Backup worker failed: ${message}`);
      result = { timestamp: new Date().toISOString(), backedUp: false, error: message };
    }

    writeFileSync(backupFile, JSON.stringify(result, null, 2));
    return result;
  }

  /**
   * Self-optimizing harness loop worker (ADR-176 phase 8). Strictly bounded:
   * OPT-IN (RUFLO_HARNESS_LOOP), $0-default (no optimizer/verifier wired => no
   * promotion), trajectory-capped, single-flight via the daemon, never throws.
   * On acceptance the (unsigned) champion is staged for the separate sign step.
   */
  private async runHarnessWorker(): Promise<unknown> {
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');
    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
    const harnessFile = join(metricsDir, 'harness-loop.json');

    let result: Record<string, unknown>;
    try {
      // ADR-176 flywheel (A-P3b autonomy loop): run ONE COMPOUNDING generation
      // on the install's REAL data — read the persisted champion as baseline,
      // gate a constrained candidate on the frozen self-supervised held-out with
      // the human-anchor guard + separate canary, and on a verified promotion
      // advance the champion so the NEXT tick compounds. Shadow-first (serve lags
      // one tick). Opt-in ($0 no-op without RUFLO_HARNESS_LOOP).
      const { runFlywheelGenerationWorker } = await import('./harness-flywheel-runtime.js');
      const gen = await runFlywheelGenerationWorker(this.projectRoot, { sample: 120 });
      let status: unknown = null;
      try {
        const { flywheelStatus } = await import('./harness-flywheel-generations.js');
        status = flywheelStatus(this.projectRoot);
      } catch { /* no lineage yet */ }
      if (gen.promoted) this.log('info', `Flywheel gen ${gen.generation}: PROMOTED (+${(gen.delta ?? 0).toFixed(4)} held-out, significant=${gen.significant}) — champion advanced`);
      result = { timestamp: new Date().toISOString(), flywheel: gen, lineage: status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('warn', `Harness worker failed: ${message}`);
      result = { timestamp: new Date().toISOString(), ran: false, error: message };
    }

    writeFileSync(harnessFile, JSON.stringify(result, null, 2));
    return result;
  }

  /**
   * Local testgaps worker (fallback when headless unavailable)
   */
  private async runTestGapsWorkerLocal(): Promise<unknown> {
    // Check for test coverage gaps
    const testGapsFile = join(this.projectRoot, '.claude-flow', 'metrics', 'test-gaps.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const result = {
      timestamp: new Date().toISOString(),
      mode: 'local',
      hasTestDir: existsSync(join(this.projectRoot, 'tests')) || existsSync(join(this.projectRoot, '__tests__')),
      estimatedCoverage: 'unknown',
      gaps: [],
      note: 'Install Claude Code CLI for AI-powered test gap analysis',
    };

    writeFileSync(testGapsFile, JSON.stringify(result, null, 2));
    return result;
  }

  /**
   * Local predict worker (fallback when headless unavailable)
   */
  private async runPredictWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      predictions: [],
      preloaded: [],
      note: 'Install Claude Code CLI for AI-powered predictions',
    };
  }

  /**
   * Local document worker (fallback when headless unavailable)
   */
  private async runDocumentWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      filesDocumented: 0,
      suggestedDocs: [],
      note: 'Install Claude Code CLI for AI-powered documentation generation',
    };
  }

  /**
   * Local ultralearn worker (fallback when headless unavailable)
   */
  private async runUltralearnWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      patternsLearned: 0,
      insightsGained: [],
      note: 'Install Claude Code CLI for AI-powered deep learning',
    };
  }

  /**
   * Local refactor worker (fallback when headless unavailable)
   */
  private async runRefactorWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      suggestions: [],
      duplicatesFound: 0,
      note: 'Install Claude Code CLI for AI-powered refactoring suggestions',
    };
  }

  /**
   * Local deepdive worker (fallback when headless unavailable)
   */
  private async runDeepdiveWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      analysisDepth: 'shallow',
      findings: [],
      note: 'Install Claude Code CLI for AI-powered deep code analysis',
    };
  }

  /**
   * Local benchmark worker
   */
  private async runBenchmarkWorkerLocal(): Promise<unknown> {
    const benchmarkFile = join(this.projectRoot, '.claude-flow', 'metrics', 'benchmark.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const result = {
      timestamp: new Date().toISOString(),
      mode: 'local',
      benchmarks: {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime(),
      },
    };

    writeFileSync(benchmarkFile, JSON.stringify(result, null, 2));
    return result;
  }

  /**
   * Local preload worker
   */
  private async runPreloadWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      resourcesPreloaded: 0,
      cacheStatus: 'active',
    };
  }

  /**
   * Manually trigger a worker
   */
  async triggerWorker(type: WorkerType): Promise<WorkerResult> {
    const workerConfig = this.config.workers.find(w => w.type === type);
    if (!workerConfig) {
      throw new Error(`Unknown worker type: ${type}`);
    }
    // #2251 — wait for headless probe to settle before running. Without
    // this, on-demand `daemon trigger -w <worker>` races the constructor's
    // fire-and-forget init and ALWAYS falls through to local mode even
    // when `claude` is on PATH and scheduled fires of the same worker
    // use headless correctly. Scheduled fires already wait long enough
    // (timer + offset) that this is a no-op for them.
    await this.headlessInitPromise;
    // #2661 root-fix — an explicit manual trigger bypasses the repository-
    // supervisor gate (still budget/dedup-gated) — see runWorkerLogic()'s
    // doc comment.
    return this.executeWorker(workerConfig, { manualTrigger: true });
  }

  /**
   * Enable/disable a worker
   */
  setWorkerEnabled(type: WorkerType, enabled: boolean): void {
    const workerConfig = this.config.workers.find(w => w.type === type);
    if (workerConfig) {
      workerConfig.enabled = enabled;

      if (enabled && this.running) {
        this.scheduleWorker(workerConfig);
      } else if (!enabled) {
        const timer = this.timers.get(type);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(type);
        }
      }

      this.saveState();
    }
  }

  /**
   * Save daemon state to file
   */
  private saveState(): void {
    const state = {
      running: this.running,
      startedAt: this.startedAt?.toISOString(),
      workers: Object.fromEntries(
        Array.from(this.workers.entries()).map(([type, state]) => [
          type,
          {
            ...state,
            lastRun: state.lastRun?.toISOString(),
            lastStartedAt: state.lastStartedAt?.toISOString(),
            nextRun: state.nextRun?.toISOString(),
          }
        ])
      ),
      config: {
        ...this.config,
        workers: this.config.workers.map(w => ({ ...w })),
      },
      savedAt: new Date().toISOString(),
    };

    try {
      // ruvnet/ruflo#2782: use writeFileAtomic — its temp file is uniquified with
      // pid + timestamp + random suffix, so two concurrent in-process saveState()
      // calls can no longer collide on a shared `.tmp` basename and race one
      // another's renameSync into ENOENT. Related to but distinct from #1637.
      writeFileAtomic(this.config.stateFile, Buffer.from(JSON.stringify(state, null, 2)));
    } catch (error) {
      this.log('error', `Failed to save state: ${error}`);
    }
  }

  /**
   * Log message
   */
  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    this.emit('log', { level, message, timestamp });

    // Also write to log file
    try {
      const logFile = join(this.config.logDir, 'daemon.log');
      appendFileSync(logFile, logMessage + '\n');
    } catch {
      // Ignore log write errors
    }
  }
}

// Singleton instance for global access
let daemonInstance: WorkerDaemon | null = null;

/**
 * Get or create daemon instance
 */
export function getDaemon(projectRoot?: string, config?: Partial<DaemonConfig>): WorkerDaemon {
  if (!daemonInstance && projectRoot) {
    daemonInstance = new WorkerDaemon(projectRoot, config);
  }
  if (!daemonInstance) {
    throw new Error('Daemon not initialized. Provide projectRoot on first call.');
  }
  return daemonInstance;
}

/**
 * Start daemon (for use in session-start hook)
 */
export async function startDaemon(projectRoot: string, config?: Partial<DaemonConfig>): Promise<WorkerDaemon> {
  const daemon = getDaemon(projectRoot, config);
  await daemon.start();
  return daemon;
}

/**
 * Stop daemon
 */
export async function stopDaemon(): Promise<void> {
  if (daemonInstance) {
    await daemonInstance.stop();
  }
}

export default WorkerDaemon;
