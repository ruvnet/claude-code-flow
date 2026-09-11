# ADR-322D: Cross-repo anchor record — proposed extension promoted to Accepted

- **Status**: Accepted — implemented and consumed downstream
- **Parent**: ADR-322C (defines the record types and verification protocol this ADR's record anchors *into* a foreign chain)
- **Date**: 2026-08-29
- **Related**: ADR-322 (flywheel receipt protocol), ADR-322C (receipt/ledger verification), `v3/docs/spec/witness-receipt-contract.md` §9, `ruvnet/ruflo#3066` (closed — PIR program tracking issue), `ruvnet/RuVector#837` (PIR program epic)

## Context

`witness-receipt-contract.md` §9 and `schemas/ruflo-anchor-record-v1.schema.json` both currently read as `PROPOSED-EXTENSION` — "Nothing above is decided. It needs an ADR before `rvm`, `autogenous`, or `ruvector` depends on it." That framing is stale. Checked directly against the actual repos (2026-08-29):

- `ruvnet/rvm#37` — **MERGED**: "feat(anchor): verify and anchor ruflo ADR-322C receipts into the witness chain (WP8, #35)".
- `ruvnet/autogenous#13` — **MERGED**: "feat(radio-moe): export promotion evidence in the ruflo ADR-322C receipt shape (WP8, #10)".
- `ruvnet/ruflo#3066` (the PIR tracking issue that scoped this work) — **CLOSED**, with its own final status comment confirming the schema (PR #3067, merged 2026-08-20) is canonical on `main` and the two downstream conformance audits (`rvm#37`, `autogenous#13`) cleared.

Two consumers have already built against this "not decided" placeholder and shipped. The ADR this repo's own spec said was a precondition for that dependency was never actually written. This ADR is that missing formal record, written after the fact to match what's already true rather than to authorize something new.

## Decision

Promote the cross-repo anchor record (`ruflo.anchor-record/v1`, schema at `v3/docs/spec/schemas/ruflo-anchor-record-v1.schema.json`) from `PROPOSED-EXTENSION` to **Accepted**, unchanged in shape from what shipped:

- `payload.anchoredContentId` / `anchoredSchemaVersion` — identifies the ADR-322C record being anchored (normally a `receiptId`, since receipt signatures are implemented and ledger-head signatures are not — gap G2, unchanged by this ADR).
- `payload.chain` (`chainId`, `position`) — opaque foreign-chain pointer.
- `payload.assuranceLevel` (`service-side` | `hypervisor-side`) — required by `rvm` (its own ADR-285 discipline: a service-side record anchored into a hypervisor chain does not thereby acquire hypervisor-side guarantees) and by `autogenous`.
- Signing domain `ruflo/flywheel-anchor/v1`, distinct from `ruflo/flywheel-receipt/v1` so an anchor signature can never be replayed as a receipt signature (ADR-322 §Persistence and key boundaries).

No schema changes. This ADR is a status change, not a design change — the two live consumers already built against the shape as specified; changing it now would break them.

### What this does *not* cover

This ADR concerns exactly one cross-repo contract: ruflo's own flywheel evaluation receipts, anchored into `rvm`'s or `autogenous`'s witness chain. It is unrelated to, and should not be conflated with, `ruvnet/LatentMesh`'s own aspiration (its ADR-008/ADR-009) to have RVF/RVM gate *LatentMesh's* candidate cognition specifically — that remains, per a direct check of LatentMesh's own docs on 2026-08-29, explicitly unwired and unreferenced anywhere in RVM's documentation. Two different things share the word "RVM" here: a real, shipped ruflo→RVM receipt-anchoring contract (this ADR), and a still-aspirational LatentMesh→RVM candidate-cognition gate (not this ADR, not yet real anywhere).

## Consequences

**Positive**: `witness-receipt-contract.md` and the schema file's own header stop contradicting the two repos that already built against them. Future readers of either file (including the "external implementers... without reading ruflo's source" audience §9 itself names) get an accurate status instead of a placeholder warning that undersold what's already shipped.

**Negative**: none — this is a documentation-accuracy correction, not a behavior change. `rvm#37` and `autogenous#13` do not need to change anything; they already built the real thing.

## Verification

```bash
# Schema exists and is the one both downstream consumers built against:
cat v3/docs/spec/schemas/ruflo-anchor-record-v1.schema.json
gh pr view 37 --repo ruvnet/rvm --json state,title
gh pr view 13 --repo ruvnet/autogenous --json state,title
gh issue view 3066 --repo ruvnet/ruflo --json state
```

## Implementation status

Already implemented, on both sides, before this ADR was written. This ADR is the record catching up to that reality, per `v3/docs/spec/witness-receipt-contract.md`'s own instruction: "requiring its own ADR before use" — the "before use" window closed on 2026-08-20 when `rvm#37`/`autogenous#13` merged; this ADR closes the paperwork gap that left, not a code gap.
