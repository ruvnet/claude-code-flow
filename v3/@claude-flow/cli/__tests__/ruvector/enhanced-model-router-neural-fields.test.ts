/**
 * Regression test for the dream-cycle 2026-09-07 finding: EnhancedModelRouter
 * forwarded a wrong-tier `modelId` when tier3-keyword/AST complexity boosts
 * escalated the returned tier past the tier the base bandit router chose
 * `modelId` for. `agent-execute-core.ts` treats a present `modelId` as an
 * override that skips tier-based dispatch, so a stale modelId from a cheaper
 * tier silently defeated the escalation.
 */

import { describe, it, expect } from 'vitest';
import { createEnhancedModelRouter } from '../../src/ruvector/enhanced-model-router.js';
import type { ModelRoutingResult } from '../../src/ruvector/model-router.js';

function stubBaseResult(overrides: Partial<ModelRoutingResult>): ModelRoutingResult {
  return {
    model: 'haiku',
    confidence: 0.9,
    uncertainty: 0.05,
    complexity: 0.1,
    reasoning: 'stub',
    alternatives: [],
    inferenceTimeUs: 1,
    costMultiplier: 0.04,
    routedBy: 'hybrid',
    provider: 'openrouter',
    modelId: 'inclusionai/ling-2.6-flash',
    openrouterModel: 'inclusionai/ling-2.6-flash',
    ...overrides,
  };
}

describe('EnhancedModelRouter neural-field tier consistency (ADR-149)', () => {
  it('drops modelId/provider/openrouterModel when a tier3 keyword escalates past the base router tier', async () => {
    const router = createEnhancedModelRouter();
    // Base bandit router picked a cheap haiku-tier model for a low-complexity read.
    (router as unknown as { baseRouter: { route: () => Promise<ModelRoutingResult> } }).baseRouter.route =
      async () => stubBaseResult({ model: 'haiku', complexity: 0.4 });

    // Single tier3 keyword ("encryption") boosts finalComplexity by +0.25 to
    // 0.65, past the 0.6 sonnet/opus threshold — the returned tier is 'opus',
    // but baseResult.model was 'haiku'.
    const result = await router.route('add encryption to the audit log write path');

    expect(result.tier).toBe(3);
    expect(result.model).toBe('opus');
    expect(result.modelId).toBeUndefined();
    expect(result.openrouterModel).toBeUndefined();
    expect(result.routedBy).toBeUndefined();
    expect(result.provider).toBeUndefined();
  });

  it('still forwards modelId/routedBy/provider when the escalated tier matches the base router tier', async () => {
    const router = createEnhancedModelRouter();
    // Base bandit router already picked opus for this complexity.
    (router as unknown as { baseRouter: { route: () => Promise<ModelRoutingResult> } }).baseRouter.route =
      async () => stubBaseResult({ model: 'opus', complexity: 0.4 });

    const result = await router.route('add encryption to the audit log write path');

    expect(result.tier).toBe(3);
    expect(result.model).toBe('opus');
    expect(result.modelId).toBe('inclusionai/ling-2.6-flash');
    expect(result.routedBy).toBe('hybrid');
    expect(result.provider).toBe('openrouter');
    expect(result.openrouterModel).toBe('inclusionai/ling-2.6-flash');
  });

  it('forwards modelId unchanged when no escalation happens (no tier boundary crossed)', async () => {
    const router = createEnhancedModelRouter();
    (router as unknown as { baseRouter: { route: () => Promise<ModelRoutingResult> } }).baseRouter.route =
      async () => stubBaseResult({ model: 'haiku', complexity: 0.05 });

    const result = await router.route('rename this local variable for clarity');

    expect(result.tier).toBe(2);
    expect(result.model).toBe('haiku');
    expect(result.modelId).toBe('inclusionai/ling-2.6-flash');
  });
});
