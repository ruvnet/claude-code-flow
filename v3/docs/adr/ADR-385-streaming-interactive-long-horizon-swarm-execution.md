# ADR-385: Streaming, interactive, long-horizon swarm execution — model the console swarm on ruflo's research agents

**Status:** Proposed
**Date:** 2026-09-10
**Author:** Claude Code (for rUv), after the ruOS console Swarms page shipped a deploy that "set up then finished before anything useful happened."

**Relates to:** ADR-057 (agent tasks & swarms), ADR-069 (per-tenant LLM gateway — the key dependency), ADR-099 (dossier-investigator recursive parallel research), ADR-164 (agentbbs federation), ADR-101/ADR-325 (federated claims). Reference implementation model: the `ruflo-goals:deep-researcher`, `ruflo-goals:dossier-investigator`, `ruflo-goals:horizon-tracker`, and `ruflo-agent:nested-*` agents.

## Context — why the swarm does nothing useful

`ruflo swarm start` (`commands/swarm.ts:588–672`) **never executes the objective.** It prints the objective, prints a static Agent Deployment Plan table, calls MCP `swarm_init` (topology only), writes `.swarm/state.json`, and then prints, verbatim:

> "This CLI coordinates agent state. Execution happens via: Claude Code Agent tool (interactive) / claude -p (headless background) / hive-mind spawn --claude (autonomous)."

…and returns `success`. Nothing invokes any of those drivers. The console's Swarms deploy runs this over `/run` with a 30 s timeout and streams the CLI's stdout — so a user sees `[OK] Agent X spawned`, a plan table, `Total: 15 agents`, `SUCCESS in 44s`, a transcript path, and **no work, no artifacts, nothing to find/use/deploy.** The agents are registry rows with no running process (confirmed live in the #3253 investigation). This is by design: `swarm start` is set-up-and-defer, and the deferral target is never called.

rUv's three requirements:
1. **Actually collaborate + produce output** — agents do the objective, not just register.
2. **Stream like Claude Code**, and take **real-time guidance mid-run** — not fire-and-forget.
3. A **final overview**: what it did, where the output is, how to use/deploy it.
4. Do it as **multi-agent, multi-tool, federated, long-horizon agentic flows using ruflo's capabilities**, modelled on the **research agents**.

## Decision

**`swarm start` becomes a streaming, steerable, long-horizon agentic orchestrator that WIRES ruflo's existing execution primitives** — it stops deferring. It adopts the research-agent pattern that already works in-repo (recursive parallel fan-out, per-claim provenance, budget caps, streamed progress, horizon persistence) rather than inventing a new engine.

### D1 — Execute, don't defer (the core change)
`swarm start --execute` (and the console default) runs the objective. Each planned agent is a real agentic worker driven by an existing ruflo primitive — the same `claude -p` / nested-orchestrator path the research agents use (`ruflo-agent:nested-queen` → `nested-*-researcher`/`-reviewer`/`-leaf`). The coordinator decomposes the objective; workers fan out in parallel (the `dossier-investigator` recursive pattern, ADR-099); results reduce back through hive-mind consensus (raft) for anti-drift.

### D2 — Stream every token (like Claude Code)
Each worker's output streams to stdout as NDJSON events (`{agent, phase, kind:'token'|'tool'|'result', data, ts}`), interleaved with agent labels — exactly what the console's SSE `/run` already pipes through live. No new transport is needed for **output** streaming; the fix is that `swarm start` must *emit* the stream instead of a summary table. This alone converts "set then done" into "watchable work."

### D3 — Real-time guidance (the one new transport)
Output streaming is one-way; **steering the swarm mid-run needs a bidirectional channel.** The console's `/run` SSE cannot carry input back. Introduce a **swarm session**: `swarm start --session <id>` writes guidance-inbox at `.swarm/sessions/<id>/inbox.jsonl`; a `swarm guide <id> "<message>"` command (and a console input box) appends to it; the running coordinator polls the inbox between turns and injects guidance into the next worker prompt. Ruflo-native, file-based first (works over `/run`), upgradeable to a WebSocket in ruos-desktop later.

### D4 — Multi-tool, memory, hooks, federation, long-horizon (ruflo capabilities)
- **Multi-tool:** workers get the MCP tool surface (they already can via ToolSearch) — so a coder writes files, a tester runs them, a researcher fetches.
- **Memory:** objective + intermediate findings persist to AgentDB (HNSW recall) so a resumed session continues instead of restarting — the horizon-tracker pattern.
- **Hooks:** every worker turn records a trajectory step (self-learning), so the swarm improves across runs.
- **Federation (long-horizon, cross-node):** for objectives that outlive one machine or need external compute, workers claim work and publish results over agentbbs / x.ruv.io (ADR-164) — the federation coordination plane. Claims prevent duplicate work (ADR-325).
- **Long-horizon:** `horizon-tracker` persists milestones + drift detection so a multi-hour objective survives restarts and resumes mid-plan.

### D5 — A structured final overview
On completion the swarm emits a structured summary (`--format json` and a rendered card): objective, agent roster (role/type/model), topology + consensus + swarm id, **artifacts produced** (files created/changed with paths), **where to find/run/deploy** them, memory keys written, the transcript path, and **next steps**. The console renders this as a result card instead of dumping CLI noise. This is the "what it did / where it is / how to deploy" overview.

## Hard dependencies (stated plainly)
1. **Agents cannot run without a model key.** D1 needs the per-tenant LLM gateway (ADR-069, PR #120) deployed and `RUOS_LLM_GATE_SECRET` set — otherwise `claude -p` on the desktop falls through to whatever login exists (the 2026-09-09 failure). Streaming a swarm that has no key just streams auth errors. **ADR-069 is a prerequisite for the console path.**
2. **Real-time guidance needs the bidirectional channel** (D3). File-inbox works over `/run` today; true low-latency steering wants a WebSocket session in ruos-desktop.

## Increments
- **I1 — Streaming execution.** `swarm start --execute` runs the objective via the nested-orchestrator/`claude -p` path and streams NDJSON. (ruflo, clean repo; gated on a key at runtime.)
- **I2 — Final overview.** Structured JSON summary + console result card (D5).
- **I3 — Guidance inbox.** `swarm guide` + coordinator poll + console input box (D3).
- **I4 — Federation + long-horizon.** agentbbs claim/publish + horizon-tracker persistence (D4) for cross-node, multi-hour objectives.

## Acceptance test
Deploy a swarm with a real objective ("add a /health endpoint with a test") from the console; watch worker output stream token-by-token; send a mid-run guidance message ("also return build SHA") and see the next turn honour it; on completion see a result card naming the file(s) created, how to run the test, and the transcript — then find those files on the desktop. (Mirrors the research-agent + ADR-069 e2e already exercised this session.)

## Consequences
- `swarm start`'s current defer-message becomes a fallback only when no key is configured (honest degradation, not a silent no-op).
- This supersedes the "coordination-only" reading of ADR-057's swarm surface: the swarm now executes.
- The console Swarms page's deploy verdict (ruos-desktop #122) is the seam the D5 overview card plugs into.
