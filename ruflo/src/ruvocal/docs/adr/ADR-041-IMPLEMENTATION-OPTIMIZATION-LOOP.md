# ADR-041: Evidence bound implementation and optimization loop

**Status:** Proposed
**Date:** 2026-09-05
**Source baseline:** `ruvnet/ruflo@db4991967c45c6f72133dff0bb80b0a492960fc1`
**Related:** [ADR-039](ADR-039-WORKSPACE-CAPABILITY-EVIDENCE.md), [ADR-040](ADR-040-GOVERNED-RUNTIME-INTEGRATIONS.md), repository `AGENTS.md` and Ruflo ADR-322A/324/325 policy

## Context

The requested work combines a user interface redesign, ecosystem integration, security validation and optimization. A polished screenshot is insufficient evidence for the integration; passing library tests is insufficient evidence for the interface; a published package version is insufficient evidence for the deployed web application.

The repository guide assigns coordination and policy decisions to Ruflo and execution to Codex workers. It requires isolated worktrees, scoped ownership, constrained delegation, source bound evidence and a separately authorized release gate. MetaHarness evaluation must not silently promote a candidate or expand the safety envelope.

## Decision

Use a bounded SPARC implementation loop with explicit source identities, predeclared acceptance conditions, independent scopes and an evidence receipt for the final candidate. Optimize measured bottlenecks only. Preserve all failed and unmeasured gates in the final report.

The work may create reviewable source, tests and ADRs. It must not publish the website, merge a release, install remote adapters, provision ruOS resources or promote a candidate without separate authorization. A local commit and review branch do not constitute deployment.

## Inputs, outputs and ownership

| Workstream | Inputs | Outputs | Assumptions and boundary |
| --- | --- | --- | --- |
| UI and mission flow | Baseline SvelteKit application, supplied archive, user objective | Workspace, entry points, search and draft interaction | No automatic mission execution |
| Runtime observation | Existing admin auth and fixed operator endpoint configuration | Bounded status API and focused tests | No arbitrary destinations, arguments or consequential tools |
| Source delta and bridge | Git history, current tools and bridge groups | Source inventory and restricted operational exposure where implemented | Source history does not prove production revision |
| Architecture review | Source evidence and proposed implementation | ADRs, gap analysis, risks and acceptance matrix | Documentation does not assert unexecuted tests passed |
| Integration and verification | Scoped commits and actual runtime | Candidate evidence, corrections and review handoff | Only the coordinator integrates workstreams |

Each writer owns an isolated worktree and exact files. When a tracked collaboration harness exists, acquire the relevant session and resource leases before edits and release them at handoff. A lease coordinates work; it does not grant an action capability. Where no runnable lease harness is present, explicit scoped ownership and isolated worktrees remain mandatory.

## SPARC gates

### 1. Specification

Freeze the tasks and safety invariants before optimizing:

1. Users can identify a useful task, draft a mission, find a tool and return to chat.
2. Missing integrations are truthful and do not break the local experience.
3. Runtime discovery is admin only, finite and restricted to documented status calls.
4. Operator secrets remain server side.
5. No new path executes an autonomous mission or promotes code without the existing authority checks.
6. Normal chat, navigation, model selection and settings continue working.

### 2. Pseudocode

```text
record immutable baseline and environment
recall relevant Ruflo memory and inspect current source
assign isolated scopes and acceptance conditions

for each candidate iteration within the agreed scope:
    implement the smallest change addressing an observed gap
    run focused functional and failure checks
    inspect desktop and mobile behavior
    measure only the relevant performance dimensions
    compare with the same baseline, fixture and environment
    if a hard invariant fails:
        repair or revert before continuing
    if a metric is unmeasured:
        record unknown rather than invent improvement
    retain source identity, outputs and failure evidence

integrate reviewed scopes
run the necessary combined regression checks
bind evidence to the final immutable candidate
handoff reviewable source and unresolved risks
do not infer deployment or promotion authorization
```

### 3. Architecture

Ruflo records coordination and policy context. Codex workers perform edits and execute validation. MetaHarness patterns structure evaluation, candidate comparison and recovery. Autogenous's bounded mutation and conjunctive promotion rules constrain any future learned tuning. The UI presents observations without becoming the release authority.

Do not claim the standalone MetaHarness or Autogenous runtime ran unless command outputs or signed receipts demonstrate that invocation. A deterministic local validation harness is useful but must be named accurately. Root coordination may use an initialized local memory store when prior memory is absent; absence of historical memory is a disclosed input condition, not a failed implementation.

### 4. Refinement

Perform focused validation first, then broaden only to resolve a remaining concrete risk or required repository gate. Record baseline failures separately from newly introduced failures. An unavailable package registry, browser, service credential or remote endpoint must be reported with the exact affected check rather than converted into a pass.

