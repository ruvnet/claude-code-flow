/**
 * SmartRetrieval — LongMemEval-derived retrieval pipeline (ADR-090)
 *
 * Wraps a raw HNSW `SearchFn` with the optimizations identified by the
 * ADR-088 LongMemEval benchmark:
 *
 *   1. Query expansion (template-based, no LLM)
 *   2. Multi-query fan-out + Reciprocal Rank Fusion
 *   3. Recency boost from metadata timestamps
 *   4. MMR diversity re-ranking (token-Jaccard proxy)
 *   5. Session round-robin for multi-session coverage
 *
 * The module is pluggable: callers provide a `SearchFn` that hits whatever
 * raw store they use (AgentDB HNSW, sql.js, a test fake, etc.). That keeps
 * `@claude-flow/memory` free of a hard dependency on the CLI's memory-initializer
 * and makes the pipeline easy to benchmark in isolation.
 */

// ── Types ──────────────────────────────────────────────────────

export interface SearchCandidate {
  id: string;
  key: string;
  content: string;
  score: number;
  namespace: string;
  /** Optional metadata pulled through from the underlying store. */
  metadata?: Record<string, unknown>;
  /** Optional unix-ms timestamp used by the recency booster. */
  createdAt?: number;
  /** Optional unix-ms timestamp; preferred over createdAt when present. */
  updatedAt?: number;
  /**
   * Optional embedding vector, when the caller's SearchFn has one on hand
   * (e.g. already computed for the primary similarity score). When both
   * candidates in an MMR comparison carry one, `mmrRerank` uses cosine
   * similarity instead of the token-Jaccard proxy — see "MMR Diversity"
   * below. Never forwarded to CLI/MCP JSON responses by this module's
   * callers (they whitelist output fields explicitly).
   */
  embedding?: number[];
}

export interface RawSearchRequest {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
}

export interface RawSearchResponse {
  results: SearchCandidate[];
}

/** Pluggable raw search function — typically wraps HNSW or a test fake. */
export type SearchFn = (req: RawSearchRequest) => Promise<RawSearchResponse>;

export interface SmartSearchOptions {
  query: string;
  namespace?: string;
  /** Final number of results to return (default 10). */
  limit?: number;
  /** Similarity floor applied to the raw store (default 0.3). */
  threshold?: number;

  // ── Phase toggles ──
  /** Fan out 2-3 expanded query variants and fuse with RRF. Default: true. */
  multiQuery?: boolean;
  /** Re-score with recency boost using entry timestamps. Default: true. */
  recencyBoost?: boolean;
  /** Apply MMR diversity re-ranking. Default: true. */
  diversityMMR?: boolean;
  /** Round-robin across distinct session_ids. Default: true. */
  sessionDiversity?: boolean;

  // ── Tunables ──
  /** How many candidates to pull from the raw store per variant (default limit × 3). */
  fanOutK?: number;
  /** RRF constant; 60 is the standard default. */
  rrfK?: number;
  /** Recency half-life in days; older entries decay past this. Default 30. */
  recencyHalfLifeDays?: number;
  /** Max recency multiplier applied to top of the curve. Default 0.2. */
  recencyWeight?: number;
  /** MMR tradeoff λ — 1.0 = pure relevance, 0.0 = pure diversity. Default 0.7. */
  mmrLambda?: number;
  /** Metadata key that identifies a session for round-robin. Default 'session_id'. */
  sessionKey?: string;
  /** "Now" for recency decay — pass a fixed value in tests for determinism. */
  now?: number;

  /** Override the default template-based expansions with your own set. */
  queryExpansions?: (query: string) => string[];
}

export interface SmartSearchStats {
  variantCount: number;
  variants: string[];
  rawCandidateCount: number;
  afterRrfCount: number;
  afterRecencyCount: number;
  afterMmrCount: number;
  afterSessionCount: number;
  durationMs: number;
}

export interface SmartSearchResult {
  results: SearchCandidate[];
  stats: SmartSearchStats;
}

// ── Query Expansion ────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'did', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me',
  'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/**
 * Default query expansion set. Keeps variants cheap (≤3) so we only pay
 * ~3× the HNSW cost on the hot path.
 */
