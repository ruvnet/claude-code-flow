/**
 * Swarm executor — pure event/prompt/overview helpers (ADR-385).
 *
 * This module holds the side-effect-free half of streaming swarm execution:
 * per-role prompt derivation, reshaping a `claude -p --output-format
 * stream-json` line into the CLI's own NDJSON event, secret redaction, and
 * the final structured overview. The impure spawn/pool/deadline engine lives
 * in `swarm-executor.ts` and imports from here. Keeping the pure pieces
 * separate is what the unit test imports (no subprocess needed), and it keeps
 * both files under the 500-line repo limit.
 */

/** NDJSON event kinds streamed to stdout. `overview` is the terminal event. */
export type SwarmEventKind = 'token' | 'tool' | 'status' | 'result' | 'error' | 'overview';

/** One streamed NDJSON event. Interleaved across agents on a single stdout. */
export interface SwarmEvent {
  agent: string;
  role: string;
  kind: SwarmEventKind;
  data: string;
  ts: string;
  /** Absolute path of a file a tool_use event touched (Write/Edit/…). */
  file?: string;
  /** Attached to overview events (JSON payload). */
  overview?: SwarmOverview;
}

/** A single planned worker (agentPlan counts are expanded into these). */
export interface WorkerSpec {
  name: string;
  role: string;
  model: string;
  prompt: string;
}

/** Terminal per-worker status. */
export type WorkerStatus = 'ok' | 'partial' | 'failed';

export interface WorkerResult {
  name: string;
  role: string;
  model: string;
  status: WorkerStatus;
  summary: string;
  files: string[];
  costUsd: number | null;
  error?: string;
}

/** Structured "what it did / where it is / how to deploy" overview (I2). */
export interface SwarmOverview {
  objective: string;
  swarmId: string;
  topology: string;
  consensus: string;
  strategy: string;
  roster: Array<{ name: string; role: string; model: string }>;
  workers: WorkerResult[];
  artifacts: string[];
  memoryKeys: string[];
  transcriptPath: string | null;
  elapsedMs: number;
  reduce: string;
  nextSteps: string[];
}

/**
 * Expand an agentPlan (role/type/count rows) into individual named workers,
 * truncated to `maxAgents` (preserving plan order — the coordinator, listed
 * first, always survives the trim). Names are role-scoped and unique
 * (`coder-1`, `coder-2`). `objective` is untrusted text and is only ever
 * embedded as literal prompt content, never a shell string.
 */
export function buildWorkerSpecs(
  objective: string,
  agentPlan: Array<{ role: string; type: string; count: number; purpose: string }>,
  opts: { maxAgents: number; model: string },
): WorkerSpec[] {
  const specs: WorkerSpec[] = [];
  for (const row of agentPlan) {
    const role = String(row.type || row.role || 'worker').toLowerCase();
    const count = Math.max(1, Number(row.count) || 1);
    for (let i = 1; i <= count; i++) {
      const name = count === 1 ? role : `${role}-${i}`;
      specs.push({
        name,
        role,
        model: opts.model,
        prompt: buildWorkerPrompt(objective, role, row.purpose, { index: i, total: count }),
      });
    }
  }
  const cap = Math.max(1, Math.floor(opts.maxAgents));
  return specs.slice(0, cap);
}

/**
 * Deterministic per-role prompt derivation (I1). A coordinator decomposes and
 * summarizes; each specialist gets a focused instruction. An LLM coordinator
 * pass that hands bespoke subtasks to each worker is deferred (ADR-385 I1.5).
 */
