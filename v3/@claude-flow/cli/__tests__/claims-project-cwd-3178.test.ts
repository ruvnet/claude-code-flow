import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimsTools } from '../src/mcp-tools/claims-tools.js';

describe('claims persistence uses the effective project cwd (#3178)', () => {
  let originalCwd: string;
  let project: string;
  let firstCwd: string;
  let secondCwd: string;

  const call = (name: string, input: Record<string, unknown> = {}) =>
    claimsTools.find(tool => tool.name === name)!.handler(input);
  const claim = (issueId = '3178', claimant = 'agent:coder-1:coder') =>
    call('claims_claim', { issueId, claimant });
  const readStore = (root: string) =>
    JSON.parse(readFileSync(join(root, '.claude-flow/claims/claims.json'), 'utf8'));

  beforeEach(() => {
    originalCwd = process.cwd();
    project = mkdtempSync(join(tmpdir(), 'claims-project-cwd-'));
    firstCwd = join(project, 'packages', 'first');
    secondCwd = join(project, 'packages', 'second', 'src');
    mkdirSync(firstCwd, { recursive: true });
    mkdirSync(secondCwd, { recursive: true });
    vi.stubEnv('CLAUDE_FLOW_CWD', project);
    process.chdir(firstCwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    rmSync(project, { recursive: true, force: true });
  });

  it('shares writes, queries, ownership checks and release across nested cwd values', async () => {
    expect(await claim()).toMatchObject({ success: true });
    expect(readStore(project).claims['3178']).toMatchObject({ issueId: '3178' });
    process.chdir(secondCwd);
    expect(await call('claims_list')).toMatchObject({ count: 1 });
    expect(await call('claims_board')).toMatchObject({ summary: { total: 1, active: 1 } });
    expect(await claim('3178', 'agent:coder-2:coder')).toMatchObject({ success: false });
    expect(await call('claims_release', { issueId: '3178', claimant: 'agent:coder-2:coder' }))
      .toMatchObject({ success: false });
    expect(await call('claims_release', { issueId: '3178', claimant: 'agent:coder-1:coder' }))
      .toMatchObject({ success: true });
    process.chdir(firstCwd);
    expect(await call('claims_list')).toMatchObject({ count: 0 });
    expect(readStore(project).claims).toEqual({});
    expect(existsSync(join(firstCwd, '.claude-flow'))).toBe(false);
    expect(existsSync(join(secondCwd, '.claude-flow'))).toBe(false);
  });

  it('persists handoff and status changes in the same store', async () => {
    expect(await claim()).toMatchObject({ success: true });
    process.chdir(secondCwd);
    expect(await call('claims_handoff', {
      issueId: '3178', from: 'agent:coder-1:coder', to: 'human:alice:Alice', progress: 40,
    })).toMatchObject({ success: true });
    process.chdir(firstCwd);
    expect(await call('claims_accept-handoff', { issueId: '3178', claimant: 'human:alice:Alice' }))
      .toMatchObject({ success: true });
    expect(await call('claims_status', { issueId: '3178', status: 'paused' }))
      .toMatchObject({ success: true });
    process.chdir(secondCwd);
    expect(await call('claims_list', { status: 'paused', claimant: 'human:alice:Alice' }))
      .toMatchObject({ count: 1 });
    expect(readStore(project).claims['3178']).toMatchObject({ status: 'paused', progress: 40 });
  });

  it('shares stealable work and the resulting ownership change', async () => {
    expect(await claim()).toMatchObject({ success: true });
    expect(await call('claims_mark-stealable', { issueId: '3178', reason: 'voluntary' }))
      .toMatchObject({ success: true });
    process.chdir(secondCwd);
    expect(await call('claims_stealable')).toMatchObject({ count: 1 });
    expect(await call('claims_steal', { issueId: '3178', stealer: 'agent:coder-2:coder' }))
      .toMatchObject({ success: true });
    process.chdir(firstCwd);
    expect(await call('claims_load', { agentId: 'coder-2' })).toMatchObject({ totalClaims: 1 });
    expect(readStore(project).claims['3178'].claimant.agentId).toBe('coder-2');
    expect(await call('claims_stealable')).toMatchObject({ count: 0 });
  });

  it.each([undefined, '/', process.env.HOME])('preserves cwd fallback for CLAUDE_FLOW_CWD=%s', async value => {
    vi.stubEnv('CLAUDE_FLOW_CWD', value);
    expect(await claim()).toMatchObject({ success: true });
    expect(readStore(firstCwd).claims['3178']).toMatchObject({ issueId: '3178' });
    expect(existsSync(join(project, '.claude-flow'))).toBe(false);
  });

  it('does not share claims between different effective project roots', async () => {
    expect(await claim()).toMatchObject({ success: true });
    vi.stubEnv('CLAUDE_FLOW_CWD', secondCwd);
    expect(await call('claims_list')).toMatchObject({ count: 0 });
    expect(await claim('3178', 'agent:coder-2:coder')).toMatchObject({ success: true });
    expect(readStore(project).claims['3178'].claimant.agentId).toBe('coder-1');
    expect(readStore(secondCwd).claims['3178'].claimant.agentId).toBe('coder-2');
  });
});
