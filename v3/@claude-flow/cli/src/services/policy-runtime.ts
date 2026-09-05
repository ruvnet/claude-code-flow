import {
  AgenticPolicyEngine,
  createLegacyCompatibleState,
  type BudgetLimit,
  type CapabilityEnvelope,
  type PolicyApproval,
  type PolicyDecision,
  type PolicyEvidence,
  type PolicyRequest,
  type PolicyRule,
  type PolicyState,
} from '@claude-flow/security';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';

const POLICY_DIR = join('.claude-flow', 'policy');
const POLICY_FILE = 'state.json';
const LOCK_FILE = 'state.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function paths(projectRoot: string): { dir: string; state: string; lock: string } {
  const root = resolve(projectRoot);
  const dir = join(root, POLICY_DIR);
  return { dir, state: join(dir, POLICY_FILE), lock: join(dir, LOCK_FILE) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function acquireLock(lockPath: string): Promise<() => void> {
  const started = Date.now();
  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      closeSync(fd);
      return () => {
        try { unlinkSync(lockPath); } catch { /* already released */ }
      };
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch { /* another process changed the lock */ }
      await sleep(10);
    }
  }
  throw new Error('policy-state-lock-timeout');
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function trustPaths(projectRoot: string): { key: string; anchor: string } {
  const trustRoot = join(userInfo().homedir, '.config', 'ruflo', 'policy-trust');
  const projectId = createHash('sha256').update(realpathSync(projectRoot)).digest('hex');
  const dir = join(trustRoot, projectId);
  return { key: join(dir, 'anchor.key'), anchor: join(dir, 'state.anchor.json') };
}

