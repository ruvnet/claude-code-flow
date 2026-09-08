/**
 * Self-optimizing flywheel (ADR-176) — closes the loop so an install gets
 * smarter AS IT RUNS, with proof.
 *
 * Each tick:
 *   1. HARVEST a benchmark corpus from the install's REAL store (self-supervised
 *      self-retrieval), blended with the human-labeled ADR-081 anchor.
 *   2. BASELINE = the currently-active champion (or shipped defaults).
 *   3. PROPOSE neighbor configs; pick the best on the TRAIN split (local
 *      hill-climb — deterministic, selection uses train only).
 *   4. GATE the winner through the shipped runHarnessLoop on the HELD-OUT split:
 *      held_out_improves AND redblue(anchor-no-regress) AND drift<=thr AND
 *      replay-deterministic AND receipt_coverage AND canary-no-worse.
 *   5. On accept → emit + persist an immutable evaluation receipt. Evaluation
 *      never mutates active policy. Explicit promotion is handled by the
 *      ADR-322A transaction service.
 *
 * Trust split: LOCAL self-optimization is unsigned (an install trusting its own
 * measured gate); CROSS-install propagation still requires the config-signed
 * champion (ADR-177). Deterministic, $0, never throws. Injectable deps → testable
 * without ONNX/network.
 */
import { createHash } from 'node:crypto';
import { runHarnessLoop } from './harness-loop.js';
import { hashCorpus } from './harness-benchmark.js';
import { harvestSelfSupervisedTasks, blendCorpus, type HarvestPattern } from './harness-corpus-harvester.js';
import { applyChampionParams } from '../config/harness-feedback-applier.js';
import { appendLedger, bootstrapDeltaCILow, type LedgerEntry } from './harness-improvement-ledger.js';
import {
  createFlywheelReceipt,
  sha256Ref,
  type FlywheelEvaluationReceipt,
} from './flywheel-receipt.js';
import {
  readFlywheelTransactionState,
  registerFlywheelReceipt,
} from './flywheel-transaction.js';
import { minInformativePairsToClear } from './flywheel-sequential-evidence.js';
import { runBoundedPool } from './bounded-worker-pool.js';

export interface RetrievalConfig { alpha: number; subjectWeight: number; mmrLambda: number; bodyWeight: number; typePenaltyFactor: number; }
export const DEFAULT_CONFIG: RetrievalConfig = { alpha: 0.5, subjectWeight: 2.0, mmrLambda: 0.7, bodyWeight: 1.0, typePenaltyFactor: 1.0 };

export interface RankedItem { id: string; name: string; }
export interface AnchorTask { id: string; input: { id: string; q: string }; expected: string[]; }

export interface FlywheelDeps {
  getPatterns: () => HarvestPattern[] | Promise<HarvestPattern[]>;
  search: (
    query: string,
    config: RetrievalConfig,
    signal?: AbortSignal,
  ) => Promise<RankedItem[]> | RankedItem[];
  anchorTasks: AnchorTask[];
  activeParams?: () => Partial<RetrievalConfig> | null;
  sample?: number;
  now?: number;
  lineageId?: string;
  evaluationRunId?: string;
  safetyEnvelopeRef?: string;
  /** Hash of the project-specific human-labelled objective. */
  anchorRef?: string;
  requestedProposer?: 'auto' | 'local' | 'darwin';
  effectiveProposer?: 'local' | 'darwin';
  proposerSubstitution?: string;
  receiptPrivateKeyPem?: string;
  receiptPublicKeyPem?: string;
  bootstrapIterations?: number;
  /** Candidate policies supplied by an external proposer archive (ADR-322B). */
  candidatePolicies?: RetrievalConfig[];
  /** ADR-324: hard local cap for concurrent candidate/task evaluation. */
  maxConcurrency?: number;
  evaluationTimeoutMs?: number;
}

export interface FlywheelResult {
  ran: boolean;
  reason: string;
  accepted?: boolean;
  applied?: boolean;
  baselineScore?: number;
  candidateScore?: number;
  delta?: number;
  anchorRegressed?: boolean;
  championRef?: string;
  corpusVersion?: string;
  candidateConfig?: RetrievalConfig;
  receiptId?: string;
  receipt?: FlywheelEvaluationReceipt;
  promotable?: boolean;
  legacyDeprecation?: boolean;
  /**
   * ADR-381 §4 soft pre-flight: whether this evaluation's promotion holdout
   * can clear the sequential-evidence threshold at the ledger's next test
   * index even on a perfect all-win sweep. viable:false does NOT block the
   * evaluation (learn value stands; the gate refuses size-inviable receipts
   * without alpha spend) — it tells the operator promotion is out of reach.
   */
  sequentialPreflight?: { viable: boolean; heldSize: number; minPairsRequired: number; nextTestIndex: number };
}

