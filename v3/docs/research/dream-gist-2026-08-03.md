# Memory SOTA Report — 2026-08-03

**TL;DR:** Zero-Mem (arXiv 2026-07-31, Grade A) eliminates intermediate LLM calls during memory retrieval via entity-context graphs, cutting latency 57.6% — a direct gap in AgentDB's flat-row architecture. A concurrent replication study (LightMem) warns that retriever quality drives accuracy (58.1%–75.5%) more than memory construction complexity, cautioning against over-engineering AgentDB before tuning HNSW retrieval parameters.

---

## What's New in 2026

| Finding | Source | Confidence |
|---|---|---|
| Zero-Mem: entity-context graphs cut memory retrieval latency 57.6% on long-context QA | arXiv 2026-07-31 (Xiao et al.) | A |
| MemHarness: context-conditioned memory reconstruction beats static replay on ALFWorld + WebShop | arXiv 2026-07-30 (Wu et al.) | A |
| AdaMM: analytic (SQL-like) memory queries +11.3% MemEye, +7.3% MemGallery over retrieval-only | arXiv 2026-07-31 (Tian et al.) | A |
| LightMem repro: retriever choice drives accuracy 58.1%–75.5%; construction complexity secondary | arXiv 2026-07-31 (Zhou et al.) | A |
| HAM-VLN: hierarchical depth-grounded world graph compresses context 65%, 61.0% VLN-CE zero-shot | arXiv 2026-07-31 (Liu et al.) | A |
| GAMER: episodic memory + inference-time scaling via action-centric graphs, +20.81% success rate | arXiv 2026-07-29 (Zheng et al.) | B |
| Sigma-Mem: per-agent-pair reliability state enables multi-agent trust without central arbiter | arXiv 2026-07-30 (Feng et al.) | B |
| Metis: memory-foundation model embeds persistent state in LLM backbone, no external vector store | arXiv 2026-07-29 (Zhang et al.) | B |

---

## Ruflo Current Capability

| Dimension | Current State | Gap |
|---|---|---|
| Memory data model | Flat vector rows + SQLite in AgentDB | No entity-context graph; no temporal hierarchy |
| Retrieval mechanism | HNSW ANN (measured ~1.9x–4.7x vs brute force at N=5k–20k) | Retriever quality not tuned; no lazy tool loading |
| Memory reconstruction | Static vector replay at recall time | No context-conditioned reconstruction (MemHarness pattern) |
| Analytic queries | Raw SQL selects; no episodic filtering API | No structured query interface over stored episodes |
| Multi-agent trust memory | None | No per-agent-pair reliability tracking (Sigma-Mem gap) |
| Memory compression | RaBitQ 32x compression (measured) | No hierarchical summarization like HAM-VLN |

---

## Competitor Comparison

| Competitor | Memory / Plugin Signal (2026) | Ruflo Parity |
|---|---|---|
| **LangGraph 1.2.10** | trace_policy per-node; stream_events v3 type safety; CLI 1.0.x compatibility | No per-node trace policy; weaker observability |
| **AutoGen 0.7.5** | Redis linear memory for persistent stateful workflows; Docker executor default | SafeExecutor exists; no Redis persistent memory |
| **CrewAI 1.15.10** | Skill usage event collection; tool failure structured signals; progressive disclosure | SkillGate ADR-145 P2 not yet shipped |
| **OpenAI Swarm** | Stateless minimal orchestration; no memory architecture updates in 2026 | Ruflo far ahead; Swarm is lightweight comparison only |

---

## Benchmarks

| Benchmark | Metric | System | Grade |
|---|---|---|---|
| Long-context QA retrieval latency | −57.6% vs baseline | Zero-Mem (entity-context graph) | A |
| MemEye accuracy | +11.3% over retrieval-only | AdaMM analytic memory | A |
| MemGallery accuracy | +7.3% over retrieval-only | AdaMM analytic memory | A |
| ALFWorld + WebShop | Outperforms RL + static replay (margin unreported) | MemHarness | A |
| VLN-CE R2R zero-shot success | 61.0% | HAM-VLN hierarchical memory | A |
| LightMem config sweep | 58.1%–75.5% accuracy across configs (retriever is key variable) | LightMem repro study | A |

---

## Scan Findings — Plugins (2026-08-03)

**Finding:** DualView/OpenClaw (arXiv 2026) proposes plugin security hooks that add access controls without modifying core agent logic — a clean extension model. CrewAI v1.15.10 ships skill-usage event collection and structured tool failure signals, raising the bar for plugin observability. Lazy tool discovery (arXiv, "Building Effective AI Coding Agents") defers plugin loading until needed, directly relevant to Ruflo's plugin registry startup overhead.

**Competitive signal:** CrewAI's per-skill telemetry is ahead of Ruflo's plugin system, which has no built-in skill-invocation event stream.

**One-sentence finding:** C — Plugin observability (per-invocation events, failure signals, lazy loading) is becoming standard across CrewAI and arXiv proposals, and Ruflo's plugin system lacks all three.

---

## Scan Findings — Automation (2026-08-03)

**Finding:** HierFlow (arXiv 2026) synthesizes agent workflow topology and execution jointly without training, directly addressing Ruflo's swarm-init fixed-topology limitation. DataFlow-Harness constructs typed DAG workflows incrementally as persistent artifacts. AutoGen 0.7.5's Redis linear memory enables stateful automation across sessions — the most concrete shipped signal.

**Competitive signal:** AutoGen now ships persistent cross-session memory by default (Redis). Ruflo's AgentDB is the equivalent capability but not the default for automation workflows.

**One-sentence finding:** C — Training-free workflow topology synthesis (HierFlow) and cross-session persistent memory (AutoGen Redis) are 2026 automation benchmarks Ruflo's swarm-init and AgentDB do not yet match by default.

---

## SOTA Proof & Witness

| Field | Value |
|---|---|
| Session commit | `913f9eaedee92627950544424e50339feaf98271` |
| Report SHA-256 | `2fd06bf1496897dc068141c92fa9339a0c316671f5947fc300bf638aa64c3d2f` |
| Witness stamp | `0300f5d529efbfd35693c23e8ad91cd8790fba9e6d21eef3cc6eedd61cd54f43` |

**Verifier:** `sha256sum dream-gist-2026-08-03.md` → concat with session commit `913f9eaedee92627950544424e50339feaf98271` → `sha256sum` → must equal witness stamp.

---

## Recommended Next Steps

1. **Implement Zero-Mem entity-context graph layer in AgentDB** — introduce a `MemoryGraph` abstraction that organises stored entries as entity nodes with temporal edges, replacing the flat-row append model. Target: −40% retrieval latency at N=10k (conservative relative to Zero-Mem's 57.6%). File as ADR-381. Estimated effort: 2 sprints.

2. **Tune HNSW retrieval parameters before adding construction complexity** — the LightMem replication result is a direct warning: accuracy varies 17.4 pp across retriever configs, not memory construction strategies. Run an in-tree benchmark sweeping `ef_construction` (100–400) and `M` (16–64) at N=10k, N=50k before merging any new memory-construction feature. Add to `scripts/benchmark-intelligence.mjs`.

3. **Add plugin invocation telemetry hook** — wire a `PostPluginInvoke` hook that emits structured events (plugin id, duration, success/failure, token cost). CrewAI's equivalent is already shipping. This is a one-sprint addition to the existing 17-hook system that closes a competitive gap and enables the lazy-loading pattern from the arXiv agent-terminal paper.
