# Conformance checklist — Witness / Receipt Contract v1

Testable criteria for consumers of [`witness-receipt-contract.md`](./witness-receipt-contract.md):
`rvm-witness` anchoring (`ruvnet/rvm#35`), the `autogenous` ledger
(`ruvnet/autogenous#10`), and the `ruvector-agent-memory` TARL ledger
(`ruvnet/RuVector#840`).

Each item is a test to write, not a box to assert. Items derived from ADR-322C's
own §"Required tests" are marked **[322C]**; the rest are the consumer-facing
consequences of the same rules.

## A. Producer conformance (you emit records)

- [ ] **A1** Every emitted record validates against the matching file in
  [`schemas/`](./schemas/) with `additionalProperties: false`. This is the only
  enforcement of ADR-322C's unknown-field rule — ruflo's own verifier does not
  whitelist fields (contract §2.4, gap G3).
- [ ] **A2** No record contains `NaN`, `±Infinity`, or negative zero anywhere.
- [ ] **A3** Every fractional value is a canonical decimal string, not a binary
  float. Round-tripping a record through your serializer does not change its
  content ID.
- [ ] **A4** `candidateId` recomputes as `SHA-256(JCS(candidatePolicy))`, and
  `receiptId` as `SHA-256(JCS(payload minus receiptId))` (contract §3).
- [ ] **A5** Re-evaluating the same candidate produces the **same** `candidateId`
  with a **new** `evaluationRunId` and a **new** `receiptId`. **[322C]**
- [ ] **A6** The signature covers `UTF8(domain) || 0x00 || JCS(payload)` with the
  exact domain string for the record type (contract §4). Verify against
  [`examples/receipt-accepted.example.json`](./examples/receipt-accepted.example.json),
  whose signature was produced by ruflo's implementation.
- [ ] **A7** Every gate marked `true` has a `termVerification` entry, and no
  authorizing term is `trusted-assertion` without a named attestor (contract §5).
- [ ] **A8** `pairedOutcomes` is emitted, is the same length and order as
  `heldOutDeltas`, and each per-task delta reproduces its aggregate. Aggregate-only
  receipts are refused by the promotion authority (ADR-381).

## B. Verifier conformance (you check records)

- [ ] **B1** Altering **any** byte of a canonical record or a referenced object
  fails verification. **[322C]** Confirmed behaviour: flipping one score in the
  reference fixture yields `receipt content ID mismatch`.
- [ ] **B2** Reordering object keys in transport does **not** change validity —
  canonicalization sorts keys. A verifier that depends on serialized order is
  non-conforming.
- [ ] **B3** A cryptographically valid signature from a signer outside the trusted
  set is **refused**, not merely flagged.
- [ ] **B4** A signature whose `domain` is not the exact expected string is
  refused, including one that is otherwise valid under a different ruflo domain.
  This is the replay defence — an ADR-103 witness signature must not verify as a
  promotion signature (contract §4).
- [ ] **B5** The statistical decision is **recomputed**, not read. Your bootstrap
  reproduces `relativeLift`, `pairedBootstrapProbability`,
  `pairedBootstrapDeltaCILow95`, and `accepted` **exactly** for
  [`examples/receipt-bootstrap-reference.example.json`](./examples/receipt-bootstrap-reference.example.json),
  using the procedure now normative in ADR-322C §Update (2026-08-19). Expected:
  `0.100428571429`, `1`, `0.0489`, `true`, with
  `seedHex = 167c9185d76163dfa69ae57c11af813669a6353abcb49d7af673acf918f3a7c3`.
  Use **that** fixture, not `receipt-accepted.example.json` — only its deltas are
  heterogeneous enough to discriminate. Verified: a wrong seed slice, wrong byte
  order, or different LCG constants all produce `0.0425` on the accepted-receipt
  fixture (indistinguishable) but `0.04975` / `0.04965` / `0.04915` on this one.
  [`conformance/recompute_reference.py`](./conformance/recompute_reference.py) is a
  runnable oracle you can diff your implementation against.