function trustKey(projectRoot: string, create: boolean): Buffer | undefined {
  const { key } = trustPaths(projectRoot);
  if (!existsSync(key)) {
    if (!create) return undefined;
    mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
    writeFileSync(key, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const material = readFileSync(key);
  if (material.length !== 32) throw new Error('invalid-policy-trust-key');
  return material;
}

function stateAuthentication(state: PolicyState, key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify(state)).digest('hex');
}

function verifyStateAnchor(projectRoot: string, state: PolicyState | undefined): void {
  const { anchor } = trustPaths(projectRoot);
  if (!existsSync(anchor)) return;
  if (!state) throw new Error('policy-state-missing-for-anchored-project');
  const key = trustKey(projectRoot, false);
  if (!key) throw new Error('policy-trust-key-missing');
  const record = JSON.parse(readFileSync(anchor, 'utf8')) as { authentication?: string };
  const expected = stateAuthentication(state, key);
  const actual = record.authentication ?? '';
  if (!/^[a-f0-9]{64}$/.test(actual)
    || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
    throw new Error('policy-state-authentication-failed');
  }
}

function writePolicyState(projectRoot: string, statePath: string, state: PolicyState): void {
  const anchorPath = trustPaths(projectRoot).anchor;
  if (state.mode === 'enforce' || existsSync(anchorPath)) {
    const key = trustKey(projectRoot, true)!;
    const anchor = {
      version: 1,
      projectRoot: realpathSync(projectRoot),
      mode: state.mode,
      authentication: stateAuthentication(state, key),
      updatedAt: Date.now(),
    };
    // On first enforcement, establish the external trust record first. A
    // crash then leaves either a valid pair or an anchored mismatch that
    // fails closed; it can never leave enforce state silently unanchored.
    if (!existsSync(anchorPath)) {
      writeJsonAtomic(anchorPath, anchor);
      writeJsonAtomic(statePath, state);
      return;
    }
    writeJsonAtomic(statePath, state);
    writeJsonAtomic(anchorPath, anchor);
    return;
  }
  writeJsonAtomic(statePath, state);
}

function detectLegacyCapabilities(projectRoot: string): string {
  const candidates = [
    '.swarm/memory.db',
    '.claude-flow/memory.db',
    '.claude-flow/data/memory.db',
    'agentdb.rvf',
    'agentdb-memory.db',
  ];
  const found = candidates.filter((candidate) => existsSync(join(projectRoot, candidate)));
  const flags = [
    process.env.CLAUDE_FLOW_STRICT_AUTH === 'true' ? 'strict-auth' : null,
    process.env.CLAUDE_FLOW_STRICT_MEMORY === 'true' ? 'strict-memory' : null,
  ].filter(Boolean);
  return `pre-ADR-324; capabilities=${[...found, ...flags].join(',') || 'none-detected'}`;
}

function configuredPolicyMode(projectRoot: string): PolicyState['mode'] | undefined {
  let configured: PolicyState['mode'] | undefined;
  for (const relative of ['.agents/config.toml', '.codex/config.toml']) {
    const file = join(resolve(projectRoot), relative);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    const section = content.match(/(?:^|\n)\[policy\]\s*\n([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[1];
    const mode = section?.match(/(?:^|\n)\s*mode\s*=\s*"(legacy|observe|enforce)"/)?.[1];
    if (mode) configured = mode as PolicyState['mode'];
  }
  return configured;
}

export function loadPolicyState(projectRoot = process.cwd()): PolicyState {
  const target = paths(projectRoot);
  if (!existsSync(target.state)) {
    verifyStateAnchor(projectRoot, undefined);
    return createLegacyCompatibleState(detectLegacyCapabilities(projectRoot));
  }
  const parsed = JSON.parse(readFileSync(target.state, 'utf8')) as PolicyState;
  if (parsed.version !== 1 || !Array.isArray(parsed.rules) || !Array.isArray(parsed.receipts)) {
    throw new Error(`unsupported-policy-state-version:${String(parsed.version)}`);
  }
  verifyStateAnchor(projectRoot, parsed);
  return parsed;
}

export async function autoMigratePolicyStateIfNeeded(projectRoot = process.cwd()): Promise<{
  migrated: boolean;
  statePath?: string;
  mode?: PolicyState['mode'];
}> {
  const target = paths(projectRoot);
  if (existsSync(target.state)) {
    const configured = configuredPolicyMode(projectRoot);
    const current = loadPolicyState(projectRoot);
    if (configured && current.configuredMode !== configured) {
      await withPolicyTransaction(projectRoot, (engine) => engine.setConfiguredMode(configured));
    }
    return { migrated: false, statePath: target.state, mode: loadPolicyState(projectRoot).mode };
  }
  // Only upgrade existing Ruflo installations. A random directory should not
  // acquire policy state merely because `ruflo --version` ran there.
  if (!existsSync(join(resolve(projectRoot), '.claude-flow'))
    && !existsSync(join(resolve(projectRoot), '.swarm'))) return { migrated: false };
  mkdirSync(target.dir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(target.lock);
  try {
    if (!existsSync(target.state)) {
      const state = createLegacyCompatibleState(detectLegacyCapabilities(projectRoot));
      const configured = configuredPolicyMode(projectRoot);
      if (configured) {
        state.mode = configured;
        state.configuredMode = configured;
      }
      writePolicyState(projectRoot, target.state, state);
    }
  } finally {
    release();
  }
  return { migrated: true, statePath: target.state, mode: loadPolicyState(projectRoot).mode };
}

export async function withPolicyTransaction<T>(
  projectRoot: string,
  operation: (engine: AgenticPolicyEngine) => T | Promise<T>,
  options: {
    approvalIssuerVerifier?: (issuer: string) => boolean;
  } = {},
): Promise<T> {
  const target = paths(projectRoot);
  mkdirSync(target.dir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(target.lock);
  try {
    const engine = AgenticPolicyEngine.fromState(loadPolicyState(projectRoot), {
      signingKey: process.env.CLAUDE_FLOW_POLICY_SIGNING_KEY,
      keyId: process.env.CLAUDE_FLOW_POLICY_KEY_ID,
      evidenceVerifier: verifyPolicyEvidence,
      approvalIssuerVerifier: options.approvalIssuerVerifier,
    });
    const result = await operation(engine);
    const nextState = engine.exportState();
    if (!engine.verifyLedger().valid) throw new Error('policy-ledger-verification-failed');
    writePolicyState(projectRoot, target.state, nextState);
    return result;
  } finally {
    release();
  }
}

function verifyPolicyEvidence(evidence: PolicyEvidence): boolean {
  if (!evidence.keyId || !evidence.contentHash || !evidence.signature) return false;
  let keys: Record<string, string>;
  try {
    keys = JSON.parse(process.env.CLAUDE_FLOW_POLICY_EVIDENCE_KEYS ?? '{}') as Record<string, string>;
  } catch {
    return false;
  }
  const key = keys[evidence.keyId];
  if (!key || key.length < 16 || !/^sha256:[a-f0-9]{64}$/i.test(evidence.contentHash)) return false;
  const signedClaims = JSON.stringify({
    id: evidence.id,
    provenance: evidence.provenance,
    attestor: evidence.attestor,
    observedAt: evidence.observedAt,
    contentHash: evidence.contentHash,
    keyId: evidence.keyId,
  });
  const expected = createHmac('sha256', key).update(signedClaims).digest('hex');
  const provided = evidence.signature.replace(/^hmac-sha256:/, '');
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

export async function evaluatePolicyRequest(
  request: PolicyRequest,
  projectRoot = process.cwd(),
): Promise<PolicyDecision> {
  return withPolicyTransaction(projectRoot, (engine) => engine.evaluate(request));
}

export async function setPolicyMode(mode: PolicyState['mode'], projectRoot = process.cwd()): Promise<void> {
  return withPolicyTransaction(projectRoot, (engine) => engine.setMode(mode));
}

export async function upsertPolicyRule(rule: PolicyRule, projectRoot = process.cwd()): Promise<void> {
  return withPolicyTransaction(projectRoot, (engine) => engine.upsertRule(rule));
}

export async function setPolicyBudget(limit: BudgetLimit, projectRoot = process.cwd()): Promise<void> {
  return withPolicyTransaction(projectRoot, (engine) => engine.setBudget(limit));
}

export async function issuePolicyApproval(
  approval: Omit<PolicyApproval, 'uses' | 'issuedAt'> & { uses?: number; issuedAt?: number },
  projectRoot = process.cwd(),
  approvalIssuerVerifier?: (issuer: string) => boolean,
): Promise<PolicyApproval> {
  return withPolicyTransaction(
    projectRoot,
    (engine) => engine.issueApproval(approval),
    { approvalIssuerVerifier },
  );
}

export async function revokePolicyApproval(id: string, projectRoot = process.cwd()): Promise<boolean> {
  return withPolicyTransaction(projectRoot, (engine) => engine.revokeApproval(id));
}

export async function verifyPolicyLedger(projectRoot = process.cwd()): Promise<ReturnType<AgenticPolicyEngine['verifyLedger']>> {
  return withPolicyTransaction(projectRoot, (engine) => engine.verifyLedger());
}

export async function authorizeMcpTool(
  toolName: string,
  input: Record<string, unknown>,
  context: Record<string, unknown> = {},
  attributes: Readonly<{
    actionType?: string;
    network?: boolean;
    destructive?: boolean;
    namespaceAccess?: 'read' | 'write';
    envelope?: CapabilityEnvelope;
    costUsd?: number;
    tokens?: number;
    concurrency?: number;
  }> = {},
): Promise<PolicyDecision> {
  let projectRoot = typeof context.projectRoot === 'string' ? context.projectRoot : process.cwd();
  let processEnvelope: CapabilityEnvelope | undefined;
  if (process.env.CLAUDE_FLOW_CAPABILITY_ENVELOPE) {
    try {
      const parsed = JSON.parse(process.env.CLAUDE_FLOW_CAPABILITY_ENVELOPE) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      processEnvelope = parsed as CapabilityEnvelope;
    } catch {
      throw new Error('invalid-worker-capability-envelope');
    }
    // Linked git worktrees share one immutable common git directory. Derive
    // the coordinator checkout from that directory so a worker cannot fall
    // back to independent legacy policy state in its isolated worktree.
    try {
      const cwd = realpathSync(process.cwd());
      const common = execFileSync(
        'git',
        ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      projectRoot = dirname(realpathSync(common));
    } catch {
      throw new Error('authoritative-worker-policy-root-unavailable');
    }
  }
  return evaluatePolicyRequest({
    identity: {
      id: process.env.CLAUDE_FLOW_PRINCIPAL_ID ?? 'legacy-cli',
      type: process.env.CLAUDE_FLOW_PRINCIPAL_ID ? 'agent' : 'legacy',
    },
    action: {
      type: attributes.actionType ?? 'mcp.tool.call',
      resource: toolName,
      tool: toolName,
      server: typeof context.serverId === 'string' ? context.serverId : 'ruflo',
      namespace: toolName === 'agentdb_hierarchical-create'
        ? `hierarchical:${typeof input.tier === 'string' ? input.tier : 'invalid'}`
        : typeof input.namespace === 'string' ? input.namespace : undefined,
      environment: typeof context.environment === 'string' ? context.environment : undefined,
      costUsd: attributes.costUsd,
      tokens: attributes.tokens,
      concurrency: attributes.concurrency,
      network: attributes.network === true,
      destructive: attributes.destructive === true,
    },
    context: {
      envelope: attributes.envelope ?? processEnvelope,
      approvalIds: Array.isArray(context.approvalIds) ? context.approvalIds.map(String) : undefined,
      evidence: Array.isArray(context.evidence) ? context.evidence as PolicyEvidence[] : undefined,
      metadata: {
        inputDigest: `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`,
      },
    },
  }, projectRoot);
}

/** Trusted classification derived from the registered tool name, never input. */
export function classifyMcpTool(toolName: string): {
  actionType: string;
  network: boolean;
  destructive: boolean;
  namespaceAccess?: 'read' | 'write';
} {
  const normalized = toolName.toLowerCase();
  const policyAdmin = normalized.startsWith('policy_')
    && !['policy_evaluate', 'policy_status'].includes(normalized);
  const memoryRead = /^(?:memory|agentdb)_(?:pattern-)?(?:search|query|get|retrieve|list|status|stats)/.test(normalized);
  const memoryWrite = normalized === 'agentdb_hierarchical-create' || /^(?:memory|agentdb)_(?:pattern-)?(?:store|insert|update|delete|clear|purge|init)/.test(normalized);
  const terminal = /^(?:terminal_execute|bash|shell|exec)/.test(normalized);
  const destructive = policyAdmin
    || terminal
    || /(delete|remove|clear|purge|revoke|promote|deploy|integrate|cleanup|terminate|stop)/.test(normalized);
  const network = terminal
    || /(github|browser|web_|http_|fetch|managed_agent|federation|ipfs|openrouter|provider)/.test(normalized);
  return {
    actionType: policyAdmin
      ? `policy.admin.${normalized.slice('policy_'.length)}`
      : memoryRead
        ? 'memory.read'
        : memoryWrite
          ? 'memory.write'
          : 'mcp.tool.call',
    network,
    destructive,
    namespaceAccess: memoryRead ? 'read' : memoryWrite ? 'write' : undefined,
  };
}
