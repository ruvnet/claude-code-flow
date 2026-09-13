---
id: ADR-0001
title: Adopt SSSF Visualizer as ruflo's observability UI — phased schema-adapter approach
status: Proposed
date: 2026-08-06
updated: 2026-08-06
authors:
  - stavros
  - ZCode (design)
tags: [adr, ui, observability, sssf, sqlite, vue, bun, trace]
---

# ADR-0001 — Adopt the Super Simple Software Factory visualizer as ruflo's UI

## Context

### The gap

Ruflo today has **no user interface**. Every surface is programmatic:

- **CLI** — `npx ruflo <cmd>` (26+ commands in `v3/@claude-flow/cli/src/commands/`)
- **MCP** — the 314-tool `mcp__claude-flow__*` surface (the programmatic dispatch layer)
- **Agents/skills/commands** — markdown consumed by host agents (Claude Code, Codex, 14 others)
- **Background workers** — `.agents/config.toml [workers.*]` (audit / optimize / consolidate loops)
- **Ledger / AgentDB** — `agentdb.rvf` (HNSW vector + semantic memory)

There is no way for a human to *see* what ruflo is doing as it happens: which agents are spawned, what tools they call, what tasks pass or fail, what a run costs. The closest thing is `ruflo-status` (a skill that reports state as text) and console output. For a system whose entire identity is "Ruflo = LEDGER/orchestrator" (`AGENTS.md:11-19`), the ledger is invisible.

### The candidate

