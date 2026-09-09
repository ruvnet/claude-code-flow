import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  autoMigratePolicyStateIfNeeded,
  classifyMcpTool,
  evaluatePolicyRequest,
  issuePolicyApproval,
  loadPolicyState,
  setPolicyBudget,
  setPolicyMode,
  upsertPolicyRule,
  verifyPolicyLedger,
} from '../src/services/policy-runtime.js';
import { callMCPTool } from '../src/mcp-client.js';

const roots: Array<{ root: string; trust: string }> = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'ruflo-policy-runtime-'));
  mkdirSync(join(root, '.claude-flow'), { recursive: true });
  // policy-runtime derives the trust-anchor id from the CANONICAL root
  // (realpathSync), so hash the same thing here — on macOS tmpdir() sits
  // behind a symlink, so hashing the raw path pointed this test (and its
  // cleanup) at a directory that is never created, leaking real anchors.
  const projectId = createHash('sha256').update(realpathSync(root)).digest('hex');
  roots.push({
    root,
    trust: join(userInfo().homedir, '.config', 'ruflo', 'policy-trust', projectId),
  });
  return root;
}

afterEach(() => {
  for (const item of roots.splice(0)) {
    rmSync(item.trust, { recursive: true, force: true });
    rmSync(item.root, { recursive: true, force: true });
  }
  delete process.env.CLAUDE_FLOW_POLICY_APPROVERS;
  delete process.env.CLAUDE_FLOW_CAPABILITY_ENVELOPE;
});

