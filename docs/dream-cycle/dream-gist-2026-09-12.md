# Intelligence SOTA Report — 2026-09-12

TL;DR: Tonight's `intelligence` deep-dive found that `LocalReasoningBank.findSimilar()` (`v3/@claude-flow/cli/src/memory/intelligence.ts`) has been silently overwriting every returned pattern's `confidence` (its learned reliability) with the per-query cosine similarity score, instead of exposing the score under the already-declared, already-exported `PatternMatch.similarity` field. This conflation broke `distillLearning()`'s "only distill from high-confidence matches" gate (`match.confidence < 0.5`) — it tested query-similarity, not the pattern's actual reliability, silently inverting its stated intent — and forced `findSimilarPatterns()`'s public API into an unsafe type-cast fallback that made `confidence` and `similarity` numerically identical for every caller. Fixed by having `findSimilar()` preserve the real stored `confidence` and return the cosine score as a distinct `similarity` field, then migrating the one downstream consumer (`memory-bridge.ts`'s search-ranking path) that actually wanted the old query-similarity semantics. Five research roles ran in parallel tonight (2026 self-learning-agent literature, capabilities scan, memory scan, competitor analysis, independent architecture review); this candidate was the architecture reviewer's top finding, selected over five other scored candidates from the deep researcher (see below).

## What's New in 2026

