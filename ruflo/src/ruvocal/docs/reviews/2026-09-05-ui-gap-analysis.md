# Ruflo UI and ecosystem gap analysis

**Date:** 2026-09-05
**Review status:** Source analysis complete; implementation and runtime validation tracked separately
**Implementation baseline:** `ruvnet/ruflo@db4991967c45c6f72133dff0bb80b0a492960fc1`
**Decisions:** [ADR-039](../adr/ADR-039-WORKSPACE-CAPABILITY-EVIDENCE.md), [ADR-040](../adr/ADR-040-GOVERNED-RUNTIME-INTEGRATIONS.md), [ADR-041](../adr/ADR-041-IMPLEMENTATION-OPTIMIZATION-LOOP.md)

**Implementation evidence:** [Validation report and remaining release gates](2026-09-05-workspace-validation.md).

## Decision

Evolve the existing RuVocal chat application into a workspace with visible mission drafting, searchable capabilities and truthful runtime observations. Retain the conversation product and add a bounded administrator observation API. Integrate current Ruflo status and policy surfaces first; expose Autogenous and MetaHarness as configured capabilities with explicit evidence limits; reuse ruOS's instrument panel interaction principles.

The largest gap is the distance between a sophisticated backend ecosystem and the operator's ability to discover, verify and deliberately use it. Adding package names or simulated activity would enlarge that gap. The initial implementation should make the next useful action clear and show exactly what the application has observed.

This report does not attest that the candidate is deployed, that a live integration is connected, that cryptographic receipts were verified, or that the requested validation has passed. Those claims require candidate evidence under ADR-041.

## Evidence scope and chronology

| Observation | Evidence | Implication |
| --- | --- | --- |
| Current source baseline | `db4991967c45c6f72133dff0bb80b0a492960fc1` | Immutable starting point for the implementation |
| GitHub release v3.38.21 | Published 2026-09-02 at 13:40:40 UTC | A Ruflo release record, not evidence of the web deployment revision |
| Latest inspected RuVocal path change | `40affb83fe18d35e5c290ff8a4aba425baba6ac0`, 2026-08-13 | Chat source has changes later than the older goal UI |
| Goal UI path history | `e58154a4267d406011f2d4ef63eee15a2aa129ef`, May 1 rebrand; `a10a13e623a1f7d752e95c189e07cd28b4cacfce`, May 3 fixes; `f8f4cd4bc754aeacb34a6bf11549fc7a81174e37`, May 5 environment removal | An alternate UI exists, but its history is not the target chat deployment history |
| Supplied web archive | User supplied visual capture | Useful visual context, without source or runtime attestation |

The user referred to changes since the last publication. The actual production build identity remains unverified. The correct comparison is therefore an explicitly recorded source baseline plus observed visual context until a deployment manifest, image digest or running build identifier closes that gap. A draft release or package tag cannot substitute for that evidence.

The v3.38.21 release fixes MCP HTTP memory persistence after restart. The same release notes also disclose a monorepo dependency installation gap involving an unpublished standalone `@claude-flow/mcp` version. Do not silently change dependency provenance or label a blocked install a product test failure; record the exact affected environment and use the scoped application's reproducible lockfile where available. [Release record](https://github.com/ruvnet/ruflo/releases/tag/v3.38.21).

## Source findings

### The landing page leaves useful capability undiscovered

The baseline `ChatIntroduction.svelte` renders the brand and animated dots. It deliberately references the model and message callback only to satisfy linting while the richer introduction blocks remain commented out. An operator who does not already know Ruflo's tools receives little guidance on what to ask, how to constrain a mission or how to verify available integrations. [Pinned component](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/ruflo/src/ruvocal/src/lib/components/chat/ChatIntroduction.svelte).

The proposed improvement is a compact task oriented introduction with an obvious workspace route and mission examples. Mission drafts should expose objective, constraints and acceptance conditions without granting execution authority. The business hypothesis is shorter time to a useful first request; it must be tested through a fixed task, not claimed as a measured conversion improvement.

### Conversation navigation is a useful base, but not an operations console

The existing navigation groups conversations by recency and provides MCP management through a modal. Keep those behaviors. Add a clear workspace entry point and local capability search instead of forcing operational information into an increasingly dense modal. A dedicated route also allows independent empty, failed and restricted states. [Pinned navigation](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/ruflo/src/ruvocal/src/lib/components/NavMenu.svelte).

### Configuration and capability availability are currently easy to confuse

`/api/mcp/servers` returns configured server metadata with status unset; health is determined separately. The existing health route accepts a URL, attempts Streamable HTTP and SSE, and lists tools. This establishes a useful general MCP foundation but does not provide the smaller operator controlled runtime boundary needed for an infrastructure console. [Inventory route](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/ruflo/src/ruvocal/src/routes/api/mcp/servers/%2Bserver.ts), [health route](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/ruflo/src/ruvocal/src/routes/api/mcp/health/%2Bserver.ts).

