# Dream Cycle Ledger

Durable cross-night memory for the Ruflo Nightly Dream Cycle routine
(`trig_01HpEqAcEP7wzrxy3TzakrQ2`, `.github`-external, runs 06:00 UTC daily).
Read at the start of every run (STEP 1 of the v2 prompt) before the agent
touches `gh` at all — a fresh cloud checkout otherwise has zero memory of
prior nights beyond a `gh issue list` grep.

**Why this file exists**: the v1 routine (2026-05-25 through 2026-08-13)
filed 80 nightly research issues with no durable follow-through signal —
each night only checked whether it was repeating itself, never whether
anyone had acted on what it proposed. Backfilled from the full issue
history below: **4 shipped (5%), 1 rejected, 75 (94%) never touched**, some
over 2.5 months stale. The v2 prompt uses this table to bias toward
attempting a real Flywheel evaluation (STEP 3.5) over another docs-only
proposal when the merge rate over the trailing 14 nights is 0.

## Backfill (one-time, computed 2026-08-13T14:xx UTC from `gh issue list`)

`PR`, `Evaluated?`, and `Verdict` are placeholders for this backfill batch —
those columns didn't exist before v2 and weren't tracked live. `Fate` for
these rows reflects issue state only (MERGED = issue closed as completed,
CLOSED = closed not-planned/duplicate, STALE = open >14 days as of the
backfill date, OPEN = open ≤14 days). From v2 onward, each row is written
live by STEP 9 of the same night it was researched, and `Fate` in the last
column of a LATER row reflects what STEP 1 found when it re-checked EARLIER
rows — not a static snapshot.