| Finding | Source | Confidence |
|---|---|---|
| ReasoningBank: agent memory should be distilled from both successful *and failed* trajectories via self-judged verdicts — the paper Ruflo's own module is named after | arXiv:2509.25140 (Sep 2025) | A — Ruflo's `distillLearning()` narrows DISTILL to success/partial-only at 3 separate layers, a real drift from this design (see Additional Candidates #4 below) |
| Lodestar: offline-trained LLM routers drift under workload/serving-state shift; a router needs continuous online decay, not just an opt-in decay knob | arXiv:2606.00946 (Jun 2026) | B | 
| EWC done right: poorly-calibrated/wrong-dimensioned Fisher estimates are EWC's main practical failure mode | arXiv:2603.18596 (Mar 2026) | B — directly explains why the (already-known, still-open) `distillLearning()` EWC-gate bug (#3110, unmerged) matters |
| EWC for continual learning cuts forgetting 45.7% relative vs. naive sequential training when correctly wired | arXiv:2512.01890 (Dec 2025) | B |
| Catastrophic forgetting in skill retrieval: synthetic-trajectory fine-tuning improves in-distribution recall but forgets OOD/real data — argues for conservatism in what gets persisted into agent memory | arXiv:2609.10750 (Sep 2026) | B |
| GEPA (ICLR 2026 oral, now `dspy.GEPA`) and ACE (ICLR 2026, Stanford/SambaNova/MSR) ship real reflective/evolutionary optimization loops with explicit anti-overfitting / anti-context-collapse mechanisms — the closest analogs anywhere in this survey to a "catastrophic-forgetting guard" | arXiv:2507.19457, arXiv:2510.04618 | A/B — peer-reviewed, but this session relied on abstracts/summaries rather than full-paper verification for the deeper mechanism claims |
| No mainstream agent framework (LangGraph, Microsoft Agent Framework, CrewAI, OpenAI Agents SDK, Google ADK) ships human-gated evolutionary self-improvement — re-verified today, and the ecosystem arguably regressed: OpenAI is sunsetting Agent Builder/Evals (its no-code auto-prompt-optimization layer) on 2026-11-30, 8 months after launch | Microsoft BUILD 2026 devblog, OpenAI's own 2026-06-03 announcement, cross-checked against 2 independent write-ups | A (dates/GA status), B (deeper mechanism claims) |
| Letta's self-editing memory is the clearest shipped example of an agent updating its own behavior from experience, but its own comparison literature discloses drift/unpredictability with no consolidation mechanism — a genuine open gap, not a quiet solved problem | github.com/letta-ai/letta, Mem0-vs-Letta comparison (2026) | B |

## Ruflo Current Capability

The intelligence pipeline (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE) lives mainly in `v3/@claude-flow/cli/src/memory/intelligence.ts` (`LocalSonaCoordinator` + `LocalReasoningBank`), `v3/@claude-flow/neural/src/{reasoning-bank,pattern-learner,moe-router}.ts`, and `v3/@claude-flow/cli/src/ruvector/{model-router,enhanced-model-router,q-learning-router}.ts`. Four bugs on this surface were found and fixed on prior nights (Thompson-sampling prior decay #3049 merged; EWC-gate wrong-Fisher-dimension #3110 unmerged; `LearningBridge.consolidate()` reward-blindness #3160 unmerged; wrong-tier `modelId` forwarding #3221 merged) — tonight's deep researcher independently re-verified #3110 and #3160 are *still present on `main`* exactly as the ledger states, since both PRs remain open/draft.

Tonight's selected finding is upstream of all of that in the pipeline: `LocalReasoningBank.findSimilar()` (`intelligence.ts:604-638`) is the single RETRIEVE-stage function every JUDGE/DISTILL consumer calls to look up related patterns. Its return-value contract was already correctly specified — `export interface PatternMatch extends Pattern { similarity: number }` (`intelligence.ts:1195-1197`) — but the implementation never honored it: it returned `StoredPattern[]` with `confidence` overwritten by the cosine score, and `findSimilarPatterns()` (the function realizing `PatternMatch[]`) had to paper over the gap with `(r as unknown as { similarity?: number }).similarity ?? r.confidence ?? 0.5`.

## Competitor Comparison

| Framework | Online/adaptive model routing | Continual-learning-from-experience | Forgetting/reward-hacking guards | Grade |
|---|---|---|---|---|
| LangGraph | None shipped — conditional edges route on developer-authored state | None at the policy level — "memory" is a RAG-style store an LLM writes into | N/A | B |
| Microsoft Agent Framework (GA Apr 2026, successor to AutoGen, now maintenance-only) | Azure Foundry Model Router exists as a separate product (classifier-based Cost/Balanced/Quality modes), pluggable but not framework-native and not reward-learned | None in GA; "AF Labs" RL-for-agents access is unshipped/unbenchmarked | N/A | A (GA facts), C (Labs claim) |
| CrewAI | None documented | Weak-positive: adaptive-depth recall blends similarity/recency/importance, still store-and-retrieve, no policy update | N/A | C |
| OpenAI Agents SDK / Agent Builder | None built-in (best-effort LiteLLM/Any-LLM adapters) | Human/tool-gated offline loop only (traces→evals→Codex patches), not autonomous online updating | N/A — and retreating: Agent Builder/Evals sunsets 2026-11-30 | A (sunset dates), B (loop pattern) |
| Google ADK | Context-sensitive handoffs, not cost/quality-learned | Session/long-term memory service only (RAG-style) | N/A | C |
| Letta (non-floor, most relevant shipped system) | N/A | Real: self-editing memory blocks agents rewrite based on what worked | Acknowledged-but-unsolved: drift/unpredictability, no forgetting benchmark | B (capability), C (guard gap) |
| Research frontier: GEPA/DSPy, ACE | N/A (prompt/context-layer optimizers) | Real reflective/evolutionary loops, offline or test-time, not wired into any floor framework by default | Only concrete anti-collapse/anti-overfit mechanisms found in this survey | A/B |

Synthesis: the "no mainstream framework does human-gated evolutionary self-improvement" finding from prior nights still holds and was re-verified with 2026-dated primary sources rather than repeated verbatim. Ruflo's Darwin/Flywheel governance shape remains a genuine differentiator against this landscape — the gap is real, not unpublished, and the field moved backward (OpenAI's sunset) rather than forward this year.

## Hypothesis

> Given `LocalReasoningBank.findSimilar()` (`v3/@claude-flow/cli/src/memory/intelligence.ts:604-638`) returning pattern objects whose `confidence` field is overwritten with the per-query cosine similarity score, when the candidate change stops overwriting `confidence` and instead returns the cosine score as a distinct `similarity` field (satisfying the pre-existing, already-exported `PatternMatch extends Pattern { similarity: number }` contract that `findSimilarPatterns()` was already trying, and failing, to satisfy via an unsafe type-cast fallback), then (a) `distillLearning()`'s "only distill from high-confidence matches" gate (`match.confidence < 0.5`, `intelligence.ts:357`) should correctly test the pattern's learned reliability rather than its similarity to the current trajectory step, and (b) `findSimilarPatterns()`'s public API should return genuinely distinct `confidence`/`similarity` values, relative to baseline where both are conflated, subject to:
> 1. `memory-bridge.ts`'s search-ranking consumer (`bridgeSearchPatterns`, ~line 2189), which reads the match score for relevance ranking, is migrated to prefer the new `similarity` field (falling back to `confidence` defensively) so its ranking behavior isn't silently switched from relevance to reliability;
> 2. `endTrajectory()`'s RL-update consumer (`intelligence.ts:269-289`), which already re-fetches `pattern.confidence` via `bank.get()` rather than reading the match object's field, is unaffected;
> 3. all existing tests remain green;
> 4. fully deterministic, $0 evaluation cost, no LLM calls, verifiable via hash-fallback embeddings.

Frozen before evaluation; not modified after seeing results.

## Benchmarks / Evaluation

**evaluated: accepted.** Real evaluator: Vitest 4.1.8, deterministic (hand-crafted embeddings, no randomness), zero LLM calls, $0 cost. New test file: `v3/@claude-flow/cli/__tests__/intelligence-confidence-similarity-conflation.test.ts` (4 tests).

**Baseline vs. candidate, isolated via `git stash` of just the 2 source files (test file kept):** all 4 new tests fail against baseline for exactly the predicted reason (`expected 1 to be 0.42` — identical-embedding confidence overwritten by cosine 1.0; `expected 0.44998... to be 0.9` — partial-match confidence overwritten by cosine ~0.45; `expected 0.30100000000000005 to be 0.30000000000000004` — the DISTILL gate's inverted-inclusion bug, off by exactly the extra LoRA bump a wrongly-included low-reliability pattern receives; `expected +0 to be 0.85` — the public API's conflated field) and pass on candidate.

**Full `@claude-flow/cli` package suite, run both ways:** baseline 91 failed / 149 passed / 1 skipped (241 files), candidate 90 failed / 150 passed / 1 skipped (241 files) — the *only* difference between the two failed-file sets (`comm` diff) is the new test file itself; all other 90 failing files are identical, pre-existing, environmental failures (unbuilt monorepo sibling packages — e.g. `@claude-flow/neural`/`@claude-flow/memory` module-resolution failures via Vite's import-analysis — unrelated to this diff, matching the documented pattern from #3221/#3243). `tsc --noEmit`: 463 pre-existing errors, byte-identical count and lines both ways (including the one hit inside `memory-bridge.ts` itself, at an unrelated line/module-resolution issue, line 221, far from this diff's changes).

**Independent adversarial critique (STEP 10, separate subagent, no authoring context):** verdict **CONFIRMED**. Independently re-derived the bug from the raw diff, re-ran the discriminating test both ways itself (reproducing 4/4 pass on the fix and 4/4 fail on baseline for the claimed reasons), grepped every `.findSimilar(` call site in `v3/` and confirmed no consumer was missed, verified `endTrajectory()`'s RL-update loop is unaffected (it reads `pattern.confidence` via a separate `bank.get()` call, never the match object's field), and specifically verified the `memory-bridge.ts` fallback chain's `??` (not `||`) correctly handles a legitimate `0` similarity value. One cosmetic-only nit (a doc line-number off by 10, corrected above). No blocking caveats.

