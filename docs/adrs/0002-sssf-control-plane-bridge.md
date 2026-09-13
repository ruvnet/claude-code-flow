---
id: ADR-0002
title: Bridge SSSF's phased control plane into ruflo via an agent_ruflo.py backend
status: Proposed
date: 2026-08-06
updated: 2026-08-06
authors:
  - stavros
  - ZCode (design)
tags: [adr, sssf, control-plane, phases, gates, envelopes, agent-backend, worktree, plugin, mcp]
related: [ADR-0001]
---

# ADR-0002 — Bridge SSSF's phased control plane into ruflo

> **Companion to [ADR-0001](./0001-sssf-visualizer-as-ruflo-ui.md).** ADR-0001 adopts SSSF's *visualizer* (the read side). This ADR adopts SSSF's *control plane* (the write side): deterministic phased pipelines, typed envelopes, and acceptance gates — the part that makes agent runs repeatable.

## Context

### The thesis both projects share

Ruflo and SSSF start from the same axiom, stated in two dialects:

- **Ruflo** (`AGENTS.md:11-19`): *"Ruflo = LEDGER/orchestrator; the host agent = EXECUTOR."*
- **SSSF**: *"Agent proposes, code disposes."*

Both reject "give the model the whole SDLC and hope." Both separate *what should happen* (deterministic) from *the work inside one step* (agentic). They differ in what each is *good at*:

| | SSSF | Ruflo |
|---|---|---|
| Control plane | Python scripts + Pydantic envelopes + gates + SQLite trace | MCP tools (314) + ledger + AgentDB |
| Executor | Pi coding agent (v1 only; `agent_cc.py` is a deliberate v2 stub) | Any host agent: Claude Code, Codex, 14 others — a swarm |
| **Strength** | **Deterministic phased pipelines with acceptance gates.** "Run it twice, get the same shape." | **Freeform swarm orchestration + memory + tools.** |
| **Gap** | One agent backend (Pi), no memory, no swarm, no tool catalog | No built-in notion of *phased acceptance* or *per-run typed trace* |

The fit is complementary, not overlapping: **SSSF's control plane is exactly the determinism primitive ruflo lacks; ruflo's agent pool + memory is exactly the capability SSSF's executor lacks.**

### What SSSF's control plane actually is (verified by reading the source)

SSSF ships as a set of `adws/adw_*.py` workflow scripts (~12 shipped) plus an `adw_modules/` package. Each ADW is a thin orchestration script (40–180 lines) that:

1. Loads + validates a roster (`sssf.config.yaml`) naming the agents it needs.
2. Establishes a `Run` (`session.ensure()`) — opens `sssf.db`, installs SIGTERM handlers so a killed run still finalizes its trace.
3. Pins a git baseline.
4. Executes a **sequence of phases** via `with run.phase(PhaseParams(...))` — the single primitive for all three phase kinds: `engineer`, `code`, `agent`.
   - **`code` phases** are deterministic Python: `git commit`, `run tests`, etc. No model touches them.
   - **`agent` phases** call one bounded agent (`ph.call(AgentCall(...))`), parse its output against a typed Pydantic envelope, then run **gates** against the claims.
   - Bounded fix/retest loops (≤3×) and review/revise loops (≤2×) live entirely in Python.
5. Emits the typed envelope + a gate verdict to `sssf.db`, then `Run.finish(accepted=verified)` returns an exit code.

The **agent backend is a single swappable file**: `agent_pi.py` spawns `pi -p --mode json`, tails its JSONL stdout, and returns the agent's JSON. It is the *only* place SSSF talks to an executor. SSSF's config schema already anticipates a backend swap — `coding_agent: pi | claude_code` — and ships `agent_cc.py` as a stub that raises.

This is the seam. **An `agent_ruflo.py` backend turns SSSF's Pi-only world into "any agent ruflo can spawn," with zero changes to phases, gates, envelopes, or trace.**

### Why an ADR

