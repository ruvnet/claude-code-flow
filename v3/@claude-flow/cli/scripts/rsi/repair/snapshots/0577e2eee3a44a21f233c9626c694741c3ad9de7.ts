/**
 * Sequential promotion evidence — family-wise error control for an ADAPTIVE
 * candidate stream (report item 2 / upstream @metaharness/flywheel 0.1.10
 * `withSequentialEvidence` interop, implemented in-house so ruflo keeps the
 * property with every MetaHarness package removed).
 *
 * THE GAP THIS CLOSES: every promotion gate ruflo runs (accept/v1+sig, the
 * ruflo.flywheel-gate/v1 bootstrap) spends a FRESH alpha per candidate. A
 * flywheel proposes candidates adaptively — each new candidate is chosen after
 * looking at the last one's scores — so per-candidate alpha does not bound the
 * probability that ANY promotion in the stream is false. Published
 * measurements of greedy accept-if-improved loops put the false-commit rate at
 * 30-42% under exactly this regime.
 *
 * TWO COMPOSED MECHANISMS, both required by the promotion authority:
 *
 * 1. Anytime-valid e-process per candidate (testing-by-betting). Per paired
 *    task, a discordant pair multiplies the e-value by (1+lambda) when the
 *    candidate wins and (1-lambda) when the baseline wins; concordant pairs
 *    carry no information (McNemar). Under the null the e-value is a
 *    non-negative martingale with expectation 1, so by Ville's inequality
 *    P(e ever reaches 1/alpha) <= alpha — no penalty for peeking mid-stream.
 *
 * 2. Alpha allocation ACROSS candidates. Candidate k in the lineage's test
 *    stream must clear 1/alpha_k where alpha_k = alphaTotal * 6/(pi^2 * k^2),
 *    so sum(alpha_k) = alphaTotal for arbitrarily many adaptively-chosen
 *    candidates. The allocation index is persisted per receipt in the
 *    transaction state — looking spends alpha whether or not the candidate
 *    promotes, and retrying the same receipt reuses its index (no double
 *    spend, no index shopping).
 *
 * Family-wise guarantee: P(any false promotion, ever, in the stream)
 * <= sum_k alpha_k = alphaTotal. The acceptance test for this module is the
 * 1,000-null-simulation in flywheel-sequential-evidence.test.ts.
 *
 * Pure, $0, deterministic. Never throws on well-typed input.
 */

export const SEQUENTIAL_EVIDENCE_VERSION = 'ruflo.sequential-evidence/v1';

export const DEFAULT_ALPHA_TOTAL = 0.05;
export const DEFAULT_LAMBDA = 0.5;
/** Score tie-band: |candidate - baseline| <= epsilon is a concordant (uninformative) pair. */
export const DEFAULT_SCORE_EPSILON = 1e-9;

/** Task-level paired outcome — the evidence unit receipts must now carry. */
export interface PairedTaskOutcome {
  taskId: string;
  baselineScore: number;
  candidateScore: number;
}

export interface SequentialEvidenceConfig {
  /** Total family-wise type-I budget across the WHOLE candidate stream. */
  alphaTotal?: number;
  /** Betting fraction in (0,1); 0.5 needs no tuning. */
  lambda?: number;
  /** Tie band on score comparisons. */
  epsilon?: number;
}

export interface SequentialEvidenceVerdict {
  significant: boolean;
  eValue: number;
  threshold: number;        // 1 / alphaAllocated
  alphaAllocated: number;   // this test's share of the family-wise budget
  testIndex: number;        // 1-based position in the lineage's test stream
  informativePairs: number; // discordant pairs — the only ones carrying signal
  totalPairs: number;
  version: typeof SEQUENTIAL_EVIDENCE_VERSION;
}

/**
 * Alpha share for the k-th test in the stream: alphaTotal * 6/(pi^2 k^2).
 * Chosen over 2^-k because it decays polynomially — test 10 still gets a
 * workable ~0.6% of a 5% budget instead of ~0.005%.
 */
export function alphaForTest(testIndex: number, alphaTotal = DEFAULT_ALPHA_TOTAL): number {
  if (!Number.isInteger(testIndex) || testIndex < 1) throw new RangeError('testIndex must be a positive integer');
  if (!(alphaTotal > 0 && alphaTotal < 1)) throw new RangeError('alphaTotal must be in (0, 1)');
  return (alphaTotal * 6) / (Math.PI * Math.PI * testIndex * testIndex);
}

/**
 * Fold paired outcomes into an anytime-valid e-value and judge it against the
 * k-th test's allocated alpha. Deterministic; order of outcomes does not
 * change the final e-value (the product commutes).
 */
