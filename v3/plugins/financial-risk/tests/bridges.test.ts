/**
 * Financial Risk Plugin - Bridge Tests
 *
 * Tests for FinancialEconomyBridge and FinancialSparseBridge initialization, lifecycle, and methods
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FinancialEconomyBridge } from '../src/bridges/economy-bridge.js';
import { FinancialSparseBridge } from '../src/bridges/sparse-bridge.js';

// Mock WASM modules
vi.mock('../src/bridges/economy-wasm.js', () => ({
  initWasm: vi.fn().mockResolvedValue(undefined),
  wasmAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/bridges/sparse-wasm.js', () => ({
  initWasm: vi.fn().mockResolvedValue(undefined),
  wasmAvailable: vi.fn().mockReturnValue(false),
}));

describe('FinancialEconomyBridge', () => {
  let bridge: FinancialEconomyBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new FinancialEconomyBridge();
  });

  afterEach(() => {
    try {
      bridge.destroy();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    it('should create bridge instance', () => {
      expect(bridge).toBeInstanceOf(FinancialEconomyBridge);
    });

    it('should initialize successfully', async () => {
      await bridge.initialize();
      expect(bridge.initialized).toBe(true);
    });

    it('should initialize with custom config', async () => {
      await bridge.initialize({
        precision: 8,
        randomSeed: 42,
        defaultScenarios: 5000,
      });
      expect(bridge.initialized).toBe(true);
    });

    it('should handle double initialization gracefully', async () => {
      await bridge.initialize();
      await bridge.initialize();
      expect(bridge.initialized).toBe(true);
    });
  });

  describe('Lifecycle', () => {
    it('should destroy successfully', async () => {
      await bridge.initialize();
      bridge.destroy();
      expect(bridge.initialized).toBe(false);
    });

    it('should handle destroy when not initialized', () => {
      expect(() => bridge.destroy()).not.toThrow();
    });

    it('should reinitialize after destroy', async () => {
      await bridge.initialize();
      bridge.destroy();
      await bridge.initialize();
      expect(bridge.initialized).toBe(true);
    });
  });

  describe('Risk Calculations', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('should calculate risk metrics for portfolio', async () => {
      const holdings = [
        { symbol: 'AAPL', value: 100000 },
        { symbol: 'GOOGL', value: 150000 },
      ];

      const metrics = await bridge.calculateRiskMetrics(holdings, {
        confidenceLevel: 0.95,
        horizon: '1d',
      });

      expect(metrics).toHaveProperty('var');
      expect(metrics).toHaveProperty('volatility');
    });

    it('should handle empty portfolio', async () => {
      const metrics = await bridge.calculateRiskMetrics([], {
        confidenceLevel: 0.95,
        horizon: '1d',
      });

      // Empty portfolio returns NaN for var (no data to calculate)
      expect(metrics.var).toBeDefined();
    });

    it('should run Monte Carlo simulation', async () => {
      const portfolio = new Float32Array([0.1, 0.02, 0.05, -0.01, 0.03]);

      const result = await bridge.simulateMonteCarlo(portfolio, 100, 10);

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('Risk Calculation Methods', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('should calculate VaR', async () => {
      const returns = new Float32Array([0.01, -0.02, 0.015, -0.01, 0.005, -0.025, 0.02]);

      const varValue = await bridge.calculateVar(returns, 0.95);

      expect(typeof varValue).toBe('number');
      expect(varValue).toBeGreaterThanOrEqual(0);
    });

    it('should calculate CVaR', async () => {
      const returns = new Float32Array([0.01, -0.02, 0.015, -0.01, 0.005, -0.025, 0.02]);

      const cvarValue = await bridge.calculateCvar(returns, 0.95);

      expect(typeof cvarValue).toBe('number');
      expect(cvarValue).toBeGreaterThanOrEqual(0);
    });
  });

  describe('JavaScript Fallback', () => {
    it('should work without WASM', async () => {
      const fallbackBridge = new FinancialEconomyBridge();
      await fallbackBridge.initialize();

      expect(fallbackBridge.initialized).toBe(true);

      fallbackBridge.destroy();
    });
  });

  describe('Memory Management', () => {
    it('should release resources on destroy', async () => {
      await bridge.initialize();
      bridge.destroy();
      expect(bridge.initialized).toBe(false);
    });

    it('should handle multiple init/destroy cycles', async () => {
      for (let i = 0; i < 3; i++) {
        await bridge.initialize();
        bridge.destroy();
      }
      expect(bridge.initialized).toBe(false);
    });
  });

  describe('Edge cases - empty input', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('simulateMonteCarlo must not silently produce NaN scenarios on empty portfolio', async () => {
      const result = await bridge.simulateMonteCarlo(new Float32Array([]), 10, 5);
      // JS fallback: mean = 0/0 = NaN poisons every scenario. Either return an
      // empty result (signal no data) or finite scenarios, but never NaN -
      // callers can't tell NaN-poisoning apart from a successful simulation.
      const containsNaN = Array.from(result).some((v) => Number.isNaN(v));
      expect(containsNaN).toBe(false);
    });
  });
});

describe('FinancialSparseBridge', () => {
  let bridge: FinancialSparseBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new FinancialSparseBridge();
  });

  afterEach(() => {
    try {
      bridge.destroy();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    it('should create bridge instance', () => {
      expect(bridge).toBeInstanceOf(FinancialSparseBridge);
    });

    it('should initialize successfully', async () => {
      await bridge.initialize();
      expect(bridge.initialized).toBe(true);
    });

    it('should initialize with custom config', async () => {
      await bridge.initialize({
        inputDim: 256,
        hiddenDim: 128,
        sparsityThreshold: 0.01,
      });
      expect(bridge.initialized).toBe(true);
    });

    it('should handle double initialization gracefully', async () => {
      await bridge.initialize();
      await bridge.initialize();
      expect(bridge.initialized).toBe(true);
    });
  });

  describe('Lifecycle', () => {
    it('should destroy successfully', async () => {
      await bridge.initialize();
      bridge.destroy();
      expect(bridge.initialized).toBe(false);
    });

    it('should handle destroy when not initialized', () => {
      expect(() => bridge.destroy()).not.toThrow();
    });
  });

  describe('Anomaly Detection', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('should detect anomalies in transactions', async () => {
      // detectAnomalies expects Float32Array[] and threshold
      const transactions = [
        new Float32Array([0.1, 0.2, 0.3]),
        new Float32Array([0.15, 0.25, 0.35]),
        new Float32Array([10.0, 20.0, 30.0]), // Anomaly - much larger magnitude
      ];

      const result = await bridge.detectAnomalies(transactions, 0.5);

      expect(result).toBeInstanceOf(Uint32Array);
    });

    it('should handle empty transactions', async () => {
      const result = await bridge.detectAnomalies([], 0.5);
      expect(result).toBeInstanceOf(Uint32Array);
      expect(result.length).toBe(0);
    });

    it('should detect transaction anomalies with FinancialTransaction objects', async () => {
      const transactions = [
        { id: 't1', amount: 100, timestamp: new Date().toISOString(), parties: ['A', 'B'] },
        { id: 't2', amount: 150, timestamp: new Date().toISOString(), parties: ['A', 'C'] },
        { id: 't3', amount: 10000000, timestamp: new Date().toISOString(), parties: ['X', 'Y', 'Z'] },
      ];

      const result = await bridge.detectTransactionAnomalies(transactions, 0.5);

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Market Regime Classification', () => {
    beforeEach(async () => {
      await bridge.initialize();
    });

    it('should classify market regime', async () => {
      const prices = Array(50).fill(100).map((v, i) => v + (Math.random() - 0.5) * 10 + i * 0.1);

      const result = await bridge.classifyMarketRegime(prices);

      expect(result).toHaveProperty('regime');
      expect(result).toHaveProperty('confidence');
    });
  });

  describe('JavaScript Fallback', () => {
    it('should work without WASM', async () => {
      const fallbackBridge = new FinancialSparseBridge();
      await fallbackBridge.initialize();

      expect(fallbackBridge.initialized).toBe(true);

      fallbackBridge.destroy();
    });
  });

  describe('Memory Management', () => {
    it('should release resources on destroy', async () => {
      await bridge.initialize();
      bridge.destroy();
      expect(bridge.initialized).toBe(false);
    });

    it('should handle multiple init/destroy cycles', async () => {
      for (let i = 0; i < 3; i++) {
        await bridge.initialize();
        bridge.destroy();
      }
      expect(bridge.initialized).toBe(false);
    });
  });
});
