/**
 * ADR-322C receipt protocol.
 *
 * Provides deterministic JCS-style canonicalization, distinct policy/run/receipt
 * identities, deterministic paired-bootstrap statistics, and domain-separated
 * Ed25519 signatures. Signed receipts are immutable; promotion consumption is
 * tracked separately by flywheel-transaction.ts.
 */
import {
  createHash,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { checkPairedOutcomesConsistency, type PairedTaskOutcome } from './flywheel-sequential-evidence.js';

export const RECEIPT_SCHEMA = 'ruflo.flywheel-receipt/v1';
export const RECEIPT_DOMAIN = 'ruflo/flywheel-receipt/v1';
export const GENESIS_LEDGER_HEAD = `sha256:${'0'.repeat(64)}`;

export type VerificationKind = 'recomputed' | 'signature-verified' | 'trusted-assertion';
export type ProposerName = 'local' | 'darwin';

export interface ReceiptSignature {
  algorithm: 'ed25519';
  domain: typeof RECEIPT_DOMAIN;
  publicKeyPem: string;
  signatureBase64: string;
}

export interface ResourceEvidence {
  p95LatencyMicros: number;
  costMicrosPerTask: number;
  tokensPerTask: number;
  failureRate: string;
  evaluationCostMicros: number;
  energyMicrojoules?: number;
  currency: string;
}

export interface PromotionStatistics {
  ruleVersion: 'ruflo.flywheel-gate/v1';
  relativeLift: string;
  pairedBootstrapProbability: string;
  pairedBootstrapDeltaCILow95: string;
  frozenAnchorRegression: string;
  iterations: number;
  seedHex: string;
  significant: boolean;
  accepted: boolean;
}

export interface TermVerification {
  term: string;
  verification: VerificationKind;
  evidenceRef: string;
  attestor?: string;
}

export interface EvaluationEvidence {
  corpusRoles: {
    selectionTaskIds: string[];
    promotionHoldoutTaskIds: string[];
    guardTaskIds: string[];
  };
  verification: Record<string, unknown>;
  canary: Record<string, unknown>;
}

export interface FlywheelReceiptPayload {
  schemaVersion: typeof RECEIPT_SCHEMA;
  receiptId: string;
  lineageId: string;
  candidateId: string;
  evaluationRunId: string;
  baselineRef: string;
  expectedLedgerHead: string;
  candidatePolicy: Record<string, unknown>;
  gateVersion: string;
  policySchemaVersion: string;
  safetyEnvelopeRef: string;
  /** Hash-pinned human relevance anchor used for this evaluation (#2840). */
  anchorRef?: string;
  requestedProposer: 'auto' | ProposerName;
  effectiveProposer: ProposerName;
  proposerSubstitution?: string;
  corpusVersion: string;
  corpusHash: string;
  baselineScore: string;
  candidateScore: string;
  heldOutDeltas: string[];
  /**
   * Task-level paired outcomes behind heldOutDeltas — same order, same length,
   * per-task delta reproducible from the two scores. Optional in the payload
   * so pre-existing receipts still verify byte-identically, but the promotion
   * authority (flywheel-transaction.ts) REQUIRES it by default: aggregate-only
   * evidence is refused rather than silently falling back to the weaker gate.
   */
  pairedOutcomes?: Array<{ taskId: string; baselineScore: string; candidateScore: string }>;
  statistics: PromotionStatistics;
  gates: Record<string, boolean>;
  resourceEvidence: ResourceEvidence;
  evidence: EvaluationEvidence;
  termVerification: TermVerification[];
  decision: 'accepted' | 'rejected';
  issuedAt: string;
  expiresAt: string;
}

export interface FlywheelEvaluationReceipt {
  payload: FlywheelReceiptPayload;
  signature?: ReceiptSignature;
}

export interface CreateReceiptInput {
  lineageId?: string;
  evaluationRunId?: string;
  baselineRef: string;
  expectedLedgerHead?: string;
  candidatePolicy: Record<string, unknown>;
  gateVersion?: string;
  policySchemaVersion?: string;
  safetyEnvelopeRef: string;
  anchorRef?: string;
  requestedProposer?: 'auto' | ProposerName;
  effectiveProposer?: ProposerName;
  proposerSubstitution?: string;
  corpusVersion: string;
  corpusHash: string;
  baselineScore: number;
  candidateScore: number;
  heldOutDeltas: number[];
  /** Task-level paired outcomes behind heldOutDeltas (same order). */
  pairedOutcomes?: PairedTaskOutcome[];
  frozenAnchorRegression: number;
  gates: Record<string, boolean>;
  resourceEvidence?: Partial<ResourceEvidence>;
  evidence?: EvaluationEvidence;
  termVerification?: TermVerification[];
  now?: number;
  ttlMs?: number;
  privateKeyPem?: string;
  publicKeyPem?: string;
  bootstrapIterations?: number;
}

function assertJsonValue(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`non-canonical number at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (v === undefined) throw new Error(`undefined array member at ${path}[${i}]`);
      assertJsonValue(v, `${path}[${i}]`);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) throw new Error(`undefined property at ${path}.${key}`);
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`unsupported JSON value at ${path}`);
}

/**
 * RFC-8785-compatible for the JSON domain accepted above: ECMAScript primitive
 * serialization plus recursively sorted UTF-16 property names.
 */
export function canonicalizeJcs(value: unknown): string {
  assertJsonValue(value);
  const encode = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    const obj = v as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`).join(',')}}`;
  };
  return encode(value);
}

export function sha256Ref(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function policyCandidateId(policy: Record<string, unknown>): string {
  return sha256Ref(canonicalizeJcs(policy));
}

/** UUIDv7 with a 48-bit millisecond timestamp and RFC-4122 variant bits. */
export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now);
  for (let i = 5; i >= 0; i--) bytes[5 - i] = Number((timestamp >> BigInt(i * 8)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const decimal = (value: number, scale = 12): string => {
  if (!Number.isFinite(value)) throw new Error('metric must be finite');
  const normalized = value.toFixed(scale).replace(/\.?0+$/, '');
  return normalized === '-0' || normalized === '' ? '0' : normalized;
};

function seedFrom(parts: string[]): { seed: number; hex: string } {
  const digest = createHash('sha256').update(parts.join('')).digest();
  return { seed: digest.readUInt32BE(0), hex: digest.toString('hex') };
}

/**
 * Deterministic three-way quickselect. Bootstrap promotion needs one quantile,
 * not a fully sorted distribution; selecting it in expected O(n) removes the
 * O(n log n) sort from every evaluation. Three-way partitioning also keeps the
 * common all-equal bootstrap case linear.
 */
function selectKth(values: number[], k: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left <= right) {
    const pivot = values[(left + right) >>> 1];
    let lower = left;
    let scan = left;
    let upper = right;
    while (scan <= upper) {
      if (values[scan] < pivot) {
        [values[lower], values[scan]] = [values[scan], values[lower]];
        lower++;
        scan++;
      } else if (values[scan] > pivot) {
        [values[scan], values[upper]] = [values[upper], values[scan]];
        upper--;
      } else {
        scan++;
      }
    }
    if (k < lower) right = lower - 1;
    else if (k > upper) left = upper + 1;
    else return values[k];
  }
  return values[k] ?? 0;
}

export function computePromotionStatistics(input: {
  baselineScore: number;
  candidateScore: number;
  heldOutDeltas: number[];
  frozenAnchorRegression: number;
  corpusHash: string;
  candidateId: string;
  baselineRef: string;
  evaluationRunId: string;
  iterations?: number;
  metricEpsilon?: number;
}): PromotionStatistics {
  const iterations = input.iterations ?? 10_000;
  if (!Number.isInteger(iterations) || iterations < 100) throw new Error('bootstrap iterations must be >= 100');
  const n = input.heldOutDeltas.length;
  const metricEpsilon = input.metricEpsilon ?? 1e-12;
  const relativeLift = (input.candidateScore - input.baselineScore) / Math.max(Math.abs(input.baselineScore), metricEpsilon);
  const seeded = seedFrom([
    'ruflo/bootstrap/v1',
    input.corpusHash,
    input.candidateId,
    input.baselineRef,
    input.evaluationRunId,
  ]);
  let state = seeded.seed >>> 0;
  const rnd = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const means = new Array<number>(iterations);
  let positiveMeans = 0;
  if (n === 0) {
    means.fill(0);
  } else {
    for (let b = 0; b < iterations; b++) {
      let total = 0;
      for (let i = 0; i < n; i++) total += input.heldOutDeltas[Math.floor(rnd() * n)];
      const mean = total / n;
      means[b] = mean;
      if (mean > 0) positiveMeans++;
    }
  }
  const probability = positiveMeans / iterations;
  const ciLow = selectKth(means, Math.floor(0.025 * iterations));
  const significant = probability >= 0.95 && ciLow > 0;
  const accepted = relativeLift >= 0.02 && significant && input.frozenAnchorRegression <= 0;
  return {
    ruleVersion: 'ruflo.flywheel-gate/v1',
    relativeLift: decimal(relativeLift),
    pairedBootstrapProbability: decimal(probability),
    pairedBootstrapDeltaCILow95: decimal(ciLow),
    frozenAnchorRegression: decimal(input.frozenAnchorRegression),
    iterations,
    seedHex: seeded.hex,
    significant,
    accepted,
  };
}

function receiptIdentityPayload(payload: Omit<FlywheelReceiptPayload, 'receiptId'>): unknown {
  return payload;
}

function signedBytes(payload: FlywheelReceiptPayload): Buffer {
  return Buffer.concat([
    Buffer.from(RECEIPT_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalizeJcs(payload), 'utf8'),
  ]);
}

export function createFlywheelReceipt(input: CreateReceiptInput): FlywheelEvaluationReceipt {
  const now = input.now ?? Date.now();
  const evaluationRunId = input.evaluationRunId ?? uuidV7(now);
  const lineageId = input.lineageId ?? uuidV7(now);
  const candidateId = policyCandidateId(input.candidatePolicy);
  const statistics = computePromotionStatistics({
    baselineScore: input.baselineScore,
    candidateScore: input.candidateScore,
    heldOutDeltas: input.heldOutDeltas,
    frozenAnchorRegression: input.frozenAnchorRegression,
    corpusHash: input.corpusHash,
    candidateId,
    baselineRef: input.baselineRef,
    evaluationRunId,
    iterations: input.bootstrapIterations,
  });
  const decision = statistics.accepted && Object.values(input.gates).every(Boolean) ? 'accepted' : 'rejected';
  const base = {
    schemaVersion: RECEIPT_SCHEMA,
    lineageId,
    candidateId,
    evaluationRunId,
    baselineRef: input.baselineRef,
    expectedLedgerHead: input.expectedLedgerHead ?? GENESIS_LEDGER_HEAD,
    candidatePolicy: input.candidatePolicy,
    gateVersion: input.gateVersion ?? statistics.ruleVersion,
    policySchemaVersion: input.policySchemaVersion ?? 'ruflo.retrieval-policy/v1',
    safetyEnvelopeRef: input.safetyEnvelopeRef,
    ...(input.anchorRef ? { anchorRef: input.anchorRef } : {}),
    requestedProposer: input.requestedProposer ?? 'local',
    effectiveProposer: input.effectiveProposer ?? 'local',
    ...(input.proposerSubstitution ? { proposerSubstitution: input.proposerSubstitution } : {}),
    corpusVersion: input.corpusVersion,
    corpusHash: input.corpusHash,
    baselineScore: decimal(input.baselineScore),
    candidateScore: decimal(input.candidateScore),
    heldOutDeltas: input.heldOutDeltas.map((v) => decimal(v)),
    ...(input.pairedOutcomes
      ? {
        pairedOutcomes: input.pairedOutcomes.map((o) => ({
          taskId: o.taskId,
          baselineScore: decimal(o.baselineScore),
          candidateScore: decimal(o.candidateScore),
        })),
      }
      : {}),
    statistics,
    gates: input.gates,
    resourceEvidence: {
      p95LatencyMicros: input.resourceEvidence?.p95LatencyMicros ?? 0,
      costMicrosPerTask: input.resourceEvidence?.costMicrosPerTask ?? 0,
      tokensPerTask: input.resourceEvidence?.tokensPerTask ?? 0,
      failureRate: input.resourceEvidence?.failureRate ?? '0',
      evaluationCostMicros: input.resourceEvidence?.evaluationCostMicros ?? 0,
      ...(input.resourceEvidence?.energyMicrojoules === undefined
        ? {}
        : { energyMicrojoules: input.resourceEvidence.energyMicrojoules }),
      currency: input.resourceEvidence?.currency ?? 'USD',
    },
    evidence: input.evidence ?? {
      corpusRoles: {
        selectionTaskIds: [],
        promotionHoldoutTaskIds: [],
        guardTaskIds: [],
      },
      verification: {},
      canary: {},
    },
    termVerification: input.termVerification ?? [],
    decision,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (input.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
  } satisfies Omit<FlywheelReceiptPayload, 'receiptId'>;
  const receiptId = sha256Ref(canonicalizeJcs(receiptIdentityPayload(base)));
  const payload: FlywheelReceiptPayload = { ...base, receiptId };
  const receipt: FlywheelEvaluationReceipt = { payload };
  if (input.privateKeyPem || input.publicKeyPem) {
    if (!input.privateKeyPem || !input.publicKeyPem) throw new Error('both Ed25519 private and public PEM keys are required');
    receipt.signature = {
      algorithm: 'ed25519',
      domain: RECEIPT_DOMAIN,
      publicKeyPem: input.publicKeyPem,
      signatureBase64: edSign(null, signedBytes(payload), input.privateKeyPem).toString('base64'),
    };
  }
  return receipt;
}

export interface ReceiptVerification {
  valid: boolean;
  signed: boolean;
  errors: string[];
}

export function verifyFlywheelReceipt(receipt: FlywheelEvaluationReceipt, trustedPublicKeys?: Set<string>): ReceiptVerification {
  const errors: string[] = [];
  try {
    if (receipt.payload.schemaVersion !== RECEIPT_SCHEMA) errors.push('unsupported receipt schema');
    const { receiptId: _receiptId, ...base } = receipt.payload;
    const expectedId = sha256Ref(canonicalizeJcs(receiptIdentityPayload(base)));
    if (expectedId !== receipt.payload.receiptId) errors.push('receipt content ID mismatch');
    if (policyCandidateId(receipt.payload.candidatePolicy) !== receipt.payload.candidateId) errors.push('candidate content ID mismatch');
    const recomputedStatistics = computePromotionStatistics({
      baselineScore: Number(receipt.payload.baselineScore),
      candidateScore: Number(receipt.payload.candidateScore),
      heldOutDeltas: receipt.payload.heldOutDeltas.map(Number),
      frozenAnchorRegression: Number(receipt.payload.statistics.frozenAnchorRegression),
      corpusHash: receipt.payload.corpusHash,
      candidateId: receipt.payload.candidateId,
      baselineRef: receipt.payload.baselineRef,
      evaluationRunId: receipt.payload.evaluationRunId,
      iterations: receipt.payload.statistics.iterations,
    });
    if (canonicalizeJcs(recomputedStatistics) !== canonicalizeJcs(receipt.payload.statistics)) {
      errors.push('statistical decision does not recompute');
    }
    const recomputedDecision = recomputedStatistics.accepted && Object.values(receipt.payload.gates).every(Boolean)
      ? 'accepted'
      : 'rejected';
    if (receipt.payload.decision !== recomputedDecision) errors.push('receipt decision does not recompute');
    if (receipt.payload.pairedOutcomes) {
      // Paired outcomes must reproduce the aggregate they claim to back.
      // Tolerance covers the decimal(scale 12) round-trip of both scores.
      const paired = receipt.payload.pairedOutcomes.map((o) => ({
        taskId: o.taskId,
        baselineScore: Number(o.baselineScore),
        candidateScore: Number(o.candidateScore),
      }));
      const check = checkPairedOutcomesConsistency(paired, receipt.payload.heldOutDeltas.map(Number), 1e-9);
      if (!check.ok) errors.push(`paired outcomes inconsistent: ${check.reasons.join('; ')}`);
    }
    if (!receipt.signature) {
      errors.push('receipt is unsigned');
    } else {
      if (receipt.signature.algorithm !== 'ed25519' || receipt.signature.domain !== RECEIPT_DOMAIN) {
        errors.push('unsupported signature metadata');
      } else if (trustedPublicKeys && !trustedPublicKeys.has(receipt.signature.publicKeyPem)) {
        errors.push('receipt signer is not trusted');
      } else if (!edVerify(
        null,
        signedBytes(receipt.payload),
        receipt.signature.publicKeyPem,
        Buffer.from(receipt.signature.signatureBase64, 'base64'),
      )) {
        errors.push('receipt signature invalid');
      }
    }
  } catch (error) {
    errors.push(`verification error: ${(error as Error).message}`);
  }
  return { valid: errors.length === 0, signed: !!receipt.signature, errors };
}
