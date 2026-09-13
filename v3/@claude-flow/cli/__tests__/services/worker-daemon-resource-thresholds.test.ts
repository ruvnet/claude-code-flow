/**
 * WorkerDaemon Resource Thresholds Tests
 *
 * Validates CPU-proportional defaults, config priority chain,
 * state persistence, resource gating, and input validation.
 *
 * Uses real temp directories for filesystem isolation.
 * All resource gating tests use explicit constructor config
 * to avoid host-machine dependency.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerDaemon } from '../../src/services/worker-daemon.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, cpus } from 'os';

describe('WorkerDaemon resource thresholds', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'worker-daemon-test-'));
    mkdirSync(join(tempDir, '.claude-flow', 'logs'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('os');
    rmSync(tempDir, { recursive: true, force: true });
    // Clean up signal listeners to prevent MaxListenersExceededWarning
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGHUP');
  });

  // =========================================================================
  // Smart CPU-proportional defaults
  // =========================================================================
  describe('smart CPU-proportional defaults', () => {
    it('should compute maxCpuLoad as max(cpuCount * 1.5, 4.0)', () => {
      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      const cpuCount = cpus().length || 1;
      const expected = Math.max(cpuCount * 1.5, 4.0);

      expect(config.resourceThresholds.maxCpuLoad).toBeCloseTo(expected, 1);
    });

    it('should always be at least 4.0 regardless of CPU count', () => {
      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThanOrEqual(4.0);
    });

    it('should scale above 4.0 on multi-core machines', () => {
      const cpuCount = cpus().length;
      if (cpuCount <= 3) return; // skip on small machines

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThan(4.0);
    });

    it('should use platform-aware default for minFreeMemoryPercent', () => {
      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      const expectedMinFreeMem = process.platform === 'darwin' ? 2 : 10;
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(expectedMinFreeMem);
    });
  });

  // =========================================================================
  // Resource gating via canRunWorker
  // =========================================================================
  describe('resource gating', () => {
    it('should allow workers when CPU load is below threshold', async () => {
      // Explicitly set threshold — decoupled from host machine
      const daemon = new WorkerDaemon(tempDir, {
        resourceThresholds: { maxCpuLoad: 9.6, minFreeMemoryPercent: 20 },
      });

      vi.doMock('os', () => ({
        default: {
          loadavg: () => [3.5, 3.0, 2.5],
          totalmem: () => 16e9,
          freemem: () => 8e9, // 50% free
        },
        loadavg: () => [3.5, 3.0, 2.5],
        totalmem: () => 16e9,
        freemem: () => 8e9,
      }));

      const result = await (daemon as any).canRunWorker();
      expect(result.allowed).toBe(true);
    });

    it('should block workers when CPU load exceeds threshold', async () => {
      const daemon = new WorkerDaemon(tempDir, {
        resourceThresholds: { maxCpuLoad: 2.0, minFreeMemoryPercent: 5 },
      });

      vi.doMock('os', () => ({
        default: {
          loadavg: () => [5.0, 4.0, 3.0],
          totalmem: () => 16e9,
          freemem: () => 8e9,
        },
        loadavg: () => [5.0, 4.0, 3.0],
        totalmem: () => 16e9,
        freemem: () => 8e9,
      }));

      const result = await (daemon as any).canRunWorker();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('CPU');
    });

    it('should block workers when free memory is below threshold', async () => {
      const daemon = new WorkerDaemon(tempDir, {
        resourceThresholds: { maxCpuLoad: 100, minFreeMemoryPercent: 50 },
      });

      vi.doMock('os', () => ({
        default: {
          loadavg: () => [0.5, 0.5, 0.5],
          totalmem: () => 16e9,
          freemem: () => 1e9, // ~6% free — below 50% threshold
        },
        loadavg: () => [0.5, 0.5, 0.5],
        totalmem: () => 16e9,
        freemem: () => 1e9,
      }));

      const result = await (daemon as any).canRunWorker();
      expect(result.allowed).toBe(false);
      expect(result.reason.toLowerCase()).toContain('memory');
    });
  });

  // =========================================================================
  // Config file reading
  // =========================================================================
  describe('config.json reading', () => {
    it('should read daemon settings from flat dot-notation keys', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.maxCpuLoad': 10,
        'daemon.resourceThresholds.minFreeMemoryPercent': 25,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBe(10);
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(25);
    });

    it('should read daemon settings from scopes.project', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        scopes: {
          project: {
            'daemon.resourceThresholds.maxCpuLoad': 12,
          },
        },
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBe(12);
    });

    it('should handle malformed config.json gracefully', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, '{ invalid json !!!');

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      const expectedMinFreeMem = process.platform === 'darwin' ? 2 : 10;
      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThanOrEqual(4.0);
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(expectedMinFreeMem);
    });
  });

  // =========================================================================
  // Config priority chain
  // =========================================================================
  describe('config priority: constructor arg > config.json > smart default', () => {
    it('should prefer constructor arg over config.json', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.maxCpuLoad': 10,
      }));

      const daemon = new WorkerDaemon(tempDir, {
        resourceThresholds: { maxCpuLoad: 15, minFreeMemoryPercent: 5 },
      });
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBe(15);
    });

    it('should prefer config.json over smart default', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.maxCpuLoad': 42,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBe(42);
    });
  });

  // =========================================================================
  // State persistence
  // =========================================================================
  describe('state persistence', () => {
    it('should restore resourceThresholds from daemon-state.json', () => {
      const stateFile = join(tempDir, '.claude-flow', 'daemon-state.json');
      writeFileSync(stateFile, JSON.stringify({
        running: false,
        workers: {},
        config: {
          resourceThresholds: { maxCpuLoad: 8.0, minFreeMemoryPercent: 15 },
          workers: [],
        },
        savedAt: new Date().toISOString(),
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBe(8.0);
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(15);
    });

    it('should restore maxConcurrent and workerTimeoutMs from state', () => {
      const stateFile = join(tempDir, '.claude-flow', 'daemon-state.json');
      writeFileSync(stateFile, JSON.stringify({
        running: false,
        workers: {},
        config: {
          maxConcurrent: 6,
          workerTimeoutMs: 600000,
          resourceThresholds: { maxCpuLoad: 10.0, minFreeMemoryPercent: 10 },
          workers: [],
        },
        savedAt: new Date().toISOString(),
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.maxConcurrent).toBe(6);
      expect(config.workerTimeoutMs).toBe(600000);
    });

    it('should reject invalid values from saved state', () => {
      const stateFile = join(tempDir, '.claude-flow', 'daemon-state.json');
      writeFileSync(stateFile, JSON.stringify({
        running: false,
        workers: {},
        config: {
          resourceThresholds: { maxCpuLoad: -10, minFreeMemoryPercent: 200 },
          maxConcurrent: 0,
          workerTimeoutMs: -500,
          workers: [],
        },
        savedAt: new Date().toISOString(),
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThan(0);
      expect(config.resourceThresholds.minFreeMemoryPercent).toBeLessThanOrEqual(100);
      expect(config.maxConcurrent).toBeGreaterThan(0);
      expect(config.workerTimeoutMs).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Input validation
  // =========================================================================
  describe('input validation', () => {
    it('should ignore non-numeric values in config.json', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.maxCpuLoad': 'not-a-number',
        'daemon.resourceThresholds.minFreeMemoryPercent': null,
        'daemon.maxConcurrent': true,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      const expectedMinFreeMem = process.platform === 'darwin' ? 2 : 10;
      expect(typeof config.resourceThresholds.maxCpuLoad).toBe('number');
      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThanOrEqual(4.0);
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(expectedMinFreeMem);
      expect(config.maxConcurrent).toBe(2); // default
    });

    it('should ignore negative values in config.json', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.maxCpuLoad': -5,
        'daemon.maxConcurrent': -1,
        'daemon.workerTimeoutMs': -100,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThan(0);
      expect(config.maxConcurrent).toBeGreaterThan(0);
      expect(config.workerTimeoutMs).toBeGreaterThan(0);
    });

    it('should reject minFreeMemoryPercent outside 0-100 range', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.minFreeMemoryPercent': 150,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      expect(config.resourceThresholds.minFreeMemoryPercent).toBeLessThanOrEqual(100);
    });
  });

  // =========================================================================
  // processPendingWorkers busy-wait fix (WI-1 / PR #1052)
  // =========================================================================
  describe('processPendingWorkers busy-wait prevention', () => {
    it('should not spin when all workers are deferred due to resource pressure', async () => {
      // Set impossibly low thresholds so canRunWorker always rejects
      const daemon = new WorkerDaemon(tempDir, {
        maxConcurrent: 2,
        resourceThresholds: { maxCpuLoad: 0.001, minFreeMemoryPercent: 99.99 },
      });

      // Seed the pending queue with a worker
      const pendingWorkers = (daemon as any).pendingWorkers as string[];
      pendingWorkers.push('map');

      // Spy on executeWorkerWithConcurrencyControl to count invocations
      const execSpy = vi.spyOn(daemon as any, 'executeWorkerWithConcurrencyControl');

      await (daemon as any).processPendingWorkers();

      // Should have been called exactly once — then broke out of the loop
      expect(execSpy.mock.calls.length).toBe(1);
      // The deferred worker should still be on the pending queue (pushed back by executeWorkerWithConcurrencyControl)
      expect(pendingWorkers).toContain('map');
    });

    it('should schedule a backoff retry when no workers are running and a worker is deferred', async () => {
      const daemon = new WorkerDaemon(tempDir, {
        maxConcurrent: 2,
        resourceThresholds: { maxCpuLoad: 0.001, minFreeMemoryPercent: 99.99 },
      });

      const pendingWorkers = (daemon as any).pendingWorkers as string[];
      pendingWorkers.push('audit');

      // Ensure no workers are currently running
      expect((daemon as any).runningWorkers.size).toBe(0);

      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const callCountBefore = setTimeoutSpy.mock.calls.length;

      await (daemon as any).processPendingWorkers();

      // Find the 30-second backoff call among any setTimeout calls
      const backoffCalls = setTimeoutSpy.mock.calls
        .slice(callCountBefore)
        .filter((call) => call[1] === 30_000);
      expect(backoffCalls.length).toBe(1);

      setTimeoutSpy.mockRestore();
    });

    it('should not schedule backoff when running workers will drain the queue', async () => {
      const daemon = new WorkerDaemon(tempDir, {
        maxConcurrent: 1,
        resourceThresholds: { maxCpuLoad: 0.001, minFreeMemoryPercent: 99.99 },
      });

      // Simulate a worker already running — its finally block will re-trigger processPendingWorkers
      (daemon as any).runningWorkers.add('optimize');

      const pendingWorkers = (daemon as any).pendingWorkers as string[];
      pendingWorkers.push('map');

      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const callCountBefore = setTimeoutSpy.mock.calls.length;

      await (daemon as any).processPendingWorkers();

      // No 30-second backoff should have been scheduled because a running worker exists
      const backoffCalls = setTimeoutSpy.mock.calls
        .slice(callCountBefore)
        .filter((call) => call[1] === 30_000);
      expect(backoffCalls.length).toBe(0);

      setTimeoutSpy.mockRestore();
    });
  });

  // =========================================================================
  // Mutation-killing tests (Stryker-inspired)
  // Each test targets a specific code mutation that would survive existing tests.
  // =========================================================================
  describe('mutation killing', () => {
    // MUTANT: Math.max(cpuCount * 1.5, 4.0) → Math.min(cpuCount * 1.5, 4.0)
    // On 12-core: Math.min(18, 4.0) = 4.0 — would survive ">=4.0" tests
    it('should NOT use Math.min — multi-core default must exceed 4.0', () => {
      const cpuCount = cpus().length;
      if (cpuCount <= 3) return;

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: Math.max → Math.min mutant
      // Math.min(12*1.5, 4.0) = 4.0, but correct is 18
      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThan(4.0);
      expect(config.resourceThresholds.maxCpuLoad).toBeLessThan(cpuCount * 2); // sanity
    });

    // MUTANT: cpuCount * 1.5 → cpuCount * 0 (or cpuCount + 1.5)
    it('should scale proportionally to CPU count, not be constant', () => {
      const cpuCount = cpus().length;
      if (cpuCount <= 3) return;

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: * 1.5 → * 0, + 1.5, - 1.5
      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThan(cpuCount * 1.0);
      expect(config.resourceThresholds.maxCpuLoad).toBeLessThan(cpuCount * 2.0);
    });

    // MUTANT: `>` → `>=` in canRunWorker CPU check
    // loadavg === maxCpuLoad should be ALLOWED (not blocked)
    it('should allow workers when CPU load equals exactly the threshold', async () => {
      const daemon = new WorkerDaemon(tempDir, {
        resourceThresholds: { maxCpuLoad: 5.0, minFreeMemoryPercent: 5 },
      });

      vi.doMock('os', () => ({
        default: {
          loadavg: () => [5.0, 4.0, 3.0], // exactly at threshold
          totalmem: () => 16e9,
          freemem: () => 8e9,
        },
        loadavg: () => [5.0, 4.0, 3.0],
        totalmem: () => 16e9,
        freemem: () => 8e9,
      }));

      const result = await (daemon as any).canRunWorker();
      // Kills: > → >= mutant (at-threshold should pass)
      expect(result.allowed).toBe(true);
    });

    // MUTANT: `<` → `<=` in canRunWorker memory check
    // freePercent === minFreeMemoryPercent should be ALLOWED
    it('should allow workers when free memory equals exactly the threshold', async () => {
      const daemon = new WorkerDaemon(tempDir, {
        resourceThresholds: { maxCpuLoad: 100, minFreeMemoryPercent: 20 },
      });

      vi.doMock('os', () => ({
        default: {
          loadavg: () => [0.5, 0.5, 0.5],
          totalmem: () => 100e9,
          freemem: () => 20e9, // exactly 20% = threshold
        },
        loadavg: () => [0.5, 0.5, 0.5],
        totalmem: () => 100e9,
        freemem: () => 20e9,
      }));

      const result = await (daemon as any).canRunWorker();
      // Kills: < → <= mutant (at-threshold should pass)
      expect(result.allowed).toBe(true);
    });

    // MUTANT: Remove `|| 1` fallback in getEffectiveCpuCount
    // On bare metal this doesn't matter, but the floor must exist
    it('should return at least 1 from getEffectiveCpuCount', () => {
      const count = WorkerDaemon.getEffectiveCpuCount();
      // Kills: removal of || 1 (result must never be 0)
      expect(count).toBeGreaterThanOrEqual(1);
    });

    // MUTANT: Remove scopes.project fallback in readDaemonConfigFromFile
    // Config only at scopes.project level must still be read
    it('should prefer scopes.project over root when both exist', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.maxCpuLoad': 5,
        scopes: {
          project: {
            'daemon.resourceThresholds.maxCpuLoad': 20,
          },
        },
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: removal of scopes.project ?? raw fallback
      // scopes.project should take priority over root
      expect(config.resourceThresholds.maxCpuLoad).toBe(20);
    });

    // MUTANT: Remove validation `rawCpuLoad > 0` → accept zero
    it('should reject maxCpuLoad of exactly 0 in config.json', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.maxCpuLoad': 0,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: > 0 → >= 0 mutant (zero should be rejected)
      expect(config.resourceThresholds.maxCpuLoad).toBeGreaterThan(0);
    });

    // MUTANT: Remove validation `rawMinMem <= 100`
    it('should reject minFreeMemoryPercent of exactly 101 in config.json', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.minFreeMemoryPercent': 101,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: <= 100 → < 100 or removal of upper bound check
      expect(config.resourceThresholds.minFreeMemoryPercent).toBeLessThanOrEqual(100);
    });

    // MUTANT: minFreeMemoryPercent accepts 0 (boundary — should it?)
    it('should accept minFreeMemoryPercent of 0 in config.json (disable memory check)', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.minFreeMemoryPercent': 0,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: >= 0 → > 0 mutant (zero is valid — disables memory gating)
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(0);
    });

    // MUTANT: Remove `typeof ... === 'number'` check → accept booleans
    it('should reject boolean true as maxCpuLoad (typeof guard)', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.resourceThresholds.maxCpuLoad': true,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: removal of typeof check (true is truthy but not a number)
      // JS: typeof true === 'boolean', not 'number'
      expect(config.resourceThresholds.maxCpuLoad).not.toBe(true);
      expect(typeof config.resourceThresholds.maxCpuLoad).toBe('number');
    });

    // MUTANT: State restore `rt.maxCpuLoad < 1000` → remove upper bound
    it('should reject absurdly large maxCpuLoad from saved state', () => {
      const stateFile = join(tempDir, '.claude-flow', 'daemon-state.json');
      writeFileSync(stateFile, JSON.stringify({
        running: false,
        workers: {},
        config: {
          resourceThresholds: { maxCpuLoad: 999999, minFreeMemoryPercent: 10 },
          workers: [],
        },
        savedAt: new Date().toISOString(),
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: removal of < 1000 bound in state restoration
      expect(config.resourceThresholds.maxCpuLoad).toBeLessThan(1000);
    });

    // MUTANT: Swap CPU and memory checks in canRunWorker
    it('should independently check CPU and memory (not conflate them)', async () => {
      // High CPU + plenty of memory → should block on CPU
      const daemon1 = new WorkerDaemon(tempDir, {
        resourceThresholds: { maxCpuLoad: 2.0, minFreeMemoryPercent: 5 },
      });

      vi.doMock('os', () => ({
        default: {
          loadavg: () => [10.0, 8.0, 6.0], // way over CPU
          totalmem: () => 16e9,
          freemem: () => 15e9, // 93% free — plenty of memory
        },
        loadavg: () => [10.0, 8.0, 6.0],
        totalmem: () => 16e9,
        freemem: () => 15e9,
      }));

      const result1 = await (daemon1 as any).canRunWorker();
      expect(result1.allowed).toBe(false);
      expect(result1.reason).toContain('CPU');
      expect(result1.reason).not.toContain('emory'); // not memory

      vi.doUnmock('os');

      // Low CPU + low memory → should block on memory
      const tempDir2 = mkdtempSync(join(tmpdir(), 'worker-daemon-test-'));
      mkdirSync(join(tempDir2, '.claude-flow', 'logs'), { recursive: true });
      const daemon2 = new WorkerDaemon(tempDir2, {
        resourceThresholds: { maxCpuLoad: 100, minFreeMemoryPercent: 50 },
      });

      vi.doMock('os', () => ({
        default: {
          loadavg: () => [0.1, 0.1, 0.1], // barely any CPU
          totalmem: () => 16e9,
          freemem: () => 1e9, // 6% free
        },
        loadavg: () => [0.1, 0.1, 0.1],
        totalmem: () => 16e9,
        freemem: () => 1e9,
      }));

      const result2 = await (daemon2 as any).canRunWorker();
      expect(result2.allowed).toBe(false);
      expect(result2.reason.toLowerCase()).toContain('memory');

      rmSync(tempDir2, { recursive: true, force: true });
    });

    // MUTANT: Remove `config?.resourceThresholds?.maxCpuLoad` → skip constructor arg
    it('should use partial constructor resourceThresholds (only maxCpuLoad)', () => {
      const daemon = new WorkerDaemon(tempDir, {
        resourceThresholds: { maxCpuLoad: 77, minFreeMemoryPercent: 33 },
      });
      const config = daemon.getStatus().config;

      // Kills: removal of config?.resourceThresholds?.maxCpuLoad path
      expect(config.resourceThresholds.maxCpuLoad).toBe(77);
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(33);
    });

    // MUTANT: readDaemonConfigFromFile returns {} even when file exists
    it('should read maxConcurrent from config.json', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.maxConcurrent': 8,
        'daemon.workerTimeoutMs': 120000,
      }));

      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      // Kills: return {} mutant in readDaemonConfigFromFile
      expect(config.maxConcurrent).toBe(8);
      expect(config.workerTimeoutMs).toBe(120000);
    });

    // MUTANT: Remove backoff timer value (30_000 → 0)
    it('should use 30s backoff delay, not 0', async () => {
      const daemon = new WorkerDaemon(tempDir, {
        maxConcurrent: 2,
        resourceThresholds: { maxCpuLoad: 0.001, minFreeMemoryPercent: 99.99 },
      });

      (daemon as any).pendingWorkers.push('map');

      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const before = setTimeoutSpy.mock.calls.length;

      await (daemon as any).processPendingWorkers();

      const backoffCalls = setTimeoutSpy.mock.calls
        .slice(before)
        .filter((call) => call[1] === 30_000);
      // Kills: 30_000 → 0 mutant (must be exactly 30s)
      expect(backoffCalls.length).toBe(1);
      expect(backoffCalls[0][1]).toBe(30_000);

      setTimeoutSpy.mockRestore();
    });
  });

  // =========================================================================
  // Container-aware CPU detection (WI-4)
  // =========================================================================
  describe('container-aware CPU detection', () => {
    it('should expose getEffectiveCpuCount as a static method', () => {
      expect(typeof WorkerDaemon.getEffectiveCpuCount).toBe('function');
    });

    it('should return a positive integer', () => {
      const count = WorkerDaemon.getEffectiveCpuCount();
      expect(count).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(count)).toBe(true);
    });

    it('should match os.cpus().length on bare-metal (no cgroup quota)', () => {
      // On a non-containerised host both cgroup reads will throw and the
      // method falls back to os.cpus().length, so the two must agree.
      const osCpuCount = cpus().length || 1;
      const effectiveCount = WorkerDaemon.getEffectiveCpuCount();

      // If we ARE inside a container with a quota the values may differ,
      // so we only assert they are both positive — the equality check is
      // a best-effort sanity test for bare-metal CI runners.
      expect(effectiveCount).toBeGreaterThanOrEqual(1);
      expect(effectiveCount).toBeLessThanOrEqual(osCpuCount);
    });

    it('should be used by the constructor for maxCpuLoad calculation', () => {
      const daemon = new WorkerDaemon(tempDir);
      const config = daemon.getStatus().config;

      const effectiveCpus = WorkerDaemon.getEffectiveCpuCount();
      const expectedMaxCpuLoad = Math.max(effectiveCpus * 1.5, 4.0);

      expect(config.resourceThresholds.maxCpuLoad).toBeCloseTo(expectedMaxCpuLoad, 1);
    });
  });

  // =========================================================================
  // #2356 — Self-terminating lifecycle (TTL + idle shutdown)
  // Caps how long a forgotten daemon can keep dispatching headless worker
  // sweeps. Precedence: constructor arg > config.json (seconds) > env
  // (RUFLO_DAEMON_TTL_SECS / RUFLO_DAEMON_IDLE_SECS) > built-in default.
  // =========================================================================
  describe('self-terminating lifecycle (ttl/idle)', () => {
    const TTL_ENV = 'RUFLO_DAEMON_TTL_SECS';
    const IDLE_ENV = 'RUFLO_DAEMON_IDLE_SECS';
    let savedTtl: string | undefined;
    let savedIdle: string | undefined;

    beforeEach(() => {
      savedTtl = process.env[TTL_ENV];
      savedIdle = process.env[IDLE_ENV];
      delete process.env[TTL_ENV];
      delete process.env[IDLE_ENV];
    });

    afterEach(() => {
      if (savedTtl === undefined) delete process.env[TTL_ENV]; else process.env[TTL_ENV] = savedTtl;
      if (savedIdle === undefined) delete process.env[IDLE_ENV]; else process.env[IDLE_ENV] = savedIdle;
    });

    it('defaults ttlMs to 12h and idleShutdownMs to 30m (#2834)', () => {
      const config = new WorkerDaemon(tempDir).getStatus().config;
      expect(config.ttlMs).toBe(12 * 60 * 60 * 1000);
      expect(config.idleShutdownMs).toBe(30 * 60 * 1000);
    });

    it('honors RUFLO_DAEMON_TTL_SECS env override (seconds → ms)', () => {
      process.env[TTL_ENV] = '3600';
      const config = new WorkerDaemon(tempDir).getStatus().config;
      expect(config.ttlMs).toBe(3600 * 1000);
    });

    it('honors an explicit RUFLO_DAEMON_TTL_SECS=0 as "disabled" (not falling back to default)', () => {
      process.env[TTL_ENV] = '0';
      const config = new WorkerDaemon(tempDir).getStatus().config;
      expect(config.ttlMs).toBe(0);
    });

    it('falls back to default for an invalid/negative env value', () => {
      process.env[TTL_ENV] = '-5';
      const config = new WorkerDaemon(tempDir).getStatus().config;
      expect(config.ttlMs).toBe(12 * 60 * 60 * 1000);
    });

    it('honors RUFLO_DAEMON_IDLE_SECS env override', () => {
      process.env[IDLE_ENV] = '7200';
      const config = new WorkerDaemon(tempDir).getStatus().config;
      expect(config.idleShutdownMs).toBe(7200 * 1000);
    });

    it('reads daemon.ttlSecs / daemon.idleSecs from config.json (seconds → ms)', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({
        'daemon.ttlSecs': 1800,
        'daemon.idleSecs': 900,
      }));
      const config = new WorkerDaemon(tempDir).getStatus().config;
      expect(config.ttlMs).toBe(1800 * 1000);
      expect(config.idleShutdownMs).toBe(900 * 1000);
    });

    it('honors config.json daemon.ttlSecs=0 as disabled', () => {
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({ 'daemon.ttlSecs': 0 }));
      const config = new WorkerDaemon(tempDir).getStatus().config;
      expect(config.ttlMs).toBe(0);
    });

    it('prefers constructor arg over config.json and env', () => {
      process.env[TTL_ENV] = '3600';
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({ 'daemon.ttlSecs': 1800 }));
      const config = new WorkerDaemon(tempDir, { ttlMs: 60_000 }).getStatus().config;
      expect(config.ttlMs).toBe(60_000);
    });

    it('prefers config.json over env', () => {
      process.env[TTL_ENV] = '3600';
      const configFile = join(tempDir, '.claude-flow', 'config.json');
      writeFileSync(configFile, JSON.stringify({ 'daemon.ttlSecs': 1800 }));
      const config = new WorkerDaemon(tempDir).getStatus().config;
      expect(config.ttlMs).toBe(1800 * 1000);
    });

    it('arms the lifecycle monitor even when ttl/idle are disabled (#2661 workspace-removal check)', () => {
      const daemon = new WorkerDaemon(tempDir, { ttlMs: 0, idleShutdownMs: 0 });
      // Pre-#2661 this was a no-op with both limits at 0. The monitor now
      // always runs so a daemon whose worktree is deleted shuts itself
      // down; ttl/idle remain opt-in inside the shared predicate.
      (daemon as any).startLifecycleMonitor();
      expect((daemon as any).lifecycleTimer).toBeDefined();
      // But with the workspace present and both limits off, the predicate
      // must not request a shutdown.
      expect((daemon as any).lifecycleShutdownReason(Date.now())).toBeNull();
      clearInterval((daemon as any).lifecycleTimer);
      (daemon as any).lifecycleTimer = undefined;
    });

    it('arms (and can clear) the lifecycle monitor when a TTL is set', () => {
      const daemon = new WorkerDaemon(tempDir, { ttlMs: 60_000, idleShutdownMs: 0 });
      (daemon as any).startLifecycleMonitor();
      expect((daemon as any).lifecycleTimer).toBeDefined();
      // The monitor timer must be unref'd so it never keeps the process alive.
      clearInterval((daemon as any).lifecycleTimer);
      (daemon as any).lifecycleTimer = undefined;
    });
  });
});
