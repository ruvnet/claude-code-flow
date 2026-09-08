import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import {
  GENESIS_LEDGER_HEAD,
  RECEIPT_DOMAIN,
  canonicalizeJcs,
  createFlywheelReceipt,
  assertReceiptNumberDomain,
  encodePolicyFractions,
  policyCandidateId,
  sha256Ref,
  verifyFlywheelReceipt,
} from '../src/services/flywheel-receipt.js';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function acceptedReceipt(key = keys(), now = 1_700_000_000_000) {
  return {
    key,
    receipt: createFlywheelReceipt({
      baselineRef: policyCandidateId({ alpha: 0.5 }),
      expectedLedgerHead: GENESIS_LEDGER_HEAD,
      candidatePolicy: { alpha: 0.3 },
      safetyEnvelopeRef: 'sha256:safety',
      corpusVersion: 'corpus-v1',
      corpusHash: 'sha256:corpus',
      anchorRef: 'sha256:project-anchor',
      baselineScore: 0.5,
      candidateScore: 0.65,
      heldOutDeltas: [0.1, 0.12, 0.2, 0.08, 0.15, 0.11],
      frozenAnchorRegression: 0,
      gates: { heldOut: true, redblue: true, replay: true },
      now,
      bootstrapIterations: 1_000,
      ...key,
    }),
  };
}

/**
 * Rebuild a receipt's identity and signature after mutating its payload — what a
 * producer emitting a non-contract field actually does. The result is internally
 * consistent and signed by a trusted key, so only a strict field check can refuse it.
 */
function resign(receipt: any, privateKeyPem: string, publicKeyPem: string) {
  const { receiptId: _drop, ...base } = receipt.payload;
  const payload = { ...base, receiptId: sha256Ref(canonicalizeJcs(base)) };
  const signedBytes = Buffer.concat([
    Buffer.from(RECEIPT_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalizeJcs(payload), 'utf8'),
  ]);
  return {
    payload,
    signature: {
      algorithm: 'ed25519' as const,
      domain: RECEIPT_DOMAIN,
      publicKeyPem,
      signatureBase64: edSign(null, signedBytes, privateKeyPem).toString('base64'),
    },
  };
}

