# ADR-131: Tool-Output Semantic Guardrail for Indirect Prompt Injection Defense

**Status:** Proposed
**Authors:** claude (dream-cycle agent, 2026-05-26)
**Date:** 2026-05-26
**Related:** ADR-085 (CVE remediation), ADR-093 (MCP audit), ADR-095 (architectural gaps), ADR-118 (aidefence 2.3.0)

---

## Context

The OWASP Top 10 for Agentic Applications 2026 (released December 2025, 100+ contributors) ranks **ASI01 — Agent Goal Hijacking** as the #1 risk. This occurs when attackers embed malicious instructions in content that agents retrieve autonomously — poisoned documents, email, web pages, memory entries, MCP tool responses — because agents cannot reliably distinguish data from instructions.

A Jan 2026 systematic review of 78 studies (arXiv:2601.17548) found that adaptive attack strategies achieve **>85% bypass rates** against current SOTA defenses in agentic coding systems.

Ruflo's `@claude-flow/security` package provides strong transport/boundary security:
- `InputValidator` (Zod-based) — validates at HTTP ingress
- `PathValidator` — prevents path traversal
- `SafeExecutor` — prevents command injection
- `PasswordHasher`, `TokenGenerator` — credential security

**The gap:** None of these controls screen the *semantic content* returned by MCP tools, memory reads (`@claude-flow/memory`), or external API calls before that content enters agent reasoning. An attacker who can influence any retrieved content (tool output, vector store result, web fetch result) can inject adversarial instructions with no current defense layer.

OpenAI Agents SDK (March 2025) addresses this with parallel-execution guardrails at every tool-invocation boundary — input, output, and per-tool validators that run without adding latency. Ruflo has no equivalent.

---

## Decision

Introduce a `ToolOutputGuardrail` class in `@claude-flow/security/src/tool-output-guardrail.ts` that:

1. **Intercepts** content returned from MCP tool calls, memory retrievals, and external API responses before the content is appended to agent context.
2. **Screens** content using a layered detection strategy:
   - Pattern matching for known injection signatures (role-change, instruction-override, ignore-previous patterns)
   - Structural anomaly detection (unexpected JSON keys, nested instruction blocks)
   - Optional LLM-based semantic check for high-sensitivity tools (configurable per tool)
3. **Runs in parallel** with agent processing — does not add to critical-path latency for passing content.
4. **Emits** a `tool-output-injection-detected` security event to the existing audit hook pipeline.
5. **Fails safe** — on detection, quarantines the payload and returns a sanitized stub; never silently passes suspicious content.

### Interface

```typescript
// @claude-flow/security/src/tool-output-guardrail.ts

export interface ToolOutputGuardrailConfig {
  sensitivity: 'low' | 'medium' | 'high';
  semanticCheck: boolean;
  trustedTools?: string[];   // tool IDs exempt from screening
  onDetection: 'quarantine' | 'strip' | 'block';
}

export interface GuardrailResult {
  passed: boolean;
  threat?: {
    type: 'pattern-match' | 'structural-anomaly' | 'semantic-injection';
    confidence: number;
    payload: string;  // redacted excerpt for audit
  };
  sanitizedContent?: string;
}

export class ToolOutputGuardrail {
  constructor(config: ToolOutputGuardrailConfig) {}
  async screen(toolId: string, content: string): Promise<GuardrailResult> {}
}
```

### Integration Points

| Surface | Where to integrate | Priority |
|---------|-------------------|----------|
| MCP tool result handler | `v3/@claude-flow/cli/src/mcp/` tool response pipeline | P0 |
| Memory retrieve responses | `v3/@claude-flow/memory/src/` read path | P0 |
| Hive-mind consensus payload | Raft state proposal handler | P1 |
| External API / web-fetch results | `hooks/post-command` for fetch tools | P1 |
| Agent-to-agent message content | `TeammateIdle` hook, SendMessage receive path | P2 |

---

## Consequences

### Benefits
- Closes the primary attack vector for OWASP ASI01 (Agent Goal Hijacking)
- Aligns Ruflo's per-tool-call security posture with OpenAI Agents SDK
- Enables OWASP Top 10 for Agents 2026 compliance mapping (ASI01, ASI06 covered)
- Provides audit trail for injection attempts via existing security event system

### Risks / Trade-offs
- False-positive rate must be tuned — overly aggressive screening breaks legitimate tool outputs containing instructional text (e.g., documentation tools)
- Semantic check (LLM-based) adds cost and latency; must be opt-in, not default
- `trustedTools` exemption list creates an allowlist that must be maintained

### Not in Scope
- This ADR does not address ASI02–ASI10; a separate OWASP compliance mapping document is recommended (see Next Steps)
- Training-based defenses (fine-tuning the model to resist injection) are out of scope for this library-level ADR

---

## Implementation Plan

1. Implement `ToolOutputGuardrail` class with pattern-matching tier only (P0, ~3 days)
2. Integrate into MCP tool result handler and memory read path (P0, ~2 days)
3. Add `tool-output-injection-detected` event to `@claude-flow/hooks` audit pipeline (P0, ~1 day)
4. Add hive-mind consensus payload screening (P1, ~2 days)
5. Write `v3/docs/security/owasp-agents-2026-mapping.md` compliance matrix (P1, ~1 day)

---

## References

- OWASP Top 10 for Agentic Applications 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- arXiv:2601.17548 — Prompt Injection Attacks on Agentic Coding Assistants
- arXiv:2602.10453 — The Landscape of Prompt Injection Threats in LLM Agents
- arXiv:2505.05849 — AgentVigil: Black-Box Red-teaming for Indirect Prompt Injection
- OpenAI Agents SDK Guardrails: https://openai.github.io/openai-agents-python/guardrails/
- Dream Cycle Session Commit: 60f37f2d37a342866d9d4f66a257ec1166a21794
