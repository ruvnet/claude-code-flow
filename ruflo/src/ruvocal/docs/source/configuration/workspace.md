# Workspace runtime observations

The workspace reads bounded operational evidence through `GET /api/workspace`.
Access requires the existing Chat UI administrator session. Ordinary sessions
receive HTTP 403. Requests without a session receive HTTP 401. Runtime observation
is separate from enabling chat tools: registering a tool does not prove that its
runtime is healthy or that a user may execute it.

## Deployment configuration

Set private environment variables on the Chat UI server. They are not public
browser settings and are not accepted in request parameters.

| Variable                        | Meaning                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `WORKSPACE_RUFLO_MCP_URL`       | Exact deployed Ruflo Streamable HTTP MCP endpoint                                                                     |
| `WORKSPACE_RUFLO_TOKEN`         | Optional service bearer token for that endpoint                                                                       |
| `WORKSPACE_METAHARNESS_MCP_URL` | Optional separate MCP endpoint exposing the verified Ruflo MetaHarness status tool                                    |
| `WORKSPACE_METAHARNESS_TOKEN`   | Optional bearer token for the separate endpoint                                                                       |
| `WORKSPACE_AUTOGENOUS_MCP_URL`  | Optional operator supplied Autogenous MCP adapter; upstream currently provides a library rather than a status service |
| `WORKSPACE_AUTOGENOUS_TOKEN`    | Optional bearer token for that adapter                                                                                |
| `WORKSPACE_RUOS_BASE_URL`       | Deployed ruOS service origin, optionally including a reverse proxy path prefix                                        |
| `WORKSPACE_RUOS_TOKEN`          | ruOS static token or Cognitum JWT used as a bearer token                                                              |

When a separate MetaHarness endpoint is absent, observation uses the explicitly
configured Ruflo endpoint and Ruflo token. This works because Ruflo registers
`metaharness_flywheel`; it does not imply a separately deployed MetaHarness server.
Without the fixed status tool, that panel reports degraded discovery.

Example local deployment using the scoped bridge operations group:

```ini
# Set on the MCP bridge to expose the bounded status group.
MCP_GROUP_OPERATIONS=true

# Set on the Chat UI server. Replace the example host with your deployed bridge.
WORKSPACE_RUFLO_MCP_URL=http://mcp-bridge:3001/mcp/operations
```

Use HTTPS across hosts or untrusted networks. Supply credentials through the
private token variables. URLs containing credentials, query strings or fragments
are rejected. There is no implicit connection to a production host, localhost,
user configured chat MCP server, or arbitrary URL. Existing `MCP_SERVERS` entries
are not automatically promoted into administrative workspace sources.

## What is observed

The MCP adapter uses the installed MCP SDK to initialize and enumerate registered
tools. It supports JSON and SSE responses to Streamable HTTP POST requests. It
does not open a persistent background subscription or fall back to legacy SSE
endpoints. Exact fixed read calls are made only when discovered:

| Integration        | Accepted tool                             | Fixed arguments             |
| ------------------ | ----------------------------------------- | --------------------------- |
| Ruflo              | `system_status` or `ruflo__system_status` | `{ "verbose": false }`      |
| Ruflo              | `policy_status` or `ruflo__policy_status` | `{}`                        |
| MetaHarness        | `metaharness_flywheel`                    | `{ "operation": "status" }` |
| MetaHarness bridge | `ruflo__metaharness_flywheel_status`      | `{}`                        |
| Autogenous adapter | `tools/list` discovery only               | No tool execution           |

The bridge operations group includes policy and flywheel status. System status
requires a configured endpoint that also exposes the devtools group. A source
without a supported status tool stays clearly labeled as discovery only. No
candidate run, promotion, reset, arbitrary command, arbitrary tool call, or user
supplied argument is accepted by the workspace adapter. The upstream runtime may
maintain its own protocol sessions or status bookkeeping; no change to its
policy, workload, champion, or safety envelope is requested.

Ruflo output contains reported system state and process uptime, policy mode,
policy rule/receipt counts, and policy ledger validity when exposed. The source's
own unknown component health is not upgraded into a healthy claim. MetaHarness
output contains promotion ledger validity, commit count, serving epoch, and
receipt count. `success: false`, `degraded: true`, and invalid ledgers remain
degraded. A valid ledger does not prove evaluation quality, promotion authority,
or that a champion is currently serving.

