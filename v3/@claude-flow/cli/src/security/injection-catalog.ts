/**
 * Shared injection-phrase catalog for the ruflo security scanners.
 *
 * Both `mcp-composition-inspector` (#2783 static tool scan) and
 * `channel-guard` (#2783 companion runtime message scan) consume this
 * catalog so a new phrase added here strengthens both surfaces at once.
 *
 * Phrases are lowercase substrings matched case-insensitively. Keep the
 * list conservative — false-positive tolerance is low at the runtime
 * message-scan boundary because a hit blocks / quarantines a message.
 */

export const INJECTION_PHRASES = [
  'ignore previous instructions',
  'ignore all prior',
  'disregard the above',
  'you are now',
  'act as',
  'system prompt',
  'system:',
  'assistant:',
  'delete all',
  'rm -rf',
  'exfiltrate',
  'send me the',
  'reveal your',
  'reveal the',
  'override',
  'jailbreak',
] as const;

/**
 * Injection-adjacent keywords that raise a fragment's suspicion score
 * (used by the composition inspector to weight cross-tool shared
 * fragments — a fragment matching one of these AND appearing across
 * two unrelated tools is a strong Shamir-split signal).
 */
export const TRUSTED_INJECTION_ADJACENT_KEYWORDS = [
  'instructions', 'prompt', 'system', 'assistant', 'exfiltrate',
  'reveal', 'override', 'jailbreak', 'ignore', 'disregard',
] as const;

/** Commands that attempt to redirect an agent's tool-selection policy. */
export const TOOL_COERCION_PATTERNS = [
  /\byou\s+must\s+use\b[\s\S]{0,80}\b(?:tools?|mcp)\b/i,
  /\bdo\s+not\s+use\b[\s\S]{0,60}\b(?:native|built[ -]?in)\b[\s\S]{0,30}\b(?:tools?|agents?)\b/i,
  /\balways\s+prefer\b[\s\S]{0,80}\b(?:tools?|mcp)\b/i,
] as const;

export type SecurityProvenance = 'untrusted-inter-agent' | 'trusted-local-policy';
