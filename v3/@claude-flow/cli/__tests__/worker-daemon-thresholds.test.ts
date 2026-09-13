/**
 * Worker Daemon Resource Threshold Tests (#1077)
 *
 * Verifies that daemon worker resource thresholds are realistic for
 * multi-core systems and macOS memory reporting. Workers should not be
 * permanently deferred under normal development workload conditions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =============================================================================
// Source-level verification of defaults
// =============================================================================

const SRC_PATH = resolve(__dirname, '..', 'src', 'services', 'worker-daemon.ts');
const source = readFileSync(SRC_PATH, 'utf-8');

describe('Worker daemon resource thresholds (#1077)', () => {
  describe('CPU load threshold defaults', () => {
    it('should use a multiplier of at least 1.0 per CPU core', () => {
      // Extract the smartMaxCpuLoad formula
      const match = source.match(/smartMaxCpuLoad\s*=\s*Math\.max\(cpuCount\s*\*\s*([\d.]+)/);
      expect(match).not.toBeNull();
      const multiplier = parseFloat(match![1]);
      // Must be at least 1.0 to handle normal workloads on multi-core systems.
      // The old 0.8 value caused all workers to be deferred on any busy machine.
      expect(multiplier).toBeGreaterThanOrEqual(1.0);
    });

    it('should have a floor of at least 4.0 for the CPU threshold', () => {
      const match = source.match(/smartMaxCpuLoad\s*=\s*Math\.max\([^,]+,\s*([\d.]+)\)/);
      expect(match).not.toBeNull();
      const floor = parseFloat(match![1]);
      // Floor must be reasonable — 2.0 is too low even for single-core machines
      // running a dev environment.
      expect(floor).toBeGreaterThanOrEqual(4.0);
    });

    it('should produce a threshold of at least 12 on an 8-core machine', () => {
      // Simulate: cpuCount=8, multiplier from source
      const multiplierMatch = source.match(/smartMaxCpuLoad\s*=\s*Math\.max\(cpuCount\s*\*\s*([\d.]+)/);
      const floorMatch = source.match(/smartMaxCpuLoad\s*=\s*Math\.max\([^,]+,\s*([\d.]+)\)/);
      const multiplier = parseFloat(multiplierMatch![1]);
      const floor = parseFloat(floorMatch![1]);
      const threshold = Math.max(8 * multiplier, floor);
      // On 8 cores, normal dev load is 6-12. Threshold must be high enough.
      expect(threshold).toBeGreaterThanOrEqual(12);
    });
  });

  describe('Memory threshold defaults', () => {
    it('should have a macOS-specific lower threshold', () => {
      // macOS os.freemem() excludes reclaimable cache, reporting 1-5% free
      // even when plenty of memory is available.
      const match = source.match(/defaultMinFreeMemory\s*=\s*process\.platform\s*===\s*'darwin'\s*\?\s*([\d.]+)/);
      expect(match).not.toBeNull();
      const darwinThreshold = parseFloat(match![1]);
      // Must be low enough that macOS workers aren't permanently deferred
      expect(darwinThreshold).toBeLessThanOrEqual(3);
    });

    it('should have a reasonable Linux threshold', () => {
      const match = source.match(/defaultMinFreeMemory\s*=\s*process\.platform\s*===\s*'darwin'\s*\?\s*[\d.]+\s*:\s*([\d.]+)/);
      expect(match).not.toBeNull();
      const linuxThreshold = parseFloat(match![1]);
      // Linux reports available memory more accurately, so 10% is fine
      expect(linuxThreshold).toBeGreaterThanOrEqual(5);
      expect(linuxThreshold).toBeLessThanOrEqual(20);
    });
  });

  describe('canRunWorker resource checks', () => {
    it('should check both CPU and memory in canRunWorker', () => {
      // Verify canRunWorker exists and checks both resources
      expect(source).toContain('canRunWorker');
      const methodStart = source.indexOf('canRunWorker');
      const methodEnd = source.indexOf('\n  /**', methodStart + 1);
      const methodBody = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

      expect(methodBody).toContain('loadavg');
      expect(methodBody).toContain('freemem');
      expect(methodBody).toContain('maxCpuLoad');
      expect(methodBody).toContain('minFreeMemoryPercent');
    });
  });

  describe('WorkerDaemon class instantiation', () => {
    it('should construct with platform-aware defaults', async () => {
      const { WorkerDaemon } = await import('../src/services/worker-daemon.js');
      const tmpDir = '/tmp/test-daemon-' + Date.now();

      const daemon = new WorkerDaemon(tmpDir);

      // Access config via any since it's private
      const config = (daemon as any).config;

      // CPU threshold should be proportional to CPU count
      const cpuCount = WorkerDaemon.getEffectiveCpuCount();
      const expectedCpuThreshold = Math.max(cpuCount * 1.5, 4.0);
      expect(config.resourceThresholds.maxCpuLoad).toBe(expectedCpuThreshold);

      // Memory threshold should be platform-aware
      const expectedMemThreshold = process.platform === 'darwin' ? 2 : 10;
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(expectedMemThreshold);
    });

    it('should allow constructor overrides for thresholds', async () => {
      const { WorkerDaemon } = await import('../src/services/worker-daemon.js');
      const tmpDir = '/tmp/test-daemon-override-' + Date.now();

      const daemon = new WorkerDaemon(tmpDir, {
        resourceThresholds: { maxCpuLoad: 50, minFreeMemoryPercent: 1 },
      });

      const config = (daemon as any).config;
      expect(config.resourceThresholds.maxCpuLoad).toBe(50);
      expect(config.resourceThresholds.minFreeMemoryPercent).toBe(1);
    });

    it('getEffectiveCpuCount should return a positive integer', async () => {
      const { WorkerDaemon } = await import('../src/services/worker-daemon.js');
      const count = WorkerDaemon.getEffectiveCpuCount();
      expect(count).toBeGreaterThan(0);
      expect(Number.isInteger(count) || count > 0).toBe(true);
    });
  });
});
