# ADR-040: Governed runtime integration discovery

**Status:** Proposed
**Date:** 2026-09-05
**Source baseline:** `ruvnet/ruflo@db4991967c45c6f72133dff0bb80b0a492960fc1`
**Related:** [ADR-034](ADR-034-OPTIONAL-MCP-BACKENDS.md), [ADR-039](ADR-039-WORKSPACE-CAPABILITY-EVIDENCE.md), [ADR-041](ADR-041-IMPLEMENTATION-OPTIMIZATION-LOOP.md)

## Context

Ruflo, MetaHarness, Autogenous and ruOS have different integration surfaces. Treating all of them as an assumed HTTP status service would manufacture compatibility. Treating an advertised MCP tool as permission to run it would cross an authority boundary.

The existing application already supports MCP servers and a configurable health check. That general user supplied URL path is not the authority for operator integrations. The workspace needs a smaller server controlled observation path with predictable cost, bounded responses and no command execution.

## Verified upstream surfaces

| Component | Pinned source | Verified interface | What it does not establish |
| --- | --- | --- | --- |
| Ruflo | `db4991967c45c6f72133dff0bb80b0a492960fc1` | Existing MCP transport and tools registry in this application | Which tool set is deployed at a remote endpoint |
| MetaHarness | `42f568b7297c59065ea562247937bb25cd353a6a` | `@metaharness/avo` 0.2.0, `@metaharness/router` 0.4.0, `@metaharness/autogenous` 0.1.0 and AgentRadio library APIs | A universal remote MetaHarness status or MCP endpoint |
| Autogenous | `7bf327a9754ce798364dbee8b2825af42a421fd4` | `radio-moe` 0.3.1 compiled Node package and Rust governed adaptation crates | A universal remote Autogenous status or MCP endpoint |
| ruOS | `6a9be2514a20c63e570aff219944de9c38184c55` | Authenticated `GET /api/v1/server/health` | Workstation availability, brain readiness or whole fleet health |

MetaHarness and Autogenous MCP URLs therefore identify operator deployed adapters. The source review does not establish a canonical hosted endpoint for either. No endpoint is guessed or enabled merely because its package exists.

## Decision

Expose `GET /api/workspace` as a same origin, authenticated administrator only route for workspace runtime observations. Use the existing `requireAdmin` boundary: no authenticated session returns 401 and a nonadministrator returns 403, before any outbound request. Configure a finite allowlist of integration identities and endpoints on the server. The request may not supply a URL, token, command, tool name, query or additional integration.

For operator supplied MCP endpoints, permit protocol initialization, bounded tool discovery and the following exact registered status calls. The adapter supplies immutable arguments; browser data cannot select an operation or add arguments.

| Registered tool | Fixed arguments | Purpose |
| --- | --- | --- |
| `system_status` or its explicit `ruflo__` bridge equivalent | `{ "verbose": false }` | Report the configured Ruflo process status |
| `policy_status` or its explicit `ruflo__` bridge equivalent | `{}` | Report policy mode, counts and ledger status |
| `metaharness_flywheel` | `{ "operation": "status" }` | Inspect current flywheel transaction state and ledger |
| `ruflo__metaharness_flywheel_status` | `{}` | Use the bridge's restricted status wrapper when registered |

Tools absent from the discovered registry are not called. In particular, the flywheel multiplexer also supports consequential operations, but this adapter can only choose its `status` branch. It cannot run prompts, execute commands, write resources, spawn agents, create missions, start evolution or promote candidates. Initialization creates protocol session state where required, but does not constitute mission execution. Autogenous remains discovery only until a separately reviewed status adapter exists.

For ruOS, perform only the fixed health GET. Send any required bearer token from protected server configuration. Never forward the browser's session cookie or unrelated provider credentials to an upstream service.

Configuration uses `WORKSPACE_RUFLO_MCP_URL`, `WORKSPACE_METAHARNESS_MCP_URL`, `WORKSPACE_AUTOGENOUS_MCP_URL`, and `WORKSPACE_RUOS_BASE_URL`, with respective `WORKSPACE_RUFLO_TOKEN`, `WORKSPACE_METAHARNESS_TOKEN`, `WORKSPACE_AUTOGENOUS_TOKEN`, and `WORKSPACE_RUOS_TOKEN` secrets. These are application configuration, not upstream package defaults. If an explicit MetaHarness endpoint is absent, the implementation may use the explicitly configured Ruflo endpoint because the inspected Ruflo source registers the flywheel status tool. The UI must identify this source as the Ruflo integration rather than implying an independent MetaHarness deployment.

The implementation contract sets a 5 second whole integration deadline, 256 KiB decoded bytes per response, 1 MiB total bytes per integration probe, at most 12 requests, 4 tool list pages and 1,024 advertised tools. These are bounds, not measured runtime performance. A truncated or incomplete listing must not be described as a complete inventory.

## Response semantics

The public DTO should contain only the following classes of information:

