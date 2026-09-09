---
name: harness-threat-model
description: "Enterprise-review-grade threat model from `harness threat-model <path>`. Categorizes MCP-surface threats; emits `worst: 'clean'|'low'|'medium'|'high'` plus per-threat findings. Pure-read."
argument-hint: "[--path .] [--fail-on clean|low|medium|high] [--format table|json]"
allowed-tools: Bash
---

The companion to `harness-mcp-scan` for enterprise security reviews.
Where mcp-scan is a per-server static lint, threat-model produces a
categorized report suitable for sharing with an InfoSec team.

## Algorithm

Implementation: [`scripts/threat-model.mjs`](../../scripts/threat-model.mjs).

1. Invoke the pinned `harness` binary (`metaharness@~0.3.0`, resolved from a
   local install or the one-time `~/.ruflo/metaharness-cache-<pin>` cache —
   never `@latest`): `harness threat-model <path> --json`.
2. Parse `{ worst, findings[] }`.
3. `--fail-on <severity>`: exit 1 when `worst >= fail-on`. Default `high`.

## Severity rank

| Severity | Rank |
|---|---:|
| clean | 0 |
| low | 1 |
| medium | 2 |
| high | 3 |

## When to use

- Pre-launch review: include the JSON output in the release-readiness
  packet sent to security.
- Periodic audit: schedule via the planned `oia-audit` background
  worker (ADR-150 Phase 2) to detect MCP-surface drift.

## Graceful degradation

Same pattern as the other skills: when `harness` is absent, emit
`{ degraded: true }` and exit 0. ADR-150 architectural constraint.
