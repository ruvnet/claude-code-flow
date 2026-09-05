# ADR-339 — Memory Write Integrity Validation & MCP Tool Verification

**Status**: Proposed  
**Date**: 2026-06-06  
**Authors**: claude (dream-cycle agent, 2026-06-06)  
**Related**: ADR-144 (Agent Authorization Propagation), ADR-145 (Plugin Supply-Chain Integrity), ADR-146 (ToolOutputGuardrail Integration)

## Context

Dream Cycle research session 2026-06-06 (SLOT=1, DEEP=security) identified two critical gaps not addressed by ADRs 144–146:

### Gap 1 — OWASP ASI06: Memory & Context Poisoning

arXiv:2606.04329 (Dash et al., June 2026, **Grade A**) provides the first systematic taxonomy of memory poisoning attacks against LLM agents, identifying:

- **4 write channels**: direct injection, retrieval-augmented write, tool-write, agent-to-agent relay
- **9 structural vulnerabilities** across those channels
- **Key result**: a single adversarial memory write can exert long-term influence over agent behavior

Ruflo's AgentDB exposes all 4 channels. `InputValidator` exists in `@claude-flow/security` but is not applied at any AgentDB write boundary. `vector_indexes` rows have no integrity checksums. This is OWASP ASI06:2026.

### Gap 2 — MCP Tool Description-Code Inconsistency

arXiv:2606.04769 (Shi et al., June 2026, **Grade A**) measured 9.93% description-code mismatch in a corpus of real-world MCP servers — where a tool's natural-language description misrepresents its actual implementation. These mismatches create defense blind spots: guardrails screen against the description, while the code executes differently.

ADR-145 verifies plugin supply-chain signatures but does not parse or compare tool descriptions against their implementations at registration time.

### Relationship to ADR-146

ADR-146 wires `ToolOutputGuardrail` at content-entry boundaries (MCP tool result → agent context, memory read → agent context, hooks output, Raft consensus payload). It screens *output content* flowing into the agent. It does not validate *memory write operations* or *MCP tool registration semantics*. These are upstream of ADR-146's guardrail positions and require separate validation logic.

## Decision

Add two validation layers to `@claude-flow/security`:

### Layer A — AgentDB Memory Write Validator

Apply `InputValidator` at each of the 4 write channels before data reaches the `vector_indexes` table:

| Channel | Call site | Validation action |
|---------|-----------|------------------|
| Direct injection (`memory_store`) | `MemoryService.store()` | Schema + content scan, reject on policy violation |
| Retrieval-augmented write | `MemoryService.augmentedWrite()` | Source provenance check, strip injected instructions |
| Tool-write (`memory_write` tool) | Tool handler wrapper | Full `InputValidator` pass + write ACL check (ADR-144) |
| Agent-to-agent relay (hive-mind) | Hive-mind message router | HMAC origin verification before write dispatch |

Each validated write appends an integrity checksum (SHA-256 of canonical content + write-timestamp + agent identity) to the `vector_indexes` row in a new `integrity_hash` column. Read paths surface a `tampered: true` flag when stored hash diverges from recomputed hash.

### Layer B — MCP Tool Description-Code Consistency Checker

At MCP server registration time (plugin install + daemon startup), run a static consistency scan:

1. Parse each tool's `description` string for capability claims (action verbs, scope keywords).
2. Compare against the registered handler's function signature and known safe-call envelope.
3. Flag tools where description claims diverge from implementation shape (target: surface ≥9.93% mismatch rate per arXiv:2606.04769 methodology).
4. Emit a `MCP_TOOL_INCONSISTENCY` event to the ADR-146 telemetry sink; block registration if `trustLevel < 'official'`.

## Consequences

### Positive
- Closes OWASP ASI06 for Ruflo's 4 identified write channels.
- Detects the 9.93% real-world MCP mismatch class before tools enter the agent's trust perimeter.
- Integrity checksums enable forensic reconstruction of poisoning chains.
- Reuses existing `InputValidator` and `TokenGenerator` — no new security primitives.
- Feeds the ADR-146 telemetry sink — single observability pane for all security events.

### Negative
- `integrity_hash` column is a schema migration on `vector_indexes` — requires backwards-compatible default for existing rows.
- Description-code scanner is heuristic — false positive rate depends on tool description quality; needs threshold tuning.
- Agent-to-agent HMAC at the hive-mind router adds ~0.3ms per relay message (estimated; must be benchmarked).

### Neutral
- Does **not** address ASI07 (inter-agent message signing for SendMessage payloads) — that requires a separate HMAC injection point in the comms layer and is deferred to a follow-on ADR.
- Does **not** address ASI10 (rogue agent shutdown) — deferred.

## Implementation Plan

