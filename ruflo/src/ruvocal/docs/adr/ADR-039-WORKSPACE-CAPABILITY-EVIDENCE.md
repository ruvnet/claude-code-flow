# ADR-039: Workspace capability evidence and operator experience

**Status:** Proposed
**Date:** 2026-09-05
**Source baseline:** `ruvnet/ruflo@db4991967c45c6f72133dff0bb80b0a492960fc1`
**Related:** [ADR-035](ADR-035-MCP-TOOL-GROUPS.md), [ADR-040](ADR-040-GOVERNED-RUNTIME-INTEGRATIONS.md), [ADR-041](ADR-041-IMPLEMENTATION-OPTIMIZATION-LOOP.md)

## Context

The existing RuVocal application is a SvelteKit chat product inside `ruflo/src/ruvocal`. Its landing component primarily renders a logo; descriptions, model information and examples are commented out in the inspected baseline. Navigation emphasizes conversations and exposes MCP management through a modal. This makes the first useful task difficult to discover and conceals the relationship between a configured tool and an operational capability.

The surrounding Ruflo stack has acquired governance, collaboration and optimization mechanisms that cannot be represented accurately by a static tool total or an optimistic connection indicator. A tool may be registered but unconfigured, unreachable, unsupported by the current host, unauthorized for the caller, or unverified on the deployed build. These are separate facts.

The user requested a substantial UI improvement and integration of changes since publication. The available source commit is an engineering baseline, not proof of the production revision. The supplied web archive is visual context; it does not attest runtime services, credentials, build identity or deployment date.

## Specification

Inputs are the existing chat application, operator configured runtime discovery from ADR-040, the current user's existing MCP tool inventory, and source pinned capability descriptions. Outputs are a workspace console, searchable tools, a mission draft, clearer chat entry points, and explicit evidence states. No source description, mission template or discovery result grants execution authority.

The initial workspace must support these tasks:

1. Understand what Ruflo can help accomplish without memorizing package names.
2. Find an available tool by name or description and identify its source.
3. See which operator integrations are configured and which were successfully checked.
4. Draft a bounded mission with an objective, constraints and an acceptance condition.
5. Continue through the existing chat submission and execution path deliberately.
6. Return to conversations without losing the familiar interaction model.

The workspace may be visible without operational privileges. Runtime metadata must remain restricted to an authenticated administrator under ADR-040. An administrator requirement should be described as a visibility boundary, not as an integration failure.

## Decision

Add a dedicated `/workspace` console and retain the existing conversation routes. Improve the chat introduction and navigation so the console and mission examples are discoverable. Group information by operator task: mission, capabilities, runtime connections and verification. Reuse ruOS instrument panel principles while keeping Ruflo branding and the existing SvelteKit application.

Use separate evidence dimensions:

| Dimension | Meaning | Evidence required |
| --- | --- | --- |
| Documented capability | A pinned source implements or specifies an interface | Repository, commit and source path |
| Configured integration | The operator supplied a valid deployment configuration | Server configuration validation |
| Reachable integration | The configured service answered the bounded probe | Timestamp, probe type and outcome |
| Advertised tools | A remote MCP deployment returned tools | Valid bounded `tools/list` response |
| Execution authority | A particular actor can perform a particular action now | Existing authoritative policy and execution path |
| Verified outcome | An evaluator checked a particular artifact | Artifact identity and trusted evaluator receipt |

Do not collapse these dimensions into a single universal readiness score. A discovery result can establish reachability and advertised tools; it cannot establish safe execution, workload success, cryptographic verification or full upstream integration.

Represent missing values as unknown or unavailable. Zero is reserved for an observed count. A configured endpoint that cannot be reached is different from an absent endpoint. A successful check has an observation time; previously observed success becomes stale when it can no longer be refreshed.

Static integration descriptions must identify their role and limits. Examples are examples, not active missions. A draft remains editable text until the user submits it through the existing chat interaction. Merely visiting the workspace, selecting a template, copying text or filtering tools must not start an autonomous process. Administrator runtime observations may use only the fixed read only status calls in ADR-040; they must not invoke mission actions or provider completions.