| Field class | Purpose | Constraint |
| --- | --- | --- |
| Integration identity | One of the supported fixed providers | Chosen by server configuration |
| Configuration state | Missing, invalid or configured | Never return raw configuration or secrets |
| Observation state | `not_configured`, `available`, `degraded` or `unreachable` | Summaries distinguish configuration, authorization, timeout and schema failures without raw errors |
| Observation time | When this probe completed | No implication of continuous monitoring |
| Duration | Measured request duration in milliseconds | Observation only, not a benchmark claim |
| Advertised tools | Bounded safe tool names and optional bounded descriptions | Discovery is not execution authority |
| Service summary | Normalized ruOS health observations | Scope is the rendezvous service |
| Error classification | Stable safe error category | Do not expose upstream stack traces or response bodies |

`WorkspaceSnapshot` is `{ schemaVersion: 1, checkedAt, integrations }`. Each integration contains `id`, `name`, `state`, `summary`, nullable `checkedAt` and `latencyMs`, optional `toolCount`, bounded `{label,value}` metrics, and `source: {kind, label, configuredBy, discoveryOnly}`. The shared TypeScript contract is `src/lib/types/Workspace.ts`. `discoveryOnly` explicitly separates tool advertisement from actual allowed status observations.

An empty advertised tool list is a valid observed count if the protocol response is valid. A failed probe does not become a zero tool count. The response should be private and not cacheable by shared intermediaries. Client rendering must preserve the administrator visibility boundary and discard prior privileged state on sign out or denial.

## Exact ruOS health contract

The inspected service implements:

```ts
type RuosHealth = {
  ok: boolean;
  services: Record<string, string>;
};
```

The current producer checks exactly `rustdesk-hbbs` and `rustdesk-hbbr`. Each string is the result of `systemctl is-active`, or an error string if that query fails. `ok` is true only when both are `active`. The adapter must validate the JSON shape and bound entries and strings before rendering. A successful HTTP response with `ok: false` means degraded service state, not a transport failure.

ruOS's API supports static bearer authentication and Cognitum OAuth. OAuth validation and tenant authority belong to ruOS. The workspace forwards only an explicitly configured service credential to the configured ruOS endpoint. It does not install OAuth clients or invent scopes. Certificate verification stays enabled; supporting a private certificate authority requires an operator managed trust configuration.

## Network and resource boundaries

1. Accept only validated operator configuration. Require HTTPS in normal deployments; any explicitly supported local development exception must be narrow and tested.
2. Reject URL user information, credential query parameters, fragments and malformed destinations. Fixed configuration does not eliminate SSRF risk when configuration itself is compromised.
3. Refuse redirects so a trusted destination cannot move a credentialed request to an unapproved origin.
4. Apply a finite timeout and cancellation signal to connection, discovery, body reads and cleanup. No fallback path may restart the full time budget indefinitely.
5. Bound total response bytes, MCP pages, tool count, string lengths and parser work. Cancel response consumption when a limit is exceeded.
6. Bound concurrent probes and repeated refresh load. Prefer independent settled results over a single failing aggregate. Consider a short private cache or single flight control only if measured concurrent refresh load warrants it.
7. Close MCP clients, response readers and timers on success, malformed responses, timeout and exceptions.
8. Do not disable URL safety or TLS verification to make a demonstration green. Report the configuration requirement instead.

Exact limits are an implementation contract, not a performance result. The integration tests must assert that the implementation respects those constants under a slow stream, oversized response and repeated pagination cursor.

## Threat model

| Threat | Entry point | Required defense | Residual risk |
| --- | --- | --- | --- |
| Unauthenticated infrastructure discovery | Workspace GET | Server side session and administrator check before probing | Compromised administrator session |
| SSRF or credential forwarding | Integration configuration or redirect | Fixed destinations, URL validation, redirect refusal and scoped credentials | Malicious operator configuration or compromised upstream DNS |
| Metadata leakage | DTO, errors, logs or shared cache | Sanitized summaries, secret redaction, private no store response | Tool names can reveal operational capabilities to administrators |
| Memory or latency exhaustion | MCP lists, SSE or JSON body | Byte, item, page and time limits; bounded concurrency | Authorized repeated requests still consume bounded resources |
| Prompt or markup injection | Remote descriptions | Escaped text only; metadata never becomes instructions | Misleading remote descriptions remain untrusted claims |
| False health or false authority | Successful discovery | Explicit probe scope and separate execution gate | A compromised service can lie about its own state |
| Accidental mutation | Generic MCP client | Exact registered status tool allowlist, immutable arguments and no shell path | Protocol initialization may allocate a remote session; compromised upstream code may violate its own contract |
| Stale privileged state | Browser navigation or sign out | Clear prior observations on auth loss; show observation time | A screenshot can outlive its original validity |

## Staged integration plan

### Stage 1: Observe configured deployments