Use a separate administrator GET with fixed server destinations, bounded protocol work and a normalized DTO. Distinguish configured, reachable, advertised, authorized and outcome verified. The observation API must not inherit arbitrary browser headers or generic tool invocation arguments.

### The actual Ruflo status surface is richer than a tool count

Current source registers `system_status`, `policy_status` and `metaharness_flywheel`. The policy status returns mode, version, counts and ledger verification information. The flywheel's `status` branch reads transaction state and ledger without running evaluation or promotion. These exact registered tools can support useful bounded observations with fixed arguments.

There are limits even within those responses. `system_status` uses live process uptime, but several component health entries explicitly remain unknown. Do not turn the response's top level status into an assertion that memory, neural services and MCP are all healthy. The flywheel tool is a multiplexer whose other operations are consequential; only the exact `status` branch belongs in this observation API. [System tools](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/v3/%40claude-flow/cli/src/mcp-tools/system-tools.ts), [policy tools](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/v3/%40claude-flow/cli/src/mcp-tools/policy-tools.ts), [flywheel tools](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/v3/%40claude-flow/cli/src/mcp-tools/metaharness-tools.ts).

## Ecosystem integration assessment

| Component | Value to this UI | Verified seam | Initial scope | Later requirement |
| --- | --- | --- | --- | --- |
| Ruflo | Runtime and policy visibility | Registered status and policy tools | Exact status calls with immutable arguments | Action specific capability checks for mutations |
| MetaHarness | Candidate comparison, budgets and evidence | Ruflo flywheel status; AVO and router SDKs | Observe explicitly configured runtime; identify source | Dedicated artifact bound run and receipt adapter |
| Autogenous | Signed collaboration and governed improvement | radio-moe SDK and `@metaharness/autogenous` adapter | Discover operator deployed adapter; no invented health API | Real benchmark runner and trusted receipt verification |
| ruOS | Infrastructure health and coherent instrument panel design | Fixed authenticated health route; Svelte shell | Rendezvous health only | Tenant scoped fleet adapter and separate action authorization |

### MetaHarness

Pinned at `42f568b7297c59065ea562247937bb25cd353a6a`, AVO 0.2.0 exports versioned contracts for resource budgets, candidates, evaluation results, action receipts and checkpoints. `EvaluationBinding` binds a result to a branch, workspace digest, state hash and action sequence. Those are useful foundations for a future implementation loop view that can explain what was checked and why a candidate was rejected. Security policy and capability expansion are not evolvable surfaces. [AVO types](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/avo/src/types.ts).

Router 0.4.0 returns a model ID, predicted quality, cost per million tokens and `metBar`. Its fallback can choose the best prediction when no candidate meets the quality threshold. That fallback should be shown as a threshold miss, not success. Historical cost and quality comparisons require the deployment's own labeled data. [Router source](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/router/src/index.ts).

AgentRadio is a deterministic local bus with logical sequence ordering, threads and mentions. It is not a network service. Importing that package does not connect independent hosts or create a durable audit store. [Bus implementation](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/radio/src/bus.ts).

### Autogenous

Pinned at `7bf327a9754ce798364dbee8b2825af42a421fd4`, radio-moe 0.3.1 provides signed frames, deterministic mixture snapshots, lineage aware support, action gates, outcome verification and a bounded evolution loop. Its Node crypto, transport and subprocess exports must remain outside the browser bundle. [Package manifest](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/packages/radio-moe/package.json), [exports](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/packages/radio-moe/src/index.ts).

The current mutation surface has five active numeric levers: `sameProvider`, `sameArch`, `sameSize`, `sourceJaccard`, and `quorumThreshold`. Weights are bounded from 0 to 0.8; quorum from 1.5 to 4. Promotion requires separation improvement of at least 0.02, all hard gates, authorization and reversibility. `sameAccuracyBand` stays frozen until its own evaluation exists. These are code constraints, not claims of production accuracy. [Evolution source](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/packages/radio-moe/src/mesh-evolve.ts).

The latest concrete integration is `@metaharness/autogenous` 0.1.0 in the MetaHarness repository. It supplies a bounded proposer, a domain promotion rule and an evaluator seam that must call the real radio-moe benchmark. It does not duplicate the benchmark or create a hosted service. Its promotion gate retains correlated and independent quality checks, cost nonregression and every blocking reason. This is the appropriate future optimization integration seam. [Adapter documentation](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/autogenous/README.md), [evaluator seam](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/autogenous/src/evaluator.ts), [domain gate](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/autogenous/src/gate.ts).

### ruOS

Pinned at `6a9be2514a20c63e570aff219944de9c38184c55`, ruOS Control is a Svelte SPA with desktop sidebar, mobile bottom navigation, instrument panels and independent settled requests. It is a strong design reference. Borrow its task grouping and explicit unavailable states while improving its smallest text and preserving Ruflo identity. [Shell](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/control/src/App.svelte), [Fleet panel](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/control/src/lib/panels/FleetPanel.svelte).

