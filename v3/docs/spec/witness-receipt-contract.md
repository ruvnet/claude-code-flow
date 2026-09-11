# Witness / Receipt Contract v1 (extracted from ADR-322C)

- **Status**: Descriptive extract — adds no decisions. Every normative statement
  traces to [ADR-322](../adr/ADR-322-metaharness-flywheel-integration.md),
  [ADR-322A](../adr/ADR-322A-evaluation-promotion-transaction.md),
  [ADR-322C](../adr/ADR-322C-receipt-ledger-verification.md),
  [ADR-381](../adr/ADR-381-sequential-promotion-evidence-governance.md), or the
  implementing source under `v3/@claude-flow/cli/src/services/`.
- **Audience**: external implementers (`ruvnet/rvm#35`, `ruvnet/autogenous#10`,
  `ruvnet/RuVector#840`) producing or verifying these records **without reading
  ruflo's source**. Tracked by `ruvnet/ruflo#3066` (closed 2026-08-20).
- **`PROPOSED-EXTENSION`** marked anything *not* in ADR-322C: a minimal placeholder
  for a consumer need 322C does not address, requiring its own ADR before use.
  The one extension this doc defines (record type 3, §9) cleared that bar on
  2026-08-29 via [ADR-322D](../adr/ADR-322D-cross-repo-anchor-record-accepted.md)
  — both downstream consumers (`rvm#37`, `autogenous#13`) had already merged
  against this exact shape, so the label now reads as stale rather than as an
  open precondition. Kept as a term for any *future* extension this doc
  doesn't yet define.

## 1. Record types

| # | Record | Schema id | Signing domain | Implementation status |
|---|---|---|---|---|
| 1 | Evaluation receipt | `ruflo.flywheel-receipt/v1` | `ruflo/flywheel-receipt/v1` | Implemented (`flywheel-receipt.ts:18`) |
| 2 | Promotion commit + ledger head | *(unnamed in 322C)* | `ruflo/flywheel-ledger-head/v1` | **Commit implemented unsigned**; head signing **specified but not implemented** — see §7 |
| 3 | Cross-repo anchor record | `ruflo.anchor-record/v1` | `ruflo/flywheel-anchor/v1` | **Accepted — implemented, consumed by `rvm#37` and `autogenous#13` (both merged)** — see [ADR-322D](../adr/ADR-322D-cross-repo-anchor-record-accepted.md), §9 |

A third domain-separation string exists but is **not** a signing domain:
`"ruflo/bootstrap/v1"`, the seed prefix for the paired bootstrap (ADR-322C
§"Default statistical rule"). Do not treat it as an Ed25519 domain.

**Separation of powers** (ADR-322 §Decision, Track A): the proposer never promotes.
The receipt records `requestedProposer`, `effectiveProposer`, and
`proposerSubstitution`; the promotion authority refuses any receipt whose
`proposerSubstitution` is not explicitly allow-listed
(`flywheel-transaction.ts:463-466`). Crossing a repo boundary must not collapse
these roles: the party that emits a receipt must not be the party that decides
`allowedProposerSubstitutions`.

## 2. Canonicalization

ADR-322C §Canonical format:

```text
Canonical JSON: RFC 8785 JCS
Digest:         SHA-256
Signature:      Ed25519(domainPrefix || 0x00 || canonicalBytes)
Content ID:     sha256:<lowercase-hex>
Timestamp:      RFC 3339 UTC as YYYY-MM-DDTHH:mm:ss.sssZ
```

Rules, all from ADR-322C §Canonical format unless noted:

1. `NaN`, `±Infinity`, and negative zero are forbidden anywhere in a record.
2. Fractional values are **decimal strings**, never binary floats — scores, deltas,
   lift, probabilities, rates. Currency is integer micros plus an ISO-4217 code;
   duration is integer microseconds; energy is integer microjoules.
3. Object key order in transport is irrelevant — canonicalization sorts keys
   (`flywheel-receipt.ts:176-185`). Do not rely on serialized order.