export function buildWorkerPrompt(
  objective: string,
  role: string,
  purpose: string,
  seat: { index: number; total: number },
): string {
  const seatNote = seat.total > 1 ? ` You are instance ${seat.index} of ${seat.total} in this role — focus on a distinct slice.` : '';
  const header = `You are the ${role} on an autonomous swarm working toward a shared objective.${seatNote}\n\nOBJECTIVE:\n${objective}\n\nYOUR ROLE (${role}): ${purpose}\n`;
  const byRole: Record<string, string> = {
    coordinator:
      'Decompose the objective into concrete steps, then EXECUTE the smallest end-to-end slice yourself so the objective is materially advanced. Report the decomposition and what you completed.',
    researcher:
      'Investigate the objective against the current working directory and report the concrete findings/constraints needed to complete it.',
    architect:
      'Produce a concrete implementation approach (files to touch, interfaces, sequence) and, where trivial, create the scaffolding.',
    coder:
      'Implement the objective directly. Create or edit the necessary files in the working directory. Do exactly what the objective asks — nothing more.',
    tester:
      'Verify the objective is met. Run or write the checks that prove it, and report pass/fail with evidence.',
    reviewer:
      'Review whatever exists against the objective for correctness and safety, and report concrete findings.',
    analyst:
      'Analyze the objective and the working directory, and report the actionable conclusions.',
    optimizer:
      'Improve the relevant code/behavior toward the objective without changing its contract, and report what changed.',
  };
  const instruction = byRole[role] ?? 'Advance the objective within your role and report what you did concretely.';
  return `${header}\nINSTRUCTION: ${instruction}\n\nWork in the current directory. Keep output focused. When done, end with a one-paragraph summary of what you did and any file paths you created or changed.`;
}

// --- secret redaction ------------------------------------------------------

const REDACTION_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g, // Anthropic keys
  /sk-[A-Za-z0-9]{16,}/g, // OpenAI-style keys
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, // bearer tokens
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*\S+/gi, // KEY=... assignments
];

/** Strip anything that looks like a secret before it reaches the stream. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of REDACTION_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

// --- stream-json reshaping -------------------------------------------------

/** Tool inputs whose `file_path` is a real artifact write. */
const FILE_WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update']);

function ev(agent: string, role: string, kind: SwarmEventKind, data: string, ts: string, file?: string): SwarmEvent {
  const e: SwarmEvent = { agent, role, kind, data: redact(String(data ?? '')), ts };
  if (file) e.file = file;
  return e;
}

/**
 * Reshape one raw `claude -p --output-format stream-json --verbose` NDJSON
 * line into zero or more SwarmEvents. Unknown/blank lines yield []; a
 * non-JSON line becomes a single status event (so nothing is silently
 * swallowed — COROLLARY 7). Field names verified against a real capture.
 */
export function shapeStreamLine(line: string, agent: string, role: string, now: () => string = () => new Date().toISOString()): SwarmEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [ev(agent, role, 'status', trimmed.slice(0, 200), now())];
  }
  const ts = now();
  const type = msg?.type;

  if (type === 'system') {
    if (msg.subtype === 'init') return [ev(agent, role, 'status', 'session started', ts)];
    // hooks / thinking-token telemetry is noise for the stream — drop it.
    return [];
  }

  if (type === 'rate_limit_event') {
    return [ev(agent, role, 'status', 'rate-limit event', ts)];
  }

  if (type === 'assistant') {
    const out: SwarmEvent[] = [];
    const content = Array.isArray(msg?.message?.content) ? msg.message.content : [];
    for (const block of content) {
      if (block?.type === 'text' && block.text) {
        out.push(ev(agent, role, 'token', String(block.text), ts));
      } else if (block?.type === 'tool_use') {
        const fp = typeof block?.input?.file_path === 'string' ? block.input.file_path : undefined;
        const isFileWrite = FILE_WRITING_TOOLS.has(String(block?.name)) && fp;
        out.push(ev(agent, role, 'tool', `${block?.name ?? 'tool'}${fp ? ` ${fp}` : ''}`, ts, isFileWrite ? fp : undefined));
      }
      // thinking blocks are intentionally not streamed.
    }
    return out;
  }

  if (type === 'user') {
    const out: SwarmEvent[] = [];
    const content = Array.isArray(msg?.message?.content) ? msg.message.content : [];
    for (const block of content) {
      if (block?.type === 'tool_result') {
        const c = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        out.push(ev(agent, role, 'tool', `result: ${c.slice(0, 160)}`, ts));
      }
    }
    return out;
  }

  if (type === 'result') {
    if (msg.is_error) {
      return [ev(agent, role, 'error', String(msg.result ?? msg.subtype ?? 'worker reported error'), ts)];
    }
    return [ev(agent, role, 'result', String(msg.result ?? 'done'), ts)];
  }

  return [];
}