| Phase | Work item | Effort |
|-------|-----------|--------|
| P1 | `integrity_hash` column migration + SHA-256 checksum on `memory_store` direct path | 0.5 day |
| P2 | `InputValidator` wrappers on retrieval-augmented write + tool-write | 0.5 day |
| P3 | HMAC origin check on hive-mind agent-to-agent relay write | 1 day |
| P4 | MCP description-code consistency scanner + `MCP_TOOL_INCONSISTENCY` event | 1 day |

Total estimated: **3 days**.

## References

- arXiv:2606.04329 — "From Untrusted Input to Trusted Memory: A Systematic Study of Memory Poisoning Attacks in LLM Agents" (Dash et al., Jun 2026)
- arXiv:2606.04769 — "Description-Code Inconsistency in Real-world MCP Servers" (Shi et al., Jun 2026)
- arXiv:2606.05743 — "Membrane: A Self-Evolving Contrastive Safety Memory for LLM Agent Defense" (Choi et al., Jun 2026)
- OWASP ASI06:2026 — Memory & Context Poisoning
- OWASP ASI07:2026 — Insecure Inter-Agent Communication
- Dream Cycle gist: v3/docs/research/dream-cycle-2026-06-06-security.md

## 2026-09-05 addendum: protected canonical hierarchical records

**Status:** Implemented structural storage/tool prerequisite; this does not mark
this broader ADR implemented or establish a production identity authority.

The durable tiered fallback previously evicted the oldest active row after
5,000 entries per tier, and simultaneous stores could create ambiguous active
rows for the same key/tier. Exact getter commit
`b3290655f3db010706c1c10efa2c0ba35082e88f` detects ambiguity and reads the current
row, but cannot restore evicted authority or atomically create a missing member.

An operator may now configure the fallback before serving requests:

```sh
export RUFLO_HIERARCHICAL_PROTECTED_RETENTION='{"prefixes":[{"tier":"semantic","keyPrefix":"ruclip:company:cognitum:"}],"maxEntries":1000}'
```

This protects both `ruclip:company:<company>:org-member:<member>` and
`ruclip:company:<company>:goal:<goal>:issue:<issue>` under that reviewed company
prefix. The option is server-owned; MCP callers cannot set protection flags,
change the bound, or claim arbitrary protected namespaces. The policy persists
in the same SQLite database and remains effective when a later process omits
the environment variable. A conflicting supplied policy fails closed. Changing
or removing a persisted policy requires a separately reviewed migration; there
is no automatic downgrade or public policy-edit tool.

`maxEntries` is a global bound of 1–5,000 active protected rows, with at most
64 nonempty tier-qualified prefixes. A new protected row at capacity fails with
`protected_capacity_exceeded`; existing records remain readable/updateable and
idempotent creates still return the original row. Values exceeding 100,000
UTF-16 code units are rejected, never truncated. Unprotected rows retain the
existing 5,000-per-tier FIFO behavior. Hydrated recall remains bounded and is
not an authoritative complete listing; exact reads bypass that cache.

SQLite triggers prevent deletion, archival/rekeying and duplicate active
protected keys, including attempts by older processes with stale hydrated
maps. Ordinary protected stores update the current durable row in one
transaction; supersede/temporal operations and hard deletion are explicitly
refused. Deactivation belongs in the canonical record value, so its durable
identity remains reserved. Initial adoption refuses ambiguous protected keys
or a preexisting protected population over the bound, without deleting rows.
Protection cannot recover authority already evicted before adoption.

The additive MCP tool is:

```text
agentdb_hierarchical-create({key, tier, value})
  -> {success:true, status:'created'|'existing', entry,
      durable:true, persistence:'sqlite', retention:'protected'}
  -> {success:false, status:'unsupported'|'error', error}
```

There is no lookup-then-store/native/volatile fallback. Creation requires a
configured protected prefix and serializes the exact key/tier existence check
and insert under `BEGIN IMMEDIATE`. An existing row is returned unchanged even
if its value says inactive or its temporal window has expired. The caller must
verify canonical ID, company, identity and active status; creation is never
permission to reactivate or grant authority. Conflicting concurrent creates
observe one winner and its stored bytes. The new tool passes the existing
policy chokepoint as `memory.write`, with its trusted namespace derived as
`hierarchical:<tier>` so caller input cannot bypass namespace envelopes.
Existing tool classification and supported envelope behavior are unchanged.

This is not a transaction across the separate ruClip identity locator
(`memory_store`, namespace `ruclip-identity-v1`) and canonical member record.
Joining still requires deterministic canonical IDs, safe retry/reconciliation
and active-record validation; readiness must stay blocked where those service
adapters are missing. Nor does this provide compare-and-swap authority updates,
network-filesystem durability, federation, or deployment authorization.

Validation covers real independent processes racing same-key and different-key
creates, capacity enforcement, stale-process updates, more than 5,000 ordinary
writes, reopening without configuration, protected SQL deletion/archival
attempts, expired/inactive existing records, policy namespace denial and strict
MCP input. Native persistent SQLite is the supported operational adapter;
volatile/in-memory fixtures are not release evidence.