describe('flywheel receipt protocol', () => {
  it('uses deterministic canonical JSON and rejects ambiguous numeric values', () => {
    expect(canonicalizeJcs({ z: 1, a: { c: 2, b: 1 } })).toBe('{"a":{"b":1,"c":2},"z":1}');
    expect(() => canonicalizeJcs({ value: -0 })).toThrow(/non-canonical number/);
    expect(() => canonicalizeJcs({ value: Number.NaN })).toThrow(/non-canonical number/);
  });

  it('signs an accepted receipt and verifies only against an approved key', () => {
    const { key, receipt } = acceptedReceipt();
    expect(receipt.payload.decision).toBe('accepted');
    expect(verifyFlywheelReceipt(receipt, new Set([key.publicKeyPem]))).toEqual({
      valid: true,
      signed: true,
      errors: [],
    });
    expect(verifyFlywheelReceipt(receipt, new Set([keys().publicKeyPem])).errors).toContain('receipt signer is not trusted');
  });

  it('detects one-byte-equivalent content changes and separates run identity from policy identity', () => {
    const { key, receipt } = acceptedReceipt();
    const tampered = structuredClone(receipt);
    tampered.payload.candidatePolicy.alpha = 0.31;
    expect(verifyFlywheelReceipt(tampered, new Set([key.publicKeyPem])).valid).toBe(false);

    const anchorTampered = structuredClone(receipt);
    anchorTampered.payload.anchorRef = 'sha256:different-project-anchor';
    expect(verifyFlywheelReceipt(anchorTampered, new Set([key.publicKeyPem])).valid).toBe(false);

    const second = acceptedReceipt(key, 1_700_000_000_001).receipt;
    expect(second.payload.candidateId).toBe(receipt.payload.candidateId);
    expect(second.payload.evaluationRunId).not.toBe(receipt.payload.evaluationRunId);
    expect(second.payload.receiptId).not.toBe(receipt.payload.receiptId);
  });

  it('rejects an unknown payload field even when the signature over it is valid (ADR-322C, #3068)', () => {
    const { key, receipt } = acceptedReceipt();
    const forged: any = structuredClone(receipt);
    forged.payload.attackerControlledField = 'not defined by ADR-322C';
    const signed = resign(forged, key.privateKeyPem, key.publicKeyPem);

    const verification = verifyFlywheelReceipt(signed as any, new Set([key.publicKeyPem]));
    expect(verification.valid).toBe(false);
    expect(verification.errors).toContain('unknown field: payload.attackerControlledField');
    // The rejection must be attributable to the field, not to a broken signature —
    // a caller triaging this needs to tell "unrecognized" from "tampered".
    expect(verification.errors.join(' ')).not.toMatch(/signature invalid|content ID mismatch/);
  });

  it('rejects unknown fields in nested contract objects', () => {
    const { key, receipt } = acceptedReceipt();
    const forged: any = structuredClone(receipt);
    forged.payload.statistics.extraStat = 1;
    forged.payload.resourceEvidence.extraCost = 2;
    forged.payload.evidence.corpusRoles.extraRole = [];

    const signed: any = resign(forged, key.privateKeyPem, key.publicKeyPem);
    signed.signature.extraSignatureField = 'x'; // outside the signed bytes by construction

    const errors = verifyFlywheelReceipt(signed, new Set([key.publicKeyPem])).errors;
    expect(errors).toContain('unknown field: payload.statistics.extraStat');
    expect(errors).toContain('unknown field: payload.resourceEvidence.extraCost');
    expect(errors).toContain('unknown field: payload.evidence.corpusRoles.extraRole');
    expect(errors).toContain('unknown field: signature.extraSignatureField');
  });

  it('keeps contract-open objects open', () => {
    const key = keys();
    const receipt = createFlywheelReceipt({
      baselineRef: policyCandidateId({ alpha: 0.5 }),
      candidatePolicy: { alpha: 0.3, anyPolicyKnobTheSchemaOwns: 'ok', nested: { deep: 1 } },
      safetyEnvelopeRef: 'sha256:safety',
      corpusVersion: 'corpus-v1',
      corpusHash: 'sha256:corpus',
      baselineScore: 0.5,
      candidateScore: 0.65,
      heldOutDeltas: [0.1, 0.12, 0.2, 0.08, 0.15, 0.11],
      frozenAnchorRegression: 0,
      gates: { heldOut: true, anyCallerNamedGate: true },
      evidence: {
        corpusRoles: { selectionTaskIds: [], promotionHoldoutTaskIds: [], guardTaskIds: [] },
        verification: { arbitraryEvidencePayload: true },
        canary: { alsoArbitrary: 1 },
      },
      bootstrapIterations: 500,
      ...key,
    });
    // candidatePolicy is owned by policySchemaVersion, gates is a caller-named
    // term map, and the evidence payloads are evidence-specific — none are closed.
    expect(verifyFlywheelReceipt(receipt, new Set([key.publicKeyPem])).valid).toBe(true);
  });

  it('recomputes the statistical verdict instead of trusting signed fields', () => {
    const { key, receipt } = acceptedReceipt();
    const forged = structuredClone(receipt);
    forged.payload.statistics.relativeLift = '99';
    expect(verifyFlywheelReceipt(forged, new Set([key.publicKeyPem])).errors).toContain(
      'statistical decision does not recompute',
    );
  });

  it('carries task-level paired outcomes and refuses ones that cannot reproduce their aggregate', () => {
    const key = keys();
    const heldOutDeltas = [0.1, 0.12, 0.2, 0.08];
    const receipt = createFlywheelReceipt({
      baselineRef: policyCandidateId({ alpha: 0.5 }),
      candidatePolicy: { alpha: 0.3 },
      safetyEnvelopeRef: 'sha256:safety',
      corpusVersion: 'corpus-v1',
      corpusHash: 'sha256:corpus',
      baselineScore: 0.5,
      candidateScore: 0.65,
      heldOutDeltas,
      pairedOutcomes: heldOutDeltas.map((delta, i) => ({
        taskId: `t${i}`,
        baselineScore: 0.5,
        candidateScore: 0.5 + delta,
      })),
      frozenAnchorRegression: 0,
      gates: { heldOut: true },
      bootstrapIterations: 500,
      ...key,
    });
    expect(receipt.payload.pairedOutcomes).toHaveLength(4);
    expect(verifyFlywheelReceipt(receipt, new Set([key.publicKeyPem])).valid).toBe(true);

    // Tampering with a per-task score breaks BOTH the content ID and the
    // delta-reproducibility check — the paired rows are evidence, not decoration.
    const tampered = structuredClone(receipt);
    tampered.payload.pairedOutcomes![0].candidateScore = '0.9';
    const verification = verifyFlywheelReceipt(tampered, new Set([key.publicKeyPem]));
    expect(verification.valid).toBe(false);
    expect(verification.errors.join(' ')).toMatch(/paired outcomes inconsistent/);
  });

  it('keeps receipts without paired outcomes verifiable (backward compatibility)', () => {
    const { key, receipt } = acceptedReceipt();
    expect(receipt.payload.pairedOutcomes).toBeUndefined();
    expect(verifyFlywheelReceipt(receipt, new Set([key.publicKeyPem])).valid).toBe(true);
  });

  it('verifies receipts whose scores need more than twelve decimals (encoded round-trip)', () => {
    const key = keys();
    // Mean of a heterogeneous per-task corpus; not representable at scale 12.
    // Stored as "0.768708333333", so a verifier recomputes from that value —
    // the producer must have used it too, or relativeLift shifts by one ULP
    // and an honest receipt reports "statistical decision does not recompute".
    const candidateScore = 0.7687083333333332;
    const heldOutDeltas = [0.2687083333333332, 0.26870833333333326, 0.2687083333333333, 0.2687083333333331];
    const receipt = createFlywheelReceipt({
      baselineRef: policyCandidateId({ alpha: 0.5 }),
      candidatePolicy: { alpha: 0.3 },
      safetyEnvelopeRef: 'sha256:safety',
      corpusVersion: 'corpus-v1',
      corpusHash: 'sha256:corpus',
      baselineScore: 0.5,
      candidateScore,
      heldOutDeltas,
      frozenAnchorRegression: 0,
      gates: { heldOut: true },
      bootstrapIterations: 500,
      ...key,
    });
    expect(receipt.payload.candidateScore).toBe('0.768708333333');
    const verification = verifyFlywheelReceipt(receipt, new Set([key.publicKeyPem]));
    expect(verification.errors).toEqual([]);
    expect(verification.valid).toBe(true);
  });

  it('rejects small relative lifts even when every held-out delta is positive', () => {
    const { privateKeyPem, publicKeyPem } = keys();
    const receipt = createFlywheelReceipt({
      baselineRef: policyCandidateId({ alpha: 0.5 }),
      candidatePolicy: { alpha: 0.49 },
      safetyEnvelopeRef: 'sha256:safety',
      corpusVersion: 'corpus-v1',
      corpusHash: 'sha256:corpus',
      baselineScore: 1,
      candidateScore: 1.01,
      heldOutDeltas: [0.01, 0.01, 0.01, 0.01],
      frozenAnchorRegression: 0,
      gates: { heldOut: true },
      bootstrapIterations: 500,
      privateKeyPem,
      publicKeyPem,
    });
    expect(receipt.payload.statistics.significant).toBe(true);
    expect(receipt.payload.decision).toBe('rejected');
  });
});

