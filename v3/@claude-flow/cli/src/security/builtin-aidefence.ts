import { createHash } from 'node:crypto';
import { TOOL_COERCION_PATTERNS, type SecurityProvenance } from './injection-catalog.js';

export interface DefenceContext {
  provenance?: SecurityProvenance;
}

export interface BuiltinThreat {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  confidence: number;
}

export interface DefenceResult {
  safe: boolean;
  threats: BuiltinThreat[];
  piiFound: boolean;
  detectionTimeMs: number;
  inputHash: string;
}

export interface DefenceEngine {
  detect(input: string, context?: DefenceContext): Promise<DefenceResult>;
  quickScan(input: string, context?: DefenceContext): { threat: boolean; confidence: number; type?: string };
  getStats(): Promise<{
    detectionCount: number;
    avgDetectionTimeMs: number;
    learnedPatterns: number;
    mitigationStrategies: number;
    avgMitigationEffectiveness: number;
  }>;
  getBestMitigation(type: string): Promise<{ strategy: string; effectiveness: number } | null>;
}

const THREAT_PATTERNS: Array<{
  type: string;
  severity: BuiltinThreat['severity'];
  confidence: number;
  description: string;
  pattern: RegExp;
}> = [
  {
    type: 'prompt-injection',
    severity: 'high',
    confidence: 0.96,
    description: 'Attempts to override or discard trusted instructions',
    pattern: /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,40}\b(?:previous|prior|system|developer|trusted)\b[\s\S]{0,24}\b(?:instructions?|prompts?|rules?|messages?)\b/i,
  },
  {
    type: 'system-prompt-extraction',
    severity: 'high',
    confidence: 0.94,
    description: 'Attempts to reveal hidden system or developer instructions',
    pattern: /\b(?:reveal|show|print|repeat|dump|expose)\b[\s\S]{0,32}\b(?:system|developer|hidden|initial)\b[\s\S]{0,20}\b(?:prompt|message|instructions?)\b/i,
  },
  {
    type: 'jailbreak',
    severity: 'high',
    confidence: 0.91,
    description: 'Attempts to bypass model safeguards or enter an unrestricted mode',
    pattern: /\b(?:developer mode|DAN mode|jailbreak|bypass (?:all )?(?:safeguards|restrictions|filters)|unrestricted mode)\b/i,
  },
  {
    type: 'data-exfiltration',
    severity: 'critical',
    confidence: 0.93,
    description: 'Attempts to transmit secrets or credentials to an external destination',
    pattern: /\b(?:send|upload|post|exfiltrate|transmit)\b[\s\S]{0,48}\b(?:secret|credential|password|api key|token|private key)\b/i,
  },
];

const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];

export function createBuiltinAIDefence(): DefenceEngine {
  let detectionCount = 0;
  let totalDetectionTimeMs = 0;

  const scan = (input: string, context: DefenceContext = {}): BuiltinThreat[] => {
    const threats = THREAT_PATTERNS
      .filter(({ pattern }) => pattern.test(input))
      .map(({ pattern: _pattern, ...threat }) => threat);
    if ((context.provenance ?? 'untrusted-inter-agent') !== 'trusted-local-policy' &&
        TOOL_COERCION_PATTERNS.some((pattern) => pattern.test(input))) {
      threats.push({
        type: 'tool-policy-coercion',
        severity: 'high',
        confidence: 0.92,
        description: 'Untrusted content attempts to replace the agent tool-selection policy',
      });
    }
    return threats;
  };

  return {
    async detect(input: string, context: DefenceContext = {}): Promise<DefenceResult> {
      const startedAt = performance.now();
      const threats = scan(input, context);
      const piiFound = PII_PATTERNS.some((pattern) => pattern.test(input));
      const detectionTimeMs = performance.now() - startedAt;
      detectionCount++;
      totalDetectionTimeMs += detectionTimeMs;
      return {
        safe: threats.length === 0 && !piiFound,
        threats,
        piiFound,
        detectionTimeMs,
        inputHash: createHash('sha256').update(input).digest('hex'),
      };
    },

    quickScan(input: string, context: DefenceContext = {}) {
      const threat = scan(input, context)[0];
      return threat
        ? { threat: true, confidence: threat.confidence, type: threat.type }
        : { threat: false, confidence: 0 };
    },

    async getStats() {
      return {
        detectionCount,
        avgDetectionTimeMs: detectionCount === 0 ? 0 : totalDetectionTimeMs / detectionCount,
        learnedPatterns: 0,
        mitigationStrategies: 4,
        avgMitigationEffectiveness: 0.9,
      };
    },

    async getBestMitigation(type: string) {
      const strategies: Record<string, string> = {
        'prompt-injection': 'Keep trusted instructions immutable and reject instruction overrides',
        'system-prompt-extraction': 'Do not disclose system or developer messages',
        jailbreak: 'Apply the configured policy without adopting alternate personas',
        'data-exfiltration': 'Block external transmission and rotate exposed credentials',
      };
      return strategies[type] ? { strategy: strategies[type], effectiveness: 0.9 } : null;
    },
  };
}
