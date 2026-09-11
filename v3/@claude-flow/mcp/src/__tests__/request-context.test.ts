import { describe, expect, it } from 'vitest';
import { createMCPServer } from '../server.js';
import type { ILogger, MCPRequest } from '../types.js';
import {
  MCP_2026_07_28,
  freezeRequestContext,
  getResponseTransportMetadata,
  principalFromSecret,
  validateRoutingHeaders,
} from '../request-context.js';

const logger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function initialize(id: number): MCPRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: `client-${id}`, version: '1.0.0' },
    },
  };
}

describe('request local MCP authority', () => {
  it('keeps concurrent legacy principals bound to distinct sessions', async () => {
    const server = createMCPServer({
      name: 'test', version: '1.0.0', transport: 'in-process',
    }, logger);

    server.registerTool({
      name: 'test/whoami',
      description: 'Return request scoped identity',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_input, context) => ({
        sessionId: context?.sessionId,
        principal: context?.metadata?.principal,
        requestContextId: context?.metadata?.requestContextId,
      }),
    });

    const principalA = principalFromSecret('token-a');
    const principalB = principalFromSecret('token-b');
    const [initA, initB] = await Promise.all([
      (server as any).handleRequest(initialize(1), freezeRequestContext({
        requestId: 'init-a', transport: 'http', principal: principalA,
      })),
      (server as any).handleRequest(initialize(2), freezeRequestContext({
        requestId: 'init-b', transport: 'http', principal: principalB,
      })),
    ]);

    const sessionA = getResponseTransportMetadata(initA)?.legacySessionId;
    const sessionB = getResponseTransportMetadata(initB)?.legacySessionId;
    expect(sessionA).toBeTruthy();
    expect(sessionB).toBeTruthy();
    expect(sessionA).not.toBe(sessionB);

    const contextA = freezeRequestContext({
      requestId: 'a', transport: 'http', principal: principalA, legacySessionId: sessionA,
    });
    const contextB = freezeRequestContext({
      requestId: 'b', transport: 'http', principal: principalB, legacySessionId: sessionB,
    });

    const calls = Array.from({ length: 20 }, (_, index) => Promise.all([
      (server as any).handleRequest({
        jsonrpc: '2.0', id: 1000 + index, method: 'tools/call',
        params: { name: 'test/whoami', arguments: {} },
      }, contextA),
      (server as any).handleRequest({
        jsonrpc: '2.0', id: 2000 + index, method: 'tools/call',
        params: { name: 'test/whoami', arguments: {} },
      }, contextB),
    ]));

    const results = await Promise.all(calls);
    for (const [a, b] of results) {
      expect((a.result as any).principal).toBe(principalA.subject);
      expect((a.result as any).sessionId).toBe(sessionA);
      expect((b.result as any).principal).toBe(principalB.subject);
      expect((b.result as any).sessionId).toBe(sessionB);
    }
  });

  it('rejects cross principal reuse of a legacy session identifier', async () => {
    const server = createMCPServer({
      name: 'test', version: '1.0.0', transport: 'in-process',
    }, logger);
    const principalA = principalFromSecret('token-a');
    const principalB = principalFromSecret('token-b');

    const initA = await (server as any).handleRequest(initialize(1), freezeRequestContext({
      requestId: 'init-a', transport: 'http', principal: principalA,
    }));
    const sessionA = getResponseTransportMetadata(initA)?.legacySessionId;

    const response = await (server as any).handleRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/list',
    }, freezeRequestContext({
      requestId: 'reuse', transport: 'http', principal: principalB, legacySessionId: sessionA,
    }));

    expect(response.error?.code).toBe(-32002);
  });

  it('allows modern stateless discovery without legacy initialization', async () => {
    const server = createMCPServer({
      name: 'test', version: '1.0.0', transport: 'in-process',
    }, logger);
    const principal = principalFromSecret('modern-token');
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0', id: 7, method: 'server/discover',
    }, freezeRequestContext({
      requestId: 'modern', transport: 'http', principal, protocolVersion: MCP_2026_07_28,
    }));

    expect((response.result as any).protocolVersion).toBe(MCP_2026_07_28);
    expect((response.result as any).transport.sessionsRequired).toBe(false);
    expect((response.result as any).capabilities.resources.subscribe).toBe(false);
  });

  it('rejects initialize for the modern stateless protocol era', async () => {
    const server = createMCPServer({
      name: 'test', version: '1.0.0', transport: 'in-process',
    }, logger);
    const principal = principalFromSecret('modern-token');
    const response = await (server as any).handleRequest(initialize(9), freezeRequestContext({
      requestId: 'modern-init',
      transport: 'http',
      principal,
      protocolVersion: MCP_2026_07_28,
    }));

    expect(response.error?.code).toBe(-32600);
    expect(server.getSessions()).toHaveLength(0);
  });

  it('fails closed on modern resource subscriptions until delivery can be targeted', async () => {
    const server = createMCPServer({
      name: 'test', version: '1.0.0', transport: 'in-process',
    }, logger);
    const principal = principalFromSecret('modern-token');
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0', id: 10, method: 'resources/subscribe', params: { uri: 'ruv://test' },
    }, freezeRequestContext({
      requestId: 'modern-subscribe',
      transport: 'http',
      principal,
      protocolVersion: MCP_2026_07_28,
    }));

    expect(response.error?.code).toBe(-32601);
  });
});

describe('MCP routing header validation', () => {
  it('rejects method disagreement before dispatch', () => {
    const request: MCPRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect(validateRoutingHeaders(request, { routingMethod: 'tools/call' }).valid).toBe(false);
  });

  it('rejects routed tool name disagreement before dispatch', () => {
    const request: MCPRequest = {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'safe-tool' },
    };
    expect(validateRoutingHeaders(request, {
      routingMethod: 'tools/call', routingName: 'other-tool',
    }).valid).toBe(false);
  });

  it('accepts matching routing metadata', () => {
    const request: MCPRequest = {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'safe-tool' },
    };
    expect(validateRoutingHeaders(request, {
      routingMethod: 'tools/call', routingName: 'safe-tool',
    }).valid).toBe(true);
  });
});
