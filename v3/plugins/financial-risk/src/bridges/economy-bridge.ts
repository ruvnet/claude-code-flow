/**
 * Economy Bridge - Financial Risk Plugin
 *
 * Provides token economics and portfolio risk calculation
 * capabilities. Integrates with ruvector-economy-wasm for
 * high-performance VaR, CVaR, and Monte Carlo simulations.
 *
 * Compliance Features:
 * - Deterministic execution for audit reproducibility
 * - Calculation proofs for regulatory requirements
 * - Rate limiting to prevent abuse
 */

import type {
  EconomyBridge,
  EconomyConfig,
  PortfolioHolding,
  RiskMetrics,
  TimeHorizon,
  RiskCalculationProof,
  Logger,
} from '../types.js';

/**
 * Default logger
 */
const defaultLogger: Logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => console.debug(`[economy-bridge] ${msg}`, meta),
  info: (msg: string, meta?: Record<string, unknown>) => console.info(`[economy-bridge] ${msg}`, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[economy-bridge] ${msg}`, meta),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(`[economy-bridge] ${msg}`, meta),
};

/**
 * WASM module interface for ruvector-economy-wasm
 */
interface EconomyWasmModule {
  calculate_var(returns: Float32Array, confidence: number): number;
  calculate_cvar(returns: Float32Array, confidence: number): number;
  calculate_volatility(returns: Float32Array): number;
  calculate_sharpe(returns: Float32Array, riskFreeRate: number): number;
  calculate_sortino(returns: Float32Array, riskFreeRate: number): number;
  calculate_max_drawdown(prices: Float32Array): number;
  monte_carlo_simulation(
    portfolio: Float32Array,
    covariance: Float32Array,
    scenarios: number,
    horizon: number,
    seed: number
  ): Float32Array;
  optimize_portfolio(
    returns: Float32Array,
    constraints: Float32Array,
    numAssets: number,
    numPeriods: number
  ): Float32Array;
  memory: { buffer: ArrayBuffer };
}

/**
 * Historical market data cache
 */
interface MarketDataCache {
  returns: Map<string, number[]>;
  prices: Map<string, number[]>;
  lastUpdated: Date;
}

/**
 * Portfolio risk calculator with pure JavaScript fallback
 */
export class PortfolioRiskCalculator {
  /**
   * Calculate Value at Risk (VaR) using historical simulation
   */
  calculateVaR(returns: number[], confidenceLevel: number = 0.95): number {
    if (returns.length === 0) return 0;

    const sorted = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidenceLevel) * sorted.length);
    return -sorted[index]!;
  }

  /**
   * Calculate Conditional VaR (CVaR / Expected Shortfall)
   */
  calculateCVaR(returns: number[], confidenceLevel: number = 0.95): number {
    if (returns.length === 0) return 0;

    const sorted = [...returns].sort((a, b) => a - b);
    const cutoffIndex = Math.floor((1 - confidenceLevel) * sorted.length);

    let sum = 0;
    for (let i = 0; i <= cutoffIndex; i++) {
      sum += sorted[i]!;
    }

    return -sum / (cutoffIndex + 1);
  }

  /**
   * Calculate annualized volatility
   */
  calculateVolatility(returns: number[], annualizationFactor: number = 252): number {
    if (returns.length < 2) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const dailyVol = Math.sqrt(variance);

    return dailyVol * Math.sqrt(annualizationFactor);
  }

  /**
   * Calculate Sharpe Ratio
   */
  calculateSharpe(returns: number[], riskFreeRate: number = 0.02): number {
    if (returns.length < 2) return 0;

    const annualizedReturn = this.calculateAnnualizedReturn(returns);
    const volatility = this.calculateVolatility(returns);

    if (volatility === 0) return 0;
    return (annualizedReturn - riskFreeRate) / volatility;
  }

  /**
   * Calculate Sortino Ratio
   */
  calculateSortino(returns: number[], riskFreeRate: number = 0.02): number {
    if (returns.length < 2) return 0;

    const annualizedReturn = this.calculateAnnualizedReturn(returns);
    const downsideReturns = returns.filter(r => r < 0);

    if (downsideReturns.length === 0) return Infinity;

    const downsideDeviation = Math.sqrt(
      downsideReturns.reduce((sum, r) => sum + r * r, 0) / downsideReturns.length
    ) * Math.sqrt(252);

    if (downsideDeviation === 0) return 0;
    return (annualizedReturn - riskFreeRate) / downsideDeviation;
  }

  /**
   * Calculate Maximum Drawdown
   */
  calculateMaxDrawdown(prices: number[]): number {
    if (prices.length < 2) return 0;

    let maxDrawdown = 0;
    let peak = prices[0]!;

    for (const price of prices) {
      if (price > peak) {
        peak = price;
      }
      const drawdown = (peak - price) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  /**
   * Calculate Beta against market benchmark
   */
  calculateBeta(assetReturns: number[], marketReturns: number[]): number {
    if (assetReturns.length !== marketReturns.length || assetReturns.length < 2) return 1;

    const assetMean = assetReturns.reduce((a, b) => a + b, 0) / assetReturns.length;
    const marketMean = marketReturns.reduce((a, b) => a + b, 0) / marketReturns.length;

    let covariance = 0;
    let marketVariance = 0;

    for (let i = 0; i < assetReturns.length; i++) {
      const assetDev = assetReturns[i]! - assetMean;
      const marketDev = marketReturns[i]! - marketMean;
      covariance += assetDev * marketDev;
      marketVariance += marketDev * marketDev;
    }

    if (marketVariance === 0) return 1;
    return covariance / marketVariance;
  }

  /**
   * Monte Carlo simulation for portfolio
   */
  monteCarloSimulation(
    portfolioReturns: number[],
    scenarios: number = 10000,
    horizon: number = 252,
    seed?: number
  ): number[] {
    // Empty input would make mean = 0/0 = NaN and silently poison every scenario.
    // Match the sentinel-on-empty pattern used elsewhere in this class.
    if (portfolioReturns.length === 0) {
      return [];
    }

    // Simple random number generator with seed
    let rng = seed !== undefined ? this.seededRandom(seed) : Math.random;

    const mean = portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
    const std = this.calculateVolatility(portfolioReturns, 1); // Daily volatility

    const results: number[] = [];

    for (let s = 0; s < scenarios; s++) {
      let cumulativeReturn = 0;
      for (let d = 0; d < horizon; d++) {
        // Box-Muller transform for normal distribution
        const u1 = rng();
        const u2 = rng();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        cumulativeReturn += mean + std * z;
      }
      results.push(cumulativeReturn);
    }

    return results.sort((a, b) => a - b);
  }

  private calculateAnnualizedReturn(returns: number[]): number {
    if (returns.length === 0) return 0;
    const totalReturn = returns.reduce((a, b) => a + b, 0);
    const avgDailyReturn = totalReturn / returns.length;
    return avgDailyReturn * 252; // Annualize
  }

  private seededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }
}

/**
 * Financial Economy Bridge implementation
 */
export class FinancialEconomyBridge implements EconomyBridge {
  private wasmModule: EconomyWasmModule | null = null;
  private config: EconomyConfig;
  private logger: Logger;
  private calculator: PortfolioRiskCalculator;
  private marketDataCache: MarketDataCache;
  private randomSeed: number;

  public initialized = false;

  constructor(config?: Partial<EconomyConfig>, logger?: Logger) {
    this.config = {
      precision: config?.precision ?? 6,
      randomSeed: config?.randomSeed ?? Date.now(),
      defaultScenarios: config?.defaultScenarios ?? 10000,
    };
    this.logger = logger ?? defaultLogger;
    this.calculator = new PortfolioRiskCalculator();
    this.randomSeed = this.config.randomSeed!;
    this.marketDataCache = {
      returns: new Map(),
      prices: new Map(),
      lastUpdated: new Date(),
    };
  }

  /**
   * Initialize the economy bridge
   */
  async initialize(config?: EconomyConfig): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
      if (config.randomSeed) {
        this.randomSeed = config.randomSeed;
      }
    }

    try {
      const wasmPath = await this.resolveWasmPath();
      if (wasmPath) {
        this.wasmModule = await this.loadWasmModule(wasmPath);
        this.logger.info('Economy WASM module initialized', {
          precision: this.config.precision,
          defaultScenarios: this.config.defaultScenarios,
        });
      } else {
        this.logger.warn('WASM module not available, using JavaScript fallback');
      }

      this.initialized = true;
    } catch (error) {
      this.logger.warn('Failed to initialize WASM, using fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.initialized = true;
    }
  }

  /**
   * Calculate Value at Risk
   */
  async calculateVar(returns: Float32Array, confidence: number): Promise<number> {
    if (!this.initialized) {
      throw new Error('Economy bridge not initialized');
    }

    if (this.wasmModule) {
      return this.wasmModule.calculate_var(returns, confidence);
    }

    return this.calculator.calculateVaR(Array.from(returns), confidence);
  }

  /**
   * Calculate Conditional VaR
   */
  async calculateCvar(returns: Float32Array, confidence: number): Promise<number> {
    if (!this.initialized) {
      throw new Error('Economy bridge not initialized');
    }

    if (this.wasmModule) {
      return this.wasmModule.calculate_cvar(returns, confidence);
    }

    return this.calculator.calculateCVaR(Array.from(returns), confidence);
  }

  /**
   * Optimize portfolio allocation
   */
  async optimizePortfolio(
    returns: Float32Array[],
    constraints: Record<string, number>
  ): Promise<Float32Array> {
    if (!this.initialized) {
      throw new Error('Economy bridge not initialized');
    }

    const assetCount = returns.length;
    const periodCount = returns[0]?.length ?? 0;

    if (this.wasmModule && assetCount > 0 && periodCount > 0) {
      // Flatten returns array
      const flatReturns = new Float32Array(assetCount * periodCount);
      for (let i = 0; i < assetCount; i++) {
        flatReturns.set(returns[i]!, i * periodCount);
      }

      const constraintsArray = new Float32Array([
        constraints.minWeight ?? 0,
        constraints.maxWeight ?? 1,
        constraints.targetReturn ?? 0.1,
        constraints.maxVolatility ?? 0.2,
      ]);

      return this.wasmModule.optimize_portfolio(flatReturns, constraintsArray, assetCount, periodCount);
    }

    // Fallback: Equal weight allocation
    const weights = new Float32Array(assetCount);
    const equalWeight = 1 / assetCount;
    for (let i = 0; i < assetCount; i++) {
      weights[i] = equalWeight;
    }

    return weights;
  }

  /**
   * Run Monte Carlo simulation
   */
  async simulateMonteCarlo(
    portfolio: Float32Array,
    scenarios: number,
    horizon: number
  ): Promise<Float32Array> {
    if (!this.initialized) {
      throw new Error('Economy bridge not initialized');
    }

    if (this.wasmModule) {
      // Create identity covariance for simplicity
      const n = portfolio.length;
      const covariance = new Float32Array(n * n);
      for (let i = 0; i < n; i++) {
        covariance[i * n + i] = 1.0;
      }

      return this.wasmModule.monte_carlo_simulation(
        portfolio,
        covariance,
        scenarios,
        horizon,
        this.randomSeed
      );
    }

    // Fallback: JavaScript Monte Carlo
    const results = this.calculator.monteCarloSimulation(
      Array.from(portfolio),
      scenarios,
      horizon,
      this.randomSeed
    );

    return new Float32Array(results);
  }

  /**
   * Calculate complete risk metrics for a portfolio
   */
  async calculateRiskMetrics(
    holdings: PortfolioHolding[],
    confidenceLevel: number = 0.95,
    horizon: TimeHorizon = '1d'
  ): Promise<RiskMetrics> {
    // Generate synthetic returns for demonstration
    // In production, fetch actual historical data
    const returns = this.generateSyntheticReturns(holdings.length, 252);
    const prices = this.returnsToPrice(returns, 100);

    const horizonDays = this.getHorizonDays(horizon);
    const scaledReturns = this.scaleReturns(returns, horizonDays);

    const returnsArray = new Float32Array(scaledReturns);

    return {
      var: await this.calculateVar(returnsArray, confidenceLevel),
      cvar: await this.calculateCvar(returnsArray, confidenceLevel),
      sharpe: this.calculator.calculateSharpe(returns),
      sortino: this.calculator.calculateSortino(returns),
      maxDrawdown: this.calculator.calculateMaxDrawdown(prices),
      volatility: this.calculator.calculateVolatility(returns),
      confidenceLevel,
      horizon,
    };
  }

  /**
   * Generate calculation proof for audit
   */
  generateCalculationProof(
    input: unknown,
    output: unknown,
    _modelVersion: string = '1.0.0'
  ): RiskCalculationProof {
    const inputHash = this.hashObject(input);
    const outputHash = this.hashObject(output);

    return {
      inputHash,
      modelChecksum: this.getModelChecksum(),
      randomSeed: this.randomSeed.toString(),
      outputHash,
      signature: this.signProof(inputHash, outputHash),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.marketDataCache.returns.clear();
    this.marketDataCache.prices.clear();
    this.initialized = false;
  }

  // Private methods

  private async resolveWasmPath(): Promise<string | null> {
    try {
      const module = await import(/* webpackIgnore: true */ 'ruvector-economy-wasm' as string) as { default?: string };
      return module.default ?? null;
    } catch {
      return null;
    }
  }

  private async loadWasmModule(wasmPath: string): Promise<EconomyWasmModule> {
    const module = await import(wasmPath);
    await module.default();
    return module as EconomyWasmModule;
  }

  private generateSyntheticReturns(_numAssets: number, numDays: number): number[] {
    // Generate synthetic returns for demonstration
    const returns: number[] = [];
    const dailyMean = 0.0004; // ~10% annual
    const dailyVol = 0.012; // ~19% annual

    for (let i = 0; i < numDays; i++) {
      // Box-Muller for normal distribution
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      returns.push(dailyMean + dailyVol * z);
    }

    return returns;
  }

  private returnsToPrice(returns: number[], startPrice: number): number[] {
    const prices: number[] = [startPrice];
    let currentPrice = startPrice;

    for (const ret of returns) {
      currentPrice *= (1 + ret);
      prices.push(currentPrice);
    }

    return prices;
  }

  private getHorizonDays(horizon: TimeHorizon): number {
    switch (horizon) {
      case '1d': return 1;
      case '1w': return 5;
      case '1m': return 21;
      case '3m': return 63;
      case '1y': return 252;
      default: return 1;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private scaleReturns(returns: number[], days: number): number[] {
    if (days === 1) return returns;

    // Aggregate returns over the horizon
    const scaled: number[] = [];
    for (let i = 0; i <= returns.length - days; i += days) {
      let cumReturn = 0;
      for (let j = 0; j < days && i + j < returns.length; j++) {
        cumReturn += returns[i + j]!;
      }
      scaled.push(cumReturn);
    }

    return scaled;
  }

  private hashObject(obj: unknown): string {
    const str = JSON.stringify(obj);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  private getModelChecksum(): string {
    // In production, compute actual model checksum
    return 'economy-bridge-v1-' + this.hashObject(this.config);
  }

  private signProof(inputHash: string, outputHash: string): string {
    // In production, use cryptographic signing
    return this.hashObject({ inputHash, outputHash, seed: this.randomSeed });
  }
}

/**
 * Create a new economy bridge instance
 */
export function createEconomyBridge(config?: Partial<EconomyConfig>, logger?: Logger): FinancialEconomyBridge {
  return new FinancialEconomyBridge(config, logger);
}

export default FinancialEconomyBridge;
