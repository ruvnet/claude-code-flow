import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    // Exercise the workspace security source rather than a stale installed
    // package during cross-package policy integration tests (ADR-324).
    alias: {
      '@claude-flow/security': fileURLToPath(new URL('../security/src/index.ts', import.meta.url)),
    },
  },
  plugins: [
    {
      name: 'externalize-optional-deps',
      enforce: 'pre',
      resolveId(source) {
        // Don't let Vite resolve optional deps that may have missing subpath
        // exports. These are imported via try/catch dynamic import in src/
        // (sona-optimizer falls back to no-SONA when the package isn't
        // installed). External-marking them keeps vitest from failing
        // module resolution at transform time.
        if (source.startsWith('agentic-flow')) return { id: source, external: true };
        if (source.startsWith('agentdb')) return { id: source, external: true };
        // memory-bridge dynamic-imports this inside try/catch and degrades to
        // the sql.js path; its dist is absent unless the workspace was built.
        if (source === '@claude-flow/memory') return { id: source, external: true };
        if (source.startsWith('@ruvector/')) return { id: source, external: true };
        if (source.startsWith('@huggingface/transformers')) return { id: source, external: true };
        if (source.startsWith('@xenova/transformers')) return { id: source, external: true };
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    globals: true,
    // Vitest's 5s default is unrealistic for this suite: a number of the
    // memory/intelligence tests initialise a real ONNX embedder and a SQLite
    // database. In isolation they finish quickly, but the full suite saturates
    // every core (~440% CPU), and under that contention they exceeded 5s and
    // failed with "Test timed out in 5000ms" — never an assertion failure.
    // Because it depended on scheduling, a different file timed out on each
    // run, which read as flakiness rather than a fixed timeout being too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: false,
    },
  },
});