## Architecture and data boundaries

The browser renders view models and existing user scoped tool metadata. The same origin server route performs privileged discovery. The browser does not receive operator bearer tokens, unrestricted environment configuration, raw service URLs with credentials, or arbitrary upstream error bodies.

The tool search operates on already available inventory. Search results are escaped text. Descriptions from remote servers are untrusted content and cannot modify application instructions, configure an integration or initiate navigation to arbitrary resources.

The first implementation does not import Autogenous's Node transport into the browser. It does not embed MetaHarness's repository executor or ruOS's fleet mutation API. Those interfaces require dedicated server adapters and explicit policy review.

## Interaction and visual requirements

1. Use a compact desktop navigation and a usable mobile route to the same functions. Prioritize a visible mission entry point over decorative animation.
2. Keep body and operational text readable at phone sizes; target at least 14 CSS pixels for meaningful content and 44 CSS pixels for primary touch targets.
3. Support keyboard navigation, visible focus, labeled controls and semantic heading order. Communicate state with text as well as color.
4. Honor reduced motion. Any background effect must leave controls readable and must not intercept pointer input.
5. Preserve layout when an integration errors, returns no tools or is not configured. Independent failures must not blank the entire console.
6. Keep a clear difference between an action that drafts text, an action that requests discovery and an action that submits a mission.
7. Do not display fabricated activity, agents, spend, throughput, success rates or safety scores.

The ruOS shell uses a sidebar that becomes bottom navigation below 640 pixels and groups service observations with related controls. Those design principles are reusable. Its smallest operational text and static token entry behavior should not be copied uncritically.

## SPARC plan

| Phase | Input | Output | Gate |
| --- | --- | --- | --- |
| Specification | Baseline source, task and runtime limits | Operator tasks and evidence invariants above | No ambiguous execution semantics |
| Pseudocode | Available local data and runtime DTO | Deterministic empty, loaded and failed view states | Unknown cannot become healthy implicitly |
| Architecture | Existing chat, navigation and server auth | Workspace route with separate discovery boundary | No new execution path |
| Refinement | Candidate source and fixed browser tasks | Functional checks, responsive inspection and corrections | No regression in chat navigation or submission |
| Completion | Reviewed candidate and evidence receipt | Reviewable source change and operational instructions | Release remains separately authorized |

Pseudocode for the key distinction:

```text
when user opens workspace:
    render documented capabilities and editable mission template
    render runtime state as not yet checked
    do not invoke mission actions or execute mission text

when administrator requests runtime status:
    request the same origin bounded discovery endpoint
    render each integration independently with observation time
    show returned tools as advertised capabilities
    do not infer authority from tool presence

when user chooses a mission example:
    replace or populate draft text visibly
    preserve explicit user submission as the execution boundary
```

## Acceptance and rollback

The decisive test is to open the console with all external integrations absent. Mission drafting, navigation and tool search must remain useful; every external status must be truthful; network inspection must show no outbound integration probe, mission execution or provider completion caused by opening the page.

Additional acceptance checks cover keyboard use, a narrow phone viewport, reduced motion, empty tool inventory, a denied runtime request and a single failed integration. These are required checks, not claims that they have already passed. Results belong in the implementation evidence described by ADR-041.

The change is additive. Rollback reverts the workspace and entry point changes to the recorded source baseline, preserving conversation storage and existing settings. There is no database migration or automatic promotion in this decision.

## Source evidence

1. [Baseline chat introduction](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/ruflo/src/ruvocal/src/lib/components/chat/ChatIntroduction.svelte).
2. [Baseline navigation](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/ruflo/src/ruvocal/src/lib/components/NavMenu.svelte).
3. [Existing MCP server inventory](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/ruflo/src/ruvocal/src/routes/api/mcp/servers/%2Bserver.ts).
4. [ruOS responsive shell](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/control/src/App.svelte) and [independent fleet reads](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/control/src/lib/panels/FleetPanel.svelte).