This is a non-trivial, cross-cutting integration: it introduces a new prerequisite (`uv` + Python ≥3.10), a new runtime model (a Python subprocess driven by ruflo), a vendored third-party project, and a backend contribution upstream to SSSF. It also has a genuine architectural tension that must be resolved on record — *two control planes* (ruflo's orchestrator and SSSF's phase engine) coexisting in one system. It belongs at the repo level alongside [ADR-0001](./0001-sssf-visualizer-as-ruflo-ui.md).

---

## Decision

**Bridge, don't port.** Contribute a new `agent_ruflo.py` backend to SSSF (alongside `agent_pi.py`) so SSSF's phase engine drives **ruflo-spawned agents** instead of Pi. Ship the bridge as a TS code plugin (`@claude-flow/plugin-sssf-bridge`) plus a thin Claude-Code-native plugin for the UX layer. Ruflo gains SSSF's determinism primitives; SSSF gains ruflo's agent pool, memory, and tools. The two control planes never compete because they run at different layers (see *The tension, resolved* below).

This mirrors ruflo's existing `@claude-flow/plugin-gastown-bridge` precedent almost exactly — bridge to an external orchestrator, expose its capabilities as MCP tools, list the npm package as an `optionalDependency` in the root `package.json`.

### The one new seam: `agent_ruflo.py`