Ship bounded MCP discovery, fixed Ruflo and flywheel status calls, and ruOS service health. Show absent integrations as not configured. An explicit Ruflo deployment can provide MetaHarness flywheel observations; an Autogenous library alone cannot provide remote health. This stage neither executes those SDKs nor claims their governance machinery protects existing chat execution.

### Stage 2: Read verified optimization and collaboration evidence

Add purpose built server adapters only after the deployment supplies explicit schemas and artifact identities. Useful upstream contracts already exist:

| Source contract | Useful UI fields | Boundary |
| --- | --- | --- |
| MetaHarness `VariationState` | Run, candidate, branch, budgets, pending approvals, interventions | State is not a trusted verdict by itself |
| MetaHarness `ActionReceipt` | Sequence, policy decision, artifact digest, state hash and signer | A signature field is not verified until trusted key validation succeeds |
| MetaHarness `EvaluationBinding` | Branch, workspace digest, state hash and evaluate sequence | Prevents a pass for one artifact from labeling another verified |
| Autogenous `MixtureSnapshot` | Revision, claims, contradictions, buffered frames and equivocation | Consensus is not external outcome verification |
| Autogenous `PromotionDecision` | Better, safe, authorized, reversible and final verdict | Every conjunct is independently blocking |
| Autogenous `EvolutionResult` | Candidate history, fitness, promotions and signed ledger | Verify ledger and signer policy before calling it verified |

Node only Autogenous transports and subprocess adapters stay outside the browser bundle. AgentRadio is a local metadata bus; a cross process bridge needs a separate contract. Unknown model lineage must not be rendered as independent supporting evidence.

`@metaharness/autogenous` already provides an SDK bridge to `@metaharness/flywheel`. It requires an injected runner of the real radio-moe benchmark and preserves five bounded levers, frozen safety checks, correlated and independent quality nonregression, and the governed promotion predicate. It is a useful future implementation seam; it is not a hosted service and does not automatically connect this UI to Autogenous.

### Stage 3: Governed actions under a separate decision

Any future run, rollback, fleet start or promotion endpoint needs action specific authorization, immutable budgets, validated artifact binding, idempotency, audit receipts and a rollback contract. MetaHarness may optimize retrieval, routing, context, test and repair policies; it cannot enlarge its own capabilities. Autogenous promotion requires `Better AND Safe AND Authorized AND Reversible`. Ruflo's governing release and promotion policy remains authoritative.

No deploy, fleet mutation, autonomous promotion or remote adapter installation is authorized by this ADR or by browsing the workspace.

## Pseudocode

```text
GET workspace runtime:
    require authenticated administrator before any outbound request
    load fixed operator integration configuration
    for each supported integration, within bounded concurrency:
        if missing: emit not configured
        if invalid: emit configuration error
        otherwise:
            probe allowed protocol using scoped timeout and byte budget
            validate and sanitize response
            emit observation with timestamp and safe failure classification
            release resources in finally
    return private noncacheable snapshot
```

## Validation and rollback

Required tests include unauthenticated and nonadministrator denial with zero outbound calls, missing configuration with zero outbound calls, refused redirects, no token leakage, exact allowlisted status calls with immutable arguments, no calls to absent or unlisted tools, timeout, oversized payload, invalid JSON, malformed ruOS shape, valid degraded ruOS health and one failed integration alongside one healthy integration. These are release gates, not reported results.

Rollback removes or disables the additive discovery route and workspace integration section. Server credentials remain in the operator's secret store and may be revoked independently. The feature requires no conversation migration and must not change existing execution policy.

## Source evidence

1. [Autogenous package manifest](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/packages/radio-moe/package.json), [exports](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/packages/radio-moe/src/index.ts), [Node crypto transport](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/packages/radio-moe/src/transport.ts), and [promotion implementation](https://github.com/ruvnet/autogenous/blob/7bf327a9754ce798364dbee8b2825af42a421fd4/packages/radio-moe/src/mesh-evolve.ts).
2. [MetaHarness AVO types](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/avo/src/types.ts), [package manifest](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/avo/package.json), and [router implementation](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/router/src/index.ts).
3. [ruOS exact health producer](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/service/src/serve/health.rs), [API route and middleware](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/service/src/serve/mod.rs), and [fleet API decision](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/docs/adr/ADR-008-fleet-api-and-mcp.md).
4. [Ruflo status tool](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/v3/%40claude-flow/cli/src/mcp-tools/system-tools.ts), [policy status tool](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/v3/%40claude-flow/cli/src/mcp-tools/policy-tools.ts), and [flywheel status branch](https://github.com/ruvnet/ruflo/blob/db4991967c45c6f72133dff0bb80b0a492960fc1/v3/%40claude-flow/cli/src/mcp-tools/metaharness-tools.ts).
5. [MetaHarness Autogenous adapter](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/autogenous/README.md), [injected benchmark seam](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/autogenous/src/evaluator.ts), and [promotion gate](https://github.com/ruvnet/metaharness/blob/42f568b7297c59065ea562247937bb25cd353a6a/packages/autogenous/src/gate.ts).