export function sequentialEvidenceVerdict(
  outcomes: PairedTaskOutcome[],
  testIndex: number,
  config: SequentialEvidenceConfig = {},
): SequentialEvidenceVerdict {
  const alphaTotal = config.alphaTotal ?? DEFAULT_ALPHA_TOTAL;
  const lambda = config.lambda ?? DEFAULT_LAMBDA;
  const epsilon = config.epsilon ?? DEFAULT_SCORE_EPSILON;
  if (!(lambda > 0 && lambda < 1)) throw new RangeError('lambda must be in (0, 1)');
  const alphaAllocated = alphaForTest(testIndex, alphaTotal);
  const threshold = 1 / alphaAllocated;

  let eValue = 1;
  let informativePairs = 0;
  for (const o of outcomes) {
    const delta = o.candidateScore - o.baselineScore;
    if (Math.abs(delta) <= epsilon) continue; // concordant: no information
    informativePairs++;
    // Under the null a discordant pair favors either arm with probability 1/2,
    // so E[multiplier] = 1 and the running product is a martingale.
    eValue *= delta > 0 ? 1 + lambda : 1 - lambda;
  }

  return {
    significant: eValue >= threshold,
    eValue,
    threshold,
    alphaAllocated,
    testIndex,
    informativePairs,
    totalPairs: outcomes.length,
    version: SEQUENTIAL_EVIDENCE_VERSION,
  };
}

/**
 * Minimum number of INFORMATIVE (discordant) pairs a candidate must win —
 * with zero losses — to clear the k-th test's threshold: the smallest n with
 * (1+lambda)^n >= 1/alpha_k. The pre-flight power check (ADR-381 §4): an
 * evaluation whose promotion holdout is smaller than this cannot promote even
 * on a perfect sweep, so it should be refused BEFORE compute is spent and
 * before a doomed receipt can be presented to the gate (spending alpha).
 */
export function minInformativePairsToClear(testIndex: number, config: SequentialEvidenceConfig = {}): number {
  const alphaTotal = config.alphaTotal ?? DEFAULT_ALPHA_TOTAL;
  const lambda = config.lambda ?? DEFAULT_LAMBDA;
  if (!(lambda > 0 && lambda < 1)) throw new RangeError('lambda must be in (0, 1)');
  const threshold = 1 / alphaForTest(testIndex, alphaTotal);
  return Math.ceil(Math.log(threshold) / Math.log(1 + lambda));
}

/** Family-wise budget left after `testsRun` allocated tests: alphaTotal - Σ alpha_k. */
export function remainingAlphaBudget(testsRun: number, alphaTotal = DEFAULT_ALPHA_TOTAL): number {
  if (!Number.isInteger(testsRun) || testsRun < 0) throw new RangeError('testsRun must be a non-negative integer');
  let spent = 0;
  for (let k = 1; k <= testsRun; k++) spent += alphaForTest(k, alphaTotal);
  return Math.max(0, alphaTotal - spent);
}

export interface PairedEvidenceCheck {
  ok: boolean;
  reasons: string[];
}

/**
 * Structural consistency between a receipt's paired outcomes and its
 * aggregate heldOutDeltas: same length and order, unique non-empty task IDs,
 * and each delta must equal candidateScore - baselineScore. This is what makes
 * paired outcomes EVIDENCE rather than decoration — an aggregate that cannot
 * be reproduced from its own per-task rows is refused.
 */
export function checkPairedOutcomesConsistency(
  pairedOutcomes: PairedTaskOutcome[],
  heldOutDeltas: number[],
  tolerance = 1e-9,
): PairedEvidenceCheck {
  const reasons: string[] = [];
  if (pairedOutcomes.length === 0) reasons.push('pairedOutcomes is empty');
  if (pairedOutcomes.length !== heldOutDeltas.length) {
    reasons.push(`pairedOutcomes length ${pairedOutcomes.length} != heldOutDeltas length ${heldOutDeltas.length}`);
  }
  const ids = new Set<string>();
  for (const [i, o] of pairedOutcomes.entries()) {
    if (!o.taskId || typeof o.taskId !== 'string') reasons.push(`pairedOutcomes[${i}] has an empty taskId`);
    else if (ids.has(o.taskId)) reasons.push(`duplicate taskId '${o.taskId}'`);
    else ids.add(o.taskId);
    if (!Number.isFinite(o.baselineScore) || !Number.isFinite(o.candidateScore)) {
      reasons.push(`pairedOutcomes[${i}] has a non-finite score`);
      continue;
    }
    const delta = heldOutDeltas[i];
    if (delta !== undefined && Math.abs((o.candidateScore - o.baselineScore) - delta) > tolerance) {
      reasons.push(`pairedOutcomes[${i}] delta ${(o.candidateScore - o.baselineScore).toFixed(12)} != heldOutDeltas[${i}] ${delta}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
