import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createMCPServer } from '../server.js';
import type { ILogger, MCPRequest } from '../types.js';
import {
  freezeRequestContext,
  getResponseTransportMetadata,
  principalFromSecret,
} from '../request-context.js';

const logger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function init(id: number): MCPRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: `stress-${id}`, version: '1.0.0' },
    },
  };
}

describe('MCP request context stress', () => {
  it('preserves session authority across 10000 interleaved requests', async () => {
    const server = createMCPServer({
      name: 'stress', version: '1.0.0', transport: 'in-process',
    }, logger);

    const limiter = (server as any).rateLimiter;
    limiter.check = () => ({ allowed: true });
    limiter.consume = () => undefined;

    server.registerTool({
      name: 'test/identity',
      description: 'Return request-local session identity',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_input, context) => ({ sessionId: context?.sessionId }),
    });

    const principalA = principalFromSecret('stress-token-a');
    const principalB = principalFromSecret('stress-token-b');
    const initA = await (server as any).handleRequest(init(1), freezeRequestContext({
      requestId: 'init-a', transport: 'http', principal: principalA,
    }));
    const initB = await (server as any).handleRequest(init(2), freezeRequestContext({
      requestId: 'init-b', transport: 'http', principal: principalB,
    }));
    const sessionA = getResponseTransportMetadata(initA)?.legacySessionId;
    const sessionB = getResponseTransportMetadata(initB)?.legacySessionId;
    expect(sessionA).toBeTruthy();
    expect(sessionB).toBeTruthy();
    expect(sessionA).not.toBe(sessionB);

    const started = performance.now();
    let aliases = 0;
    const batchSize = 250;
    const total = 10_000;

    for (let offset = 0; offset < total; offset += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, total - offset) }, async (_, index) => {
        const n = offset + index;
        const useA = n % 2 === 0;
        const principal = useA ? principalA : principalB;
        const sessionId = useA ? sessionA : sessionB;
        const response = await (server as any).handleRequest({
          jsonrpc: '2.0', id: 10_000 + n, method: 'tools/call',
          params: { name: 'test/identity', arguments: {} },
        }, freezeRequestContext({
          requestId: `stress-${n}`,
          transport: 'http',
          principal,
          legacySessionId: sessionId,
        }));
        const result = response.result as { sessionId?: string } | undefined;
        if (result?.sessionId !== sessionId) aliases++;
      });
      await Promise.all(batch);
    }

    const crossPrincipal = await (server as any).handleRequest({
      jsonrpc: '2.0', id: 99_999, method: 'tools/list',
    }, freezeRequestContext({
      requestId: 'cross-principal-reuse',
      transport: 'http',
      principal: principalB,
      legacySessionId: sessionA,
    }));

    const elapsedMs = performance.now() - started;
    const throughput = total / (elapsedMs / 1000);
    console.info(JSON.stringify({
      schema: 'ruflo.mcp-isolation-stress/v1',
      benchmark: 'mcp-request-context-isolation',
      candidate: 'request-local-authority',
      workload: 'two principals, two legacy sessions, alternating requests',
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      seed: 'deterministic-alternation-v1',
      sampleSize: total,
      batchSize,
      metrics: {
        aliases,
        crossPrincipalReuseAccepted: !crossPrincipal.error,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        throughputRps: Number(throughput.toFixed(2)),
      },
      regressions: aliases > 0 || !crossPrincipal.error ? 1 : 0,
      failures: aliases,
      costEnergy: 'not measured in unit-test environment',
      reproduction: 'pnpm vitest run src/__tests__/request-context.stress.test.ts',
    }));

    expect(aliases).toBe(0);
    expect(crossPrincipal.error?.code).toBe(-32002);
  }, 30_000);
});
