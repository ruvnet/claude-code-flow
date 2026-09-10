# ADR 387: MCP 2026 07 28 stateless era adapter

Status: Proposed, benchmark and independent reproduction required before runtime promotion

Date: 2026 09 10

Related: issue 2542, ADR 112, ADR 125, ADR 144, ADR 325, ADR 329, ADR 386

## Decision

RuFlo will support MCP 2026 07 28 through an explicit protocol era adapter instead of replacing the existing handshake path in place.

The modern era is stateless. It has no initialize or initialized exchange and no MCP session identifier. Each request carries its protocol version, client identity, and client capabilities. Streamable HTTP requests carry MCP Method and, where applicable, MCP Name headers. A new server discover method exposes supported versions and capabilities. List and resource responses may carry bounded cache hints. W3C trace context propagates through reserved metadata.

The existing 2025 11 25 and earlier handshake era remains a compatibility path during the transition. Modern requests must never create, consult, or mutate legacy session state. Legacy behavior remains the rollback target until the compatibility matrix is proven.

Primary specification: https://blog.modelcontextprotocol.io/posts/2026-07-28/

Current roadmap: https://blog.modelcontextprotocol.io/posts/mcp-roadmap/

## Why now

The 2026 07 28 MCP release is final and the official roadmap identifies removal of protocol sessions and initialization as a major scalability change. RuFlo currently contains multiple protocol eras at once:

* v3/@claude-flow/mcp/src/server.ts advertises 2025 11 25 and still creates a SessionManager, requires initialize for ordinary requests, and exposes session scoped behavior.
* v3/@claude-flow/shared/src/mcp/server.ts advertises 2024 11 05.
* ruflo/src/mcp-bridge/mcp-stdio-kernel.js advertises 2024 11 05.
* v3/@claude-flow/cli/bin/mcp-server.js advertises 2024 11 05.
* v3/@claude-flow/cli/bin/cli.js advertises 2024 11 05.
* ruflo/src/ruvocal/src/lib/wasm/wasm.worker.ts advertises 2024 11 05.
* v3/mcp/server.ts contains an older incompatible protocol version representation and an initialize based lifecycle.

This is not only version string drift. The lifecycle semantics differ. Advertising a modern version without separating the modern request path would be incorrect and can create authorization, cache, routing, and cross tenant state leakage hazards.

## Opportunity score

Weighted Opportunity Score: 4.590 of 5.

| Dimension | Score |
| --- | ---: |
| applicability | 5.0 |
| performance impact | 4.0 |
| implementation speed | 4.0 |
| cross stack leverage | 5.0 |
| commercial value | 5.0 |
| strategic differentiation | 3.5 |
| security improvement | 5.0 |
| open source leadership | 4.5 |
| evidence confidence | 5.0 |
| long horizon option value | 5.0 |
| experiment reversibility | 5.0 |

Weights are the RuV SOTA research weights frozen before implementation.

## Required architecture

### 1. Era detection

Introduce a single parser that classifies each request as modern 2026 07 28 or legacy handshake era. The parser is transport aware but policy neutral.

Modern HTTP uses MCP Protocol Version and the reserved request metadata. Modern stdio uses the reserved request metadata. No process global or mutable current session value may determine the identity or authorization context of a modern request.

Unknown protocol versions fail closed with a structured unsupported version response and the supported set.

### 2. Stateless modern request context

Construct a request local context from authenticated transport identity plus request metadata. Request metadata is descriptive and must not grant authority. Authorization derives from the authenticated principal and RuFlo or RVM policy, never from a claimed client name or capability field.

Modern requests do not call getOrCreateSession, update session activity, or inherit state from a previous request.

### 3. server/discover

Implement server/discover with deterministic ordering and explicit cache semantics. The discover result exposes supported protocol versions, capabilities, and enabled extensions. It must not expose secrets, tenant private tool names, or capabilities that the authenticated principal cannot observe.

Default cache policy is private with zero TTL unless a surface has an explicit public stability policy.

### 4. HTTP routing integrity

For 2026 07 28 Streamable HTTP, validate MCP Method against the JSON RPC body method and MCP Name against the body tool or resource name when defined. A mismatch is rejected before dispatch and before any side effect.

Gateways may use these headers for routing and rate limiting, but header values never substitute for body validation or authorization.

### 5. Trace context

Propagate W3C traceparent, tracestate, and baggage through the standardized MCP metadata keys. Treat baggage as untrusted input. Enforce size and allowlist rules before downstream propagation.

### 6. Cache hints

Add ttlMs and cacheScope to modern list and resource read responses. Private is the default. Public caching is opt in and requires proof that output is principal invariant. Authorization sensitive tool lists must never be marked public.

### 7. Extensions and long running work

Keep RuFlo specific behavior out of the base protocol. Use the MCP extensions framework for optional surfaces. Evaluate the Tasks extension against the existing TaskManager rather than creating a second task lifecycle.

Sampling, Roots, and Logging remain legacy compatibility surfaces while deprecated. Do not expand dependence on them. Modern server initiated interaction must use the modern multi round trip mechanism when supported or explicitly fall back to a compatible legacy era.

## Compatibility strategy

Phase 0 is inventory and conformance fixtures.

Phase 1 introduces era detection and server discover with no change to legacy dispatch.

Phase 2 adds the stateless modern request path and header consistency checks.