export function defaultQueryExpansions(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const variants = new Set<string>();
  variants.add(trimmed);

  const keywords = keywordExtract(trimmed);
  if (keywords && keywords !== trimmed.toLowerCase()) {
    variants.add(keywords);
  }

  // Context-priming variant — helps when the query is short or imperative.
  const words = trimmed.toLowerCase().replace(/[?.!]+$/, '');
  if (words && !words.startsWith('tell me')) {
    variants.add(`tell me about ${words}`);
  }

  return [...variants];
}

function keywordExtract(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .join(' ');
}

// ── Reciprocal Rank Fusion ─────────────────────────────────────

interface Scored {
  candidate: SearchCandidate;
  score: number;
}

/**
 * Public-facing Reciprocal Rank Fusion. Takes any number of pre-sorted
 * candidate lists (best-first) and fuses them with the RRF score
 * `sum(1 / (k + rank_i))`. Used by the ADR-125 Phase 5 hybridSearch
 * controller to fuse dense + sparse arms.
 */
export function applyRRF<T extends SearchCandidate>(
  rankedLists: T[][],
  k: number = 60
): Array<{ candidate: T; score: number }> {
  return reciprocalRankFusion(rankedLists as any, k) as any;
}

function reciprocalRankFusion(
  rankedLists: SearchCandidate[][],
  k: number
): Scored[] {
  const fused = new Map<string, { candidate: SearchCandidate; score: number }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const cand = list[rank];
      const rrfContribution = 1 / (k + rank + 1);
      const key = candidateKey(cand);
      const existing = fused.get(key);
      if (existing) {
        existing.score += rrfContribution;
        // Keep the highest raw score we've seen for display purposes.
        if (cand.score > existing.candidate.score) {
          existing.candidate = cand;
        }
      } else {
        fused.set(key, { candidate: cand, score: rrfContribution });
      }
    }
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

function candidateKey(cand: SearchCandidate): string {
  // Fall back through id → key → content hash so deduplication is robust
  // even when the raw store omits ids.
  return cand.id || cand.key || cand.content.slice(0, 128);
}

// ── Recency Boost ──────────────────────────────────────────────

function applyRecencyBoost(
  scored: Scored[],
  opts: Required<Pick<SmartSearchOptions, 'recencyHalfLifeDays' | 'recencyWeight'>> & { now: number }
): Scored[] {
  const halfLifeMs = opts.recencyHalfLifeDays * 24 * 60 * 60 * 1000;
  if (halfLifeMs <= 0) return scored;

  return scored
    .map(({ candidate, score }) => {
      const ts = pickTimestamp(candidate);
      if (!ts || !Number.isFinite(ts)) {
        return { candidate, score };
      }
      const ageMs = Math.max(0, opts.now - ts);
      // Exponential decay, normalized to [0,1].
      const recency = Math.pow(0.5, ageMs / halfLifeMs);
      const boosted = score * (1 + opts.recencyWeight * recency);
      return { candidate, score: boosted };
    })
    .sort((a, b) => b.score - a.score);
}

