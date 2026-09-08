# ADR-382: SONA Proactive World Monitoring

**Status:** Proposed  
**Authors:** claude (dream-cycle agent, 2026-08-12)  
**Date:** 2026-08-12  
**References:** Dream Cycle issue #2979, VibeLifeBench (Xiaohongshu Inc., arXiv Aug 2026)

---

## Context

VibeLifeBench (2026) demonstrates that frontier models fail >60% of 200 long-horizon proactive agent tasks. The benchmark's hardest subtask category is "silent world change detection" — where the environment mutates while the agent is occupied, requiring the agent to proactively notice the change rather than being told.

Ruflo's SONA intelligence pipeline is a 4-step reactive loop:

```
RETRIEVE → JUDGE → DISTILL → CONSOLIDATE
```

All four steps fire *after* a task completes. There is no background monitoring step that can detect when external state (tool outputs, memory staleness, subscribed webhook events) has drifted from the last-known snapshot while an agent is mid-task or idle. Every competitor framework (LangGraph, AutoGen, CrewAI, OpenAI Agents SDK) also lacks this — the gap is industry-wide and represents a first-mover opportunity.

## Decision

Add a **MONITOR** step as the first stage of the SONA pipeline, executed as a background `daemon` worker:

```
MONITOR → RETRIEVE → JUDGE → DISTILL → CONSOLIDATE
```

The MONITOR step:
1. Runs on a configurable interval (default: every 30s) via the existing `daemon` background worker infrastructure.
2. Compares current world-state signals against a stored `last-known-state` snapshot in AgentDB.
3. Fires a `world-drift-detected` event (via the hooks system) when the cosine distance between current and stored state vectors exceeds a configurable threshold (default: 0.15).
4. The `world-drift-detected` event triggers the full RETRIEVE→JUDGE→DISTILL→CONSOLIDATE cycle with the drift delta as context.

### World-state signals (v1 scope)

- Memory staleness score: fraction of AgentDB entries older than `stale-threshold` (default: 1h)
- Tool output fingerprint: rolling SHA-256 of the last N=10 tool outputs, updated after each tool call
- Hook telemetry: `post-task` hook success/failure rate over last 20 tasks

### Out of scope (v1)

- External webhook subscription management (future ADR)
- Cross-agent world-state federation (future ADR)
- Real-time streaming event monitoring (future ADR)

## Consequences

**Positive:**
- Closes the proactivity gap identified by VibeLifeBench — agents can detect "the world moved" without being told.
- Reuses existing `daemon` worker infrastructure (12 background workers already running).
- Reuses existing hooks event system (17 hooks already defined).
- Enables future proactive features (pre-emptive re-planning, anticipatory context refresh).

**Negative:**
- Adds a 30s background polling cycle per agent session — minor CPU overhead, configurable off.
- SONA pipeline becomes 5 steps; documentation and tests must be updated.
- `world-drift-detected` is a new event type; existing hook handlers need to handle/ignore it gracefully.

## Implementation Notes

- New worker type: `proactive-monitor` (add to the existing 12 workers in `@claude-flow/hooks`).
- New AgentDB collection: `world-state-snapshots` (keyed by agent session ID, stores state vectors).
- New hook event: `world-drift-detected` (payload: `{ agentId, driftScore, driftDelta, timestamp }`).
- New CLI subcommand: `npx claude-flow monitor status` (shows current drift threshold, last snapshot, last drift event).
- Threshold tuning guide should be added to `docs/intelligence/` after initial benchmarking.

## Alternatives Considered

- **Polling inside JUDGE step only:** too late — JUDGE fires after task completion, not during idle periods.
- **External cron job:** breaks the self-contained daemon model; requires external scheduler setup.
- **No change:** VibeLifeBench gap persists; competitors will close it first.
