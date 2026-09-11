# ADR 042: Bounded operations tools for the Ruflo workspace

Date: 2026-09-05

Status: Proposed. Implemented on the review branch; reviewer acceptance and deployment remain pending.

## Context

Source baseline `db4991967c45c6f72133dff0bb80b0a492960fc1` provides current
runtime, managed agent, policy, and MetaHarness inspection tools. The RuVocal
bridge selects tools by family prefixes, which omit these additions. Adding a
`metaharness_` or `policy_` prefix would also expose evaluation, promotion,
approval, and budget mutations. Tool discovery alone must not expand authority.

The published runtime version is v3.38.21. This source baseline is not evidence
of which revision currently serves flo.ruv.io.

## Decision

Add an `operations` bridge group enabled only when
`MCP_GROUP_OPERATIONS=true`. Its Docker default is `false`. Existing deployments
retain their existing enabled groups.

| Bridge name | Upstream name | Accepted arguments |
|---|---|---|
| `ruflo__mcp_status` | `mcp_status` | Empty object |
| `ruflo__managed_agent_list` | `managed_agent_list` | Optional integer `limit`, 1 to 200 |
| `ruflo__managed_agent_status` | `managed_agent_status` | Required nonempty `sessionId`, at most 256 characters |
| `ruflo__autopilot_status` | `autopilot_status` | Empty object |
| `ruflo__policy_status` | `policy_status` | Empty object |
| `ruflo__ruvllm_status` | `ruvllm_status` | Empty object |
| `ruflo__metaharness_flywheel_status` | `metaharness_flywheel` | Empty object; bridge supplies only `operation: "status"` |

The group uses `exactNames`, never a wildcard or family prefix. Its tools appear
only when discovered on the Ruflo backend. The bridge synthesizes the flywheel
status alias only after discovering the underlying `metaharness_flywheel` tool.
An upstream tool that happens to use the alias name cannot replace this wrapper.

The wrapper cannot accept `operation`, `projectRoot`, key paths, approval IDs,
confirmation, or evaluation settings. Unknown arguments are rejected before
dispatch. It reads only the backend's existing current project.

Every executor path checks the current visible tool list. Group endpoints also
require membership of that specific group. Thus a client cannot bypass the
operations opt-in through `/mcp`, another group endpoint, or chat autopilot.
Backend argument validation is in this common executor, not only the discovery
schema. Errors set MCP `isError` and include a structured code.

Existing groups retain their selection rules. A selector omitted entirely keeps
the existing wildcard behavior for existing dedicated backends; an empty
`exactNames` or `prefixes` array never means wildcard. Disconnected backends stop
advertising cached tools.

## Runtime integration

The workspace discovers `/mcp/operations` via authenticated `/mcp-servers`, or
uses a configured catch-all `/mcp` endpoint. `/groups` reports enabled state and
actual tool count. Consumers must interpret nested MCP text results and preserve
`isError`, `degraded`, and `exitCode`. Tool availability does not prove healthy
runtime state or successful work.

`system_status` remains in the existing devtools group. `policy_status` reports
the actual mode (`legacy`, `observe`, or `enforce`) and ledger verification.
The MetaHarness status result includes state and ledger verification; it does
not run an evaluation or promote anything. Managed agent inspection can make
authenticated upstream reads using the backend's configured credentials.

The bridge bearer credential remains a server deployment credential. This
change does not create per-user authorization or expose it to the browser.
Multi-tenant deployment still requires correctly scoped backend identities.

## Verification

Run from `mcp-bridge` after installing its dependencies:

```sh
node --check index.js
npm test
```

The Node tests start real local HTTP bridge processes with a deterministic fake
stdio backend and no external provider credentials. They verify default denial,
exact opt-in discovery, catch-all and group endpoints, cross-group denial,
lookalike names, absent upstream capability, fixed wrapper parameters, and
managed-agent input bounds. Rejected calls must leave the backend call log empty.
Successful wrapper calls must log exactly `metaharness_flywheel` with
`{"operation":"status"}`.

These tests establish bridge routing and authority boundaries. They do not
claim a live Ruflo deployment, managed cloud session, or production evaluation.

## Rollback

Unset `MCP_GROUP_OPERATIONS` or set it to `false`, then restart the bridge.
Discovery and execution of all seven operations tools are disabled together.
No new runtime state or database migration is introduced.

## References

1. `mcp-bridge/operations-tools.js` and `operations-tools.test.js`.
2. `v3/@claude-flow/cli/src/mcp-tools/metaharness-tools.ts` at the source baseline.
3. `v3/@claude-flow/cli/src/mcp-tools/policy-tools.ts` at the source baseline.
4. ADR 324 policy governance and ADR 322 evaluation and promotion transactions.
