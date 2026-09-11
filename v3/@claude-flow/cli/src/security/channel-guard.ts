/**
 * ChannelGuard (#2783 dream-cycle companion, arXiv 2607.19430).
 *
 * The finding: individually-safe LLM agents propagate prompt-injection
 * payloads to peers through inter-agent MESSAGE CHANNELS. Each agent's
 * per-message safety check passes; the payload survives because it's
 * a legitimate agent output at each hop. ChannelGuard closes the gap by
 * scanning message content at the routing boundary before it reaches
 * the next agent.
 *
 * SCOPE: same as the MCP Composition Inspector — heuristic detector,
 * not a runtime sandbox. Reports FINDINGS with severity; the caller
 * (swarm coordinator, SendMessage hook, whatever) decides whether to
 * block, quarantine, or forward.
 *
 * Detection method (v1 — deterministic, no LLM):
 *   1. Reuse the composition-inspector injection-phrase catalog for
 *      known bad phrases in the message body.
 *   2. Instruction-shift detection: sudden appearance of `system:` /
 *      `assistant:` / `user:` role markers inside the message body
 *      (mid-payload role reassignment is a classic injection tell).
 *   3. Encoded-payload detection: long base64 / hex runs that could
 *      hide an obfuscated instruction. Flag but don't parse.
 *   4. Zero-width unicode obfuscation: U+200B, U+200C, U+200D, U+FEFF,
 *      bidi overrides (U+202A-E, U+2066-9). These have zero legitimate
 *      use in agent-to-agent messages and are classic evasion.
 */

import {
  INJECTION_PHRASES,
  TOOL_COERCION_PATTERNS,
  TRUSTED_INJECTION_ADJACENT_KEYWORDS,
  type SecurityProvenance,
} from './injection-catalog.js';

export type ChannelFinding = {
  kind: 'injection-phrase' | 'tool-coercion' | 'role-shift' | 'encoded-payload' | 'zero-width-obfuscation';
  severity: 'low' | 'medium' | 'high';
  offset: number;
  span: string;
  reason: string;
};

export interface ChannelScanResult {
  safe: boolean;
  findings: ChannelFinding[];
  provenance: SecurityProvenance;
  stats: { messageLength: number; scanTimeMs: number; trustedPolicyDirectives: number };
}

const ROLE_SHIFT_RE = /(^|\n)\s*(system|assistant|user|developer)\s*:\s*/gi;
const BASE64_RE = /\b[A-Za-z0-9+/]{80,}={0,2}/g;
const HEX_RE = /\b(?:0x)?[a-f0-9]{60,}\b/gi;
// eslint-disable-next-line no-misleading-character-class
const ZWJ_RE = /[​-‍﻿‪-‮⁦-⁩]/g;

export function scanChannelMessage(
  message: string,
  options: {
    minEncodedLen?: number;
    skipEncodedScan?: boolean;
    provenance?: SecurityProvenance;
  } = {},
): ChannelScanResult {
  const start = Date.now();
  const findings: ChannelFinding[] = [];
  const lower = message.toLowerCase();
  const minEncodedLen = options.minEncodedLen ?? 80;
  const provenance = options.provenance ?? 'untrusted-inter-agent';
  let trustedPolicyDirectives = 0;

  // 1) Known prompt-injection phrases (reused from composition-inspector catalog)
  for (const phrase of INJECTION_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx >= 0) {
      findings.push({
        kind: 'injection-phrase',
        severity: 'high',
        offset: idx,
        span: message.slice(Math.max(0, idx - 8), idx + phrase.length + 24),
        reason: `Known injection phrase: "${phrase}"`,
      });
      idx = lower.indexOf(phrase, idx + phrase.length);
    }
  }

  // Tool-policy directives are suspicious when they arrive through an
  // untrusted message channel. The identical text may be legitimate when it
  // is Ruflo-authored local policy, so trust is an explicit caller-provided
  // provenance attribute rather than a textual allowlist.
  for (const pattern of TOOL_COERCION_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    if (provenance === 'trusted-local-policy') {
      trustedPolicyDirectives++;
      continue;
    }
    findings.push({
      kind: 'tool-coercion',
      severity: 'high',
      offset: match.index,
      span: match[0].slice(0, 120),
      reason: 'Untrusted message attempts to replace the agent tool-selection policy',
    });
  }

  // 2) Role-shift: mid-message role reassignment
  {
    ROLE_SHIFT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // Skip the FIRST hit if it lands at message start (that's a legitimate
    // preamble; injection is INSIDE the message).
    let seen = 0;
    while ((m = ROLE_SHIFT_RE.exec(message)) !== null) {
      seen++;
      if (seen === 1 && m.index === 0) continue;
      findings.push({
        kind: 'role-shift',
        severity: 'high',
        offset: m.index,
        span: m[0].trim(),
        reason: `Mid-message role marker (${m[2]}) — classic injection tell`,
      });
    }
  }

  // 3) Encoded-payload: suspiciously long base64 or hex runs
  if (!options.skipEncodedScan) {
    BASE64_RE.lastIndex = 0;
    let b: RegExpExecArray | null;
    while ((b = BASE64_RE.exec(message)) !== null) {
      if (b[0].length < minEncodedLen) continue;
      findings.push({
        kind: 'encoded-payload',
        severity: 'medium',
        offset: b.index,
        span: b[0].slice(0, 40) + '…',
        reason: `Long base64 run (${b[0].length} chars) — may hide instructions`,
      });
    }
    HEX_RE.lastIndex = 0;
    let h: RegExpExecArray | null;
    while ((h = HEX_RE.exec(message)) !== null) {
      if (h[0].length < minEncodedLen) continue;
      findings.push({
        kind: 'encoded-payload',
        severity: 'medium',
        offset: h.index,
        span: h[0].slice(0, 40) + '…',
        reason: `Long hex run (${h[0].length} chars) — may hide instructions`,
      });
    }
  }

  // 4) Zero-width / bidi obfuscation — zero legitimate use in agent messages
  {
    ZWJ_RE.lastIndex = 0;
    let z: RegExpExecArray | null;
    while ((z = ZWJ_RE.exec(message)) !== null) {
      findings.push({
        kind: 'zero-width-obfuscation',
        severity: 'high',
        offset: z.index,
        span: `U+${z[0].charCodeAt(0).toString(16).toUpperCase()}`,
        reason: `Zero-width or bidi-override character — obfuscation attempt`,
      });
    }
  }

  return {
    safe: findings.length === 0,
    findings,
    provenance,
    stats: { messageLength: message.length, scanTimeMs: Date.now() - start, trustedPolicyDirectives },
  };
}

// Suppress unused import warning — TRUSTED_INJECTION_ADJACENT_KEYWORDS is
// kept re-exported for downstream integration hooks.
void TRUSTED_INJECTION_ADJACENT_KEYWORDS;
