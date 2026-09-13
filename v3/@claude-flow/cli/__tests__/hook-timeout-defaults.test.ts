/**
 * Hook Timeout Defaults Tests
 *
 * Verifies that the default hook timeout is 10000ms (not 5000ms)
 * to prevent intermittent hook failures from npx startup overhead.
 *
 * Fixes: https://github.com/ruvnet/ruflo/issues/1060
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_INIT_OPTIONS } from '../src/init/types.js';

describe('Hook timeout defaults (#1060)', () => {
  it('DEFAULT_INIT_OPTIONS.hooks.timeout should be 10000ms', () => {
    expect(DEFAULT_INIT_OPTIONS.hooks.timeout).toBe(10000);
  });

  it('timeout should be at least 10000ms to avoid npx cold-start failures', () => {
    expect(DEFAULT_INIT_OPTIONS.hooks.timeout).toBeGreaterThanOrEqual(10000);
  });

  it('continueOnError should be true by default', () => {
    expect(DEFAULT_INIT_OPTIONS.hooks.continueOnError).toBe(true);
  });
});