The exact health endpoint returns `{ok, services}` for `rustdesk-hbbs` and `rustdesk-hbbr`. It does not prove that a desktop can be opened or that every ruOS capability is functioning. Fleet and brain APIs have tenant and operator restrictions that should not be bypassed by an aggregated UI. [Health producer](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/service/src/serve/health.rs), [API decision](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/docs/adr/ADR-008-fleet-api-and-mcp.md).

ruOS ADR-011 describes MetaHarness as phase 2 and Autogenous as phase 3. Those are planned integrations rather than evidence that its current dashboard runs them. [ADR-011](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/docs/adr/ADR-011-ruos-control-dashboard.md).

## Contradictions and claim controls

| Observed contradiction | Resolution |
| --- | --- |
| radio-moe API documentation describes 0.1.0 source exports while package manifest is 0.3.1 with compiled exports | Pin package manifest and implementation; treat API prose as potentially stale |
| ruOS client comments call Brain routes pending while the current server mounts and tests them | Prefer implemented routes; separately verify deployed availability |
| A tool can be registered without being configured, healthy or authorized | Keep inventory, observation and authority separate |
| Ruflo release history and UI path history have different dates | Do not identify a production web version from a package tag |
| A valid signature proves a signed artifact, not an authorized or independent producer | Apply an explicit trust policy before showing verified outcome |
| Existing chat autonomy and future governed evolution have different execution boundaries | Do not imply the new observation UI retroactively secures all existing execution |

## Alternatives and tradeoffs

Scores use 1 as weakest and 5 as strongest. They are engineering judgments for this scope, not measured product outcomes. Lower migration risk receives a higher score.

| Option | Immediate user value | Source fit | Low migration risk | Truthful integration | Total |
| --- | --- | --- | --- | --- | --- |
| Extend current RuVocal with workspace and bounded observations | 5 | 5 | 5 | 5 | 20 |
| Replace chat with the older goal UI | 3 | 2 | 2 | 3 | 10 |
| Build a new ruOS style shell with all runtimes embedded | 3 | 2 | 1 | 2 | 8 |

The first option preserves authentication, conversations, model access and existing tool settings while adding useful operator tasks. It also keeps the first release's runtime authority narrow. Its cost is a staged integration: richer Autogenous and AVO evidence requires later adapters. That limitation is preferable to presenting a package import as an operational connection.

## Implementation sequence

1. Record source and visual baseline and the unresolved deployment identity.
2. Add workspace navigation, mission drafting, task examples and tool search.
3. Add the administrator runtime API with fixed endpoints, bounded discovery and exact status calls.
4. Connect safe summarized observations and show missing, degraded and unreachable states independently.
5. Apply responsive, keyboard, reduced motion and empty state corrections.
6. Run focused failure and regression checks; measure only what can be reproduced.
7. Integrate scoped commits and bind the final evidence to the candidate identity.
8. Provide the review handoff. Publication and operational promotion remain separate actions.

The current runtime design uses `GET /api/workspace` with a 5 second whole integration deadline, 256 KiB per decoded response, 1 MiB total per integration, 12 requests, 4 tool pages and 1,024 tool entries. These are proposed implementation limits, not benchmark results. A larger or more complex adapter should be justified by an observed requirement rather than enabled speculatively.

## Acceptance matrix

| Scenario | Required observation |
| --- | --- |
| No integrations configured | Useful local workspace; not configured states; zero outbound probes |
| Guest or regular user runtime request | Denial before any upstream request |
| One healthy and one failing integration | Independent states; no global blank screen |
| A remote tool description contains markup or instructions | Escaped text; no execution, credential access or policy effect |
| Tool registry includes promotion or shell tools | Discovery may display them; observation path never invokes them |
| Flywheel status is registered | Only fixed status arguments are sent |
| Slow, oversized or repeated cursor response | Cancellation at defined bounds; safe normalized failure |
| ruOS reports `ok: false` | Degraded rendezvous health, not a claim that the whole fleet is offline |
| Mission example selected | Editable draft; no provider completion or mission execution until submission |
| Phone viewport and keyboard | Reachable controls, readable content, no horizontal overflow or focus trap |
| Final candidate evidence | Source identity, executed commands, results and limitations are reviewable |

## Remaining uncertainty and next action

The biggest uncertainty is the actual deployed UI and runtime configuration. Obtain the running web build identifier and the operator's intended integration endpoints before any publication decision. Until then, compare source to source and keep live connection claims conditional on observed responses.

The immediate next action is to integrate and validate the bounded workspace candidate under ADR-041. Accept it only when a fresh session with no integrations can complete the mission drafting task while the runtime API denies unauthorized callers before any network activity.