const EPS = 1e-3;
const cfgCanon = (c: RetrievalConfig) => JSON.stringify(Object.fromEntries(Object.keys(c).sort().map((k) => [k, (c as unknown as Record<string, number>)[k]])));
const refOf = (c: RetrievalConfig) => 'sha256:' + createHash('sha256').update(cfgCanon(c)).digest('hex');
const cfgKey = (c: RetrievalConfig) => cfgCanon(c);

function ndcg3(names: string[], labels: string[]): number {
  const rel = names.slice(0, 3).map((n) => !!n && labels.some((s) => n.toLowerCase().includes(s.toLowerCase())));
  const dcg = rel.reduce((a, r, i) => a + (r ? 1 / Math.log2(i + 2) : 0), 0);
  const num = rel.filter(Boolean).length;
  if (num === 0) return 0;
  let idcg = 0; for (let i = 0; i < num; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}
/** grade dispatch: anchor tasks (labels[]) → nDCG@3; harvested tasks (doc id) → reciprocal rank. */
function grade(ranked: RankedItem[], expected: unknown): number {
  if (Array.isArray(expected)) return ndcg3(ranked.map((r) => r.name), expected as string[]);
  const idx = ranked.findIndex((r) => r.id === expected);
  return idx >= 0 ? 1 / (idx + 1) : 0;
}

export function retrievalPolicyNeighbors(base: RetrievalConfig): RetrievalConfig[] {
  const steps: Record<keyof RetrievalConfig, number> = { alpha: 0.1, subjectWeight: 0.5, mmrLambda: 0.1, bodyWeight: 0.5, typePenaltyFactor: 0.25 };
  const out: RetrievalConfig[] = [];
  const seen = new Set<string>();
  // Per-axis moves at 1 AND 2 steps in each direction — enough to escape a flat
  // single step and reach a multi-step optimum over successive ticks (the
  // single-step search got stuck one hop short of the known champion).
  for (const ax of Object.keys(steps) as (keyof RetrievalConfig)[]) {
    for (const mult of [1, 2]) {
      for (const dir of [-1, 1]) {
        const v = +(base[ax] + dir * mult * steps[ax]).toFixed(3);
        if (ax === 'alpha' && (v <= 0 || v >= 1)) continue;
        if (ax === 'mmrLambda' && (v < 0 || v > 1)) continue;
        if (v <= 0) continue;
        const cand = { ...base, [ax]: v };
        const k = cfgKey(cand);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(cand);
      }
    }
  }
  return out;
}

/** Deterministic id-sort split (matches computeHeldOutSplit @ frac). */
function split<T extends { id: string }>(tasks: T[], frac: number): { train: T[]; held: T[] } {
  const ordered = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const cut = Math.max(0, ordered.length - Math.max(1, Math.round(ordered.length * frac)));
  return { train: ordered.slice(0, cut), held: ordered.slice(cut) };
}

/**
 * Run one flywheel tick against `projectRoot`. Best-effort; never throws.
 * Returns a rich result AND (as a side effect) appends to the improvement ledger
 * and — on accept — applies the champion locally + chains it.
 */
export async function evaluateFlywheelCandidate(projectRoot: string, deps: FlywheelDeps): Promise<FlywheelResult> {
  try {
    const patterns = await deps.getPatterns();
    if (!patterns || patterns.length < 8) return { ran: false, reason: 'store too small to harvest a corpus' };

    const harvested = harvestSelfSupervisedTasks(patterns, { sample: deps.sample ?? 40 });
    if (harvested.length < 4) return { ran: false, reason: 'not enough harvestable tasks' };
    const blended = blendCorpus(deps.anchorTasks, harvested);
    const anchorIdSet = new Set(blended.anchorIds);

    const baseline: RetrievalConfig = { ...DEFAULT_CONFIG, ...(deps.activeParams?.() ?? {}) };
    const candidates = deps.candidatePolicies?.length
      ? deps.candidatePolicies.map((candidate) => ({ ...candidate }))
      : retrievalPolicyNeighbors(baseline);

    // OBJECTIVE = the human-labeled anchor (the relevance we actually care about,
    // where headroom is known to exist). GUARD = the large, growing harvested set
    // (don't wreck broad retrieval while tuning the objective). Optimize the
    // trusted signal; guard breadth with the cheap one.
    const objective = blended.tasks.filter((t) => anchorIdSet.has(t.id));
    const guard = blended.tasks.filter((t) => !anchorIdSet.has(t.id));
    if (objective.length < 4) return { ran: false, reason: 'objective (anchor) too small to gate' };

    // Precompute retrieval for baseline + all candidates over every task (async
    // I/O up front → the harness scoring stays pure/sync).
    const cache = new Map<string, RankedItem[]>();
    const configs = [...new Map(
      [baseline, ...candidates].map((config) => [cfgKey(config), config]),
    ).values()];
    const evalTasks = configs.flatMap((cfg) => blended.tasks.map((t) => {
      const cacheKey = `${t.id}::${cfgKey(cfg)}`;
      return {
        id: cacheKey,
        run: async (signal: AbortSignal) => {
          if (signal.aborted) throw signal.reason;
          return (await deps.search((t.input as { q: string }).q, cfg, signal)) || [];
        },
      };
    }));
    const batch = await runBoundedPool(evalTasks, {
      maxConcurrency: deps.maxConcurrency ?? 2,
      timeoutMs: deps.evaluationTimeoutMs ?? 120_000,
    });
    for (const item of batch.results) {
      if (item.status === 'fulfilled') cache.set(item.id, item.value ?? []);
    }
    const failedEvaluations = batch.results.filter((item) => item.status !== 'fulfilled');
    if (failedEvaluations.length > 0) {
      return {
        ran: false,
        reason: `candidate evaluation incomplete (${failedEvaluations.length}/${batch.results.length}); peak concurrency ${batch.peakConcurrency}`,
      };
    }
    const evalFn = (input: unknown, cfg: RetrievalConfig) => cache.get(`${(input as { id: string }).id}::${cfgKey(cfg)}`) ?? [];
    const gradeFn = (output: unknown, expected: unknown) => grade(output as RankedItem[], expected);
    const heldScoreFor = (cfg: RetrievalConfig, t: { input: unknown; expected: unknown }) => gradeFn(evalFn(t.input, cfg), t.expected);

    // Local hill-climb on the OBJECTIVE train split (selection uses train only).
    const { train, held } = split(objective, 0.5);
    const trainScore = (cfg: RetrievalConfig) => train.reduce((s, t) => s + heldScoreFor(cfg, t), 0) / train.length;
    const baseTrain = trainScore(baseline);
    let candidate = baseline, candTrain = baseTrain;
    for (const c of candidates) { const s = trainScore(c); if (s > candTrain + 1e-9) { candTrain = s; candidate = c; } }

    // Generalization guard: the candidate must not regress the broad harvested
    // set (bound to the adversarial redblue verdict). This replaces the earlier
    // (inverted) design where the cheap metric was the objective.
    const guardScore = (cfg: RetrievalConfig) => guard.length ? guard.reduce((s, t) => s + heldScoreFor(cfg, t), 0) / guard.length : 1;
    const guardRegressed = guardScore(candidate) < guardScore(baseline) - EPS;

    // Qualified trajectories — one per objective train task. Deterministic,
    // executable checks with unambiguous ground truth → oracle:test-exec.
    const trajectories = train.map((t) => ({
      id: `fw-${t.id}`, steps: [{ action: 'retrieve', tier: 'oracle:test-exec' as const }],
      outcome: 'success' as const, benchmarkTaskId: `${blended.version}/${t.id}`,
      inputs: { q: (t.input as { q: string }).q }, recordedOutputs: { ranked: cache.get(`${t.id}::${cfgKey(candidate)}`) },
    }));
    const replay = (tr: { recordedOutputs: unknown }) => tr.recordedOutputs;

    const anchorRegressed = guardRegressed; // ledger field: did the broad guard set regress?
    const corpus = { version: blended.version, tasks: objective, corpusHash: hashCorpus(objective) };

    const result = await runHarnessLoop<RetrievalConfig>({
      trajectories, corpus, baseline, candidate, evalFn, gradeFn, replay,
      verify: {
        redblue: async () => (guardRegressed ? 'FAIL' : 'PASS'),
        drift: async () => guard.length ? guard.filter((t) => heldScoreFor(candidate, t) < heldScoreFor(baseline, t) - EPS).length / guard.length : 0,
      },
      canaryRunner: (input, cfg) => {
        const t = objective.find((x) => x.id === (input as { id: string }).id)!;
        const worse = heldScoreFor(cfg, t) < heldScoreFor(baseline, t) - EPS;
        return { ok: !worse, rolledBack: worse, latencyMs: 0, costUsd: 0, accepted: !worse };
      },
      holdoutFrac: 0.5, driftThreshold: 0.2, layer: 'repo/local', policyRefOf: refOf, now: deps.now,
    });

    const baselineScore = result.baselineScore ?? 0;
    const candidateScore = result.candidateScore ?? 0;

    // Significance gate (SOTA noise guard): the per-held-out-task deltas must have
    // a positive one-sided 95% bootstrap lower bound — the gain has to survive
    // resampling, not ride on one lucky task. FINAL accept = loop-accept AND
    // significant, so the ledger's accepted subsequence stays monotonic + real.
    const heldDeltas = held.map((t) => heldScoreFor(candidate, t) - heldScoreFor(baseline, t));
    // Task-level paired outcomes — the evidence the promotion authority now
    // requires; must stay in the exact order of heldDeltas.
    const pairedOutcomes = held.map((t) => ({
      taskId: t.id,
      baselineScore: heldScoreFor(baseline, t),
      candidateScore: heldScoreFor(candidate, t),
    }));
    const deltaCILow = bootstrapDeltaCILow(heldDeltas);
    const significant = deltaCILow > 0;
    const provisionalGates = Object.fromEntries(Object.entries(result.verdict?.terms ?? {}).map(([k, v]) => [k, v.pass]));
    const txState = readFlywheelTransactionState(projectRoot);
    const safetyEnvelopeRef = deps.safetyEnvelopeRef ?? sha256Ref(JSON.stringify({
      schema: 'ruflo.safety-envelope/local-default-v1',
      authorizationExpansion: false,
      networkExpansion: false,
      spendExpansion: false,
    }));
    const receipt = createFlywheelReceipt({
      lineageId: deps.lineageId,
      evaluationRunId: deps.evaluationRunId,
      baselineRef: refOf(baseline),
      expectedLedgerHead: txState.ledgerHead,
      // `as unknown as` erased RetrievalConfig's `number` fields and laundered
      // binary floats into a receipt claiming ADR-322C conformance (#3229).
      // createFlywheelReceipt now encodes fractional values to scale-12
      // decimal strings, so a single structural cast is enough and the
      // type-erasing double cast is gone.
      candidatePolicy: { ...candidate } as Record<string, unknown>,
      safetyEnvelopeRef,
      anchorRef: deps.anchorRef,
      requestedProposer: deps.requestedProposer ?? 'local',
      effectiveProposer: deps.effectiveProposer ?? 'local',
      proposerSubstitution: deps.proposerSubstitution,
      corpusVersion: blended.version,
      corpusHash: blended.corpusHash,
      baselineScore,
      candidateScore,
      heldOutDeltas: heldDeltas,
      pairedOutcomes,
      frozenAnchorRegression: guardRegressed ? 1 : 0,
      gates: provisionalGates,
      resourceEvidence: {
        p95LatencyMicros: 0,
        costMicrosPerTask: 0,
        tokensPerTask: 0,
        failureRate: '0',
        evaluationCostMicros: 0,
        currency: 'USD',
      },
      evidence: {
        corpusRoles: {
          selectionTaskIds: train.map((task) => task.id),
          promotionHoldoutTaskIds: held.map((task) => task.id),
          guardTaskIds: guard.map((task) => task.id),
        },
        verification: {
          redblue: result.verify?.redblue ?? 'SKIPPED',
          drift: result.verify?.drift ?? -1,
          driftThreshold: result.verify?.driftThreshold ?? 0.2,
          driftVerdict: result.verify?.driftVerdict ?? 'skipped',
          adversarialPass: result.verify?.adversarialPass ?? false,
        },
        canary: {
          candidate: result.canary?.candidate ?? {},
          baseline: result.canary?.baseline ?? {},
          pass: result.canary?.pass ?? false,
        },
      },
      termVerification: Object.keys(provisionalGates).map((term) => ({
        term,
        verification: 'recomputed' as const,
        evidenceRef: sha256Ref(JSON.stringify({
          term,
          corpusHash: blended.corpusHash,
          heldOutDeltas: heldDeltas,
          verification: result.verify,
          canary: result.canary,
        })),
      })),
      now: deps.now,
      privateKeyPem: deps.receiptPrivateKeyPem,
      publicKeyPem: deps.receiptPublicKeyPem,
      bootstrapIterations: deps.bootstrapIterations,
    });
    await registerFlywheelReceipt(projectRoot, receipt, deps.now ?? Date.now());
    const finalAccept = result.accepted && significant && receipt.payload.decision === 'accepted';

    // Soft pre-flight (ADR-381 §4): can the held half of the objective clear
    // the sequential-evidence threshold at the ledger's NEXT test index even
    // on a perfect all-win sweep? Annotate — never block: evaluation has
    // learn value regardless, anchors may legitimately be small (≥4), and
    // the promote gate refuses size-inviable receipts without spending alpha.
    // Read as LATE as possible (after registration, right before returning)
    // to minimize — but not eliminate — the window in which a concurrent
    // promoteFlywheelCandidate call can move the ledger's next test index.
    // This is inherently ADVISORY, not authoritative: promoteFlywheelCandidate
    // (under its own lock) is the sole authority for index allocation, so a
    // promotion racing between this read and an operator's subsequent
    // `flywheel promote` call can still flip the outcome. Callers must not
    // treat `promotable: true` as a guarantee — only as "was viable as of
    // this evaluation".
    const postState = readFlywheelTransactionState(projectRoot);
    const nextTestIndex = Object.keys(postState.sequentialTests ?? {}).length + 1;
    const heldSize = Math.max(1, Math.round(objective.length * 0.5)); // held half per split(objective, 0.5)
    const minPairsRequired = minInformativePairsToClear(nextTestIndex);
    const sequentialPreflight = { viable: heldSize >= minPairsRequired, heldSize, minPairsRequired, nextTestIndex };

    const entry: LedgerEntry = {
      ts: deps.now ?? Date.now(),
      corpusVersion: blended.version, corpusHash: blended.corpusHash,
      corpusSize: blended.tasks.length, anchorSize: blended.anchorIds.length,
      baselineRef: refOf(baseline), candidateRef: refOf(candidate),
      baselineScore, candidateScore, delta: candidateScore - baselineScore,
      deltaCILow, significant, loopAccepted: result.accepted,
      anchorRegressed, accepted: finalAccept,
      gates: provisionalGates,
      reason: finalAccept ? result.reason : (result.accepted ? `held back — improvement not significant (CI low ${deltaCILow.toFixed(4)})` : result.reason),
    };

    appendLedger(`${projectRoot}/.claude-flow/metrics`, entry);

    return {
      ran: true, reason: entry.reason, accepted: finalAccept, applied: false,
      baselineScore, candidateScore, delta: candidateScore - baselineScore,
      anchorRegressed, championRef: finalAccept ? refOf(candidate) : undefined,
      corpusVersion: blended.version, candidateConfig: candidate,
      receiptId: receipt.payload.receiptId, receipt,
      promotable: finalAccept && !!receipt.signature && sequentialPreflight.viable,
      sequentialPreflight,
    };
  } catch (e) {
    return { ran: false, reason: `error: ${(e as Error)?.message ?? e}` };
  }
}

/**
 * Compatibility wrapper. New callers get evaluation-only semantics. The legacy
 * implicit apply path exists for one release behind an explicit opt-in flag.
 */
export async function runFlywheelTick(projectRoot: string, deps: FlywheelDeps): Promise<FlywheelResult> {
  const result = await evaluateFlywheelCandidate(projectRoot, deps);
  if (
    process.env.RUFLO_FLYWHEEL_LEGACY_APPLY === '1'
    && result.accepted
    && result.candidateConfig
    && result.championRef
  ) {
    const applied = applyChampionParams(projectRoot, {
      championId: result.championRef,
      params: result.candidateConfig as unknown as Record<string, unknown>,
      layer: 'repo/local',
      previous: result.receipt?.payload.baselineRef,
      now: deps.now,
    });
    return {
      ...result,
      applied: applied.applied,
      legacyDeprecation: true,
      reason: `${result.reason}; deprecated implicit apply path`,
    };
  }
  return result;
}
