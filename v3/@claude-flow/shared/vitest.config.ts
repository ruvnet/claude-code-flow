/**
 * Vitest configuration for @claude-flow/shared.
 *
 * The v3-root vitest config drives integration coverage; this per-package
 * config keeps unit tests for shared primitives runnable from the package
 * directory in isolation, without the workspace-level setup file or
 * cross-package include patterns picking up symlinked copies of the same
 * test file via pnpm's nested `node_modules`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.git'],
    globals: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    reporters: ['default'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // Match the workspace defaults so behavior is identical when this
    // package is included from the v3-root harness.
    mockReset: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