## Darwin Results

Skipped — this is a binary correctness/API-contract fix (confidence either reflects reliability or it doesn't), not a continuous/categorical parameter with a fitness gradient for Darwin's real interface (`npx ruvector harness darwin --help`, confirmed available tonight, `@metaharness/darwin@0.9.2`) to search over. Same class as most recent nights (#3110, #3160, #3184, #3221, #3243).

## Flywheel Evidence

No `.claude-flow/flywheel/` state or signed `@metaharness/flywheel` bundle exists in this repo (confirmed via `npx ruvector harness flywheel --help`: real `verify`/`gate` interface exists but targets a replay bundle this deterministic code-correctness fix doesn't produce). Evidence retained as: the 4 new discriminating tests, this gist, the linked issue, the stash-isolated baseline-fails/candidate-passes comparison, and the independent adversarial critique transcript — consistent with every accepted dream-cycle night since 2026-08-18. Classified: OBSERVATION (`confidence: s.score` confirmed via direct code read) / MEASUREMENT (baseline fails all 4 discriminating assertions for the predicted reason, candidate passes all 4, 90/91 pre-existing-failure sets identical) / DECISION (ship as a scoped, additive RETRIEVE-stage fix) / REJECTION (none this round).

## Reward Hack Check

No standalone reward-hack CLI reachable this session (`npx ruvector harness --help` lists `status`/`route`/`flywheel`/`darwin`, no generic diff/benchmark scanner; `@metaharness/weight-eft` is a LoRA-distillation tool, not a diff scanner — consistent with every recent night's own note). Manual checklist, independently re-verified by the adversarial critic: no existing test weakened (new file only); no gold/expected data touched (none exists on this code path); no cherry-picking (full package suite reported both ways, all 90 pre-existing failures disclosed, not hidden); no seed manipulation (hand-crafted deterministic embeddings throughout, no randomness); zero cost (no model calls anywhere in the fix or its tests); the new test's discriminating power is real (confirmed to fail on baseline for the stated mechanism, not a flake).

## Security Review

Not security-sensitive: in-process ranking/confidence bookkeeping inside a local pattern store, no new I/O, network, credential, or filesystem surface. Independently confirmed by the adversarial critic (no `fs`/`http`/`exec`/env changes in the diff). The one behavior-preserving migration (`memory-bridge.ts`'s search-ranking consumer) was specifically checked for a `??` vs `||` footgun on a legitimate `0` similarity value — `??` is correct, `||` would have silently regressed ranking for a genuinely-zero-similarity top match.

## SOTA Proof & Witness

| Field | Value |
|---|---|
| Session commit | `39e0b0540c9b018174955fc8a21f355bbac26c6a` |
| Gist SHA-256 (pre-witness content) | `cb5ee8eff4a9ef7d0123ea74e3d6c30dba3bf0c2922dd1db0235a55ffc633a09` |
| Witness stamp | `cb60b43b6c2130b41626657fc19395214d2ee929e0aff4fd4ee05468cd4bca57` |

Verifier procedure: fetch `docs/dream-cycle/dream-gist-2026-09-12.md` from this branch, strip the witness table's filled values back to `PENDING`, SHA-256 it, concatenate with the session commit above, SHA-256 again — result must equal the witness stamp.

## Scan Findings: capabilities

Ruflo's swarm permission/audit system (`v3/@claude-flow/cli/src/permission/{permission-set,permission-audit}.ts`, wired only from `commands/swarm.ts:489-512` behind opt-in `swarm init --with-permissions`) writes grants and can only ever emit a `'granted'` audit event — `grep` across `v3/` for `event: 'checked'|'denied'|'revoked'` returns zero matches, and nothing reads `.swarm/permissions.jsonl` back to gate a tool call, file path, or network host. The module's own doc comment is candid that it's "a METADATA + AUDIT layer, not a runtime sandbox," but the audit-log shape (4 event kinds) implies a lifecycle 3/4 of which are dead code. Light comparison: the OpenAI Agents SDK's `tool_input_guardrail`/`tool_output_guardrail` decorators run inline in the actual tool-call path (Grade A, official docs) — ahead of Ruflo's declared-but-unenforced schema. Not selected as tonight's candidate (SCAN surface, lighter-weight); flagged as a real capability-system integrity gap for a future `capabilities`-adjacent night.

## Scan Findings: memory

`@claude-flow/memory`'s same-key upsert path is broken across all three store layers: `generateMemoryId()` (`types.ts:694-698`) never produces a deterministic/reused ID, so `AgentDBAdapter.store()` never evicts the prior occupant of a `(namespace,key)` pair (its embedding stays live in the HNSW index forever); `SQLiteBackend`'s schema has no `UNIQUE(namespace,key)` constraint, so repeated writes accumulate duplicate rows outright; and `HybridBackend.getByKey()` is hard-wired to the SQLite path, which has no `ORDER BY`, so it can return the *oldest* stale copy of a key that's been rewritten. `MemoryConsolidator.dedup()` doesn't catch this (it buckets by exact content hash; an updated value has different content by construction). A working precedent already exists in the same repo — `v3/@claude-flow/cli/src/memory/memory-initializer.ts` has a real `UNIQUE(namespace, key)` constraint plus `removeHNSWEntriesByKey()` — that the newer `@claude-flow/memory` package never carried forward. External comparison: Mem0's v3 ADD-only pipeline hits the documented same failure shape (mem0ai/mem0 issues #4956/#5867/#4896, Grade A); Qdrant/Weaviate/Milvus/LanceDB's documented pattern is a deterministic ID derived from the natural key, exactly what `generateMemoryId()` doesn't do. Not selected as tonight's candidate (SCAN surface); a strong candidate for a future `memory` DEEP night, and — per the researcher's own note — key-collision pairs are a free, structurally-labeled positive-pair corpus for the near-dup `similarityThreshold` tuning gap PR #3232 already flagged.

## Competitors Reviewed

LangGraph, Microsoft Agent Framework / AutoGen, CrewAI, OpenAI Agents SDK, Google ADK (mandated floor); Letta, GEPA/DSPy, ACE (specific non-floor comparisons carrying more signal for this exact question); Mem0, Qdrant/Weaviate/Milvus/LanceDB (memory-scan comparison); OpenAI Agents SDK tool guardrails, LangGraph third-party permission middleware (capabilities-scan comparison).

## Additional candidates surfaced but not selected tonight (STEP 3.2)

Scored under `0.25·Ruflo_fit + 0.20·testability + 0.20·measurability + 0.15·production_value + 0.10·novelty + 0.10·reviewability` (1-5 each). Tonight's selected finding (the architecture reviewer's `findSimilar()` confidence/similarity conflation) was not run through this exact rubric by its author but scores 4.85 by the same formula (5/5/5/4/5/5) — highest of all candidates surfaced tonight, so no override was needed. The deep researcher's five scored candidates, for future nights:

1. **[4.55] `priorDecay` distribution-shift fix is built, tested, benchmarked — but never wired to any config/env/default** (`model-router.ts:507-524,1428`). Lodestar (arXiv:2606.00946) argues online routers must decay continuously under distribution shift; Ruflo built the primitive (#3049) and shipped it permanently inert. Tiny patch (~15-20 lines, mirror the existing `envMaxUncertainty()` pattern), low risk (opt-in via env var).
2. **[4.20] MoE router has no explore/exploit toggle** — unlike the sibling `QLearningRouter.route(ctx, explore)`, `MoERouter.route()` always injects Gaussian noise, making `hooks_intelligence_stats`'s "moe" read-only query non-deterministic for identical input (`moe-router.ts:372-442` vs `q-learning-router.ts:343`).
3. **[4.15] `determineEvolutionType()` mislabels neutral/declining pattern evolution as `'improvement'`** — identical bug copy-pasted into `pattern-learner.ts:817-825` and `reasoning-bank.ts:1322-1330`; any delta in `(-0.1, 0.05]` falls through to the default `'improvement'` label.
4. **[3.95] `ReasoningBank.distill()` only ever distills successful/partial trajectories** — `getFailedTrajectories()` exists and `judge()` computes real failure diagnostics, but nothing feeds them back into memory at 3 separate layers, a systemic drift from the ReasoningBank paper (arXiv:2509.25140) this module is named after. Needs a schema decision (a `valence` field?), not a one-line fix — moderate risk, moderate patch size.
5. **[3.60] Cosine-similarity clamping is inconsistent across ~5 duplicate implementations** in the intelligence surface (`reasoning-bank.ts` clamps to `[0,1]`, `pattern-learner.ts`/`modes/base.ts`/`intelligence.ts`/`persistent-sona.ts` don't) — low practical blast radius today (real embeddings rarely produce strongly negative cosine), but the same copy-paste-drift pattern that produced candidate #3.

## Recommended Next Steps

1. **Merge tonight's linked draft PR** (human review required) — a scoped, additive fix restoring the intended `confidence`/`similarity` split in the RETRIEVE stage, with a discriminating test suite.
2. **Wire `priorDecay`** (candidate 1) for a future `intelligence` night — a shipped, tested, benchmarked fix that's currently dead code in every deployment; small patch, clear win.
3. **Merge backlog**: #3110 (EWC-gate wrong Fisher dims) and #3160 (LearningBridge reward-blindness) remain open/draft and unmerged since 08-27/09-02 despite ACCEPT verdicts — both independently re-verified live on `main` tonight.
4. **`findSimilar()`/upsert hardening as a themed future night**: tonight's memory-scan finding (broken same-key upsert across all three store layers) and PR #3232's still-open near-dup-corpus gap are related — the researcher notes key-collision pairs are a free, ground-truth-labeled corpus for both.
5. **Capabilities enforcement gap**: `.swarm/permissions.jsonl` is written but never read back to gate anything — worth a future `capabilities` night to either wire real enforcement or document the module as audit-only, not a security boundary.
