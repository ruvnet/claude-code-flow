# ADR 0001: Latent role composition for local model backends

Status: Proposed

Date: 2026 08 29

## Context

Ruflo already supports textual mixture of agents fanout. The MoRe paper, arXiv 2608.27338, reports that multiple learned latent roles can be composed into one steering vector and applied in one model generation. The originating team reports performance near multi agent systems while using about 20 times fewer generated tokens on its evaluated settings.

The result is not yet independently reproduced in Ruflo. It also requires hidden state access, so hosted black box APIs cannot use the latent path directly.

## Decision

Introduce a model agnostic latent role composition contract inside the federation plugin.

The contract accepts caller supplied role logits and immutable references to steering vectors, performs deterministic top K selection, normalizes selected weights with stable softmax, and returns either a latent composition plan or an explicit fallback.

The contract never infers permissions. Its output carries `authority: none`. Tool authority, capability expansion, network access, and execution remain governed by existing Ruflo and RVM controls.

## Invariants

1. No hidden state access means no latent steering. Fall back to the existing single agent or multi agent path.
2. Role identifiers are unique and steering vector references are explicit.
3. Logits must be finite.
4. Selection is deterministic for equal inputs.
5. Weights are finite and sum to one within floating point tolerance.
6. Latent role composition never grants execution authority.
7. Existing textual multi agent behavior remains unchanged unless a caller opts into a future backend integration.

## Rejected alternatives

### Replace textual multi agent routing immediately

Rejected because the published result does not support black box model APIs and does not uniformly beat the strongest multi agent baseline on both evaluated backbones.

### Train role vectors inside the federation plugin

Rejected because training belongs in the model runtime or training subsystem. Federation should consume validated artifacts, not own opaque model state mutation.

### Treat role confidence as trust

Rejected. A router score is inference evidence, not identity or authority.

## Validation plan

Compare three conditions with identical tasks and base models: single agent, current textual mixture of agents, and latent role composition. Report accuracy, generated tokens, wall time, time to first token, GPU memory, energy when available, failures, and variance.

Promotion requires either performance within 1.5 absolute percentage points of the stronger textual multi agent baseline with at least 8 times fewer coordination tokens, or at least 2 absolute points over the single agent baseline at no more than 1.1 times its generated token cost.

Security evaluation must include poisoned role vectors, malformed logits, missing vector artifacts, out of distribution prompts, and attempts to convert router output into execution authority.

## Rollback

Remove the exported composer and backend opt in. Existing routing remains the fallback and requires no data migration.