| Date | Deep | Finding (one line) | Issue | PR | Evaluated? | Verdict | Prior-night fates recorded this run |
|---|---|---|---|---|---|---|---|
| 2026-05-26 | security | Indirect prompt injection critical gap vs OWASP ASI01 + inte | #2149 | - | backfill | n/a | STALE |
| 2026-05-27 | intelligence | SR²AM 8B=120–355B via simulative planning — 95% token gap +  | #2156 | - | backfill | n/a | STALE |
| 2026-05-29 | swarm | SWARM+ hierarchical PBFT 97-98% latency gain at 1K agents +  | #2223 | - | backfill | n/a | STALE |
| 2026-05-30 | performance | MV-HNSW 14× gap + LAMaS 38-46% latency + security,hive-mind  | #2241 | - | backfill | n/a | STALE |
| 2026-05-31 | security | MCP auth gap (40.55% no-auth) + AIRGuard −85% + authorizatio | #2248 | - | backfill | n/a | STALE |
| 2026-06-01 | security | SCH plugin supply-chain 77.67% breach + 0% detection; ADR-14 | #2254 | - | backfill | n/a | STALE |
| 2026-06-02 | intelligence | SONA behavioral drift undetected — embedding-space trait aud | #2265 | - | backfill | n/a | STALE |
| 2026-06-03 | memory | VikingMem +30% temporal compression gap in AgentDB + plugins | #2277 | - | backfill | n/a | STALE |
| 2026-06-04 | swarm | AdaptOrch +22.9% topology gain gap — Ruflo fixed-hierarchica | #2289 | - | backfill | n/a | STALE |
| 2026-06-05 | performance | LAMaS 38-46% critical-path gap — Ruflo fixed-hierarchical mi | #2294 | - | backfill | n/a | STALE |
| 2026-06-06 | security | memory write poisoning (9 vulns, 4 channels) leaves AgentDB  | #2303 | - | backfill | n/a | STALE |
| 2026-06-07 | intelligence | RHO self-supervised harness optimization +19pp SWE-Bench Pro | #2309 | - | backfill | n/a | STALE |
| 2026-06-08 | memory | multi-signal retrieval gap vs Mem0 SOTA (94.4% LongMemEval)  | #2316 | - | backfill | n/a | STALE |
| 2026-06-08 | meta | ADR-147 collision across 6 open PRs + 0 merges in 14 nights | #2324 | - | backfill | n/a | STALE |
| 2026-06-09 | swarm | RL orchestration 5-decision gap (no stopping-RL in any frame | #2332 | - | backfill | n/a | STALE |
| 2026-06-10 | performance | DeLM shared-context +10.5pp SWE-bench gap (−50% cost) + secu | #2343 | - | backfill | n/a | STALE |
| 2026-06-11 | security | runtime governance gap — Microsoft AGT forecloses 7 ASI risk | #2353 | - | backfill | n/a | STALE |
| 2026-06-12 | intelligence | Agents-K1 KG gap — flat HNSW ReasoningBank cannot multi-hop; | #2362 | - | backfill | n/a | STALE |
| 2026-06-13 | memory | AgentDB lacks temporal decay — flat HNSW causes semantic dri | #2367 | - | backfill | n/a | STALE |
| 2026-06-14 | swarm | Shapley credit routing gap (+23.66% vs SHARP SOTA) + ruview- | #2378 | - | backfill | n/a | STALE |
| 2026-06-15 | performance | Arbor tree-search +193% throughput gap + security,hive-mind  | #2381 | - | backfill | n/a | STALE |
| 2026-06-16 | security | MCP threat coverage gap 34% vs 91% MCPSHIELD + intelligence, | #2393 | - | backfill | n/a | STALE |
| 2026-06-17 | intelligence | benchmark contamination +5-15pp gap + RetailBench long-horiz | #2401 | - | backfill | n/a | STALE |
| 2026-06-18 | memory | bi-temporal HNSW gap +10.4pp LongMemEval_S (Engram) + OPD-Ev | #2410 | - | backfill | n/a | STALE |
| 2026-06-19 | swarm | AdaptOrch +22.9% SWE-bench via adaptive topology — hierarchi | #2419 | - | backfill | n/a | STALE |
| 2026-06-20 | performance | Ruflo missing task-completion benchmark vs LangGraph 62% — M | #2427 | - | backfill | n/a | STALE |
| 2026-06-21 | security | 83.9% of sandbox harms pass semantic checks — execution-phas | #2429 | - | backfill | n/a | STALE |
| 2026-06-22 | intelligence | FLARE myopic commitment gap — SONA has no lookahead simulati | #2435 | - | backfill | n/a | STALE |
| 2026-06-23 | memory | semantic drift from repeated summarization cycles — AgentDB  | #2452 | - | backfill | n/a | STALE |
| 2026-06-24 | swarm | SGTO-MAS trust-weighted consensus closes 5.3% adversarial ga | #2456 | - | backfill | n/a | STALE |
| 2026-06-25 | performance | 5× Grade A evidence for stateful KV-cache + execution graph  | #2462 | - | backfill | n/a | STALE |
| 2026-06-26 | security | MCP tool permission boundaries unguarded — ShareLock >90% AS | #2471 | - | backfill | n/a | STALE |
| 2026-06-27 | intelligence | SKILL-DISCO trace-to-skill distillation closes 22%+ benchmar | #2478 | - | backfill | n/a | STALE |
| 2026-06-28 | memory | TRUSTMEM+MemStrata expose AgentDB write-verification and tem | #2485 | - | backfill | n/a | STALE |
| 2026-06-29 | swarm | RL stopping policy is the last un-automated orchestration su | #2495 | - | backfill | n/a | STALE |
| 2026-06-30 | performance | TokenDance (Grade A) proves 17.5× cross-agent KV-cache reduc | #2510 | - | backfill | n/a | STALE |
| 2026-07-01 | security | AgentDB retrieval pipeline has 0 certified defenses — SMSR p | #2516 | - | backfill | n/a | MERGED |
| 2026-07-02 | intelligence | HyDRA dimension routing +12.9% cost savings / SkillCAT +40%  | #2526 | - | backfill | n/a | STALE |
| 2026-07-03 | memory | AutoMem proves RL-trained memory ops yield 2x–4x long-horizo | #2536 | - | backfill | n/a | STALE |
| 2026-07-04 | swarm | Inverse-Wisdom Law (Grade A) proves larger swarms harden wro | #2559 | - | backfill | n/a | STALE |
| 2026-07-05 | performance | PolyKV shared KV pool cuts 15-agent memory 97.7% (Grade A) + | #2576 | - | backfill | n/a | STALE |
| 2026-07-06 | security | 40-75% agent attack rate (Grade A) exposes VMG + RepE IPI ga | #2588 | - | backfill | n/a | MERGED |
| 2026-07-07 | intelligence | SkillRL recursive skill acquisition exposes static SONA cata | #2597 | - | backfill | n/a | STALE |
| 2026-07-08 | memory | NapMem RL-navigated pyramid exposes passive-retrieval gap in | #2606 | - | backfill | n/a | STALE |
| 2026-07-09 | swarm | ND-MARL 83× zero-shot scale + HNSW-comms-fabric gap in ruvec | #2616 | - | backfill | n/a | STALE |
| 2026-07-10 | performance | Workflow-Atomic Scheduling closes 1.6×–5.9× latency gap — no | #2623 | - | backfill | n/a | STALE |
| 2026-07-11 | security | plugin supply chain 0.00% detection gap + ADR-179 + intellig | #2630 | - | backfill | n/a | STALE |
| 2026-07-12 | intelligence | Harness Effect 41% cost gap + heterogeneous 2.3× accuracy ga | #2641 | - | backfill | n/a | STALE |
| 2026-07-13 | memory | RecMem −87% token cost + SelfMem +48.7% BEAM expose eager-co | #2655 | - | backfill | n/a | STALE |
| 2026-07-14 | swarm | Swarm Skills trajectory distillation + SWARM+ 97-98% latency | #2664 | - | backfill | n/a | STALE |
| 2026-07-16 | security | IPI attack success 10.7–29.6% exposes missing RuntimeAuthori | #2692 | - | backfill | n/a | CLOSED |
| 2026-07-17 | intelligence | SLEUTH +11pt multi-hop gap + GRADE 44% runtime gap unimpleme | #2701 | - | backfill | n/a | STALE |
| 2026-07-18 | memory | selective persistence 97× token reduction + plugins,automati | #2715 | - | backfill | n/a | STALE |
| 2026-07-19 | swarm | IB+VQ messaging 181.8% task gain breaks performance-bandwidt | #2727 | - | backfill | n/a | STALE |
| 2026-07-20 | performance | world-model 14× agent-planning speedup (DSWorld) unmasks unv | #2739 | - | backfill | n/a | STALE |
| 2026-07-21 | security | NCA gate + PlanFlip planning-phase injection + MemPoison bli | #2752 | - | backfill | n/a | STALE |
| 2026-07-22 | intelligence | SCM routed memory 86% LongMemEval exposes Ruflo CMR gap + ca | #2760 | - | backfill | n/a | STALE |
| 2026-07-23 | memory | OAS budget-operator selection +48% exposes Ruflo consolidati | #2763 | - | backfill | n/a | STALE |
| 2026-07-24 | swarm | ClawArena shows privilege-granting is #1 orchestration bottl | #2768 | - | backfill | n/a | STALE |
| 2026-07-25 | performance | AA-AgentPerf 23.6× gap + mixture-of-agents ACL 2026 Pareto-o | #2778 | - | backfill | n/a | STALE |
| 2026-07-26 | security | ShareLock MCP threshold poisoning + ChannelGuard gap + intel | #2783 | - | backfill | n/a | STALE |
| 2026-07-27 | intelligence | PoTRE 49.92% HLE — heterogeneous ensembles + capabilities,me | #2792 | - | backfill | n/a | STALE |
| 2026-07-28 | memory | MemIR provenance-role collapse gap in AgentDB flat storage + | #2803 | - | backfill | n/a | STALE |
| 2026-07-29 | swarm | TPSC pheromone consensus 50% agent reduction +11.6% fitness  | #2832 | - | backfill | n/a | MERGED |
| 2026-07-30 | performance | Two Calls Beat Five Agents 7.4× token gap + HalluProp pre-ho | #2862 | - | backfill | n/a | OPEN |
| 2026-07-30 | security | Implement ADR-377: AgentDB Retrieval Security Layer | #2873 | - | backfill | n/a | MERGED |
| 2026-07-31 | security | ALIBI adversarial code comment injection + SkillGate acceler | #2881 | - | backfill | n/a | OPEN |
| 2026-08-01 | security | MemSecBench memory poisoning gap in AgentDB + OwlPath 28.8%  | #2892 | - | backfill | n/a | OPEN |
| 2026-08-02 | intelligence | MANTA in-inference topology self-evolution (+5.8pp) exposes  | #2898 | - | backfill | n/a | OPEN |
| 2026-08-03 | memory | Zero-Mem -57.6% retrieval latency exposes AgentDB entity-con | #2902 | - | backfill | n/a | OPEN |
| 2026-08-04 | swarm | Stigmergic pheromone bus closes 50%-agent-reduction gap (ADR | #2918 | - | backfill | n/a | OPEN |
| 2026-08-05 | performance | 8.08× inference gap — agents converge on 1 framework, miss 1 | #2923 | - | backfill | n/a | OPEN |
| 2026-08-06 | security | AgentDB memory poisoning 84.2% persistence gap — Adaptive Tr | #2932 | - | backfill | n/a | OPEN |
| 2026-08-07 | intelligence | EnvACE World Rehearsal gap — SONA lacks pre-execution self-s | #2938 | - | backfill | n/a | OPEN |
| 2026-08-08 | memory | ScrubJay temporal decay collapses GenGap 5.7× — AgentDB peri | #2943 | - | backfill | n/a | OPEN |
| 2026-08-09 | swarm | SwarmAgentic PSO topology auto-generation +261.8% gap (ADR-3 | #2949 | - | backfill | n/a | OPEN |
| 2026-08-10 | performance | cross-agent KV cache sharing 7.8× prefill gap (ADR-381) + se | #2953 | - | backfill | n/a | OPEN |
| 2026-08-11 | security | ColluSkill 96% compositional evasion gap (ADR-382) + intelli | #2964 | - | backfill | n/a | OPEN |
| 2026-08-12 | intelligence | VibeLifeBench proactivity gap — SONA lacks background world- | #2979 | - | backfill | n/a | OPEN |
| 2026-08-13 | memory | TOKI bitemporal contradiction resolution gap in AgentDB + pl | #3008 | - | backfill | n/a | OPEN |

## v2 live entries start below

(STEP 9 of the v2 routine appends here nightly, starting 2026-08-14.)

**Recovery note (2026-08-19):** rows for 2026-08-14 through 2026-08-18 were
never appended live despite all 5 nights running to completion (branch +
draft PR + issue exist for each — verified via `git ls-remote` and
`gh pr`/MCP search before concluding this, per STEP 1's anti-inference
rule). Backfilled below from the PRs/issues directly. Root cause not
diagnosed (out of scope for STEP 1 recovery); flagged as a candidate
finding for a future `automation`/`meta` scan surface — the ledger-append
step itself has now silently failed for 5 consecutive nights with no
alerting.

| Date | Deep | Finding | Issue | PR | Evaluated? | Verdict | Effect | Witness | Prior-night fates |
|---|---|---|---|---|---|---|---|---|---|
| 2026-08-14 | swarm | power-of-two-choices mesh peer selection: max-load -46.1%, CoV -44.4% but density -13.7% breaches ±10% invariant | #3026 | #3027 | yes | REJECT | max_load -46.1%, CoV -44.4%, density -13.7% (breach) | e77acc86... | recovered-live (5-night gap) |
| 2026-08-15 | performance | HNSWIndex efSearch query-time default decouple: latency -55.9%/-57.5% but recall@10 breaches 0.90 floor at N=8000 (-7.5pp) | #3033 | #3034 | yes | REJECT | latency -55.9%(N=3k)/-57.5%(N=8k), recall -7.5pp (breach @8k) | d756e6d9... | recovered-live |
| 2026-08-16 | security | settings.json hooks/allow-rules advisory risk scanner (CVE-2025-59536-class) wired into init/upgrade merge, advisory-only | #3043 | #3044 | yes | ACCEPT | recall 0→1.0, precision 1.0, FPR 0.0 (post-hardening, 6 critic-found bypasses fixed) | ad11d483... | recovered-live |
| 2026-08-17 | intelligence | discounted Thompson-sampling prior decay for model-router bandit (opt-in), recovers faster after workload shift | #3048 | #3049 | yes | ACCEPT-scoped | low-bucket recovery -17.6% (t=7.00, held); med-bucket null (no generalization) | e0fb0242... | recovered-live |
| 2026-08-18 | memory | hybridSearch controller reachable via explicit opt-in (was silently null-returning despite config flag) | #3056 | #3057 | yes | ACCEPT-scoped | overall recall@10 +0.267; category B (pure-paraphrase) regresses -0.133 | b28714fb... | recovered-live |
| 2026-08-19 | swarm | MessageBus retry-attempts silently reset to 0 on every re-queue, unbounded redelivery, message.failed unreachable | #3061 | #3062 | yes | ACCEPT | invocations 96-98/0-failed (baseline) → 3/2/1 stable (candidate); 220/220 tests | 62c4fdf7... | 08-14..08-18 all OPEN, none merged yet |

**Recovery note (2026-09-05):** rows for 2026-08-24 through 2026-09-03 were
again never appended live — same failure class as the 2026-08-19 recovery
above, now confirmed for a 3rd distinct occurrence. Verified via direct
evidence before concluding this (per STEP 1's anti-inference rule): `git
ls-remote --heads origin "dream/*"` shows real branches for every date
2026-08-24..2026-09-03, and `search_issues label:dream-cycle` /
`search_pull_requests` confirm a real issue+draft-PR pair for each —
the pipeline ran to completion every one of those nights; only the
ledger-append step silently no-op'd. **2026-08-20 through 2026-08-23 is a
separate, genuine gap**: no branches, no issues, no PRs for those 4 dates —
confirmed independently by three separate dream-cycle nights (08-24, 08-25,
08-27) before tonight, and reconfirmed here — the pipeline did not run at
all those nights (root cause still undiagnosed, still out of scope for a
single-surface nightly slot). Also separately confirmed via `issue_read` on
#3109: PRs #3043/#3044 (08-16), #3048/#3049 (08-17), #3056/#3057 (08-18),
#3061/#3062 (08-19) were **MERGED 2026-08-21** — a human merged the backlog
that had built up, contradicting nothing above but updating the "OPEN"
status this ledger last recorded for them. Backfilled below from issues/PRs
directly (titles + verdict only — full effect-size detail is in each
linked issue; not re-extracted tonight to protect budget for tonight's own
research per STEP 0.6). **This is now the 3rd occurrence of the same
ledger-append failure mode** (2026-08-19 recovery, implied prior instances,
now this one) — no longer a one-off. Elevating this from a "candidate
finding" to an explicit recommendation: a future `automation`/`meta` DEEP
night should treat "harden STEP 25's ledger-append against silent failure"
as a first-class, high-priority candidate, not a background note.

| 2026-08-24 | swarm | TopologyManager weightedConsensus() trust weights now reach the vote tally (were computed, discarded) | #3085 | #3086 | yes | ACCEPT | see issue #3085 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-08-25 | performance | productQuantizeDistance() implemented but never dispatched in HNSW search path — wired in | #3093 | #3094 | yes | ACCEPT | see issue #3093 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-08-26 | security | authorizeMcpTool() trusted unsigned caller identity (ASI07) — ADR-377 verifyInvocationToken bound into live chokepoint | #3102 | #3103 | yes | ACCEPT-with-caveats | see issue #3102 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-08-27 | intelligence | distillLearning() EWC gate read 1 of 384 Fisher dims via length-collapsed getPenalty() call; rewired to computeConfidencePenalty()/updateFisherFromConfidences() | #3109 | #3110 | yes | ACCEPT-scoped | 152/152 tests (+4 new), baseline-fails/candidate-passes via stash isolation | 89946458... | unmerged draft as of 09-05 |
| 2026-08-28 | memory | HybridBackend's dead `weights` field now drives real weighted-RRF fusion (was computed, never read by merge helpers) | #3118 | #3119 | yes | ACCEPT | see issue #3118 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-08-29 | swarm | TopologyManager.rebalanceHybrid() one-directional adjacency bug fixed | #3122 | #3123 | yes | ACCEPT | see issue #3122 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-08-30 | performance | unwired diskann-backend.ts removed + stale 150x-12,500x HNSW claim in generated CLAUDE.md corrected | #3129 | #3130 | yes | ACCEPT | see issue #3129 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-08-31 | security | MCP governance policy (.harness/mcp-policy.json) was never enforced at runtime — opt-in enforcement wired in | #3138 | #3139 | yes | ACCEPT | see issue #3138 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-09-01 | security | maxToolCallsPerTurn was a session-lifetime cumulative cap that never reset — sliding-window reset implemented | #3151 | #3152 | yes | ACCEPT | see issue #3151 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-09-02 | intelligence | LearningBridge.consolidate() was reward-blind — fixed to weight consolidation by trajectory reward | #3159 | #3160 | yes | ACCEPT | see issue #3159 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-09-03 | memory | SmartRetrieval's MMR diversity step used token-Jaccard similarity instead of the available embedding-cosine | #3168 | #3169 | yes | ACCEPT | see issue #3168 | n/a (backfill) | unmerged draft as of 09-05 |
| 2026-09-05 | performance | cli-cold-start.bench.ts's real measureColdStart() was dead code; every number (incl. a by-construction "5.00x V2 vs V3") came from setTimeout(); real spawn-based measurement wired in, fabricated comparison removed, 2 stale ADR-STATUS-SUMMARY.md rows corrected | #3183 | #3184 | yes | ACCEPT-scoped | real: 54.65ms mean (min 51.94/max 57.92, n=5) vs 500ms target; 99/99 tests (+4 new), baseline-fails/candidate-passes via stash isolation | 04f903ba... | 08-24..08-31 all unmerged drafts (ACCEPT/ACCEPT-scoped, correctly awaiting human review, none stale <14d) |
**Note (2026-09-03):** rows for 2026-08-24 through 2026-09-02 (9 nights, all evaluated ACCEPT) exist and are already backfilled on their own dream/* branches (see `dream/2026-08-28-memory` and `dream/2026-09-02-intelligence`'s copies of this file) but not re-transcribed here, to avoid yet another copy stuck on yet another unmerged branch — see tonight's `automation` scan finding below for the structural reason (ledger rows only reach `main` via PR merge; STEP 25 has run correctly every night). Current backlog: #3086, #3094, #3103, #3110, #3119, #3123, #3130, #3139, #3152, #3160 — all open/draft, none merged since the 2026-08-21 batch that cleared 08-14..19.
**Note (2026-09-03):** rows for 2026-08-24 through 2026-09-02 (9 nights, all evaluated ACCEPT) exist and are already backfilled on their own dream/* branches (see `dream/2026-08-28-memory` and `dream/2026-09-02-intelligence`'s copies of this file) but not re-transcribed here, to avoid yet another copy stuck on yet another unmerged branch — see tonight's `automation` scan finding for the structural reason (ledger rows only reach `main` via PR merge; STEP 25 has run correctly every night). Current backlog: #3086, #3094, #3103, #3110, #3119, #3123, #3130, #3139, #3152, #3160 — all open/draft, none merged since the 2026-08-21 batch that cleared 08-14..19.

**Update (2026-09-05):** ruvnet reviewed #3169 and REJECTed pending remediation (CI split, green CI, a real benchmark, malformed-input tests, determinism proof). Addressed: the `automation` scan's `dream-cycle-backlog-guard.yml` moved to its own PR **#3205** (no longer bundled with the memory fix); the root CI failure (unpublished `@claude-flow/mcp@3.0.0-alpha.10`) was fixed on `main` by a separate session as **#3203** (merged) and `dream/2026-09-03-memory` rebased onto it, CI green; a labeled 18-doc/6-topic benchmark (`mmr-benchmark.test.ts`) swept across `mmrLambda` shows recall/nDCG parity with baseline at the module's default (λ=0.7) while diversity/duplicate-rate improve, with an honest disclosed trade-off at diversity-heavy λ; a real NaN/Infinity-embedding hardening bug was found and fixed while adding the malformed-input tests. See gist addendum.

| 2026-09-03 | memory | SmartRetrieval's MMR diversity step used token-Jaccard text overlap instead of embedding-cosine (already computed upstream, discarded before reaching MMR) — matches Qdrant/Weaviate's 2025-2026 shipped pattern | #3168 | #3169 | yes | ACCEPT | recall/nDCG parity with baseline at default λ=0.7 (1.000/0.777 both); diversity 0.472→0.667, dup-rate 0.289→0.200; 465/466 full-suite green (1 pre-existing) | 9ce94e31... | 08-24..09-02 (9 nights) all still open/draft, none merged; automation backlog-guard split to #3205 per review |
| 2026-09-07 | intelligence | EnhancedModelRouter forwarded a wrong-tier modelId when tier3-keyword/AST complexity escalated the returned tier past the tier the base bandit router chose modelId for — agent-execute-core.ts's first-call dispatch treats a present modelId as an unconditional tier-map override, so a security-sensitive task escalated to opus could silently execute against a cheap haiku-tier model; gated forwarded fields on tier match | #3220 | #3221 | yes | ACCEPT-scoped | reviewer REJECTed original run (unmeasured latency, "168 identical failures" ≠ green suite); re-evaluated: 168→69 after building 3 unbuilt sibling packages, remainder is 2 orthogonal optional-WASM test files + e2e tests unrelated to changed file, CI 100% green throughout; latency now measured (-2.3%, PASS vs explicit ±20% threshold) | 6c578524... | #3169/#3184 merged since 09-05; #3086,#3094,#3103,#3110,#3119,#3123,#3130,#3139,#3152,#3160 (08-24..09-02) still open/draft, none merged |

**Note (2026-09-09):** 2026-09-08 (memory, #3231/#3232 — wired embedding near-dup detection into `MemoryConsolidator.dedup()`, ACCEPT, directly acting on 09-07's own recommendation #3) exists as a real branch+issue+draft-PR (verified via `search_pull_requests`, not inferred) but is not transcribed as a row here — same "ledger rows only reach `main` via PR merge" structural gap noted repeatedly since 2026-08-19/09-03/09-05. Verified GitHub state (via MCP tools, not `gh` CLI) for the trailing nights before tonight's own row: #3139 (08-31) OPEN/draft 9d old; #3152 (09-01) OPEN/draft 8d old; #3160 (09-02) OPEN/draft 7d old; #3169 (09-03) **MERGED** 09-05; #3184 (09-05) **MERGED** 09-05; #3221 (09-07) **MERGED** 09-07 (same day); #3232 (09-08) OPEN/draft 1d old. Swarm-surface backlog specifically: #3086 (08-24) now **16 days old, 0 follow-up comments → STALE** per the >14-day rule; #3123 (08-29) 11d old, has reviewer comments, not yet stale. Trailing-9-night merge rate has improved to 3/9 (09-03, 09-05, 09-07) vs. the "0 of last 14" note in earlier gists.

| 2026-09-09 | swarm | AgentPool.performHealthChecks() stamped lastHeartbeat=now on every "still healthy" tick, and updateAgentHeartbeat() (the only other legitimate way to advance it) has zero callers anywhere in v3/ — so the check's own tick was the sole thing keeping every pooled agent's heartbeat fresh, meaning timeSinceLastActivity could never exceed one interval and replaceUnhealthyAgent() could never fire for any agent, in any pool, ever; removed the self-stamp | #3242 | #3243 | yes | ACCEPT-scoped | 223/223 tests (+3 new), baseline-fails-2-of-3/candidate-passes-3-of-3 via stash isolation; adversarial critic confirmed independently but disclosed @claude-flow/swarm has no reachable path through the shipped @claude-flow/cli today (blast radius is the swarm package's own UnifiedSwarmCoordinator, not an active CLI hot path) | 008c96a0... | 08-24..09-02 backlog unchanged (see note above); #3169/#3184/#3221 merged since 09-05 |