Phase 3 adds cache hints and trace context.

Phase 4 maps the existing TaskManager to the Tasks extension if independent tests show semantic compatibility.

Phase 5 removes legacy paths only after the MCP deprecation window, measured client telemetry, and an explicit human approved migration ADR.

## Security invariants

1. Client metadata is never authority.
2. A modern request cannot inherit identity, authorization, budget, tool visibility, trace baggage, or tenant state from another request.
3. Header and body mismatches are rejected before dispatch.
4. cacheScope public is forbidden for principal dependent results.
5. Unsupported or malformed protocol metadata fails closed.
6. Legacy and modern request contexts cannot alias mutable authorization state.
7. Discovery does not make a tool invokable and does not widen capability.
8. Task continuation tokens are opaque, integrity protected, bounded, and cannot escalate authority.
9. No candidate may modify the evaluator, security policy, promotion threshold, or release gate.
10. No autonomous merge, deployment, credential escalation, or irreversible migration.

## MetaHarness evaluation

Use independent roles for research, baseline capture, implementation, adversarial review, security, testing, reproducibility, and release review. The implementation role cannot approve its own result.

Freeze the following matrix before candidate execution:

* transports: stdio and Streamable HTTP
* eras: 2024 11 05, 2025 03 26, 2025 06 18, 2025 11 25, 2026 07 28
* clients: official TypeScript SDK plus one independent official SDK
* authorization contexts: anonymous where allowed, one principal, two isolated tenants
* workloads: tools list, tool call, resources list, resource read, prompt list, server discover, one long running Task extension case
* fault cases: missing version, unknown version, malformed metadata, header body mismatch, replayed continuation, cross tenant cache probe, oversized baggage, cancellation, worker restart, load balanced instance change

## Benchmark contract

Report baseline and candidate using the exact same workload and pinned environment.

Required fields: repository commit, dependency lock hash, runtime versions, operating system, CPU, memory, transport, SDK versions, seeds, sample size, concurrency, request payload sizes, absolute latency, relative latency, throughput, error rate, variance, process RSS, bytes transferred, cache hit rate, authorization failures, cross tenant leakage attempts, restart recovery, cost and energy when measurable.

Minimum run:

* 10 warmup iterations per cell
* at least 1,000 measured requests per cheap request cell
* at least 100 measured executions per tool call cell
* at least 3 independent process restarts
* concurrency 1, 8, 32, and 100 where the host supports it

Acceptance thresholds:

* 100 percent expected modern conformance fixtures pass
* 100 percent retained legacy compatibility fixtures pass unless an exception is explicitly approved
* zero cross tenant state or cache leakage in the adversarial corpus
* zero header body mismatch dispatches
* zero authority expansion from request metadata
* p95 modern request latency no worse than 5 percent versus the equivalent legacy request after excluding handshake cost
* at concurrency 32, modern throughput at least 15 percent higher or process resident memory at least 20 percent lower than the current stateful path. If neither threshold is met, retain the implementation only for interoperability, not performance claims
* restart and round robin instance change succeed without shared session storage for modern requests

## Contradiction tests

The expected performance benefit can be false if current in process sessions are already cheap and the workload does not require horizontal scale. Therefore interoperability and isolation are independent acceptance dimensions. A candidate can be accepted for protocol correctness without claiming a speedup.

The new cache hints can make latency worse or leak data if cache boundaries are wrong. Public caching must be separately proven principal invariant.

Tasks can duplicate RuFlo lifecycle semantics. Reuse TaskManager only if cancellation, idempotency, approval, budget, and receipt semantics can be mapped without authority loss. Otherwise expose a thin adapter.

## Dependencies and licensing

Prefer the official MCP SDK for wire conformance where practical. Do not vendor draft server card or unrelated discovery schemas into the core protocol. No new dependency is accepted without license review, lockfile update, advisory scan, and a simpler implementation comparison.

## Rollback

The legacy handshake path remains untouched until the modern path passes independent reproduction. Era routing is additive and controlled by a feature gate during initial rollout. Rollback disables the modern path and restores the previous protocol advertisement without data migration.

No persistent session schema migration is required by this ADR.

## Cross stack mapping

RuFlo: modern stateless dispatch, Tasks adapter, federation gateway compatibility.

MetaHarness: conformance, isolation, restart, load balance, and adversarial evaluation.

RVM: authoritative per action effect boundary remains unchanged; modern request metadata never becomes authority.

Core Memory and RuVector: cache and retrieval results remain tenant scoped; cache hints cannot widen visibility.

RVF and RVForge: attach protocol era and trace provenance to evidence receipts without treating it as authorization.

Cognitum: horizontal MCP gateway scaling without sticky sessions or a shared session store.

RuVector WASM and browser runtimes: simpler stateless MCP calls and deterministic capability discovery.

Autogenous, MidStream, RuView, RuField, WorldGraph, Dream Machine, and LatentMesh: all gain a common modern tool transport boundary while retaining domain specific policy.

## Promotion decision

Do not merge runtime changes from this ADR until the independent MetaHarness matrix is attached to the exact candidate commit. Documentation and conformance fixtures may land first.

The first implementation target is the canonical v3/@claude-flow/mcp package. Legacy mirrors and generated CLI bridges are migrated only after the canonical path passes the frozen matrix.
