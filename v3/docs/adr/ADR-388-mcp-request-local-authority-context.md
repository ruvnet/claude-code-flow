# ADR 388: MCP request local authority context

Status: Proposed

Date: 2026-09-11

Related: #2542, #3294, ADR 387, ruvnet/metaharness#305

## Context

The canonical MCP package currently carries one mutable `currentSession` on `MCPServer`. Legacy `initialize` replaces that value. Tool calls, sampling, and resource subscription paths subsequently derive session context from it.

The transport interface compounds the problem. `RequestHandler` receives only an `MCPRequest`. The HTTP transport validates authorization and then passes only the JSON body to the server. The exact authenticated principal, protocol version header, routing headers, connection identity, and legacy session identifier therefore do not survive the transport boundary as one immutable request scoped object.

This architecture is ambiguous for multiple concurrent legacy HTTP clients and is incompatible with the trust boundary required by MCP 2026 07 28. The modern protocol removes protocol sessions and initialization, makes every request self describing, and requires Streamable HTTP routing metadata to describe the exact request being dispatched.

A session identifier is not an authority grant. Client supplied metadata is not an authority grant. A successful authentication check is not sufficient unless the resulting principal is bound to the exact request that reaches policy enforcement.

## Decision

Introduce an immutable transport neutral `MCPRequestContext` and make it the only source of transport level caller context after parsing and authentication.

The request context is created by the transport immediately before request dispatch. It is passed together with the JSON RPC request to the MCP server and then projected into `ToolContext`, subscription ownership, task ownership, trace evidence, and any policy decision that needs caller identity.

The server must not use mutable process global state to determine the calling principal or logical client.

## Request context

The initial shape should contain these fields or equivalent strongly typed fields:

```ts
export interface MCPRequestContext {
  readonly transport: TransportType;
  readonly protocolVersion?: MCPProtocolVersion;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly connectionId?: string;
  readonly legacySessionId?: string;
  readonly routing?: {
    readonly method?: string;
    readonly name?: string;
  };
  readonly principal?: {
    readonly subject?: string;
    readonly issuer?: string;
    readonly authMethod?: AuthMethod;
    readonly credentialFingerprint?: string;
  };
}
```

Raw bearer tokens, API keys, authorization headers, client secrets, or other reusable credentials must never be copied into this structure.

## Legacy protocol behavior

Protocol versions through 2025 11 25 keep their handshake semantics during the compatibility window.

Legacy session lookup is request local. An HTTP request carrying a session identifier is resolved to one legacy session and, when authentication is enabled, that session is bound to the authenticated principal that created it. A session identifier presented by another principal fails closed.

Stdio may retain one connection scoped legacy session because the process stream itself is the connection boundary. WebSocket may retain one session per authenticated socket. Neither case permits a server global mutable session to determine another connection's identity.

## Modern protocol behavior

Protocol version 2026 07 28 does not create a protocol session and does not depend on `initialize`, `initialized`, or `Mcp-Session-Id`.

The transport validates `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` before server dispatch. A routing header that disagrees with the JSON body fails closed before tool lookup or policy evaluation.

Client information and capabilities from request metadata are descriptive inputs. They may influence compatibility or feature negotiation but must never widen policy authority.

`server/discover` reports server features without creating authority or hidden state.

## Principal binding

Authentication produces a principal reference, not merely a boolean. The exact principal is attached to the request context after credential validation.

For static bearer token deployments, a migration implementation may use a non secret SHA 256 credential fingerprint as an internal subject key when no explicit subject exists. The raw token is discarded after validation. Production deployments should prefer issuer and subject claims from a validated identity protocol when available.

A credential fingerprint is an implementation identity key only. It is not proof of user intent or permission for a particular tool invocation.

## Tool authorization

`ToolAuthorizer` continues to decide whether a specific tool call may execute. The request context gives the authorizer correct caller evidence but does not change the decision model.

The migration should extend `ToolContext.metadata` first to preserve source compatibility, then consider first class principal fields only after downstream packages are audited.

