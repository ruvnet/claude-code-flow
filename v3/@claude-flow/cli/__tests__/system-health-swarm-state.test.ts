import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swarmTools } from '../src/mcp-tools/swarm-tools.js';
import { systemTools } from '../src/mcp-tools/system-tools.js';

describe('system_health swarm state', () => {
  let workdir: string;
  let previousCwd: string | undefined;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'ruflo-system-health-'));
    previousCwd = process.env.CLAUDE_FLOW_CWD;
    process.env.CLAUDE_FLOW_CWD = workdir;
  });

  afterEach(() => {
    if (previousCwd === undefined) delete process.env.CLAUDE_FLOW_CWD;
    else process.env.CLAUDE_FLOW_CWD = previousCwd;
    rmSync(workdir, { recursive: true, force: true });
  });

  it('reports the active swarm and its persisted state store as healthy', async () => {
    const init = swarmTools.find((tool) => tool.name === 'swarm_init')!;
    const health = systemTools.find((tool) => tool.name === 'system_health')!;

    const initialized = await init.handler({ topology: 'hierarchical', maxAgents: 4 }) as {
      swarmId: string;
    };
    const result = await health.handler({ deep: true }) as {
      checks: Array<{ name: string; status: string; message?: string }>;
    };

    expect(initialized.swarmId).toBeDefined();
    expect(result.checks.find((check) => check.name === 'swarm')).toMatchObject({
      status: 'healthy',
      message: expect.stringContaining(initialized.swarmId),
    });
    expect(result.checks.find((check) => check.name === 'database')).toMatchObject({
      status: 'healthy',
      message: 'Persistent swarm state store available',
    });
  });
});