4. Unknown fields fail verification for a given schema version. **Caveat**: the
   implementation enforces this only *transitively* (an unknown field changes the
   recomputed content ID, catching post-signing injection), but has no field
   whitelist, so a *producer* may emit unknown fields and they will verify.
   Consumers MUST validate against `schemas/`, which set
   `additionalProperties: false`. Gap G3 in §7.

## 3. Identity derivation

ADR-322C §Identity domains:

```text
candidateId     = SHA-256(JCS(candidate policy))          -> "sha256:<hex>"
evaluationRunId = UUIDv7, one per execution attempt
receiptId       = SHA-256(JCS(unsigned receipt payload))  -> "sha256:<hex>"
lineageId       = UUIDv7, one per persistent lineage
```

"Unsigned receipt payload" means **the `payload` object with the `receiptId`
member omitted** and no `signature` present (`flywheel-receipt.ts:394,419-421`).
Re-running the same candidate yields the same `candidateId` but a new
`evaluationRunId` and a new `receiptId` (ADR-322C §Identity domains).

## 4. Signature construction

For domain `D` and record `R`:

```text
canonicalBytes = UTF-8( JCS(R) )
signedBytes    = UTF-8(D) || 0x00 || canonicalBytes
signature      = Ed25519_sign(privateKey, signedBytes)      # base64 in the record
```

For the receipt, `R` is the **complete `payload` including `receiptId`**, and `D`
is `ruflo/flywheel-receipt/v1` (`flywheel-receipt.ts:313-319`). The signature
object carries `algorithm`, `domain`, `publicKeyPem`, `signatureBase64`.

Domain separation is the point: ADR-322 §"Persistence and key boundaries" requires
a distinct prefix and key purpose so that an ADR-103 witness signature cannot be
replayed as a promotion signature. A verifier MUST reject a signature whose
`domain` is not the exact string expected for that record type.

## 5. Evidence grades

ADR-322C §RufloFlywheelReceiptV1 defines exactly three grades. Each entry in
`termVerification[]` labels one authorizing term:

| Grade | Applies when | Verifier obligation |
|---|---|---|
| `recomputed` | The verifier reproduced the term from data inside or content-addressed by the receipt | Recompute it; a mismatch fails verification |
| `signature-verified` | The term is cryptographically bound to an identified attestor | Verify the binding **and** that the attestor is approved and in scope |
| `trusted-assertion` | Neither of the above — a bare claim | Refuse to call the promotion independently verified |

ADR-322C §Verification: *"Verification cannot label a promotion independently
verified while any authorizing term remains an unapproved assertion."* The
promotion authority enforces this: every passing gate must have a
`termVerification` entry, and a `trusted-assertion` entry must name an attestor
present in the approved set (`flywheel-transaction.ts:467-476`).

## 6. Verification algorithm

From ADR-322C §Verification, with the implementable detail a consumer needs:

1. **Schema.** Reject unknown or invalid fields for the declared `schemaVersion`.
2. **Content IDs.** Recompute `receiptId` per §3 and `candidateId` from
   `candidatePolicy`; both must match.
3. **Signature.** Check `algorithm == "ed25519"`, `domain` is the exact expected
   string, the signer is trusted, and Ed25519 verifies over §4's `signedBytes`.
4. **Evidence.** Resolve every evidence reference; verify provenance and authority
   scope.
5. **Statistics.** Recompute the decision (§6.1); it must reproduce
   `statistics` byte-for-byte under JCS.
6. **Corpus roles.** Check role disjointness and sealed manifests — a task used for
   selection may not also serve as promotion holdout for the same lineage
   (ADR-322 Track C).
7. **Preconditions.** Check `baselineRef`, `safetyEnvelopeRef`, `gateVersion`,
   `policySchemaVersion`, `expiresAt`, and ledger continuity.
8. **Report.** Emit a grade (§5) for every term.