The [Super Simple Software Factory](https://github.com/disler/super-simple-software-factory) (SSSF, MIT, disler) ships a read-only observability UI at `.claude/skills/sssf/apps/visualizer/`. It is a **Bun server + Vue 3 + Vite SPA** that renders a phased trace waterfall: sessions → phases → events, with agent lanes, gate verdicts, envelope outputs, token/cost breakdowns, and live polling.

**What makes it adoptable — verified by reading the source:**

The visualizer is **fully decoupled from SSSF's Python control plane**. Its entire data contract is:

1. One SQLite file in WAL mode (`sssf.db`), read **readonly** via `bun:sqlite`.
2. Prompt files on disk at `{data_dir}/sessions/{adw_id}/{agent}/prompts/{system,user}.md`.

It imports **zero** SSSF Python modules. The server (`server/index.ts`) opens the db readonly, runs SELECTs, and serves JSON over 8 REST routes — 7 GET, 1 POST (archive, the only write, opens a separate connection). There is no ingest endpoint, no websocket; the UI polls (`GET /api/sessions/:adw_id/events?after=<rowid>`). The schema is defined in `shared/types.ts` as six tables: `sessions`, `phases`, `events`, `envelopes`, `gate_results`, `agent_sessions`.

The data path is one-directional: **writers (whatever they are) → SQLite → readonly server → polling browser.** The writers don't have to be SSSF's tracer. They have to produce rows that match the schema.

### Why this is worth an ADR

Adopting an external project's UI is a cross-cutting decision that doesn't belong to any single plugin (ruflo's ADR convention is plugin-scoped: each plugin has `docs/adrs/0001-<name>-contract.md`). This establishes `docs/adrs/` at the repo level as the home for architectural decisions that span the whole system. The decision also creates a new prerequisite (a SQLite trace store + emitter) and a new runtime process (the Bun server) — both worth recording.

---

## Decision

**Adopt SSSF's visualizer as ruflo's observability UI, in two phases.** Phase 1 runs it unchanged against SSSF-bridged runs. Phase 2 writes a ruflo-native trace emitter so the same UI renders ruflo's own activity (swarms, MCP calls, agents). **Do not fork the UI in Phase 1 or 2** — run the upstream code and adapt the data side.

### Phase 1 — Ship the visualizer unchanged for SSSF-bridged runs

When ruflo invokes an SSSF ADW (per the companion integration, see *Related decisions*), SSSF's own `tracer.py` writes `sssf.db`. The visualizer reads it. **Zero ruflo changes needed to get a working UI for those runs.**

Ruflo's only contribution is a launcher — an optional dependency / convenience command that runs the Bun server pointed at the right db:

```
npx ruflo ui [--db <path>] [--port 4600]
```

This wraps `bun run server/index.ts --db <path>` and resolves `<path>` via: `--db` flag → `RUFLO_TRACE_DB` env → `<workspace>/.ruflo/trace.db` (default).

**Exit criterion for Phase 1:** `npx ruflo ui` opens a browser showing live SSSF run traces. The upstream visualizer repo is consumed as-is (git subtree or vendored copy under `v3/ui/visualizer/`, MIT attribution preserved).

### Phase 2 — Map ruflo's native telemetry onto the same schema

Phase 1 only shows SSSF runs. Phase 2 makes the visualizer a UI for **ruflo itself** — swarms, spawned agents, MCP tool calls, memory ops, hooks — by writing a trace emitter that translates ruflo's native events into the SSSF SQLite schema. The visualizer still runs unchanged; it just reads a richer db.

**Schema mapping** (ruflo concept → SSSF table → notes):

| Ruflo concept | SSSF table | Mapping |
|---|---|---|
| One swarm / task / agent session | `sessions` | `adw_id` = ruflo task id; `request` = the prompt; `status` = running/success/fail; `adw_name` = the command (`swarm`, `agent`, etc.) |
| Swarm phases / task sub-steps | `phases` | `kind`: `agent` for spawned agents, `code` for deterministic steps (hooks, workers), `engineer` for the orchestrator's own turns. `owner` = agent type or `orchestrator` |
| MCP tool calls, agent spawn/exit | `events` | `type`: `tool_call` for `mcp__claude-flow__*` calls; `agent_start`/`agent_end` for `agent_spawn`/exit; `log`/`error` for hook and worker events |
| Task results | `envelopes` | `output_type` = ruflo's result schema name; `payload_json` = the task result; `valid` = whether it passed schema validation |
| (new) acceptance checks | `gate_results` | Ruflo has no gates today — this is SSSF's unique value. Phase 2 emits gate rows only if/when ruflo adds acceptance checks. Until then the gates view is empty but harmless. |
| Spawned agents | `agent_sessions` | `agent` = type; `model` = the model id; `session_id` = ruflo's internal agent id |

**The emitter** lives in the TS core as a new service: `v3/@claude-flow/cli/src/services/trace-emitter.ts`. It opens `trace.db` (WAL, `busy_timeout=5000` — matching SSSF's `db.ts` settings), and the existing event-emission points in ruflo (the MCP tool dispatcher, the agent spawner, the task runner, the hook router) call `emitter.log(...)` at the same places they currently update the ledger. The emitter is the *only* writer; like SSSF's tracer, it owns the schema and the WAL mode.

**The one honest gap:** ruflo's model is not strictly phased. A swarm is more concurrent and less linear than an SSSF ADW. The `phases.seq` column imposes an order; for concurrent agents we assign `seq` by spawn order and rely on `events.started_at`/`ended_at` for the true timeline (the visualizer already renders durations from timestamps, not just seq). This works but the waterfall will look busier/noisier than SSSF's tidy linear chains — which is an *accurate* representation of what ruflo does.

**Exit criterion for Phase 2:** `npx ruflo ui` shows live ruflo swarm activity — agents spawning, tool calls streaming in, costs accumulating — with no SSSF run required.

### Phase 3 (deferred) — Generalize, only if needed

Only if the Phase 2 mapping proves painful (the phase metaphor fights ruflo's concurrency too hard, or the UI hardcodes SSSF-specific assumptions that mislead). Then: fork the visualizer, generalize `shared/types.ts` to a ruflo-native schema (e.g. drop the strict phase kind enum, add a `swarm_id` parent, add concurrent-lane rendering), and rename/rebrand. **Not now** — the schema is close enough, and forking means owning a UI codebase we don't need to own yet.

---

## Consequences

### Positive

- **Ruflo gets a real UI for the first time**, with live trace waterfalls, agent lanes, cost breakdowns, and gate verdicts — built and battle-tested-by-one-author but well-engineered (the `db.ts` code handles WAL, `busy_timeout`, optional-column migration for forward compatibility, and bounded polling correctly).
- **The UI is decoupled by design.** Because the contract is "a SQLite file with this schema," the emitter and the UI can evolve independently. Any tool that writes the schema gets the UI for free.
- **Observable ruflo is a stated goal that's currently unmet.** The ledger philosophy (`AGENTS.md`) assumes you can inspect state; a UI makes that inspection concrete for humans, not just MCP clients.
- **SSSF's gate concept** — acceptance checks per phase — is something ruflo lacks and could adopt as a side effect of this integration, giving ruflo deterministic quality gates (the real value proposition of SSSF).
- **MIT license**, compatible with ruflo. Attribution is straightforward.

### Negative

- **New runtime process.** The Bun server is a long-running process on port 4600 (configurable). Ruflo today is process-per-command; adding an optional server is a model shift. Mitigation: it's opt-in (`npx ruflo ui`), read-only, and not required for any ruflo functionality.
- **New prerequisite: Bun.** Ruflo's current runtime is Node ≥20. The visualizer server uses `bun:sqlite` (Bun-native). Options: (a) require Bun when `ruflo ui` is invoked, (b) port the server to Node + `better-sqlite3` (the server is ~200 lines, the port is mechanical). Recommend (b) for Phase 2 to avoid a second runtime — see *Open questions*.
- **Schema impedance for concurrent swarms.** SSSF's schema assumes linear phased runs. Ruflo's swarms are concurrent. Phase 2 handles this with timestamp-based timelines, but the UI's mental model (tidy phase chains) won't perfectly match ruflo's reality. Phase 3 (fork) exists as the escape valve.
- **Vendor coupling to a 4-day-old project.** SSSF is brand-new (created 2026-08-02, single commit, 8 open issues). Pinning to a specific commit SHA (not `main`) and vendoring (not depending on upstream live) mitigates this. The visualizer is ~30 files; vendoring is cheap.
- **Two trace stores** (ruflo's AgentDB `agentdb.rvf` + the new SQLite `trace.db`) for the foreseeable future. They serve different purposes (AgentDB = semantic memory / vector search; trace.db = temporal event log for the UI), but it's another store to keep coherent.

### Neutral

- Establishes `docs/adrs/` at the repo level. Future cross-cutting ADRs land here; plugin-scoped ADRs stay at `plugins/<name>/docs/adrs/`.

---

## Alternatives considered

### A. Build a UI from scratch

Rejected for Phase 1. Ruflo's value is orchestration, not UI. The visualizer is well-built, MIT, and solves exactly this problem. Building from scratch delays the "ruflo has a UI" milestone by weeks for no unique capability. Revisit only if Phase 3 (generalize) reveals fundamental mismatches.

### B. Use a generic APM/dashboard tool (Grafana, etc.)

Rejected. Ruflo's events are semantic (agent spawns, tool calls, gate verdicts, envelope contents), not metrics. A generic dashboard can chart token costs but can't render "the planner agent called `grep` then produced this envelope, which failed this gate." The visualizer's components (`PhaseDetail`, `SessionTrace`, envelope/gate renderers) are purpose-built for agentic traces.

### C. Expose ruflo state only via the existing `ruflo-status` skill

Rejected. That's text-in-a-terminal. The whole point is a visual, live, explorable view. They're complementary, not alternatives.

### D. Fork the visualizer immediately (Phase 1)

Rejected as premature. The schema mapping hasn't been validated against real ruflo telemetry yet. Running upstream unchanged for Phase 1 proves the data path before we own the code. Fork in Phase 3 only if needed.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| SSSF schema can't cleanly express ruflo's concurrent swarm model | Medium | Phase 2 validates this with real telemetry. Phase 3 (fork) is the escape valve. The `events` table is general enough (parent_id for nesting, timestamps for true ordering) that most ruflo activity maps without distortion. |
| Bun prerequisite fragments the runtime | Medium | Port the ~200-line server to Node + `better-sqlite3` in Phase 2. The Vue SPA is runtime-agnostic (built static assets). |
| SSSF upstream instability (4 days old, 8 open issues) | Medium | Vendor at a pinned SHA under `v3/ui/visualizer/`. Don't track `main`. The visualizer is decoupled enough that upstream churn in the Python control plane doesn't affect us. |
| Two stores (AgentDB + trace.db) drift out of sync | Low | They serve different read patterns. Document the boundary: AgentDB = queryable semantic memory (vector); trace.db = append-only temporal event log (the UI's source). No cross-store consistency required. |
| Gate view is empty for non-SSSF ruflo runs (Phase 2) | Low | Honest representation — ruflo has no gates yet. The empty state is accurate. If ruflo adopts gates (a likely follow-on), the view fills naturally. |

---

## Verification

**Phase 1:**
```bash
# Vendor the visualizer (pinned SHA)
# Run an SSSF-bridged ADW through ruflo (per companion integration)
npx ruflo ui --db .ruflo/trace.db
# Expected: browser opens, the SSSF run appears with live phase waterfall + cost breakdown
```

**Phase 2:**
```bash
# Run a native ruflo swarm with the trace emitter active
npx ruflo swarm "refactor the auth module" --trace
npx ruflo ui
# Expected: swarm appears as a session; spawned agents render as lanes;
#           MCP tool calls stream as events; costs accumulate live
```

**Schema conformance** (both phases): the emitter must produce a db that passes the visualizer's own startup checks — `PRAGMA journal_mode` = `wal`, all six tables present, `busy_timeout` set. If the visualizer's `/api/health` returns `ok: true`, the schema contract is met.

---

## Open questions (to resolve before Phase 2 implementation)

1. **Node port or Bun dependency?** The server is ~200 lines using `bun:sqlite` and `Bun.serve`. A Node port (`better-sqlite3` + `node:http` or Fastify) removes the Bun prerequisite but means we own the server. **Recommendation: port in Phase 2** — keeps ruflo single-runtime (Node ≥20) and the port is mechanical. The Vue SPA stays as-is (built static assets, served by whichever server).
2. **Where does `trace.db` live?** Proposed default: `<workspace>/.ruflo/trace.db` (gitignored). Confirm this doesn't collide with existing `.ruflo/` usage (there is no `.ruflo/` dir today — `.claude/`, `.agents/`, `.harness/` are the existing dot-dirs).
3. **Does the emitter write synchronously or batch?** SSSF's tracer writes per-event (each tool call = one INSERT, mid-run). For ruflo's higher event volume (314 tools, concurrent agents), a batched writer (flush every N ms or N events) may be needed to avoid write contention even with WAL. Benchmark in Phase 2.
4. **Gate adoption scope.** If this ADR's Phase 2 exposes the empty gates view, do we want to spec a ruflo-native gates concept (acceptance checks on task results) as a follow-on ADR? This is where SSSF's real value — "code disposes, gates verify" — could cross-pollinate into ruflo. Out of scope for this ADR; flag for a future ADR-0002.

---

## Related decisions

- **Companion integration (backend):** A separate design (not yet an ADR) covers using SSSF's *control plane* — phased pipelines, envelopes, gates — inside ruflo, with a `agent_ruflo.py` backend that spawns ruflo agents instead of Pi. This ADR (the UI) is **independent of that**: the visualizer works whether ruflo runs SSSF ADWs or native swarms, because it reads the trace db, not the control plane. The two designs compose: Phase 1 of this ADR is accelerated by the backend integration (SSSF runs produce traces immediately); Phase 2 stands on its own.
- **Establishes `docs/adrs/` at repo level.** Plugin-scoped ADRs (`plugins/<name>/docs/adrs/0001-...`) continue unchanged. This is the first repo-level ADR.