describe('policy runtime compatibility and transactions', () => {
  it('derives security attributes from trusted tool identity', () => {
    expect(classifyMcpTool('memory_search')).toMatchObject({
      actionType: 'memory.read',
      namespaceAccess: 'read',
      destructive: false,
    });
    expect(classifyMcpTool('memory_delete')).toMatchObject({
      actionType: 'memory.write',
      namespaceAccess: 'write',
      destructive: true,
    });
    expect(classifyMcpTool('policy_rule_upsert')).toMatchObject({
      actionType: 'policy.admin.rule_upsert',
      destructive: true,
    });
  });

  it('does not exempt policy administration from the MCP chokepoint', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await setPolicyMode('enforce', root);
    await expect(callMCPTool('policy_rule_upsert', {
      rule: { id: 'self-allow', effect: 'allow', actions: ['*'] },
      projectRoot: root,
    }, {
      projectRoot: root,
      principalId: 'agent:untrusted',
      principalType: 'agent',
    })).rejects.toThrow('MCP tool not found');
    expect(loadPolicyState(root).rules).toHaveLength(0);
  });

  it('enforces a spawned worker capability envelope at MCP dispatch', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await upsertPolicyRule({ id: 'allow-tools', effect: 'allow', actions: ['mcp.tool.call'] }, root);
    await setPolicyMode('enforce', root);
    process.env.CLAUDE_FLOW_CAPABILITY_ENVELOPE = JSON.stringify({
      actions: ['*'],
      resources: ['*'],
      tools: ['*'],
      network: false,
      destructive: false,
      maxConcurrency: 1,
    });
    await expect(callMCPTool('terminal_execute', {
      command: 'echo should-not-run',
    }, { projectRoot: root })).rejects.toThrow('network-outside-envelope');
  });

  it('uses parent policy from an isolated git worktree', async () => {
    const root = project();
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'README.md'), 'policy worktree test\n');
    execFileSync('git', ['-C', root, 'add', 'README.md']);
    execFileSync('git', [
      '-C', root, '-c', 'user.name=Ruflo Test', '-c', 'user.email=test@invalid',
      'commit', '-qm', 'initial',
    ]);
    await autoMigratePolicyStateIfNeeded(root);
    await upsertPolicyRule({ id: 'allow-tools', effect: 'allow', actions: ['mcp.tool.call'] }, root);
    await setPolicyMode('enforce', root);

    const worktree = `${root}-worker`;
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', worktree, 'HEAD']);
    const previousCwd = process.cwd();
    process.env.CLAUDE_FLOW_CAPABILITY_ENVELOPE = JSON.stringify({
      actions: ['*'],
      resources: ['*'],
      tools: ['*'],
      network: false,
      destructive: false,
    });
    try {
      process.chdir(worktree);
      await expect(callMCPTool('terminal_execute', {
        command: 'echo should-not-run',
      })).rejects.toThrow('network-outside-envelope');
      expect(loadPolicyState(root).receipts).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', worktree]);
    }
  });

  it('auto-migrates an existing installation once in legacy mode', async () => {
    const root = project();
    expect(await autoMigratePolicyStateIfNeeded(root)).toMatchObject({ migrated: true, mode: 'legacy' });
    expect(await autoMigratePolicyStateIfNeeded(root)).toMatchObject({ migrated: false, mode: 'legacy' });
    expect(loadPolicyState(root).migratedFrom).toContain('pre-ADR-324');
  });

  it('applies Codex policy mode changes without overwriting later CLI transitions', async () => {
    const root = project();
    mkdirSync(join(root, '.agents'), { recursive: true });
    const config = join(root, '.agents', 'config.toml');
    writeFileSync(config, '[policy]\nmode = "observe"\n');
    expect(await autoMigratePolicyStateIfNeeded(root)).toMatchObject({ mode: 'observe' });

    await setPolicyMode('enforce', root);
    expect(await autoMigratePolicyStateIfNeeded(root)).toMatchObject({ mode: 'enforce' });

    writeFileSync(config, '[policy]\nmode = "legacy"\n');
    expect(await autoMigratePolicyStateIfNeeded(root)).toMatchObject({ mode: 'enforce' });
  });

  it('fails closed when enforced policy state is modified or removed', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await setPolicyMode('enforce', root);
    const statePath = join(root, '.claude-flow', 'policy', 'state.json');
    expect(existsSync(roots.at(-1)!.trust)).toBe(true);

    const original = readFileSync(statePath, 'utf8');
    const changed = JSON.parse(original) as { mode: string };
    changed.mode = 'legacy';
    writeFileSync(statePath, JSON.stringify(changed));
    expect(() => loadPolicyState(root)).toThrow('policy-state-authentication-failed');

    writeFileSync(statePath, original);
    expect(loadPolicyState(root).mode).toBe('enforce');
    unlinkSync(statePath);
    expect(() => loadPolicyState(root)).toThrow('policy-state-missing-for-anchored-project');
  });

  it('binds the trust anchor to the canonical project path', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await setPolicyMode('enforce', root);
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    try {
      expect(loadPolicyState(alias).mode).toBe('enforce');
    } finally {
      unlinkSync(alias);
    }
  });

  it('does not treat a local issuer string as authenticated human authority', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await expect(issuePolicyApproval({
      id: 'forged-local-approval',
      principal: 'agent:release',
      actions: ['deployment.promote'],
      issuedBy: 'user:claimed-admin',
      expiresAt: Date.now() + 60_000,
      maxUses: 1,
    }, root)).rejects.toThrow('untrusted-approval-issuer');
  });

  it('moves from observation to enforcement without changing rule semantics', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await upsertPolicyRule({ id: 'allow-read', effect: 'allow', actions: ['code.read'] }, root);
    await setPolicyMode('observe', root);
    const writeObserved = await evaluatePolicyRequest({
      identity: { id: 'agent-1', type: 'agent' },
      action: { type: 'code.write', resource: 'src/a.ts' },
    }, root);
    expect(writeObserved.outcome).toBe('denied');
    expect(writeObserved.enforcedOutcome).toBe('allowed');

    await setPolicyMode('enforce', root);
    const read = await evaluatePolicyRequest({
      identity: { id: 'agent-1', type: 'agent' },
      action: { type: 'code.read', resource: 'src/a.ts' },
    }, root);
    expect(read.enforcedOutcome).toBe('allowed');
    const write = await evaluatePolicyRequest({
      identity: { id: 'agent-1', type: 'agent' },
      action: { type: 'code.write', resource: 'src/a.ts' },
    }, root);
    expect(write.enforcedOutcome).toBe('denied');
    expect(await verifyPolicyLedger(root)).toEqual({ valid: true, length: 3 });
  });

  it('cryptographically binds signed evidence provenance claims', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await upsertPolicyRule({
      id: 'verified-release',
      effect: 'allow',
      actions: ['deployment.promote'],
      constraints: { requireSignedEvidence: true, requiredProvenance: ['tool_result'] },
    }, root);
    await setPolicyMode('enforce', root);
    const key = 'test-evidence-key-material';
    process.env.CLAUDE_FLOW_POLICY_EVIDENCE_KEYS = JSON.stringify({ ci: key });
    const evidence = {
      id: 'evidence-1',
      provenance: 'tool_result' as const,
      attestor: 'ci',
      observedAt: 100,
      contentHash: `sha256:${'a'.repeat(64)}`,
      keyId: 'ci',
    };
    const claims = JSON.stringify(evidence);
    const signature = `hmac-sha256:${createHmac('sha256', key).update(claims).digest('hex')}`;
    try {
      expect((await evaluatePolicyRequest({
        identity: { id: 'agent:release', type: 'agent' },
        action: { type: 'deployment.promote' },
        context: { evidence: [{ ...evidence, signature }] },
      }, root)).enforcedOutcome).toBe('allowed');
      expect((await evaluatePolicyRequest({
        identity: { id: 'agent:release', type: 'agent' },
        action: { type: 'deployment.promote' },
        context: {
          evidence: [{ ...evidence, provenance: 'user_claim', signature }],
        },
      }, root)).enforcedOutcome).toBe('denied');
    } finally {
      delete process.env.CLAUDE_FLOW_POLICY_EVIDENCE_KEYS;
    }
  });

  it('serializes concurrent decisions into one valid receipt chain', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await Promise.all(Array.from({ length: 20 }, (_, index) => evaluatePolicyRequest({
      identity: { id: `agent:${index}`, type: 'agent' },
      action: { type: 'code.read', resource: `file-${index}` },
    }, root)));
    expect(await verifyPolicyLedger(root)).toEqual({ valid: true, length: 20 });
  });

  it('cannot overspend a budget under concurrent decisions', async () => {
    const root = project();
    await autoMigratePolicyStateIfNeeded(root);
    await upsertPolicyRule({ id: 'allow-model', effect: 'allow', actions: ['model.call'] }, root);
    await setPolicyBudget({
      id: 'model-window',
      principal: 'agent:*',
      action: 'model.call',
      maxCostUsd: 1,
      periodMs: 60_000,
    }, root);
    await setPolicyMode('enforce', root);

    const decisions = await Promise.all(Array.from({ length: 10 }, (_, index) => evaluatePolicyRequest({
      identity: { id: `agent:${index}`, type: 'agent' },
      action: { type: 'model.call', resource: 'openrouter', costUsd: 0.2 },
    }, root)));

    expect(decisions.filter((decision) => decision.enforcedOutcome === 'allowed')).toHaveLength(5);
    expect(decisions.filter((decision) => decision.enforcedOutcome === 'denied')).toHaveLength(5);
    expect(loadPolicyState(root).usage[0]?.costUsd).toBeCloseTo(1);
    expect(await verifyPolicyLedger(root)).toEqual({ valid: true, length: 10 });
  });
});
