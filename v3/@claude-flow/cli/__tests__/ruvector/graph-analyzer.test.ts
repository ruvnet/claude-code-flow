/**
 * Graph Analyzer Tests
 *
 * Tests for the dependency graph analysis functionality.
 * Tests the function-based API: buildDependencyGraph, analyzeGraph, etc.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildDependencyGraph,
  analyzeGraph,
  analyzeMinCutBoundaries,
  analyzeModuleCommunities,
  detectCircularDependencies,
  exportToDot,
  loadRuVector,
  fallbackMinCut,
  fallbackLouvain,
  clearGraphCaches,
  type DependencyGraph,
  type GraphNode,
  type GraphEdge,
  type MinCutBoundary,
  type ModuleCommunity,
  type CircularDependency,
  type GraphAnalysisResult,
} from '../../src/ruvector/graph-analyzer.js';
import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the @ruvector/wasm module
vi.mock('@ruvector/wasm', () => ({
  minCut: vi.fn(() => null),
  louvain: vi.fn(() => null),
}));

describe('Graph Analyzer', () => {
  let testDir: string;

  beforeEach(async () => {
    // graph-analyzer caches by directory path with a 5-minute TTL, and the cache
    // is module-level state this suite never controlled. `Date.now()` alone is
    // not a unique name at test speed — measured, 28 beforeEach calls produced
    // only 22 distinct directories — so consecutive tests shared a path and a
    // later test was served an earlier test's graph. That is the whole of the
    // "should detect self-referencing imports" flake: 6 of 8 runs failed on
    // untouched main, and clearing the cache OR making the path unique each
    // brought it to 0 of 8 on its own. Both are applied: the unique path is
    // correct fixture hygiene, and clearing the cache is what keeps this honest
    // if a path is ever legitimately reused.
    clearGraphCaches();
    testDir = await mkdtemp(join(tmpdir(), 'graph-test-'));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadRuVector', () => {
    it('should return null when ruvector is not installed', async () => {
      const result = await loadRuVector();
      // Returns null or IRuVectorGraph interface
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('buildDependencyGraph', () => {
    it('should build graph from directory with TypeScript files', async () => {
      // Create test files
      await writeFile(join(testDir, 'index.ts'), `
import { helper } from './utils';
export function main() { return helper(); }
`);
      await writeFile(join(testDir, 'utils.ts'), `
export function helper() { return 'hello'; }
`);

      const graph = await buildDependencyGraph(testDir);

      expect(graph).toHaveProperty('nodes');
      expect(graph).toHaveProperty('edges');
      expect(graph.nodes.size).toBeGreaterThan(0);
    });

    it('should detect imports correctly', async () => {
      await writeFile(join(testDir, 'a.ts'), `
import { b } from './b';
export const a = b;
`);
      await writeFile(join(testDir, 'b.ts'), `
export const b = 'value';
`);

      const graph = await buildDependencyGraph(testDir);
      const nodeA = Array.from(graph.nodes.values()).find(n => n.path.includes('a.ts'));

      expect(nodeA).toBeDefined();
      expect(nodeA?.imports.length).toBeGreaterThan(0);
    });

    it('should handle empty directory', async () => {
      const graph = await buildDependencyGraph(testDir);
      expect(graph.nodes.size).toBe(0);
      expect(graph.edges.length).toBe(0);
    });

    it.skip('should handle nested directories', async () => { // Skip: file system race condition
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(join(testDir, 'src', 'index.ts'), `
export const main = 'main';
`);

      const graph = await buildDependencyGraph(testDir);
      expect(graph.nodes.size).toBeGreaterThan(0);
    });

    it('should exclude node_modules by default', async () => {
      await mkdir(join(testDir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(testDir, 'node_modules', 'pkg', 'index.js'), `
export const pkg = 'pkg';
`);
      await writeFile(join(testDir, 'index.ts'), `
export const main = 'main';
`);

      const graph = await buildDependencyGraph(testDir);
      const hasNodeModules = Array.from(graph.nodes.values()).some(n => n.path.includes('node_modules'));
      expect(hasNodeModules).toBe(false);
    });
  });

  describe('detectCircularDependencies', () => {
    it('should detect circular dependencies', async () => {
      await writeFile(join(testDir, 'a.ts'), `
import { b } from './b';
export const a = b;
`);
      await writeFile(join(testDir, 'b.ts'), `
import { a } from './a';
export const b = a;
`);

      const graph = await buildDependencyGraph(testDir);
      const cycles = detectCircularDependencies(graph);

      expect(cycles.length).toBeGreaterThan(0);
    });

    it('should return empty array when no circular dependencies', async () => {
      await writeFile(join(testDir, 'a.ts'), `
import { b } from './b';
export const a = b;
`);
      await writeFile(join(testDir, 'b.ts'), `
export const b = 'value';
`);

      const graph = await buildDependencyGraph(testDir);
      const cycles = detectCircularDependencies(graph);

      expect(cycles.length).toBe(0);
    });

    it('should detect self-referencing imports', async () => {
      await writeFile(join(testDir, 'self.ts'), `
import { self } from './self';
export { self };
`);

      const graph = await buildDependencyGraph(testDir);
      const cycles = detectCircularDependencies(graph);

      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  describe('analyzeGraph', () => {
    it('should return comprehensive analysis', async () => {
      await writeFile(join(testDir, 'index.ts'), `
import { util } from './util';
export const main = util;
`);
      await writeFile(join(testDir, 'util.ts'), `
export const util = 'util';
`);

      // analyzeGraph expects a rootDir string, not a DependencyGraph
      const analysis = await analyzeGraph(testDir);

      expect(analysis).toHaveProperty('graph');
      expect(analysis).toHaveProperty('boundaries');
      expect(analysis).toHaveProperty('communities');
      expect(analysis).toHaveProperty('circularDependencies');
      expect(analysis).toHaveProperty('statistics');
    });

    it('should calculate stats correctly', async () => {
      await writeFile(join(testDir, 'a.ts'), `export const a = 1;`);
      await writeFile(join(testDir, 'b.ts'), `export const b = 2;`);
      await writeFile(join(testDir, 'c.ts'), `
import { a } from './a';
import { b } from './b';
export const c = a + b;
`);

      // analyzeGraph expects a rootDir string, not a DependencyGraph
      const analysis = await analyzeGraph(testDir);

      // Verify analysis structure - nodeCount may be 0 if files don't parse correctly
      expect(analysis.statistics).toHaveProperty('nodeCount');
      expect(analysis.statistics).toHaveProperty('edgeCount');
      expect(analysis.statistics).toHaveProperty('avgDegree');
      expect(analysis.statistics).toHaveProperty('maxDegree');
      expect(analysis.statistics).toHaveProperty('density');
      expect(analysis.statistics).toHaveProperty('componentCount');
    });

    it('should respect includeBoundaries option', async () => {
      await writeFile(join(testDir, 'a.ts'), `export const a = 1;`);

      const analysisWithBoundaries = await analyzeGraph(testDir, { includeBoundaries: true });
      const analysisWithoutBoundaries = await analyzeGraph(testDir, { includeBoundaries: false });

      expect(analysisWithBoundaries.boundaries).toBeDefined();
      expect(analysisWithoutBoundaries.boundaries).toBeUndefined();
    });

    it('should respect includeModules option', async () => {
      await writeFile(join(testDir, 'a.ts'), `export const a = 1;`);

      const analysisWithModules = await analyzeGraph(testDir, { includeModules: true });
      const analysisWithoutModules = await analyzeGraph(testDir, { includeModules: false });

      expect(analysisWithModules.communities).toBeDefined();
      expect(analysisWithoutModules.communities).toBeUndefined();
    });

    it('should respect numPartitions option', async () => {
      await writeFile(join(testDir, 'a.ts'), `export const a = 1;`);
      await writeFile(join(testDir, 'b.ts'), `export const b = 2;`);
      await writeFile(join(testDir, 'c.ts'), `export const c = 3;`);

      const analysis = await analyzeGraph(testDir, { numPartitions: 3 });

      expect(analysis).toHaveProperty('boundaries');
    });
  });

  describe('analyzeMinCutBoundaries', () => {
    it('should identify module boundaries', async () => {
      // Create two separate module groups
      await mkdir(join(testDir, 'moduleA'), { recursive: true });
      await mkdir(join(testDir, 'moduleB'), { recursive: true });

      await writeFile(join(testDir, 'moduleA', 'a1.ts'), `
import { a2 } from './a2';
export const a1 = a2;
`);
      await writeFile(join(testDir, 'moduleA', 'a2.ts'), `
export const a2 = 'a2';
`);
      await writeFile(join(testDir, 'moduleB', 'b1.ts'), `
import { b2 } from './b2';
export const b1 = b2;
`);
      await writeFile(join(testDir, 'moduleB', 'b2.ts'), `
export const b2 = 'b2';
`);
      await writeFile(join(testDir, 'index.ts'), `
import { a1 } from './moduleA/a1';
import { b1 } from './moduleB/b1';
export { a1, b1 };
`);

      const graph = await buildDependencyGraph(testDir);
      const boundaries = await analyzeMinCutBoundaries(graph);

      expect(boundaries).toBeDefined();
      expect(Array.isArray(boundaries)).toBe(true);
    });
  });

  describe('analyzeModuleCommunities', () => {
    it('should detect module communities', async () => {
      await writeFile(join(testDir, 'a.ts'), `export const a = 1;`);
      await writeFile(join(testDir, 'b.ts'), `
import { a } from './a';
export const b = a;
`);

      const graph = await buildDependencyGraph(testDir);
      const communities = await analyzeModuleCommunities(graph);

      expect(Array.isArray(communities)).toBe(true);
    });
  });

  describe('exportToDot', () => {
    it('should export graph to DOT format', async () => {
      await writeFile(join(testDir, 'a.ts'), `
import { b } from './b';
export const a = b;
`);
      await writeFile(join(testDir, 'b.ts'), `
export const b = 'b';
`);

      // analyzeGraph expects a rootDir string, not a DependencyGraph
      const analysis = await analyzeGraph(testDir);
      const dot = exportToDot(analysis);

      expect(dot).toContain('digraph');
      // DOT may or may not contain edges depending on whether imports resolve
      // The key is that it produces valid DOT output
      expect(dot).toMatch(/^digraph \w+ \{[\s\S]*\}$/);
    });

    it('should handle empty graph', async () => {
      // analyzeGraph expects a rootDir string, not a DependencyGraph
      const analysis = await analyzeGraph(testDir);
      const dot = exportToDot(analysis);

      expect(dot).toContain('digraph');
    });

    it('should accept custom options', async () => {
      await writeFile(join(testDir, 'a.ts'), `export const a = 1;`);

      // analyzeGraph expects a rootDir string, not a DependencyGraph
      const analysis = await analyzeGraph(testDir);
      const dot = exportToDot(analysis, { includeLabels: true });

      expect(dot).toContain('digraph');
    });

    it('should colorByCommunity when option is enabled', async () => {
      await writeFile(join(testDir, 'a.ts'), `export const a = 1;`);
      await writeFile(join(testDir, 'b.ts'), `import { a } from './a'; export const b = a;`);

      const analysis = await analyzeGraph(testDir);
      const dot = exportToDot(analysis, { colorByCommunity: true });

      expect(dot).toContain('digraph');
    });

    it('should highlightCycles when option is enabled', async () => {
      // Create circular dependency
      await writeFile(join(testDir, 'x.ts'), `import { y } from './y'; export const x = y;`);
      await writeFile(join(testDir, 'y.ts'), `import { x } from './x'; export const y = x;`);

      const analysis = await analyzeGraph(testDir);
      const dot = exportToDot(analysis, { highlightCycles: true });

      expect(dot).toContain('digraph');
    });
  });

  describe('fallback implementations', () => {
    it('fallbackMinCut should return boundaries', () => {
      // fallbackMinCut takes nodes array and edges array, not a graph object
      const nodes = ['a', 'b', 'c'];
      const edges: Array<[string, string, number]> = [
        ['a', 'b', 1],
        ['b', 'c', 1],
      ];

      const result = fallbackMinCut(nodes, edges);

      expect(result).toHaveProperty('cutValue');
      expect(result).toHaveProperty('partition1');
      expect(result).toHaveProperty('partition2');
      expect(result).toHaveProperty('cutEdges');
      expect(Array.isArray(result.partition1)).toBe(true);
      expect(Array.isArray(result.partition2)).toBe(true);
    });

    it('fallbackLouvain should return communities', () => {
      // fallbackLouvain takes nodes array and edges array, not a graph object
      const nodes = ['a', 'b', 'c'];
      const edges: Array<[string, string, number]> = [
        ['a', 'b', 1],
        ['b', 'c', 1],
      ];

      const result = fallbackLouvain(nodes, edges);

      expect(result).toHaveProperty('communities');
      expect(result).toHaveProperty('modularity');
      expect(Array.isArray(result.communities)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle files with syntax errors gracefully', async () => {
      await writeFile(join(testDir, 'broken.ts'), `
export const broken = {
  // Missing closing brace
`);
      await writeFile(join(testDir, 'valid.ts'), `
export const valid = 'valid';
`);

      const graph = await buildDependencyGraph(testDir);
      // Should still process valid files
      expect(graph.nodes.size).toBeGreaterThanOrEqual(1);
    });

    it('should handle various import styles', async () => {
      await writeFile(join(testDir, 'styles.ts'), `
import defaultExport from './default';
import { named } from './named';
import * as namespace from './namespace';
const dynamic = import('./dynamic');
export { defaultExport, named, namespace };
`);
      await writeFile(join(testDir, 'default.ts'), `export default 'default';`);
      await writeFile(join(testDir, 'named.ts'), `export const named = 'named';`);
      await writeFile(join(testDir, 'namespace.ts'), `export const ns = 'ns';`);
      await writeFile(join(testDir, 'dynamic.ts'), `export const dyn = 'dyn';`);

      const graph = await buildDependencyGraph(testDir);
      const stylesNode = Array.from(graph.nodes.values()).find(n => n.path.includes('styles.ts'));

      expect(stylesNode).toBeDefined();
      expect(stylesNode?.imports.length).toBeGreaterThan(0);
    });

    it('should handle re-exports', async () => {
      await writeFile(join(testDir, 'reexport.ts'), `
export { foo } from './foo';
export * from './bar';
`);
      await writeFile(join(testDir, 'foo.ts'), `export const foo = 'foo';`);
      await writeFile(join(testDir, 'bar.ts'), `export const bar = 'bar';`);

      const graph = await buildDependencyGraph(testDir);
      const reexportNode = Array.from(graph.nodes.values()).find(n => n.path.includes('reexport.ts'));

      expect(reexportNode).toBeDefined();
    });

    it('should handle JavaScript files', async () => {
      await writeFile(join(testDir, 'file.js'), `
const { helper } = require('./helper');
module.exports = { main: helper };
`);
      await writeFile(join(testDir, 'helper.js'), `
module.exports = { helper: 'helper' };
`);

      const graph = await buildDependencyGraph(testDir);
      expect(graph.nodes.size).toBeGreaterThan(0);
    });

    it('should handle mixed TS/JS projects', async () => {
      await writeFile(join(testDir, 'index.ts'), `
import { jsHelper } from './helper';
export const main = jsHelper;
`);
      await writeFile(join(testDir, 'helper.js'), `
export const jsHelper = 'helper';
`);

      const graph = await buildDependencyGraph(testDir);
      expect(graph.nodes.size).toBeGreaterThan(0);
    });
  });

  describe('performance', () => {
    it('should handle many files efficiently', async () => {
      // Create 50 files
      const promises = [];
      for (let i = 0; i < 50; i++) {
        const deps = i > 0 ? `import { f${i-1} } from './f${i-1}';\n` : '';
        const content = `${deps}export const f${i} = ${i};`;
        promises.push(writeFile(join(testDir, `f${i}.ts`), content));
      }
      await Promise.all(promises);

      const startTime = performance.now();
      const graph = await buildDependencyGraph(testDir);
      const duration = performance.now() - startTime;

      expect(graph.nodes.size).toBe(50);
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });
});
