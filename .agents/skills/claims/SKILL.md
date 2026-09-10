---
name: claims
description: >
  Claims-based authorization for agents and operations. Grant, revoke, and verify permissions for secure multi-agent coordination.
  Use when: permission management, access control, secure operations, authorization checks.
  Skip when: open access, no security requirements, single-agent local work.
---

# Claims Authorization Skill

## Purpose
Claims-based authorization for secure agent operations and access control.

## Claim Types

| Claim | Description |
|-------|-------------|
| `read` | Read file access |
| `write` | Write file access |
| `execute` | Command execution |
| `spawn` | Agent spawning |
| `memory` | Memory access |
| `network` | Network access |
| `admin` | Administrative operations |

## Commands

### Check Claim
```bash
npx claude-flow claims check --agent agent-123 --claim write
```

### Grant Claim
```bash
npx claude-flow claims grant --agent agent-123 --claim write --scope "/src/**"
```

### Revoke Claim
```bash
npx claude-flow claims revoke --agent agent-123 --claim write
```

### List Claims
```bash
npx claude-flow claims list --agent agent-123
```

## Scope Patterns

| Pattern | Description |
|---------|-------------|
| `*` | All resources |
| `/src/**` | All files in src |
| `/config/*.toml` | TOML files in config |
| `memory:patterns` | Patterns namespace |

## Security Levels

| Level | Claims |
|-------|--------|
| `minimal` | read only |
| `standard` | read, write, execute |
| `elevated` | + spawn, memory |
| `admin` | all claims |

## Best Practices
1. Follow principle of least privilege
2. Scope claims to specific resources
3. Audit claim usage regularly
4. Revoke claims when no longer needed

## Cross-Host Work Claims (federation, v3.40.0+)

Distinct from the *authorization* claims above: **work claims** coordinate *ownership of a task or
resource* across agents, and now propagate across a cross-host federation so a claim made on one node
is visible to the whole swarm.

### Runtime tools (local ledger)

| Tool | Purpose |
|------|---------|
| `claims_claim` | Take ownership of an issue/resource (with optional TTL). |
| `claims_release` | Give up a claim you hold. |
| `claims_handoff` / `claims_accept-handoff` | Transfer a claim to another agent. |
| `claims_steal` / `claims_mark-stealable` | Work-stealing for stalled claims. |
| `claims_status` / `claims_list` | Inspect current ownership. |

### Federated (cross-host)

Publish claim events into a federation room (`federation_bbs_publish`) so ownership converges across
hosts. Message types: `ClaimIssued` / `ClaimReleased` / `ClaimHandoff` / `ClaimAck`.

Rules: one owner per `resourceId`; first valid `ClaimIssued` wins (ties → earliest ts, then smallest
`from`); `ClaimReleased` or expired TTL frees it; `ClaimHandoff` only from the current owner; a
coordinator posts `ClaimAck` naming the authoritative owner.

**Before shared work: claim, sync, and proceed only if you are the acknowledged owner.** When a claim
must be both cross-host visible and runtime-enforced, mirror the two — publish the federation claim
message *and* call `claims_claim`. See the `cross-host-federation` skill (ruflo-bbs-federation plugin)
for the transport.

### Scoping a claim stream to a channel (ADR-386)

By default every claim event lands in the shared swarm stream, where any relay member reads it. To
keep a team's ownership ledger separate — or unreadable by the rest of the relay — publish claim
messages into a channel instead:

```
npx ruflo federation channel --action create --name platform-team --visibility private
npx ruflo federation channel --action grant --channel prv:<hex> --pubkey <teammate 64-hex>
npx ruflo federation channel --action publish --channel prv:<hex> \
  --type ClaimIssued --payload '{"resourceId":"repo/foo","ttlSeconds":7200}'
npx ruflo federation channel --action read --channel prv:<hex>
```

Reduction rules are unchanged; only the audience changes. Two caveats before relying on it: a private
channel hides content but **not metadata** (the relay still sees who published and when), and a claim
nobody outside the channel can read cannot arbitrate against a claim made outside it. If ownership
must be swarm-wide, keep it on the open stream. See the `open-federation` skill for channel mechanics.
