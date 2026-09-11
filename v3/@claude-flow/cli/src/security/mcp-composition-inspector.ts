/**
 * MCP Composition Inspector (#2783 dream-cycle, arXiv 2606.27027 ShareLock).
 *
 * The attack: an adversary registers N seemingly-benign MCP tools whose
 * INDIVIDUAL descriptions look fine, but whose CONCATENATION forms an
 * injection payload targeting a specific downstream agent. Per-tool
 * inspection misses this (each fragment is under the detection threshold).
 * The inspector composes them and looks for cross-tool signal.
 *
 * SCOPE: heuristic detector, not a security boundary. Reports SUSPECTS —
 * the operator decides. No blocking, no rewriting. This is the "MCP
 * Composition Inspector" surface from dream-cycle #2783's ADR-320
 * recommendation, delivered as a bounded engineering fix rather than
 * an ADR-scope subsystem.
 *
 * Detection method (v1 — deterministic, no LLM):
 *   1. Common-substring scan: for every pair of tools, find shared
 *      substrings of length ≥ minFragment (default 20). Attacker
 *      fragments would repeat identically or near-identically across
 *      the split tools; benign tools rarely share 20+ char sequences
 *      that aren't proper nouns or well-known phrases.
 *   2. Suspicious-phrase catalog: strings that appear in known
 *      prompt-injection templates ("ignore previous instructions",
 *      "you are now", "system prompt", "delete all", etc.) — even
 *      inside one tool, flagged.
 *   3. Tool-name lookalikes: names that differ by ≤ 2 chars from a
 *      known-trusted ruflo tool (typosquatting mitigation).
 *
 * Future v2: SimHash + LSH for scale (arXiv 2606.27027's proposal),
 * OWASP LLM07 alignment.
 */

export interface ToolDescriptor {
  name: string;
  description: string;
}

export interface CompositionSuspect {
  /** Suspect category — `shared-fragment`, `injection-phrase`, `name-lookalike`. */
  kind: 'shared-fragment' | 'injection-phrase' | 'name-lookalike';
  /** Tool name that carries the suspicious content. */
  tool: string;
  /** Peer tool (for shared-fragment / name-lookalike) or empty. */
  peer?: string;
  /** The offending substring or phrase (truncated for display). */
  fragment: string;
  /** Heuristic score, 0..1. Higher = more suspicious. */
  score: number;
  /** Human-readable explanation. */
  reason: string;
}

export interface CompositionScanResult {
  suspects: CompositionSuspect[];
  stats: {
    toolsScanned: number;
    pairsCompared: number;
    fragmentsCompared: number;
  };
}

// Injection-phrase catalog is now shared with channel-guard (#2783
// runtime companion). Adding a phrase there strengthens both surfaces.
import { INJECTION_PHRASES } from './injection-catalog.js';

/** Known-trusted ruflo tool-name prefixes for typosquatting comparison. */
const TRUSTED_PREFIXES = [
  'memory_', 'hooks_', 'swarm_', 'agent_', 'claims_', 'coordination_',
  'session_', 'workflow_', 'neural_', 'browser_', 'daemon_', 'agentdb_',
  'aidefence_', 'analyze_', 'autopilot_', 'business_pod_', 'config_',
  'embeddings_', 'federation_', 'github_', 'guidance_', 'hive-mind_',
  'http_', 'managed_agent_', 'mcp_', 'metaharness_', 'performance_',
  'progress_', 'ruvllm_', 'system_', 'task_', 'terminal_', 'transfer_',
  'wasm_', 'wasm_gallery_', 'agenticow_',
] as const;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Levenshtein distance (bounded — returns Infinity past `max`). */
function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    let minRow = dp[0];
    for (let j = 1; j <= n; j++) {
      const cur = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j - 1], dp[j]) + 1;
      prev = cur;
      if (dp[j] < minRow) minRow = dp[j];
    }
    if (minRow > max) return Infinity;
  }
  return dp[n];
}

/** Find all common substrings of length ≥ minLen between a and b. */
function commonSubstrings(a: string, b: string, minLen: number, cap = 20): string[] {
  const out = new Set<string>();
  const aLen = a.length, bLen = b.length;
  if (aLen < minLen || bLen < minLen) return [];

  // Sliding-window: hash each a[i..i+minLen] and check if it appears in b.
  // Then expand greedily. Cheap and deterministic.
  const seen = new Map<string, number>();
  for (let i = 0; i + minLen <= aLen; i++) {
    seen.set(a.slice(i, i + minLen), i);
  }
  for (let j = 0; j + minLen <= bLen; j++) {
    const window = b.slice(j, j + minLen);
    const aIdx = seen.get(window);
    if (aIdx === undefined) continue;

    // Expand greedily forward
    let len = minLen;
    while (
      aIdx + len < aLen &&
      j + len < bLen &&
      a[aIdx + len] === b[j + len]
    ) len++;

    out.add(a.slice(aIdx, aIdx + len));
  }

  // Sliding windows generate the same match again at every one-character
  // offset. Keep only maximal fragments before population scoring so an
  // overlap cannot inflate either the finding count or the risk score.
  const maximal: string[] = [];
  for (const fragment of Array.from(out).sort((x, y) => y.length - x.length)) {
    const overlapsExisting = maximal.some((candidate) => {
      if (candidate.includes(fragment) || fragment.includes(candidate)) return true;
      const limit = Math.min(candidate.length, fragment.length);
      for (let size = limit; size >= minLen; size--) {
        if (candidate.endsWith(fragment.slice(0, size)) || fragment.endsWith(candidate.slice(0, size))) {
          return true;
        }
      }
      return false;
    });
    if (overlapsExisting) continue;
    maximal.push(fragment);
    if (maximal.length >= cap) break;
  }
  return maximal;
}

