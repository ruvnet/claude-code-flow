# ADR-385 — Streaming Interactive Long-Horizon Swarm Execution

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** ruflo CLI maintainers, ruOS console integration owner
**Supersedes/relates:** #1423 (swarm start was stub-only), ADR-020 (headless worker executor), ADR-069 (production LLM key), ADR-330 (pheromone-adaptive scheduling). In-tree instance: `v3/@claude-flow/cli/src/services/swarm-executor.ts` + `swarm-executor-events.ts`, wired into `commands/swarm.ts`.

---

## Context

`ruflo swarm start` did not execute anything. It printed the objective, printed an Agent Deployment Plan table, called MCP `swarm_init`, wrote `.swarm/state.json`, printed "execution happens via claude -p / hive-mind spawn --claude", and returned (`commands/swarm.ts` ~lines 664-671 before this change). The roster in `getAgentPlan(strategy)` was real; nothing consumed it. A user — or the ruOS console driving the CLI over an SSE `/run` endpoint — got a plan and a deferral, never a result.

We already spawn headless `claude -p` correctly elsewhere: `services/headless-worker-executor.ts` pipes the prompt over stdin (never a shell/argv token), scrubs the nested-session env markers, detaches the child into its own process group, and kills the group on timeout. That machinery was never connected to `swarm start`.

We want `swarm start` to actually run the objective as a **streaming, bounded, multi-agent flow** whose live NDJSON output the console can tail, and which ends with a structured overview of what was done, where the artifacts are, and how to run/deploy them.

---

## Decision

`swarm start` executes by default. It builds a roster from the strategy plan, spawns each planned worker as a real headless `claude -p` subprocess, interleaves their reshaped output as NDJSON on stdout, and reduces to a structured overview. Execution is bounded (concurrency cap, per-worker timeout, global deadline, process-cap via `--max-agents`) and safe (objective is prompt text only, never shell; capability bounded by `--allowedTools`, never skip-permissions; secrets redacted from every streamed byte). `--no-execute` restores the plan-only behavior.

The engine lives in two new modules to keep `swarm.ts` thin and the pure pieces unit-testable without a subprocess:

- `services/swarm-executor-events.ts` (pure): per-role prompt derivation, `stream-json` → NDJSON reshaping, secret redaction, artifact extraction, overview builder + human card.
- `services/swarm-executor.ts` (impure): spawn/pool/deadline engine, transcript sink, guidance inbox.

**Coordination model (I1):** deterministic fan-out → parallel workers → deterministic reduce. Per-worker prompts are a pure function of `(objective, role, purpose)`. An LLM coordinator pass that hands bespoke subtasks to each worker and an LLM reduce are deferred (I1.5) — the deterministic path is what ships and what the tests pin.

---

## Implementation

### I1 — streaming execution (`swarm start --execute`, default true)

- `buildWorkerSpecs(objective, agentPlan, {maxAgents, model})` expands the strategy plan's role/count rows into individually named workers (`coder-1`, `coder-2`), truncated to `--max-agents` (plan order preserved, so the coordinator always survives the trim).
- Each worker is spawned as `claude -p --output-format stream-json --verbose --model <m> --allowedTools <tools>` via an **argv array with `shell:false`**; the role-specific prompt is piped over **stdin** (`child.stdin.end(prompt)`). The objective is therefore never a shell string or an argv token. The nested-session env markers (`CLAUDE_SESSION_ID`, `CLAUDE_PARENT_SESSION_ID`) are deleted and `CLAUDE_ENTRYPOINT=worker` is set, matching `headless-worker-executor.ts`, so workers don't exit on a nested-session check.
- `shapeStreamLine()` reshapes each raw `stream-json` line into the CLI's own NDJSON event `{agent, role, kind, data, ts, file?}` where `kind ∈ token|tool|status|result|error`. Field mapping was verified against a real capture (checked in at `__tests__/fixtures/claude-stream-json.ndjson`): `system/init`→status, `assistant.message.content[].text`→token, `.tool_use`→tool (capturing `input.file_path` for Write/Edit/… as an artifact), `user.tool_result`→tool, `result`→result (or error when `is_error`). Events stream to stdout **as they arrive** (readline over the child's stdout), interleaved across parallel workers.
- Reduce: after all workers finish or the global deadline fires, a **deterministic merge** summarizes (`N ok, M partial, K failed`). LLM reduce is I1.5.