describe('ADR-322C rule 2 — fractional values are decimal strings (#3229)', () => {
  /**
   * The exact candidatePolicy v3.38.21 wrote, from the issue. Fractions become
   * scale-12 decimal strings; integers stay JSON numbers, which is what the
   * contract's own example shows (`{"hnswEf": 128, "hybridWeight": "0.65"}`).
   */
  it('encodes the live RetrievalConfig shape from the bug report', () => {
    const encoded = encodePolicyFractions({
      alpha: 0.3,
      subjectWeight: 1,
      mmrLambda: 0.5,
      bodyWeight: 1.5,
      typePenaltyFactor: 0.5,
    });
    expect(encoded).toEqual({
      alpha: '0.3',
      subjectWeight: 1,
      mmrLambda: '0.5',
      bodyWeight: '1.5',
      typePenaltyFactor: '0.5',
    });
  });

  it('recurses through nested objects and arrays', () => {
    expect(
      encodePolicyFractions({ outer: { inner: 0.25 }, list: [1, 0.5, 'x'], flag: true }),
    ).toEqual({ outer: { inner: '0.25' }, list: [1, '0.5', 'x'], flag: true });
  });

  /**
   * Idempotence is load-bearing: `policyCandidateId` encodes at the hashing
   * boundary, so a raw config and an already-encoded policy must hash the
   * same or `verify` could never recompute the ID from the payload.
   */
  it('is idempotent, so a raw and an encoded policy share one candidate ID', () => {
    const raw = { alpha: 0.3, hnswEf: 128 };
    const once = encodePolicyFractions(raw);
    expect(encodePolicyFractions(once)).toEqual(once);
    expect(policyCandidateId(raw)).toBe(
      policyCandidateId(once as Record<string, unknown>),
    );
  });

  it('normalizes negative zero rather than emitting -0', () => {
    expect(encodePolicyFractions({ z: -0 })).toEqual({ z: '0' });
  });

  it('refuses a non-finite policy value instead of writing null', () => {
    expect(() => encodePolicyFractions({ a: Number.NaN })).toThrow(/must be finite/);
    expect(() => encodePolicyFractions({ a: Number.POSITIVE_INFINITY })).toThrow(/must be finite/);
  });

  /** A produced receipt must satisfy the contract it claims. */
  it('produces a receipt whose candidatePolicy carries no fractional floats', () => {
    const { receipt } = acceptedReceipt();
    const policy = receipt.payload.candidatePolicy as Record<string, unknown>;
    expect(policy.alpha).toBe('0.3');
    for (const [k, v] of Object.entries(policy)) {
      if (typeof v === 'number') {
        expect(Number.isInteger(v), `${k} must be an integer if it is a number`).toBe(true);
      }
    }
  });

  /**
   * The enforcement half. Before this, `assertJsonValue` accepted any finite
   * non-`-0` number, so ruflo verified its own non-conforming receipts while
   * autogenous's stricter verifier rejected them. The error must NAME the
   * path — the original bug needed a live fixture to find precisely because
   * neither verifier said which field was wrong.
   */
  it('rejects a fractional JSON number anywhere in the payload, naming the path', () => {
    const { receipt } = acceptedReceipt();
    const tampered = JSON.parse(JSON.stringify(receipt));
    tampered.payload.candidatePolicy.alpha = 0.3;
    // Asserted at the RECEIPT boundary, not in the shared JCS canonicalizer —
    // that is used by the proposer envelope and the ledger, which the contract
    // does not govern.
    const result = verifyFlywheelReceipt(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(
      /fractional number at \$\.candidatePolicy\.alpha must be a scale-12 decimal string/,
    );
  });

  it('still accepts integers and scaled integers as JSON numbers', () => {
    expect(() =>
      assertReceiptNumberDomain({ micros: 1_500_000, iterations: 2000, depth: 24 }),
    ).not.toThrow();
  });

  /** Regression guard: the rule must NOT live in the shared canonicalizer. */
  it('leaves the shared JCS canonicalizer permissive for non-receipt structures', () => {
    expect(() => canonicalizeJcs({ candidates: [{ policy: { alpha: 0.3 } }] })).not.toThrow();
  });
});