- [ ] **B5a** Your producer computes statistics from the **encoded** scores, not
  from internal full-precision values — a verifier only ever sees the encoded form.
  Note contract gap G5: ruflo's own producer does not yet do this, so a receipt
  whose mean needs more than twelve decimals fails its own verifier. Distinguish
  that failure from tampering when triaging.
- [ ] **B6** Float and decimal fixtures produce identical hashes across every
  runtime you support (Rust and TypeScript both matter here). **[322C]**
- [ ] **B7** Corpus-role disjointness is checked — a task ID appearing in both
  `selectionTaskIds` and `promotionHoldoutTaskIds` fails verification.
- [ ] **B8** An expired receipt (`expiresAt <= now`) is refused.
- [ ] **B9** Your report labels **every** authorizing term `recomputed`,
  `signature-verified`, or `trusted-assertion`, and refuses to describe a
  promotion as independently verified while any authorizing term is an unapproved
  assertion. **[322C]**

## C. Ledger and anchoring

- [ ] **C1** Removing, reordering, or reparenting a commit breaks verification
  from head to genesis. **[322C]**
- [ ] **C2** Exactly one commit may consume a given `receiptId`; a second attempt
  is idempotent, not a second promotion (ADR-322A).
- [ ] **C3** You anchor the **receipt** (`receiptId`), whose signature is
  implemented — not the ledger head, whose `ruflo/flywheel-ledger-head/v1`
  signature is specified but not implemented on `main` (contract gap G2). If you
  anchor a head, you are anchoring an unsigned hash chain; say so.
- [ ] **C4** An anchored record's stated assurance is the assurance it carries,
  not the assurance of the chain it landed in. A service-side record anchored into
  a hypervisor chain does not acquire hypervisor-side guarantees
  (`rvm` ADR-285). Uses the `assuranceLevel` field in
  [`schemas/ruflo-anchor-record-v1.schema.json`](./schemas/ruflo-anchor-record-v1.schema.json)
  (ADR-322D — Accepted).
- [ ] **C5** No dependency edge is introduced between `rvm-witness` and
  `autogenous`'s witness crate in either direction — both consume this contract
  independently (`rvm#35`, `autogenous#10`).

## D. Separation of powers across the repo boundary

- [ ] **D1** The party emitting receipts is **not** the party that decides
  `allowedProposerSubstitutions`, `trustedPublicKeys`, or `approvedAttestors`.
  A cross-repo promotion that lets one actor supply both collapses the
  proposer/promoter split ADR-322 exists to maintain.
- [ ] **D2** A receipt carrying `proposerSubstitution` does not promote unless
  that exact substitution string is explicitly allow-listed. Default denies.
- [ ] **D3** Promotion preconditions are re-checked **at promotion time**, not
  inherited from evaluation time: `baselineRef`, `expectedLedgerHead`,
  `gateVersion`, `policySchemaVersion`, `safetyEnvelopeRef`, `expiresAt`
  (ADR-322A §"Promotion compare-and-swap").

## E. Statistical claims you republish

- [ ] **E1** Any restatement of the family-wise false-promotion bound carries both
  qualifiers: it is **per evidence epoch**, and **ADR-381 is `Proposed`** (though
  the mechanism is present on `main`). Contract §6.2.
- [ ] **E2** A governed reset opens a new epoch, expires outstanding receipts, and
  restarts allocation at `k = 1`. A receipt whose `issuedAt` predates the current
  epoch boundary is refused even if registered after the reset.
- [ ] **E3** You do not claim phase-3/4 properties. `safetyEnvelopeRef` is carried
  and compared, but the **signed** `SafetyEnvelope` it names is a phase-3 artifact
  that does not exist yet (contract §7).

## F. Versioning

- [ ] **F1** You pin `schemaVersion` and `gateVersion` strings, not ruflo git
  SHAs (`ruvnet/ruflo#3066`).
- [ ] **F2** An unrecognized `schemaVersion` is refused, never best-effort parsed.
- [ ] **F3** A `gateVersion` change is not applied retroactively to receipts
  issued under an older gate.
