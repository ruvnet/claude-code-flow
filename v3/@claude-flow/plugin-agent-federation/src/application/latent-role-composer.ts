export interface LatentRoleCandidate {
  id: string;
  vectorRef: string;
  logit: number;
}

export type LatentRoleFallback = 'single' | 'multi-agent';

export interface LatentRoleComposeRequest {
  candidates: readonly LatentRoleCandidate[];
  hiddenStateAccess: boolean;
  topK?: number;
  fallback?: LatentRoleFallback;
}

export interface ComposedLatentRole {
  id: string;
  vectorRef: string;
  weight: number;
  rank: number;
}

export type LatentRoleRoute =
  | {
      mode: 'latent';
      roles: ComposedLatentRole[];
      authority: 'none';
      requiresHiddenStateAccess: true;
    }
  | {
      mode: 'fallback';
      fallback: LatentRoleFallback;
      reason: 'hidden-state-access-required';
      authority: 'none';
    };

function validateCandidates(candidates: readonly LatentRoleCandidate[]): void {
  if (candidates.length === 0) {
    throw new Error('at least one latent role candidate is required');
  }

  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.id.trim()) {
      throw new Error('latent role candidate id must be non-empty');
    }
    if (!candidate.vectorRef.trim()) {
      throw new Error(`latent role candidate ${candidate.id} must include vectorRef`);
    }
    if (!Number.isFinite(candidate.logit)) {
      throw new Error(`latent role candidate ${candidate.id} has non-finite logit`);
    }
    if (ids.has(candidate.id)) {
      throw new Error(`duplicate latent role candidate id: ${candidate.id}`);
    }
    ids.add(candidate.id);
  }
}

/**
 * Compose a bounded set of latent roles from caller supplied router logits.
 *
 * This function is intentionally model agnostic. It does not infer roles or
 * touch model hidden states. Backends with hidden state access can use the
 * returned normalized weights to combine prevalidated steering vectors.
 * Hosted black box backends receive an explicit fallback instead.
 *
 * The result carries no execution authority. Role routing is evidence about
 * how to shape inference, never permission to call tools or expand capabilities.
 */
export function composeLatentRoles(request: LatentRoleComposeRequest): LatentRoleRoute {
  validateCandidates(request.candidates);

  const fallback = request.fallback ?? 'multi-agent';
  if (!request.hiddenStateAccess) {
    return {
      mode: 'fallback',
      fallback,
      reason: 'hidden-state-access-required',
      authority: 'none',
    };
  }

  const topK = request.topK ?? Math.min(3, request.candidates.length);
  if (!Number.isInteger(topK) || topK < 1 || topK > request.candidates.length) {
    throw new Error(`topK must be an integer in [1, ${request.candidates.length}]`);
  }

  const selected = [...request.candidates]
    .sort((a, b) => b.logit - a.logit || a.id.localeCompare(b.id))
    .slice(0, topK);

  // Stable softmax. Subtracting the maximum makes large magnitude logits safe
  // and preserves invariance to a common additive shift.
  const maxLogit = selected[0].logit;
  const exp = selected.map((candidate) => Math.exp(candidate.logit - maxLogit));
  const denominator = exp.reduce((sum, value) => sum + value, 0);

  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new Error('latent role weights could not be normalized');
  }

  return {
    mode: 'latent',
    roles: selected.map((candidate, index) => ({
      id: candidate.id,
      vectorRef: candidate.vectorRef,
      weight: exp[index] / denominator,
      rank: index + 1,
    })),
    authority: 'none',
    requiresHiddenStateAccess: true,
  };
}