SSSF's `agent_pi.py` is one file implementing a contract: given an `AgentConfig` + a rendered prompt + the `Run`, it produces the agent's JSON output (parsed against the phase's `output_type`) and emits `tool_call` events to `sssf.db`. `agent_ruflo.py` implements the same contract:

- **Spawn:** calls `mcp__claude-flow__agent_spawn` with `--type` derived from the SSSF agent name (e.g. `builder` → the ruflo builder agent type).
- **Wait:** polls `mcp__claude-flow__task_status` until the spawned agent's turn closes.
- **Collect:** returns the agent's final message as the JSON envelope payload.
- **Trace:** emits the same `tool_call` event types to `sssf.db` by tailing the spawned agent's tool events.

On a parse failure against the phase's `output_type`, **SSSF's existing bounded-retry logic applies unchanged** — it continues the same session with a correction, never a cold restart. The retry machinery is in `adw_modules/`, not in the backend, so the swap is invisible to it.

**Config extension** (one schema branch added upstream):
```yaml
# sssf.config.yaml
defaults:
  coding_agent: ruflo   # was: pi | claude_code  → now: pi | claude_code | ruflo
agents:
  - name: builder
    coding_agent: ruflo
    model: sonnet       # a ruflo model id, NOT provider/model-id
```

`agents.validate()` gains a branch: for `coding_agent == "ruflo"`, the model is a ruflo id (not `provider/model-id`), and no `OPENROUTER_API_KEY`/`FIREWORKS_API_KEY` is required (ruflo handles provider auth). This is the only change to SSSF's validation logic.

### File layout

#### New TS code plugin — `v3/plugins/sssf-bridge/`

Modeled on `v3/plugins/gastown-bridge/` (verified: `@claude-flow/plugin-gastown-bridge` exists, implements `IPlugin`, ships `src/mcp-tools.ts`, listed as `optionalDependency` in root `package.json`). Published as `@claude-flow/plugin-sssf-bridge`.

```
v3/plugins/sssf-bridge/
├── package.json                  # name @claude-flow/plugin-sssf-bridge
├── tsconfig.json
├── src/
│   ├── index.ts                  # class SssfBridgePlugin implements IPlugin;
│   │                             #   initialize / shutdown / healthCheck
│   │                             #   registerMCPTools() → the 4 tools below
│   │                             #   registerCLICommands() → `ruflo sssf ...`
│   ├── mcp-tools.ts              # zod schemas + 4 MCP tools (table below)
│   ├── stamp.ts                  # runs SSSF install.py into a leased worktree
│   ├── runner.ts                 # subprocess wrapper: uv run adws/adw_*.py
│   ├── worktree.ts               # leases a worktree via workspace-lease service,
│   │                             #   registers it with ruflo's ledger as a writer
│   ├── trace-reader.ts           # reads sssf.db (readonly, WAL-safe) for results
│   └── envelope.ts               # reads/validates sessions/<id>/envelope.json
├── python/
│   └── agent_ruflo.py            # ← the SSSF backend (§ "new seam"), shipped here,
│                                 #   symlinked into the stamped adw_modules/ at install
└── README.md
```

Registered via the TS plugin registry at `v3/@claude-flow/plugins/src/registry/plugin-registry.ts` and runtime manager `v3/@claude-flow/cli/src/plugins/manager.ts` (verified paths). Listed in root `package.json` under `optionalDependencies` (gastown-bridge pattern).

**Implements `IPlugin`** (verified interface at `v3/@claude-flow/plugins/src/core/plugin-interface.ts:38`): `initialize(context)`, `shutdown()`, `healthCheck()`, `registerMCPTools()` (the 4 tools), `registerCLICommands()` (`ruflo sssf install | run | status`).

#### MCP tools exposed (namespace `sssf_`)

Namespaced `mcp__claude-flow__sssf_*` and re-exported from `v3/@claude-flow/cli/src/mcp-tools/index.ts` so they join the 314-tool surface and become referenceable from skill `allowed-tools`.

| Tool | Input | Output | Maps to SSSF |
|---|---|---|---|
| `sssf_install` | `{worktree?, force?}` | `{worktree, version}` | `scripts/install.py` |
| `sssf_run` | `{adw, prompt, adw_id?, config?, worktree?}` | `{adw_id, exit_code, accepted, worktree}` | `uv run adws/adw_<adw>.py` |
| `sssf_session` | `{adw_id, worktree?}` | `{session, phases[], envelopes[], agents[]}` | reads `sessions/<id>/` |
| `sssf_trace_query` | `{adw_id, query, worktree?}` | structured rows | reads `sssf.db` |

Honors `.harness/mcp-policy.json` (default-deny). These tools shell out to a single blessed subprocess (`uv run`) and read files; no arbitrary shell at the MCP layer.

#### Claude-Code-native plugin — `plugins/ruflo-super-simple-software-factory/`

Thin UX layer so ruflo's host agents know *when* and *how* to invoke SSSF. Follows the 40-sibling contract exactly (manifest has only `name`/`description`/`version`/etc; skills/commands/agents auto-discovered):

```
plugins/ruflo-super-simple-software-factory/
├── .claude-plugin/plugin.json
├── skills/
│   ├── run-phased-workflow/SKILL.md      # when to choose SSSF over freeform swarm
│   └── design-acceptance-gates/SKILL.md  # how to author gates.py entries
├── commands/
│   ├── sssf.md                           # /sssf <adw> "<prompt>"  → $ARGUMENTS
│   └── sssf-install.md
├── agents/
│   └── sssf-orchestrator.md              # persona that decides SSSF vs swarm
├── docs/adrs/0001-sssf-bridge-contract.md  # plugin-level ADR (per convention)
├── scripts/smoke.sh                      # ≥8 structural checks (repo requirement)
└── README.md
```

**Two registrations in existing files:**
- `.claude-plugin/marketplace.json` — add one entry `{name, source: "./plugins/ruflo-super-simple-software-factory", description}`.
- `skills.sh.json` — add a "Software Factory" grouping so `npx skills add` picks it up.

Skills' `allowed-tools` reference `mcp__claude-flow__sssf_*`.

### The tension, resolved: two control planes, two layers

The risk a reviewer will (rightly) raise: *ruflo has a control plane (its orchestrator/ledger); SSSF has a control plane (its phase engine). Aren't they competing?*

**No — they run at different layers, and the `agent_ruflo.py` backend is precisely what keeps them from meeting:**

```
ruflo orchestrator (LEDGER layer)
  └─ decides: "this task should be a repeatable, gated, phased workflow"
     └─ calls mcp__claude-flow__sssf_run
        └─ SSSF phase engine (CONTROL PLANE layer)  ◄── runs in a subprocess
           ├─ phase: plan   → agent_ruflo.py → ruflo agent_spawn(planner)
           ├─ gate: artifacts_exist                        ◄── deterministic
           ├─ phase: build  → agent_ruflo.py → ruflo agent_spawn(builder)
           ├─ phase: test   → code (quality.run_tests)     ◄── deterministic
           └─ phase: fix    → agent_ruflo.py → ruflo agent_spawn(fixer) ...
                  ▲
                  └── the only place SSSF calls back into ruflo
```

Ruflo's orchestrator decides *whether* to use SSSF (the `run-phased-workflow` skill makes this choice); once it invokes `sssf_run`, it hands control to SSSF's phase engine for the duration. SSSF's phase engine is the control plane *for that run*; ruflo's orchestrator is the control plane *above it*. They never both try to drive the same agent turn. The single callback seam (`agent_ruflo.py → agent_spawn`) is where executor control briefly re-enters ruflo — and that's a leaf call, not a control loop.

If ruflo also wants freeform swarm behavior for a task, it doesn't call `sssf_run` — it uses its native swarm tools directly. The `sssf-orchestrator` agent exists *only* to make this routing decision.

### Worktree coordination (the non-obvious requirement)

SSSF explicitly *"runs on the current git branch, no sandbox, no branch-per-run, no merge step"* — an intentional gap it tells you to fill. Ruflo's `AGENTS.md` has a **hard invariant: no two writers in a worktree.** So:

- `sssf_install` / `sssf_run` **must** lease a worktree via `v3/@claude-flow/cli/src/services/workspace-lease.ts` before stamping/running. SSSF's commit phases then mutate *that* worktree, never the caller's.
- The bridge registers the run in ruflo's ledger as an external writer, so the orchestrator won't dispatch a conflicting agent into the same worktree.
- On `Run.finish(accepted=true)`, the bridge offers `--merge` (merge the leased worktree back); on failure, the worktree is preserved for inspection. **This fills the exact gap SSSF documents.**

---

## Consequences

### Positive

- **Ruflo gains determinism primitives it lacks** — phased pipelines with bounded retry, typed envelopes as the cross-phase context contract, and acceptance gates (the real, differentiated value of SSSF). These become available to any ruflo user via `/sssf`.
- **SSSF gains ruflo's executor.** The Pi dependency — the #1 source of SSSF's open issues (#1, #4, #5 are all `~/.pi/agent/models.json` fresh-install crashes) — is **eliminated for ruflo users**. That's a strong reason this integration is worth doing at all, and a selling point for upstreaming `agent_ruflo.py`.
- **It is a clean backend swap, not a fork.** Phases, gates, envelopes, trace, permissions, git — all of SSSF's control plane — run untouched. The swap is one file + one config branch.
- **Composes with [ADR-0001](./0001-sssf-visualizer-as-ruflo-ui.md).** SSSF runs produce `sssf.db` traces immediately, so ADR-0001's Phase 1 (the visualizer showing live traces) works out of the box the moment this bridge runs an ADW. The two ADRs accelerate each other.
- **The precedent already exists.** `gastown-bridge` is a bridge to an external Go orchestrator with its own control plane; this is the same shape against a Python orchestrator. Reviewers have a familiar reference.

### Negative

- **New prerequisites: `uv` + Python ≥3.10.** Ruflo's runtime is Node ≥20 (plus an optional Rust surface for federation). Adding Python is a real dependency cost. Mitigation: the TS plugin is an `optionalDependency`; `sssf_install` checks for `uv` and degrades gracefully. Users who don't invoke `/sssf` never need Python.
- **Vendor coupling to a 4-day-old project.** SSSF is brand-new (created 2026-08-02, single commit, 8 open issues, no test suite). Mitigation: pin to a specific commit SHA, vendor `templates/` (not track `main`), and the bridge's `smoke.sh` asserts SSSF stamps cleanly before exposing `sssf_run`.
- **Two trace stores, for now.** SSSF writes `sssf.db`; ruflo's AgentDB is `agentdb.rvf`. [ADR-0001](./0001-sssf-visualizer-as-ruflo-ui.md) Phase 2 unifies these by streaming SSSF trace events into a ruflo-native emitter, but until then they coexist (they serve different read patterns — see ADR-0001).
- **Upstream coordination cost.** `agent_ruflo.py` is genuinely useful to SSSF (it's the first non-Pi backend, and SSSF's own `agent_cc.py` is a stub). But upstreaming means tracking SSSF's review cadence on a brand-new repo. Fallback: ship the backend in `v3/plugins/sssf-bridge/python/` and symlink it into stamped `adw_modules/` at install time, so ruflo is never blocked on upstream.
- **Schema impedance is ADR-0001's problem, not this one.** Flagged for completeness: ruflo's concurrent swarms don't map perfectly onto SSSF's linear phased chains. That's a *visualization* concern (ADR-0001 Phase 3), not a *control-plane* concern — SSSF runs are deliberately linear, which is the point.

### Neutral

- Adds a third entry to SSSF's `coding_agent` enum (`pi | claude_code | ruflo`). Upstream PR; if declined, ruflo vendors the config schema branch.

---

## Alternatives considered

### A. Shallow wrapper — skills/commands that `bash` SSSF's CLI directly

Rejected as the *whole* answer (kept as the UX layer on top of the bridge). No structured output back to the agent; ruflo can't enforce its worktree invariants; SSSF still spawns Pi, so you get **two executors** (Pi + ruflo's host agent) and the competing-control-plane problem becomes real. The backend swap exists precisely to avoid this.

### B. MCP bridge only, no backend swap

Half-measure. SSSF still spawns Pi — you get the two-executor problem and gain nothing over A. The whole value is that `agent_ruflo.py` makes ruflo the single executor.

### C. Port SSSF's primitives into ruflo natively (phase/gate/envelope as new MCP concepts)

Tempting long-term, **premature now.** SSSF is 4 days old, single commit, no tests, 8 open issues. Porting today means re-implementing a moving target in TypeScript and maintaining it ourselves. Bridge now; port only if (a) SSSF stabilizes and (b) ruflo wants the primitives as first-class MCP concepts rather than a subprocess. This is the explicit Phase 3 escape hatch.

### D. Don't integrate; let ruflo users run SSSF standalone

Rejected. SSSF standalone means Pi as executor (with its fresh-install fragility), no ruflo memory/tools/agents, no worktree coordination. The integration's value is precisely that ruflo *is* the executor.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **SSSF is 4 days old, single commit, no tests, 8 open issues** (#1/#4/#5 = Pi/`models.json` fresh-install crashes) | High | Pin to a specific commit SHA; bridge's `smoke.sh` asserts clean stamp before exposing `sssf_run`; `agent_ruflo.py` eliminates the Pi fragility for ruflo users. |
| **Pi dependency is the #1 SSSF issue source** | High | `agent_ruflo.py` removes it entirely for ruflo — turns this risk into a selling point. |
| **`agent_cc.py` is a stub** — SSSF's own Claude Code backend doesn't exist yet | Medium | Our `agent_ruflo.py` is the first non-Pi backend; coordinate via upstream issue/PR rather than diverging. |
| **Two control planes** (ruflo orchestrator + SSSF phase engine) | Medium | Resolved by layering (see *The tension, resolved*). The `agent_ruflo.py` seam is a leaf call, not a loop; the orchestrator hands off for the duration of a run. |
| **Python/`uv` prerequisite fragments the runtime** | Medium | TS plugin is `optionalDependency`; `sssf_install` detects + degrades. Non-`/sssf` users never need Python. |
| **`diff_matches_claims` gate is acknowledged weak** (SSSF issue #6) | Low | Inherited SSSF limitation; documented. Gates are SSSF's responsibility, not the bridge's. Users author their own gates. |
| **Upstream declines the `coding_agent: ruflo` branch** | Low | Vendor the config schema branch in the stamped `sssf.config.yaml`; the bridge owns the symlinked `agent_ruflo.py` regardless. |
| **License** | None | Both MIT — compatible. Attribution in plugin README. |

---

## Phased rollout

**Phase 0 — Spike (1–2 days).** Hand-build `agent_ruflo.py` against SSSF's `agent_pi.py` contract; prove one ADW (`adw_simple_sdlc`) runs end-to-end with a ruflo-spawned builder. No plugin packaging.
*Exit criterion:* `uv run adws/adw_simple_sdlc.py "add /health"` succeeds with `coding_agent: ruflo`, exit code 0, `envelope.json` populated, gate verdicts in `sssf.db`.

**Phase 1 — Bridge plugin (the MVP above).** Package `v3/plugins/sssf-bridge/` + `plugins/ruflo-super-simple-software-factory/`. Worktree leasing. Upstream the `agent_ruflo.py` PR to SSSF.
*Exit criterion:* `/sssf simple_sdlc "..."` works from a ruflo host agent; `scripts/smoke.sh` + `scripts/smoke-all-plugins.mjs` pass; `marketplace.json` + `skills.sh.json` registered.

**Phase 2 — Observability unification** (depends on [ADR-0001](./0001-sssf-visualizer-as-ruflo-ui.md) Phase 2). Stream SSSF trace events into the ruflo-native emitter so there's one observability surface. Deprecate direct `sssf.db` polling from the bridge.

**Phase 3 — Native primitives (only if SSSF stabilizes).** Revisit Alternative C: promote `phase`/`gate`/`envelope` to first-class ruflo MCP concepts so the determinism model isn't owned by a bridged subprocess.

---

## Verification

**Phase 0 spike:**
```bash
# Clone SSSF into a scratch dir, stamp into a test repo, swap the backend
git clone https://github.com/disler/super-simple-software-factory /tmp/sssf @<pinned-sha>
cd /tmp/test-repo && uv run /tmp/sssf/.claude/skills/sssf/scripts/install.py
# Drop agent_ruflo.py into adws/adw_modules/, set coding_agent: ruflo in sssf.config.yaml
uv run adws/adw_simple_sdlc.py "add a /health endpoint"
# Expected: exit 0; sessions/<id>/envelope.json populated; sssf.db gate_results rows present
```

**Phase 1 plugin:**
```bash
bash plugins/ruflo-super-simple-software-factory/scripts/smoke.sh   # ≥8 checks
node scripts/smoke-all-plugins.mjs                                   # repo-wide
npx ruflo sssf install                                               # stamps into a leased worktree
npx ruflo sssf run --adw simple_sdlc "add a /health endpoint"        # end-to-end
# Expected: accepted=true; the leased worktree has the commit; merge back succeeds
```

---

## Open questions (to resolve before Phase 1 implementation)

1. **Model id mapping.** SSSF config uses `provider/model-id` for Pi; ruflo uses short ids (`sonnet`, `opus`). The `agent_ruflo.py` branch needs a small resolver. Confirm the canonical ruflo model id list (from the agent type definitions) and whether the SSSF `model` field should accept a ruflo id directly or a new `ruflo_model` key.
2. **Tool catalog translation.** SSSF's `tools` allowlist (`read`, `bash`, `edit`, `grep`, ...) maps to ruflo's MCP tools (`mcp__claude-flow__*`) but not 1:1. Decide: map SSSF capability names to ruflo tool sets at the backend boundary, or pass the allowlist through and let `agent_spawn` enforce it.
3. **Memory injection.** Should a ruflo-spawned agent inside an SSSF phase have access to AgentDB memory? Default yes (it's a ruflo agent), but this changes SSSF's "agents are stateless across runs" assumption. Flag for the spike.
4. **Upstream PR scope.** Is `agent_ruflo.py` + the `coding_agent: ruflo` config branch enough, or does SSSF want the ruflo-agent-spawn MCP client as a documented reference? Decide before opening the upstream issue.

---

## Relationship to ADR-0001

This ADR (the control plane / write side) and [ADR-0001](./0001-sssf-visualizer-as-ruflo-ui.md) (the visualizer / read side) are **independent but complementary**:

- **Independent:** each can be implemented and merged without the other. ADR-0001's Phase 2 (ruflo-native emitter) works for native swarms with no SSSF involvement; this ADR works with no UI (results land in `sssf.db` / `envelope.json`, readable by CLI).
- **Complementary:** this ADR's SSSF runs produce `sssf.db` traces immediately, giving ADR-0001's Phase 1 (the upstream visualizer) real data to show on day one. ADR-0001's Phase 2 eventually unifies the trace stores. The two Phase 2s converge on one observability surface.

**Recommended merge order:** ADR-0001 first (the UI is lower-risk — read-only, no new executor). This ADR second (the backend swap is higher-value but higher-risk, and benefits from the UI existing to visualize spike results).
