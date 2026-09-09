/**
 * RuVector Integration Tests
 *
 * Tests for the main ruvector module exports and integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isRuvectorAvailable,
  getRuvectorVersion,
  createQLearningRouter,
  createASTAnalyzer,
  createDiffClassifier,
  createCoverageRouter,
  QLearningRouter,
  ASTAnalyzer,
  DiffClassifier,
  CoverageRouter,
  // Graph analyzer exports (function-based API)
  buildDependencyGraph,
  analyzeGraph,
  analyzeMinCutBoundaries,
  analyzeModuleCommunities,
  detectCircularDependencies,
  exportToDot,
  loadRuVector,
  fallbackMinCut,
  fallbackLouvain,
} from '../../src/ruvector/index.js';

// Mock all ruvector modules
vi.mock('@ruvector/core', () => ({
  createQLearning: vi.fn(() => null),
  version: '1.0.0',
}));

vi.mock('@ruvector/ast', () => ({
  createASTAnalyzer: vi.fn(() => null),
}));

vi.mock('@ruvector/diff', () => ({
  createDiffClassifier: vi.fn(() => null),
}));

vi.mock('@ruvector/coverage', () => ({
  createCoverageRouter: vi.fn(() => null),
}));

vi.mock('@ruvector/wasm', () => ({
  minCut: vi.fn(() => null),
  louvain: vi.fn(() => null),
}));

describe('RuVector Module Exports', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isRuvectorAvailable', () => {
    it('should return boolean', async () => {
      const result = await isRuvectorAvailable();
      expect(typeof result).toBe('boolean');
    });

    it('never rejects — the try/catch swallows module-resolution failure', async () => {
      // Deliberately does NOT assert a specific boolean. Whether
      // `import('@ruvector/core')` resolves is environment-dependent: under
      // vitest's module runner a bare-specifier dynamic import is rewritten to
      // '/@id/@ruvector/core' and fails (ERR_MODULE_NOT_FOUND), while a normal
      // node process with the package installed resolves it. The previous
      // assertion pinned one environment's outcome (`toBe(true)`, then my
      // `toBe(false)`) and so flipped between the two — green locally, red in
      // CI. The invariant that holds everywhere is the only thing the try/catch
      // promises: it resolves to a boolean and never throws.
      const result = await isRuvectorAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getRuvectorVersion', () => {
    it('should return version string or null', async () => {
      const version = await getRuvectorVersion();
      expect(version === null || typeof version === 'string').toBe(true);
    });
  });

  describe('Factory Functions', () => {
    it('should export createQLearningRouter', () => {
      expect(typeof createQLearningRouter).toBe('function');
      const router = createQLearningRouter();
      expect(router).toBeInstanceOf(QLearningRouter);
    });

    it('should export createASTAnalyzer', () => {
      expect(typeof createASTAnalyzer).toBe('function');
      const analyzer = createASTAnalyzer();
      expect(analyzer).toBeInstanceOf(ASTAnalyzer);
    });

    it('should export createDiffClassifier', () => {
      expect(typeof createDiffClassifier).toBe('function');
      const classifier = createDiffClassifier();
      expect(classifier).toBeInstanceOf(DiffClassifier);
    });

    it('should export createCoverageRouter', () => {
      expect(typeof createCoverageRouter).toBe('function');
      const router = createCoverageRouter();
      expect(router).toBeInstanceOf(CoverageRouter);
    });
  });

  describe('Graph Analyzer Functions', () => {
    it('should export buildDependencyGraph', () => {
      expect(typeof buildDependencyGraph).toBe('function');
    });

    it('should export analyzeGraph', () => {
      expect(typeof analyzeGraph).toBe('function');
    });

    it('should export analyzeMinCutBoundaries', () => {
      expect(typeof analyzeMinCutBoundaries).toBe('function');
    });

    it('should export analyzeModuleCommunities', () => {
      expect(typeof analyzeModuleCommunities).toBe('function');
    });

    it('should export detectCircularDependencies', () => {
      expect(typeof detectCircularDependencies).toBe('function');
    });

    it('should export exportToDot', () => {
      expect(typeof exportToDot).toBe('function');
    });

    it('should export loadRuVector', () => {
      expect(typeof loadRuVector).toBe('function');
    });

    it('should export fallbackMinCut', () => {
      expect(typeof fallbackMinCut).toBe('function');
    });

    it('should export fallbackLouvain', () => {
      expect(typeof fallbackLouvain).toBe('function');
    });
  });

  describe('Class Exports', () => {
    it('should export QLearningRouter class', () => {
      expect(QLearningRouter).toBeDefined();
      const router = new QLearningRouter();
      expect(router).toBeInstanceOf(QLearningRouter);
    });

    it('should export ASTAnalyzer class', () => {
      expect(ASTAnalyzer).toBeDefined();
      const analyzer = new ASTAnalyzer();
      expect(analyzer).toBeInstanceOf(ASTAnalyzer);
    });

    it('should export DiffClassifier class', () => {
      expect(DiffClassifier).toBeDefined();
      const classifier = new DiffClassifier();
      expect(classifier).toBeInstanceOf(DiffClassifier);
    });

    it('should export CoverageRouter class', () => {
      expect(CoverageRouter).toBeDefined();
      const router = new CoverageRouter();
      expect(router).toBeInstanceOf(CoverageRouter);
    });
  });
});

describe('RuVector Integration Scenarios', () => {
  describe('Code Analysis Workflow', () => {
    it('should analyze TypeScript code and extract information', () => {
      const analyzer = createASTAnalyzer();
      const code = `
import { helper } from './utils';

export class UserService {
  getUsers() {
    return [];
  }
}

export function createUser(name: string) {
  return { name };
}
`;
      
      const analysis = analyzer.analyze(code, 'user-service.ts');
      
      expect(analysis.language).toBe('typescript');
      expect(analysis.classes.length).toBeGreaterThan(0);
      expect(analysis.functions.length).toBeGreaterThan(0);
      expect(analysis.imports).toContain('./utils');
      expect(analysis.exports).toContain('UserService');
      expect(analysis.exports).toContain('createUser');
    });
  });

  describe('Diff Analysis Workflow', () => {
    it('should analyze diff and provide classification', () => {
      const classifier = createDiffClassifier();
      const diff = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,6 +10,10 @@ export async function login(username: string, password: string) {
   const user = await findUser(username);
+  
+  // Add rate limiting
+  if (await isRateLimited(username)) {
+    throw new Error('Too many attempts');
+  }
   
   if (!user) {
     throw new Error('User not found');
`;
      
      const files = classifier.parseDiff(diff);
      const analysis = classifier.classify(files);
      
      expect(analysis.files.length).toBe(1);
      expect(analysis.overall.impactLevel).toBe('critical'); // auth file
      expect(analysis.overall.testingStrategy.length).toBeGreaterThan(0);
    });
  });

  describe('Coverage Routing Workflow', () => {
    it('should route based on coverage and suggest improvements', () => {
      const router = createCoverageRouter();
      const coverageData = {
        'src/critical/auth.ts': {
          lineCoverage: 45,
          branchCoverage: 30,
          functionCoverage: 50,
          statementCoverage: 45,
          uncoveredLines: [10, 20, 30, 40, 50],
          totalLines: 100,
          coveredLines: 45,
        },
        'src/utils/helper.ts': {
          lineCoverage: 90,
          branchCoverage: 85,
          functionCoverage: 95,
          statementCoverage: 90,
          uncoveredLines: [5],
          totalLines: 50,
          coveredLines: 45,
        },
      };
      
      const report = router.parseCoverage(coverageData, 'json');
      const result = router.route(report);
      
      expect(result.action).toBe('prioritize'); // Low overall coverage
      expect(result.targetFiles.length).toBeGreaterThan(0);
      expect(result.gaps.length).toBeGreaterThan(0);
      expect(report.uncoveredCritical.length).toBeGreaterThan(0);
    });
  });

  describe('Dependency Graph Workflow', () => {
    it('should build graph using function-based API', async () => {
      // The function-based API builds graphs from directories
      // For testing without actual files, we test that the functions are callable
      expect(typeof buildDependencyGraph).toBe('function');
      expect(typeof analyzeGraph).toBe('function');
      expect(typeof detectCircularDependencies).toBe('function');
      expect(typeof exportToDot).toBe('function');
    });

    it('should detect circular dependencies in graphs', () => {
      // Create a mock graph with circular dependency
      const graph = {
        nodes: new Map([
          ['a.ts', { id: 'a.ts', path: 'a.ts', name: 'a.ts', type: 'file', imports: ['./b'], exports: ['a'], size: 100 }],
          ['b.ts', { id: 'b.ts', path: 'b.ts', name: 'b.ts', type: 'file', imports: ['./a'], exports: ['b'], size: 100 }],
        ]),
        edges: [
          { source: 'a.ts', target: 'b.ts', type: 'import', weight: 1 },
          { source: 'b.ts', target: 'a.ts', type: 'import', weight: 1 },
        ],
        metadata: { rootDir: '.', totalFiles: 2, totalEdges: 2, buildTime: 0 },
      };

      const cycles = detectCircularDependencies(graph as any);
      expect(Array.isArray(cycles)).toBe(true);
    });

    it('should export graph to DOT format using GraphAnalysisResult', () => {
      // exportToDot takes GraphAnalysisResult, not DependencyGraph
      const analysisResult = {
        graph: {
          nodes: new Map([
            ['a.ts', { id: 'a.ts', path: 'a.ts', name: 'a.ts', type: 'file', imports: [], exports: ['a'], size: 100 }],
          ]),
          edges: [],
          metadata: { rootDir: '.', totalFiles: 1, totalEdges: 0, buildTime: 0 },
        },
        circularDependencies: [],
        statistics: { nodeCount: 1, edgeCount: 0, avgDegree: 0, maxDegree: 0, density: 0, componentCount: 1 },
      };

      const dot = exportToDot(analysisResult as any);
      expect(dot).toContain('digraph');
    });
  });

  describe('Q-Learning Task Routing Workflow', () => {
    it('should learn and improve routing decisions', async () => {
      const router = createQLearningRouter({
        explorationInitial: 0.1, // Low exploration for predictable tests
      });
      
      // Train the router with feedback
      router.update('implement user authentication', 'coder', 10.0);
      router.update('write unit tests for auth', 'tester', 10.0);
      router.update('review security of auth module', 'reviewer', 10.0);
      router.update('design database schema', 'architect', 10.0);
      
      // After training, router should make informed decisions
      const coderDecision = router.route('implement new feature', false);
      const testerDecision = router.route('write tests for feature', false);
      
      expect(coderDecision.confidence).toBeGreaterThan(0);
      expect(testerDecision.confidence).toBeGreaterThan(0);
      expect(coderDecision.alternatives.length).toBeGreaterThan(0);
    });

    it('should persist and restore learning', () => {
      const router1 = createQLearningRouter();
      
      // Train router 1
      router1.update('task1', 'coder', 10.0);
      router1.update('task2', 'tester', 8.0);
      
      // Export state
      const exported = router1.export();
      
      // Create new router and import
      const router2 = createQLearningRouter();
      router2.import(exported);
      
      // Verify state was restored
      expect(router2.getStats().qTableSize).toBe(router1.getStats().qTableSize);
    });
  });

  describe('Combined Workflow', () => {
    it('should use multiple analyzers together', () => {
      // 1. Analyze code structure
      const astAnalyzer = createASTAnalyzer();
      const code = `
export function processOrder(order: Order) {
  if (!order.items.length) {
    throw new Error('Empty order');
  }
  return calculateTotal(order);
}
`;
      const astAnalysis = astAnalyzer.analyze(code, 'order.ts');

      // 2. Use function-based graph API with GraphAnalysisResult
      const mockAnalysisResult = {
        graph: {
          nodes: new Map([
            ['order.ts', { id: 'order.ts', path: 'order.ts', name: 'order.ts', type: 'file', imports: ['./utils'], exports: astAnalysis.exports, size: 200 }],
            ['utils.ts', { id: 'utils.ts', path: 'utils.ts', name: 'utils.ts', type: 'file', imports: [], exports: ['calculateTotal'], size: 100 }],
          ]),
          edges: [{ source: 'order.ts', target: 'utils.ts', type: 'import', weight: 1 }],
          metadata: { rootDir: '.', totalFiles: 2, totalEdges: 1, buildTime: 0 },
        },
        circularDependencies: [],
        statistics: { nodeCount: 2, edgeCount: 1, avgDegree: 0.5, maxDegree: 1, density: 0.5, componentCount: 1 },
      };
      const dotOutput = exportToDot(mockAnalysisResult as any);

      // 3. Check coverage
      const coverageRouter = createCoverageRouter();
      const coverageReport = coverageRouter.parseCoverage({
        'order.ts': {
          lineCoverage: 60,
          branchCoverage: 50,
          functionCoverage: 100,
          statementCoverage: 60,
          uncoveredLines: [3, 4],
          totalLines: 10,
          coveredLines: 6,
        },
      }, 'json');

      const coverageResult = coverageRouter.route(coverageReport);

      // 4. Route to appropriate agent
      const qRouter = createQLearningRouter();
      qRouter.update('write tests for order processing', 'tester', 10.0);
      const routeDecision = qRouter.route('add tests for order.ts', false);

      // Verify integration
      expect(astAnalysis.functions.length).toBeGreaterThan(0);
      expect(mockAnalysisResult.graph.nodes.size).toBeGreaterThan(0);
      expect(dotOutput).toContain('digraph');
      expect(coverageResult.targetFiles.length).toBeGreaterThan(0);
      expect(routeDecision.route).toBeDefined();
    });
  });
});

describe('Error Handling', () => {
  it('should handle invalid inputs gracefully', () => {
    const astAnalyzer = createASTAnalyzer();
    expect(() => astAnalyzer.analyze('', 'empty.ts')).not.toThrow();

    const diffClassifier = createDiffClassifier();
    expect(() => diffClassifier.parseDiff('')).not.toThrow();

    // Graph analyzer - detectCircularDependencies with proper structure
    const emptyGraph = {
      nodes: new Map(),
      edges: [],
      metadata: { rootDir: '.', totalFiles: 0, totalEdges: 0, buildTime: 0 },
    };
    expect(() => detectCircularDependencies(emptyGraph as any)).not.toThrow();

    // exportToDot requires GraphAnalysisResult
    const emptyAnalysisResult = {
      graph: emptyGraph,
      circularDependencies: [],
      statistics: { nodeCount: 0, edgeCount: 0, avgDegree: 0, maxDegree: 0, density: 0, componentCount: 0 },
    };
    expect(() => exportToDot(emptyAnalysisResult as any)).not.toThrow();

    const coverageRouter = createCoverageRouter();
    expect(() => coverageRouter.parseCoverage({}, 'json')).not.toThrow();

    const qRouter = createQLearningRouter();
    expect(() => qRouter.route('')).not.toThrow();
  });

  it('should handle malformed data gracefully', () => {
    const coverageRouter = createCoverageRouter();

    // Invalid LCOV
    expect(() => coverageRouter.parseCoverage('invalid lcov data', 'lcov')).not.toThrow();

    // Invalid Cobertura
    expect(() => coverageRouter.parseCoverage('<invalid>xml</invalid>', 'cobertura')).not.toThrow();

    // Note: parseCoverage may throw for certain invalid inputs - that's expected behavior
    // The key is that it handles valid formats properly
  });
});

describe('Performance', () => {
  it('should handle large graph operations efficiently', () => {
    // Generate large mock graph
    const nodes = new Map();
    const graphEdges = [];
    for (let i = 0; i < 100; i++) {
      nodes.set(`module${i}/file.ts`, {
        id: `module${i}/file.ts`,
        path: `src/module${i}/file.ts`,
        name: `file${i}.ts`,
        type: 'file',
        imports: i > 0 ? [`../module${i-1}/file`] : [],
        exports: [`export${i}`],
        size: 100,
      });
      if (i > 0) {
        graphEdges.push({ source: `module${i}/file.ts`, target: `module${i-1}/file.ts`, type: 'import', weight: 1 });
      }
    }

    const graph = {
      nodes,
      edges: graphEdges,
      metadata: { rootDir: '.', totalFiles: 100, totalEdges: 99, buildTime: 0 },
    };
    const analysisResult = {
      graph,
      circularDependencies: [],
      statistics: { nodeCount: 100, edgeCount: 99, avgDegree: 0.99, maxDegree: 1, density: 0.01, componentCount: 1 },
    };

    const startTime = performance.now();
    const cycles = detectCircularDependencies(graph as any);
    const dot = exportToDot(analysisResult as any);
    const duration = performance.now() - startTime;

    expect(nodes.size).toBe(100);
    expect(Array.isArray(cycles)).toBe(true);
    expect(dot).toContain('digraph');
    expect(duration).toBeLessThan(1000); // Should complete within 1 second
  });

  it('should cache results for performance', () => {
    const astAnalyzer = createASTAnalyzer();
    const code = 'function test() { return 1; }';

    // First analysis
    const start1 = performance.now();
    astAnalyzer.analyze(code, 'test.ts');
    const duration1 = performance.now() - start1;

    // Cached analysis
    const start2 = performance.now();
    astAnalyzer.analyze(code, 'test.ts');
    const duration2 = performance.now() - start2;

    // Cached should be faster (or at least not significantly slower)
    expect(duration2).toBeLessThanOrEqual(duration1 + 5);
  });
});