Use before and after screenshots for responsive behavior, not for backend verification. Use API tests and observed transport logs for the runtime boundary. Use actual production build output for bundle measurements. Do not import benchmark numbers from unrelated upstream packages into this UI's claims.

### 5. Completion

The completion artifact is an integrated source commit or immutable source snapshot plus reviewable evidence. An ADR remains Proposed until the responsible reviewer accepts the implementation and its evidence. The final handoff states what changed, what ran, what remains unverified and what release action would require authorization.

## Measurement plan

Targets below are candidate acceptance criteria. They are not measured results.

| Measure | Baseline procedure | Candidate criterion |
| --- | --- | --- |
| Capability discovery | Open baseline landing page and count actions to tool inventory | Workspace provides a visible route and local search without a provider call |
| Mission drafting | Attempt the same objective in the baseline | Objective, constraints and acceptance condition can be prepared before submission |
| Mobile usability | Capture at 390 by 844 CSS pixels using the same browser | No horizontal overflow; primary controls usable; text readable; nav accessible |
| Keyboard usability | Follow a fixed tab sequence | All primary actions reachable; focus visible; no new trap |
| Status isolation | One healthy fixture and one failing fixture | Healthy result survives; failed result does not become zero or healthy |
| Authorization | Guest and regular user requests | 401 or 403 before outbound activity |
| Runtime resource budget | Slow, oversized and paginated fixtures | Every request stays within ADR-040 constants and releases resources |
| Secret boundary | Token canaries in server config and malicious error payloads | Canaries absent from response, browser bundle and user visible logs |
| Browser JavaScript | Production route chunks from baseline and candidate | Record added bytes; justify required dependencies; no Node runtime imports |
| Status latency | Repeated fixture probes under the same environment | Report median and p95 with sample count; comply with timeout bound |
| Chat regression | Existing conversation, model selection and submission tasks | No regression attributable to the candidate |

For latency comparisons, distinguish cold process startup, warm handler cost and upstream service delay. A reasonable local fixture sample is 20 or more completed probes, but a small sample must not be described as a production p99 guarantee. For any percent improvement, publish both raw baseline and candidate values, the formula and the environment. If baseline measurement is unavailable, report only the observed candidate and label comparison unavailable.

Do not tune the suite against the final candidate until it passes. Keep the critical fixtures and gates fixed across iterations. Any deliberate change to a gate requires a recorded reason and rerunning both baseline and candidate where comparison remains meaningful.

## Evidence receipt

The final evidence record should identify:

```json
{
  "schemaVersion": 1,
  "baselineCommit": "db4991967c45c6f72133dff0bb80b0a492960fc1",
  "candidateCommit": "to be populated after integration",
  "sourceSnapshotDigest": "required if candidate is not a clean commit",
  "environment": {
    "runtimeVersion": "observed value",
    "packageLockDigest": "observed value",
    "browserVersion": "observed value or unavailable"
  },
  "checks": [],
  "measurements": [],
  "unverified": [],
  "deployment": { "performed": false, "authorizationRequired": true }
}
```

This is a schema example, not an executed receipt. Each check records command or procedure, scope, exit status, time, artifact identity and evidence path. Credentials and raw private prompts are excluded. A source hash identifies content; it does not establish signer trust or approval.

## Failure modes and recovery

| Failure | Consequence | Fix path |
| --- | --- | --- |
| Stale source or deployment assumption | Wrong claims about what changed since publication | Record source history separately and obtain actual deployment build identity before release |
| General status multiplexer receives user arguments | Mutation through an observation endpoint | Immutable call allowlist and negative argument tests |
| Tool list or remote stream is unbounded | Server resource exhaustion | Byte, request, page and time caps with cancellation |
| Optimizer changes tests or authority | Apparent improvement with weaker guarantees | Freeze protected paths, policies and evaluation fixtures |
| Candidate benchmark uses a different environment | Misleading performance comparison | Same environment or clearly separated incomparable observations |
| UI shows unsigned input as verified evidence | False assurance | Separate received, parsed, signed and trust verified states |
| Worktree collisions | Lost edits or invalid candidate identity | Isolated writers and exact scoped handoff |
| Release inferred from task completion | Unreviewed production changes | Explicit final release authorization gate |

Rollback is a source revert to the last reviewed commit, with operator integration configuration disabled independently if needed. No UI rollout should rewrite conversation storage. A future operational promotion must retain an independently verifiable rollback target; this implementation loop does not execute that promotion.

## Acceptance test

From the final source identity, run the fixed guest, nonadministrator, missing endpoint, malicious payload and slow endpoint fixtures, then complete the mission drafting task on a narrow viewport. The result is acceptable only when the authority boundaries remain intact and every reported metric can be traced to a recorded observation. Publication is a separate decision.