### I2 — structured final overview

A terminal `{"kind":"overview", overview:{…}}` NDJSON event is emitted on stdout, a human card is rendered to stderr, and with `--format json` the bare overview object is written last on stdout. It carries: objective, swarm id, topology/consensus/strategy, roster (name/role/model), **artifacts** (union of tool_use `file_path`s and the cwd git-status delta, absolute paths), per-worker status (ok/partial/failed) + error, transcript path (`.swarm/sessions/<id>/transcript.ndjson`), elapsed, reduce description, and **next steps** (review the files, run the checks, re-run hints).

### I3 — guidance inbox

`swarm guide <id> "<msg>"` appends to `.swarm/sessions/<id>/inbox.jsonl`. The running executor reads the inbox at each worker's dispatch ("between turns" for the fan-out model) and injects accumulated guidance into that worker's prompt.

### Security (hard requirements, all met)

- **No shell:** argv array + `shell:false`; objective piped over stdin. Unit test spawns a fixture binary with objective `"; rm -rf ~ #"` and asserts it is absent from the child's argv.
- **Bounded:** `--max-parallel` (default 4) concurrency, per-worker timeout, `--deadline-secs` (default 300) global deadline via a shared `AbortController`, `--max-agents` (default 4) process cap. Timeout/deadline kill the **process group** (`process.kill(-pid, SIGTERM)` then `SIGKILL` after 5s).
- **Redaction:** every streamed `data` string passes `redact()` (Anthropic/OpenAI keys, bearer tokens, GitHub tokens, `KEY=val` secrets). `process.env` is inherited for ambient auth but never emitted.
- **No escalation:** capability is bounded by `--allowedTools` (default `Read,Write,Edit,Bash,Glob,Grep`); there is no `--dangerously-skip-permissions`. Workers run in the invocation cwd (same trust boundary as the existing `/run`).
- **No silent fallback (COROLLARY 7):** every failure — spawn error, nonzero exit, `is_error` result, timeout, deadline — is surfaced as a `kind:"error"` event and a `failed`/`partial` worker status.
- **ADR-069 no-key degradation:** workers use ambient `claude -p` auth, which has no single env signal, so execution runs first and detects after. If **every** worker fails on an auth/credit error (`looksLikeAuthError`), the overview degrades honestly — its next steps state that no usable model auth was detected and point the user at the defer path (`claude -p` / `hive-mind spawn --claude` / `--no-execute` plan-only). Where auth is present (verified in the e2e), execution proceeds normally.

### Verification

- Unit: `__tests__/swarm-executor.test.ts` (20 cases) covers prompt decomposition, NDJSON reshaping against the real fixture, redaction, the overview builder, and — via an injectable `claudeBin` pointed at tiny node fixture scripts — live streaming, the shell-safety guard, nonzero-exit surfacing, timeout group-kill, bounded-concurrency runs, transcript writing, and guidance injection. `tsc --noEmit` is clean for the three changed files.
- Real e2e: `swarm start --execute` was run from the built CLI against a small verifiable objective ("create /tmp/…/hello.txt containing HELLO-SWARM") with `--max-agents 1 --model haiku`. Confirmed: NDJSON streamed to stdout as the run progressed (not buffered to the end), the file was created with the exact content, and the terminal overview named that artifact with its absolute path.

## Deferred

- **I1.5** — LLM coordinator decomposition (bespoke per-worker subtasks) and LLM reduce. The deterministic path ships.
- **I4** — federation / long-horizon resumability across sessions (checkpoint + resume of a partially-run swarm).
- **Console wiring** — the ruOS console `/run` SSE consumer that renders the stream and overview card.
- **Production deploy** — needs the ADR-069 production LLM key live; local runs use the ambient `claude -p` auth on the host.

## Consequences

`swarm start` now does work instead of deferring it, on a plain stdout pipe the console can tail. The blast radius is bounded by concurrency/deadline/process caps and the `--allowedTools` grant, and the objective can never reach a shell. `--no-execute` preserves the old plan-only contract for callers that only want the roster.
