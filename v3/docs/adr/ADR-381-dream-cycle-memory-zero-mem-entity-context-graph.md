# ADR-381: Zero-Mem Entity-Context Graph Architecture for AgentDB

**Status:** Proposed  
**Authors:** claude (dream-cycle agent, 2026-08-03)  
**Date:** 2026-08-03  
**Dream Cycle Issue:** TBD (filed same session)  

---

## Context

ArXiv 2026-07-31 (Zero-Mem, Xiao et al.) demonstrates that eliminating intermediate LLM calls during memory access — by organising traces as entity-context graphs with temporal hierarchies — reduces memory retrieval latency by 57.6% on long-context QA benchmarks (Grade A: reproducible benchmark).

Ruflo's AgentDB currently stores memories as flat vector rows (embedding + metadata) in SQLite with HNSW indexing. Retrieval is a k-ANN lookup returning the top-k rows, with no graph structure, no temporal hierarchy, and no entity-centric organisation. This architecture:

- Cannot exploit entity-level temporal locality (recent interactions with entity X are scattered across flat rows)
- Performs k-ANN search over the entire corpus for every retrieval, even when the query is clearly scoped to a single entity or time window
- Requires an LLM call to summarise or contextualise retrieved rows before use

A concurrent replication study (LightMem, arXiv 2026-07-31) warns that **retriever quality drives accuracy 17.4 pp more than memory construction strategy** — so we must not add construction complexity before verifying HNSW retrieval quality at production scale.

---

## Decision

Introduce a `MemoryGraph` abstraction layer in `@claude-flow/memory` that organises stored entries as:

1. **Entity nodes** — named entities (agents, users, tasks, files) extracted at write time
2. **Context edges** — typed relationships between entities (authored, modified, blocked-by, reported-to)
3. **Temporal hierarchy** — a three-level time index (session → turn → fact) enabling scoped retrieval without full corpus scan

The flat-row store is preserved as a compatibility layer. `MemoryGraph` is additive: it builds a graph index on top of existing rows and falls back to flat k-ANN if the graph index is empty or not configured.

**Phase 1 (1 sprint):**
- Add entity extraction at `memory store` time (regex + lightweight NER; no LLM call)
- Build `entity_nodes` and `context_edges` tables in AgentDB SQLite
- Implement scoped retrieval: `graph_search(entity, time_window)` → returns matching rows without full corpus scan

**Phase 2 (1 sprint):**
- Add HNSW index over entity-node embeddings (separate from the flat-row HNSW)
- Benchmark Phase 1 vs baseline at N=10k, N=50k (add to `scripts/benchmark-intelligence.mjs`)
- Target: −40% retrieval latency at N=10k (conservative vs Zero-Mem's 57.6%)

**Pre-condition (before Phase 1 merge):**
- Run HNSW parameter sweep (`ef_construction` 100–400, `M` 16–64) at N=10k and N=50k per LightMem warning — do not ship Phase 1 without a retriever quality baseline.

---

## Rationale

- Zero-Mem's 57.6% latency reduction (Grade A) is the largest memory-retrieval gain reported in 2026 arXiv literature surveyed.
- AdaMM (Grade A) independently demonstrates +11.3% / +7.3% accuracy gains from adding SQL-like analytic queries over episodic memory — compatible with the entity-node model.
- MemHarness (Grade A) validates context-conditioned retrieval (over static replay) on ALFWorld + WebShop; the entity-context graph enables context conditioning without a separate reconstruction model.
- LightMem's retriever-quality warning (Grade A) shapes sequencing: retriever benchmark before construction additions.

---

## Consequences

**Positive:**
- Projected −40% retrieval latency at N=10k (to be verified in Phase 2 benchmark)
- Enables analytic queries (`find all memories where entity=agent-X AND time > T`) without full corpus scan
- Compatible with existing HNSW indexing; no breaking API change

**Negative / Risks:**
- Entity extraction adds ~2ms write overhead (mitigated: async extraction post-write)
- Graph index adds ~15% SQLite storage overhead at N=10k (estimated)
- If entity extraction quality is low, graph precision degrades; fallback to flat k-ANN is the safety net

**No impact on:**
- RaBitQ 32x compression (operates on flat-row layer)
- Session-start memory import bridge
- SONA / MoE routing

---

## Alternatives Considered

| Alternative | Rejected Reason |
|---|---|
| Adopt Metis (memory-in-backbone LLM) | Grade B only; requires replacing AgentDB with a custom LLM backbone — 10+ sprint effort, breaks all existing APIs |
| Full replay with LightMem retriever tuning only | Forfeits Zero-Mem latency gains; treats retriever tuning as sufficient when entity-scoping can eliminate most of the search space |
| GAMER action-centric graphs | Grade B; episodic + RL dependency; higher complexity than entity-context graphs for general use |

---

## References

- Zero-Mem (Xiao et al., arXiv 2026-07-31)
- AdaMM (Tian et al., arXiv 2026-07-31)
- MemHarness (Wu et al., arXiv 2026-07-30)
- LightMem repro (Zhou et al., arXiv 2026-07-31)
- HAM-VLN (Liu et al., arXiv 2026-07-31)
- Dream Cycle gist: `v3/docs/research/dream-gist-2026-08-03.md`