### 6.1 Statistical recomputation

Default rule (ADR-322C §Default statistical rule) — all four conjuncts:

```text
relativeLift >= 0.02
AND pairedBootstrapProbability(candidate > baseline) >= 0.95
AND pairedBootstrapDeltaCILow95 > 0
AND frozenAnchorRegression <= 0
```

with `relativeLift = (candidateMean - baselineMean) / max(|baselineMean|, metricEpsilon)`,
`metricEpsilon` fixed by the metric schema (ADR-322 §Statistical promotion rule;
default `1e-12` at `flywheel-receipt.ts:265`).

Seed (ADR-322C): `SHA-256("ruflo/bootstrap/v1" || corpusHash || candidateId ||
baselineRef || evaluationRunId)`, concatenated with no separator. The full digest
hex is recorded as `seedHex`.

The PRNG driven by that seed, the resampling procedure, and the decimal encoding
of the results are now normative in **ADR-322C §Update (2026-08-19)** — added by
ruflo#3069, which this spec's first draft raised. Consult that section as the
authority; in summary:

- PRNG state = first 4 bytes of the seed digest, big-endian uint32.
- Step: `state = (1664525 * state + 1013904223) mod 2^32`; draw = `state / 2^32`.
- 10,000 resamples by default; each draws `n` indices as `floor(draw * n)`, in
  sequence, and averages the corresponding `heldOutDeltas`.
- `pairedBootstrapProbability` = fraction of resample means strictly `> 0`.
- `pairedBootstrapDeltaCILow95` = the `floor(0.025 * iterations)`-th order
  statistic (0-based) of the resample means.
- Results are encoded at scale 12 with trailing zeros stripped.

**Test your implementation against
[`examples/receipt-bootstrap-reference.example.json`](./examples/receipt-bootstrap-reference.example.json),
not the accepted-receipt example.** Only the former has heterogeneous per-task
deltas. The latter's deltas take two distinct values, which makes its 2.5th
percentile identical under a wrong seed slice, a wrong byte order, or entirely
different LCG constants — it would pass a non-conforming verifier.
[`conformance/recompute_reference.py`](./conformance/recompute_reference.py) is a
runnable oracle written from the ADR prose alone; it reproduces that fixture
exactly and is the demonstration that the spec is sufficient to reimplement from.

**Caveat consumers will hit:** a producer must compute the statistics from the
*encoded* scores, since that is all a verifier has. `createFlywheelReceipt`
currently computes from full-precision means while storing scale-12 strings, so a
receipt whose mean needs more than twelve decimals fails ruflo's own verifier with
`statistical decision does not recompute`. Gap G5 in §7.

### 6.2 Sequential evidence (ADR-381)

Promotion additionally requires an anytime-valid e-process over task-level
`pairedOutcomes`. Per discordant pair the e-value multiplies by `(1 + λ)` when the
candidate wins and `(1 - λ)` when the baseline wins; concordant pairs
(`|delta| <= 1e-9`) carry no information. Test `k` must clear `1 / α_k` where
`α_k = α_total · 6/(π² k²)`, defaults `α_total = 0.05`, `λ = 0.5`
(ADR-381 §1, §3; `flywheel-sequential-evidence.ts:39-124`).

**Guarantee, stated honestly (ADR-381 §2):** the family-wise false-promotion bound
is `≤ α_total` **per evidence epoch**, not for all time. An explicit, logged
governance reset opens a new epoch, expires outstanding receipts, and restarts the
allocation at `k = 1`. **ADR-381's status is `Proposed`** — but the mechanism is
already present on `main` (`flywheel-transaction.ts:478-550`, state fields
`sequentialTests` / `evidenceEpoch` / `sequentialResets`). Consumers quoting the
bound must quote the per-epoch qualifier and the `Proposed` status together.

## 7. Known gaps between ADR-322C and the implementation