function pickTimestamp(cand: SearchCandidate): number | undefined {
  if (cand.updatedAt && Number.isFinite(cand.updatedAt)) return cand.updatedAt;
  if (cand.createdAt && Number.isFinite(cand.createdAt)) return cand.createdAt;
  const meta = cand.metadata;
  if (meta) {
    const candidates = ['timestamp', 'updatedAt', 'createdAt', 'time', 'ts'];
    for (const k of candidates) {
      const v = meta[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const parsed = Date.parse(v);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return undefined;
}

// ── MMR Diversity (embedding-cosine, token-Jaccard fallback) ───
//
// Dream Cycle 2026-09-03: 2026 production practice (LangChain's reference
// `maximal_marginal_relevance`, Qdrant's native `Mmr` query, Weaviate 1.37's
// MMR reranker) universally computes MMR's "similarity to already-selected"
// term over the embedding space, not lexical overlap — token-Jaccard misses
// low-token-overlap paraphrases that embeddings correctly flag as
// near-duplicates (see e.g. openclaw/openclaw#19760). Ruflo's own retrieval
// pipeline already computes these embeddings upstream; this only threads
// them through to MMR. Falls back to token-Jaccard whenever either
// candidate lacks an embedding (test fakes, or a SearchFn that doesn't
// supply one) or the two embeddings have mismatched dimensions, so existing
// callers/tests that never populate `.embedding` are unaffected.

/**
 * Public-facing MMR rerank.
 *
 * Re-exported as `applyMMR` for ADR-125 Phase 5 callers (the hybridSearch
 * controller). Takes already-scored candidates plus an MMR lambda
 * (1.0 = pure relevance, 0.0 = pure diversity).
 */
export function applyMMR<T extends SearchCandidate>(
  scored: Array<{ candidate: T; score: number }>,
  lambda: number = 0.7,
  limit?: number
): Array<{ candidate: T; score: number }> {
  return mmrRerank(scored as any, lambda, limit ?? scored.length) as any;
}

function mmrRerank(scored: Scored[], lambda: number, limit: number): Scored[] {
  if (scored.length <= 1) return scored.slice(0, limit);

  // Lazy, per-candidate token cache: PR #3169 made embedding-cosine the
  // common `pairSimilarity` path, so eager per-outer-pass tokenization
  // (the prior implementation) mostly computed tokens that were then
  // discarded. Tokens are now computed at most once per candidate, only
  // when the Jaccard fallback actually needs them (Dream Cycle 2026-09-10).
  const tokenCache = new Map<SearchCandidate, Set<string>>();
  const getTokens = (item: Scored): Set<string> => {
    let tokens = tokenCache.get(item.candidate);
    if (!tokens) {
      tokens = tokenize(item.candidate.content);
      tokenCache.set(item.candidate, tokens);
    }
    return tokens;
  };

  const selected: Scored[] = [];
  const remaining = [...scored];
  const selectedEmbeddings: Array<number[] | undefined> = [];

  // Seed with the top-scored candidate.
  const first = remaining.shift()!;
  selected.push(first);
  selectedEmbeddings.push(first.candidate.embedding);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const candEmbedding = cand.candidate.embedding;
      let maxOverlap = 0;
      for (let j = 0; j < selected.length; j++) {
        const sim = pairSimilarity(candEmbedding, selectedEmbeddings[j], cand, selected[j], getTokens);
        if (sim > maxOverlap) maxOverlap = sim;
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxOverlap;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;
    const [chosen] = remaining.splice(bestIdx, 1);
    selected.push(chosen);
    selectedEmbeddings.push(chosen.candidate.embedding);
  }

  return selected;
}

/** Cosine similarity when both embeddings exist, agree in dimension, and are well-formed; token-Jaccard (computed lazily via `getTokens`) otherwise. */
function pairSimilarity(
  embA: number[] | undefined,
  embB: number[] | undefined,
  a: Scored,
  b: Scored,
  getTokens: (item: Scored) => Set<string>
): number {
  if (
    isWellFormedEmbedding(embA) &&
    isWellFormedEmbedding(embB) &&
    embA.length === embB.length
  ) {
    return cosineSimilarity(embA, embB);
  }
  return jaccard(getTokens(a), getTokens(b));
}

/**
 * Guards against malformed embeddings (NaN/Infinity components, empty
 * arrays, non-arrays) reaching `cosineSimilarity`, where a single NaN/
 * Infinity would poison the dot product and silently corrupt every
 * downstream MMR comparison for the rest of the rerank — falls back to
 * `jaccard` instead, same as a missing/dimension-mismatched embedding.
 */
function isWellFormedEmbedding(emb: number[] | undefined): emb is number[] {
  return (
    Array.isArray(emb) &&
    emb.length > 0 &&
    emb.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Exported (this package's `exports` map is a `"./*"` wildcard, so this is
 * real public API, not just test access) so the mmrRerank tokenize-call-
 * count regression test can spy on it (Dream Cycle 2026-09-10). Pure and
 * side-effect-free, so widening its visibility carries no behavioral risk.
 */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// ── Session Round-Robin ────────────────────────────────────────

function sessionRoundRobin(
  scored: Scored[],
  sessionKey: string,
  limit: number
): Scored[] {
  if (scored.length === 0) return scored;

  const bySession = new Map<string, Scored[]>();
  for (const item of scored) {
    const sid = getSessionId(item.candidate, sessionKey) ?? '__no_session__';
    const bucket = bySession.get(sid);
    if (bucket) bucket.push(item);
    else bySession.set(sid, [item]);
  }

  // If every candidate falls in the same bucket we can't diversify — pass through.
  if (bySession.size <= 1) return scored.slice(0, limit);

  // Round-robin across session buckets, preferring each bucket's highest score.
  const buckets = [...bySession.values()].map((b) =>
    [...b].sort((a, b) => b.score - a.score)
  );
  const interleaved: Scored[] = [];
  const seen = new Set<string>();

  while (interleaved.length < limit) {
    let progressed = false;
    for (const bucket of buckets) {
      while (bucket.length > 0) {
        const next = bucket.shift()!;
        const key = candidateKey(next.candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        interleaved.push(next);
        progressed = true;
        break;
      }
      if (interleaved.length >= limit) break;
    }
    if (!progressed) break;
  }

  return interleaved;
}

function getSessionId(cand: SearchCandidate, key: string): string | undefined {
  const meta = cand.metadata;
  if (!meta) return undefined;
  const v = meta[key];
  return typeof v === 'string' ? v : undefined;
}

// ── Public API ─────────────────────────────────────────────────

export async function smartSearch(
  search: SearchFn,
  opts: SmartSearchOptions
): Promise<SmartSearchResult> {
  const start = Date.now();
  const limit = opts.limit ?? 10;
  const threshold = opts.threshold ?? 0.3;
  const fanOutK = opts.fanOutK ?? Math.max(limit * 3, 20);
  const rrfK = opts.rrfK ?? 60;
  const recencyHalfLifeDays = opts.recencyHalfLifeDays ?? 30;
  const recencyWeight = opts.recencyWeight ?? 0.2;
  const mmrLambda = opts.mmrLambda ?? 0.7;
  const sessionKey = opts.sessionKey ?? 'session_id';
  const now = opts.now ?? Date.now();

  const multiQuery = opts.multiQuery !== false;
  const recencyBoost = opts.recencyBoost !== false;
  const diversityMMR = opts.diversityMMR !== false;
  const sessionDiversity = opts.sessionDiversity !== false;

  const expander = opts.queryExpansions ?? defaultQueryExpansions;

  // ── Phase 1: query expansion + fan-out ──
  const variants = multiQuery ? expander(opts.query) : [opts.query];
  if (variants.length === 0) variants.push(opts.query);

  const ranked: SearchCandidate[][] = [];
  let totalRaw = 0;
  for (const v of variants) {
    const resp = await search({
      query: v,
      namespace: opts.namespace,
      limit: fanOutK,
      threshold,
    });
    ranked.push(resp.results);
    totalRaw += resp.results.length;
  }

  // ── Phase 2: RRF fusion ──
  let scored: Scored[] =
    ranked.length === 1
      ? ranked[0].map((c) => ({ candidate: c, score: c.score }))
      : reciprocalRankFusion(ranked, rrfK);

  const afterRrfCount = scored.length;

  // ── Phase 3: recency boost ──
  if (recencyBoost) {
    scored = applyRecencyBoost(scored, { recencyHalfLifeDays, recencyWeight, now });
  }
  const afterRecencyCount = scored.length;

  // Truncate before MMR so we don't re-rank thousands of items.
  if (scored.length > fanOutK) scored = scored.slice(0, fanOutK);

  // ── Phase 4: MMR diversity ──
  if (diversityMMR) {
    scored = mmrRerank(scored, mmrLambda, Math.min(limit * 2, scored.length));
  } else {
    scored = scored.slice(0, Math.min(limit * 2, scored.length));
  }
  const afterMmrCount = scored.length;

  // ── Phase 5: session round-robin ──
  let final: Scored[] = scored;
  if (sessionDiversity) {
    final = sessionRoundRobin(scored, sessionKey, limit);
  } else {
    final = scored.slice(0, limit);
  }
  const afterSessionCount = final.length;

  return {
    results: final.slice(0, limit).map(({ candidate, score }) => ({
      ...candidate,
      score,
    })),
    stats: {
      variantCount: variants.length,
      variants,
      rawCandidateCount: totalRaw,
      afterRrfCount,
      afterRecencyCount,
      afterMmrCount,
      afterSessionCount,
      durationMs: Date.now() - start,
    },
  };
}
