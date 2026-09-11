import { describe, expect, it } from 'vitest';
import { composeLatentRoles } from '../../src/application/latent-role-composer.js';

const roles = [
  { id: 'skeptic', vectorRef: 'rvf://roles/skeptic', logit: 2 },
  { id: 'engineer', vectorRef: 'rvf://roles/engineer', logit: 4 },
  { id: 'teacher', vectorRef: 'rvf://roles/teacher', logit: 1 },
  { id: 'scientist', vectorRef: 'rvf://roles/scientist', logit: 3 },
] as const;

describe('composeLatentRoles', () => {
  it('falls back when the backend cannot expose hidden state', () => {
    expect(
      composeLatentRoles({
        candidates: roles,
        hiddenStateAccess: false,
      }),
    ).toEqual({
      mode: 'fallback',
      fallback: 'multi-agent',
      reason: 'hidden-state-access-required',
      authority: 'none',
    });
  });

  it('selects top K roles and normalizes their weights', () => {
    const result = composeLatentRoles({
      candidates: roles,
      hiddenStateAccess: true,
      topK: 3,
    });

    expect(result.mode).toBe('latent');
    if (result.mode !== 'latent') throw new Error('expected latent route');

    expect(result.roles.map((role) => role.id)).toEqual([
      'engineer',
      'scientist',
      'skeptic',
    ]);
    expect(result.roles.map((role) => role.rank)).toEqual([1, 2, 3]);
    expect(result.roles.reduce((sum, role) => sum + role.weight, 0)).toBeCloseTo(1, 12);
    expect(result.authority).toBe('none');
  });

  it('is invariant to a common additive logit shift', () => {
    const base = composeLatentRoles({ candidates: roles, hiddenStateAccess: true, topK: 3 });
    const shifted = composeLatentRoles({
      candidates: roles.map((role) => ({ ...role, logit: role.logit + 10_000 })),
      hiddenStateAccess: true,
      topK: 3,
    });

    if (base.mode !== 'latent' || shifted.mode !== 'latent') {
      throw new Error('expected latent routes');
    }

    expect(shifted.roles.map((role) => role.id)).toEqual(base.roles.map((role) => role.id));
    shifted.roles.forEach((role, index) => {
      expect(role.weight).toBeCloseTo(base.roles[index].weight, 12);
    });
  });

  it('breaks equal logit ties deterministically by id', () => {
    const result = composeLatentRoles({
      candidates: [
        { id: 'zeta', vectorRef: 'rvf://zeta', logit: 1 },
        { id: 'alpha', vectorRef: 'rvf://alpha', logit: 1 },
      ],
      hiddenStateAccess: true,
      topK: 2,
    });

    if (result.mode !== 'latent') throw new Error('expected latent route');
    expect(result.roles.map((role) => role.id)).toEqual(['alpha', 'zeta']);
    expect(result.roles[0].weight).toBeCloseTo(0.5, 12);
    expect(result.roles[1].weight).toBeCloseTo(0.5, 12);
  });

  it('handles very large finite logits without overflow', () => {
    const result = composeLatentRoles({
      candidates: [
        { id: 'a', vectorRef: 'rvf://a', logit: 1e300 },
        { id: 'b', vectorRef: 'rvf://b', logit: 1e300 - 1e290 },
      ],
      hiddenStateAccess: true,
    });

    if (result.mode !== 'latent') throw new Error('expected latent route');
    for (const role of result.roles) expect(Number.isFinite(role.weight)).toBe(true);
    expect(result.roles.reduce((sum, role) => sum + role.weight, 0)).toBeCloseTo(1, 12);
  });

  it('rejects duplicate ids, invalid top K, and non finite logits', () => {
    expect(() =>
      composeLatentRoles({
        candidates: [
          { id: 'same', vectorRef: 'rvf://1', logit: 1 },
          { id: 'same', vectorRef: 'rvf://2', logit: 2 },
        ],
        hiddenStateAccess: true,
      }),
    ).toThrow('duplicate latent role candidate id');

    expect(() =>
      composeLatentRoles({ candidates: roles, hiddenStateAccess: true, topK: 0 }),
    ).toThrow('topK must be an integer');

    expect(() =>
      composeLatentRoles({
        candidates: [{ id: 'bad', vectorRef: 'rvf://bad', logit: Number.NaN }],
        hiddenStateAccess: true,
      }),
    ).toThrow('non-finite logit');
  });
});