| # | Gap | Consumer impact |
|---|---|---|
| G1 | ~~Bootstrap PRNG algorithm is in source only~~ — **closed** by ADR-322C §Update (2026-08-19) (ruflo#3069) | Resolved; recompute from the ADR, verify against the reference fixture |
| G2 | ADR-322C §Ledger specifies content-addressed segments with `segmentMerkleRoot` and a **signed** head under `ruflo/flywheel-ledger-head/v1`. `main` implements a flat `commits[]` array in one state file with an **unsigned** SHA-256 chain (`flywheel-transaction.ts:553-568,619-636`) | A ledger head cannot currently be signature-verified across a repo boundary; anchor the **receipt**, whose signature is implemented |
| G3 | No unknown-field whitelist in `verifyFlywheelReceipt` (§2.4) | Consumers must enforce it via `schemas/` |
| G4 | ADR-322C §Flywheel projection (external receipt export) is deliberately disabled (ADR-322 §Current inventory) | Do not assume an upstream `@metaharness/flywheel` round-trip is available |
| G5 | `createFlywheelReceipt` computes statistics from full-precision means but stores scale-12 strings, so a receipt whose mean needs >12 decimals fails ruflo's own verifier (§6.1) | A legitimately produced receipt can be unverifiable. Compute from the encoded values; treat a `statistical decision does not recompute` error on a receipt you trust as this defect, not tampering |

Per ADR-322 §"Phased rollout", phases 0–2 are implemented; phases 3–4 (signed
`SafetyEnvelope`, `toolPolicy`/`modelPolicy` evolution, unattended promotion) are
**not** — `safetyEnvelopeRef` is carried and compared, but the signed envelope it
names is a phase-3 artifact.

## 8. Versioning

- `schemaVersion` is exact-match, not semver-range. A verifier accepts only the
  versions it implements (ADR-322C §Canonical format: schema evolution requires a
  new version plus a migration recording input and output hashes).
- `gateVersion` changes are **never retroactive** — an existing receipt is judged
  under the gate version it recorded (ADR-322C §Default statistical rule).
- Per `ruvnet/ruflo#3066`, consumers must not pin to unreleased ruflo commits
  without a compatibility ADR. Pin `schemaVersion` + `gateVersion` strings, not
  git SHAs.

## 9. Cross-repo anchoring — **Accepted** ([ADR-322D](../adr/ADR-322D-cross-repo-anchor-record-accepted.md))

ADR-322C defines records and their verification but **no pointer format** for
anchoring one into a foreign chain. `rvm#35` and `autogenous#10` both needed
one. Shape, in `schemas/ruflo-anchor-record-v1.schema.json`:

- `anchoredContentId` / `anchoredSchemaVersion` — the `sha256:` ID of the anchored
  record and what kind of record it is.
- `chain` — foreign chain identifier and position.
- `assuranceLevel` (`service-side` | `hypervisor-side`) — required by `rvm#35` and
  `autogenous#10`: a service-side record anchored into a hypervisor chain does
  **not** thereby acquire hypervisor-side guarantees (`rvm` ADR-285 discipline).
- Signing domain `ruflo/flywheel-anchor/v1` — distinct so an anchor signature can
  never be replayed as a receipt signature (§4).

**No longer a placeholder.** `rvm#37` ("verify and anchor ruflo ADR-322C
receipts into the witness chain") and `autogenous#13` ("export promotion
evidence in the ruflo ADR-322C receipt shape") are both merged, built against
exactly this shape. ADR-322D promotes this record from `PROPOSED-EXTENSION`
to Accepted to match — schema unchanged, since two live consumers already
depend on it as specified.

Scope note carried over from ADR-322D: this is ruflo's own flywheel receipts
anchoring into `rvm`/`autogenous`'s witness chains specifically. It is not the
same thing as `ruvnet/LatentMesh`'s separate, still-unwired aspiration to have
RVF/RVM gate its own candidate cognition — a different "RVM" relationship
that this section does not cover.