export function scanToolDescriptions(
  tools: ToolDescriptor[],
  options: {
    minFragment?: number;
    trustedPrefixes?: readonly string[];
    injectionPhrases?: readonly string[];
    /**
     * Maximum number of tools a fragment may appear in before we treat it
     * as "template language" and stop flagging it. Attack fragments live
     * in small conspiracies (2–3 tools); template language shows up in
     * dozens. Default 3 catches Shamir-split attacks without flooding on
     * legitimate ruflo tools that share the same MCP-tool-description
     * template.
     */
    maxFragmentPopulation?: number;
  } = {},
): CompositionScanResult {
  const minFragment = options.minFragment ?? 20;
  const trustedPrefixes = options.trustedPrefixes ?? TRUSTED_PREFIXES;
  const injectionPhrases = options.injectionPhrases ?? INJECTION_PHRASES;
  const maxPopulation = options.maxFragmentPopulation ?? 3;

  const suspects: CompositionSuspect[] = [];
  const stats = { toolsScanned: tools.length, pairsCompared: 0, fragmentsCompared: 0 };

  const normalized = tools.map((t) => ({
    name: t.name,
    raw: t.description,
    norm: normalize(t.description),
  }));

  // 1) Injection-phrase scan (per tool)
  for (const t of normalized) {
    for (const phrase of injectionPhrases) {
      const idx = t.norm.indexOf(phrase);
      if (idx >= 0) {
        suspects.push({
          kind: 'injection-phrase',
          tool: t.name,
          fragment: t.raw.slice(Math.max(0, idx - 10), idx + phrase.length + 20).trim(),
          score: 0.9,
          reason: `Description contains known prompt-injection phrase "${phrase}"`,
        });
      }
    }
  }

  // 2) Cross-tool shared-fragment scan — first collect ALL candidate
  //    fragments and count how many distinct tools each appears in. Only
  //    flag pairs where the fragment shows up in ≤ maxPopulation tools
  //    (template language across N tools is not an attack signature).
  const fragmentToTools = new Map<string, Set<string>>();
  const rawPairs: Array<{ i: number; j: number; frag: string }> = [];
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      stats.pairsCompared++;
      const shared = commonSubstrings(normalized[i].norm, normalized[j].norm, minFragment);
      stats.fragmentsCompared += shared.length;
      for (const frag of shared) {
        const wordCount = new Set(frag.split(/\s+/).filter(w => w.length > 2)).size;
        if (wordCount < 3) continue;
        const set = fragmentToTools.get(frag) ?? new Set<string>();
        set.add(normalized[i].name);
        set.add(normalized[j].name);
        fragmentToTools.set(frag, set);
        rawPairs.push({ i, j, frag });
      }
    }
  }

  // Emit only fragments that live in a SMALL conspiracy of tools (≤ maxPop).
  const emittedPair = new Set<string>();
  for (const { i, j, frag } of rawPairs) {
    const population = fragmentToTools.get(frag)?.size ?? 0;
    if (population > maxPopulation) continue;
    const key = `${normalized[i].name}||${normalized[j].name}||${frag}`;
    if (emittedPair.has(key)) continue;
    emittedPair.add(key);
    const wordCount = new Set(frag.split(/\s+/).filter(w => w.length > 2)).size;
    suspects.push({
      kind: 'shared-fragment',
      tool: normalized[i].name,
      peer: normalized[j].name,
      fragment: frag.slice(0, 80),
      score: Math.min(1, frag.length / 100),
      reason: `Shared substring (${frag.length} chars, ${wordCount} words, appears in ${population} tools) with ${normalized[j].name} — possible Shamir-split fragment`,
    });
  }

  // 3) Name-lookalike scan (typosquat detection against trusted prefixes)
  for (const t of normalized) {
    for (const prefix of trustedPrefixes) {
      // Exact-prefix match is fine (that's a legitimate ruflo tool)
      if (t.name.startsWith(prefix)) break;
      // Near-match to a trusted prefix (1-2 char edit distance)
      const nameHead = t.name.slice(0, prefix.length);
      const dist = editDistance(nameHead, prefix, 2);
      if (dist > 0 && dist <= 2) {
        suspects.push({
          kind: 'name-lookalike',
          tool: t.name,
          peer: prefix,
          fragment: nameHead,
          score: 0.7,
          reason: `Tool name prefix "${nameHead}" is ${dist} edit(s) from trusted ruflo prefix "${prefix}" — possible typosquat`,
        });
        break;
      }
    }
  }

  return { suspects, stats };
}