RVM remains the privileged effect boundary for consequential operations. MCP transport identity, KYA signals, agent identity, signatures, attestation, discovery, and trace metadata remain evidence inputs to that boundary rather than substitutes for it.

## Resource subscriptions and server initiated interaction

Legacy resource subscriptions must be owned by the exact legacy session and authenticated principal that created them. Unsubscribe operations must prove the same ownership.

Modern MCP should migrate change notification behavior to the current subscription model rather than recreating hidden transport sessions.

Deprecated legacy sampling, roots, logging, and HTTP SSE support remain compatibility surfaces only. New functionality must not depend on them.

## Failure behavior

The server fails closed when:

1. a modern routing header disagrees with the body
2. a required protocol version is malformed or unsupported
3. a legacy session identifier is unknown, expired, or bound to another principal
4. authenticated principal context is required but unavailable
5. request metadata attempts to assert authority that policy has not granted
6. a request context cannot be constructed without retaining a raw credential

Errors must not echo secrets or security sensitive internal state.

## Migration

Phase 1 adds the typed request context and transport plumbing with no behavior change for a single legacy client.

Phase 2 removes server global session lookup from tool, sampling, subscription, and task paths. Legacy sessions are selected from request local context.

Phase 3 adds modern MCP request classification, routing header validation, and `server/discover`.

Phase 4 moves modern list and resource caching, subscriptions, Tasks extension behavior, and tracing onto the modern path.

Phase 5 removes deprecated compatibility code only after retained clients have an explicit migration window and rollback is no longer required.

Each phase is independently revertible.

## Verification

The frozen MetaHarness suite must cover at least two concurrent authenticated clients and two concurrent modern clients across in process, stdio, HTTP, WebSocket, and retained HTTP SSE behavior.

Required schedules include A initialize, B initialize, A call; simultaneous A and B calls; reconnect; process restart; and modern requests alternating across two server instances without shared session storage.

Adversarial cases include stolen or replayed legacy session identifiers, mismatched principal and session, routing header and body disagreement, malformed metadata, cancellation races, oversized headers, partial requests, and connection loss during subscription activity.

Promotion requires:

1. zero cross principal or cross session authority aliases across at least 10000 interleaved cheap requests
2. zero successful use of one principal's session identifier by another principal
3. zero tool dispatch on routing header and body mismatch
4. zero authority expansion from request metadata
5. 100 percent retained legacy fixtures passing
6. 100 percent modern 2026 07 28 fixtures passing
7. p95 request context overhead no greater than 5 percent against the frozen baseline
8. no reusable secret in logs, traces, cache keys, receipts, or error bodies
9. modern restart and round robin tests passing without shared session storage

## Benchmark record

Every run records exact commit, Node and package manager versions, MCP SDK versions, operating system, CPU, memory, workload, seed, sample size, concurrency, request mix, absolute and relative throughput, p50 p95 p99 latency, variance, RSS, network bytes, failures, regressions, auth failures, and reproduction commands.

A correctness improvement may be accepted without a throughput improvement. Performance claims require measured evidence.

## Rollback

Legacy behavior remains behind an explicit compatibility path until the migration is promoted. Each implementation phase is a separate commit or reviewable unit. No database migration, credential format migration, deployment, or irreversible state conversion is required by this ADR.

If request local context introduces a compatibility regression, disable the modern path and revert the affected phase while preserving the new regression tests and audit evidence.

## Consequences

The additional request object adds a small allocation and parsing cost per request. The expected overhead is low single digit percent and must be measured rather than assumed.

The design removes hidden authority state from the server core, makes multi tenant reasoning testable, enables correct MCP 2026 routing and stateless scaling, and creates a reusable authority context for RuFlo, MetaHarness, RVM, RVF, Cognitum gateways, and future agent identity or commerce trust adapters.

## Non goals

This ADR does not define a new identity protocol, payment protocol, attestation format, agent certification scheme, or authorization policy language.

It does not treat KYA, AICP, AADP, MCP metadata, signatures, hashes, attestation, or federation membership as execution authority.

It does not authorize autonomous merge, deployment, credential escalation, or irreversible migration.