The bridge may wrap its stdio MCP response inside a second HTTP MCP text
envelope. Observation unwraps at most three envelopes and checks `isError`,
`success`, `degraded`, and `exitCode` at every layer. A failure at any layer is
never overridden by a successful inner payload. If both text and structured
representations are provided, both must be valid and agree. Excess nesting or
contradictory representations report degraded status.

ruOS observation uses the actual `GET /api/v1/server/health` contract:

```json
{
	"ok": true,
	"services": {
		"rustdesk-hbbs": "active",
		"rustdesk-hbbr": "active"
	}
}
```

It reports only rendezvous service health. Both services must report `active` and
`ok` must be true for availability. This does not measure workstation CPU, fleet
readiness, or desktop connectivity. Upstream service errors are never forwarded.
The implementation is bound to the [ruOS health producer at the inspected source
revision](https://github.com/cognitum-one/ruos-desktop/blob/6a9be2514a20c63e570aff219944de9c38184c55/service/src/serve/health.rs).

## Response contract and limits

`WorkspaceSnapshot` in `src/lib/types/Workspace.ts` contains `schemaVersion: 1`,
an observation completion timestamp, and four integrations in the order Ruflo,
MetaHarness, Autogenous, ruOS. Each integration exposes:

1. `id`, `name`, `state`, and a static normalized `summary`.
2. `checkedAt` and `latencyMs`, both null if no network observation was attempted.
3. `toolCount` only after a complete bounded MCP inventory was validated.
4. An explicit allowlist of numeric or fixed enumeration `metrics`.
5. `source.kind`, `source.label`, `source.configuredBy`, and `source.discoveryOnly`.

| State            | Meaning                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `not_configured` | No deployment endpoint is set; no network request occurs                                                                                 |
| `available`      | The declared observation succeeded; discovery alone never establishes operational readiness                                              |
| `degraded`       | Invalid configuration, unsuccessful HTTP response, unsupported/malformed/oversized result, rejected credentials, or reported degradation |
| `unreachable`    | Network failure or the observation deadline elapsed                                                                                      |

Each source has one five second deadline covering initialization, listing, status
calls and response reads. Sources run concurrently. Each decoded response is
limited to 256 KiB, the total per integration to 1 MiB, requests to twelve, pages
to four, and tools to 1,024. Duplicate names and repeated cursors invalidate the
inventory. A limit produces degraded output rather than a misleading complete
count. Prefer a scoped MCP endpoint for a large registry.

Only a completed observation is committed to the returned snapshot. Late
responses are cancelled after the deadline, and a late reader cannot change a
previously returned timeout result. Protocol cleanup does not extend the deadline.

Redirects are rejected without a second request. Outbound requests use only the
configured service credentials; browser cookies and user tokens are not forwarded.
The response never contains raw URLs, upstream error text, prompts, tool
descriptions, credential values, machine identifiers, ledger hashes, or policy
documents. Responses use `Cache-Control: private, no-store`; cross origin browser
requests and all query parameters are rejected before contacting a runtime.

The deployment operator owns endpoint selection and network access. This adapter
is not a tenant shared proxy. Use ordinary service egress controls to restrict
the operator configured destinations. Workspace status is an observation, not
authorization for subsequent actions.

## Acceptance checks

```bash
npx vitest run src/lib/server/workspace --project server
```

Tests exercise the installed MCP client against protocol fixtures, JSON and SSE
responses, fixed read calls, missing configuration, timeout and cancellation,
decoded response bounds, malformed and duplicate inventory, failed status tools,
redaction, redirect and credential handling, ruOS service health, and HTTP 401/403
before observation. They do not claim a deployed production runtime was tested.

For deployment acceptance, sign in as an administrator, configure the scoped
bridge endpoint, and verify that changing the real policy status changes the
observed policy mode. Disconnect the endpoint and confirm the next refresh shows
unreachable with empty operational metrics. Sign in as an ordinary user and
confirm `/api/workspace` returns 403 without issuing a runtime request.