/**
 * Absolute file paths a worker's events touched (from tool_use file_path).
 * Union this with a cwd git-status delta at the call site.
 */
export function artifactsFromEvents(events: SwarmEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) if (e.file) set.add(e.file);
  return [...set];
}

// --- overview --------------------------------------------------------------

export function buildOverview(input: {
  objective: string;
  swarmId: string;
  topology: string;
  consensus: string;
  strategy: string;
  workers: WorkerResult[];
  extraArtifacts?: string[];
  memoryKeys?: string[];
  transcriptPath?: string | null;
  elapsedMs: number;
  reduce: string;
}): SwarmOverview {
  const artifactSet = new Set<string>(input.extraArtifacts ?? []);
  for (const w of input.workers) for (const f of w.files) artifactSet.add(f);
  const artifacts = [...artifactSet].sort();
  const failed = input.workers.filter((w) => w.status === 'failed').length;
  const partial = input.workers.filter((w) => w.status === 'partial').length;
  const nextSteps: string[] = [];
  if (artifacts.length) nextSteps.push(`Review the changed files: ${artifacts.slice(0, 5).join(', ')}${artifacts.length > 5 ? ' …' : ''}`);
  nextSteps.push('Run the project checks (build + tests) to validate the changes.');
  if (failed) nextSteps.push(`${failed} worker(s) failed — re-run with a longer --deadline-secs or narrower objective.`);
  else if (partial) nextSteps.push(`${partial} worker(s) hit the deadline — inspect the transcript and re-run if needed.`);
  if (input.transcriptPath) nextSteps.push(`Full transcript: ${input.transcriptPath}`);
  return {
    objective: input.objective,
    swarmId: input.swarmId,
    topology: input.topology,
    consensus: input.consensus,
    strategy: input.strategy,
    roster: input.workers.map((w) => ({ name: w.name, role: w.role, model: w.model })),
    workers: input.workers,
    artifacts,
    memoryKeys: input.memoryKeys ?? [],
    transcriptPath: input.transcriptPath ?? null,
    elapsedMs: input.elapsedMs,
    reduce: input.reduce,
    nextSteps,
  };
}

/** Human-facing card (rendered to stderr in execute mode). */
export function renderOverviewCard(o: SwarmOverview): string {
  const lines: string[] = [];
  const secs = (o.elapsedMs / 1000).toFixed(1);
  lines.push(`Objective : ${o.objective}`);
  lines.push(`Swarm     : ${o.swarmId} (${o.topology} / ${o.consensus} / ${o.strategy})`);
  lines.push(`Elapsed   : ${secs}s`);
  lines.push('');
  lines.push('Workers:');
  for (const w of o.workers) {
    const mark = w.status === 'ok' ? 'ok' : w.status === 'partial' ? 'partial' : 'FAILED';
    lines.push(`  [${mark}] ${w.name} (${w.role}, ${w.model})${w.error ? ` — ${w.error}` : ''}`);
  }
  lines.push('');
  lines.push(`Artifacts (${o.artifacts.length}):`);
  if (o.artifacts.length) for (const f of o.artifacts) lines.push(`  ${f}`);
  else lines.push('  (none detected)');
  if (o.memoryKeys.length) {
    lines.push('');
    lines.push(`Memory keys: ${o.memoryKeys.join(', ')}`);
  }
  lines.push('');
  lines.push('Next steps:');
  for (const s of o.nextSteps) lines.push(`  - ${s}`);
  return lines.join('\n');
}
