import { describe, expect, it } from 'vitest';
import { createMCPServer } from '../server.js';
import type { ILogger, MCPRequest } from '../types.js';
import {
  MCP_2026_07_28,
  MCP_HEADER_MISMATCH,
  freezeRequestContext,
  getResponseTransportMetadata,
  principalFromSecret,
  validateModernEnvelope,
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

function modernParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_2026_07_28,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
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
      description: 'Return request scoped session identity',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_input, context) => ({
        sessionId: context?.sessionId,
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
      expect((a.result as any).sessionId).toBe(sessionA);
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

  it('returns final-era stateless discovery bookkeeping without a legacy session', async () => {
    const server = createMCPServer({
      name: 'test', version: '1.0.0', transport: 'in-process',
    }, logger);
    const principal = principalFromSecret('modern-token');
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0', id: 7, method: 'server/discover', params: modernParams(),
    }, freezeRequestContext({
      requestId: 'modern', transport: 'http', principal, protocolVersion: MCP_2026_07_28,
    }));

    expect((response.result as any).supportedVersions).toContain(MCP_2026_07_28);
    expect((response.result as any).capabilities.resources.subscribe).toBe(false);
    expect((response.result as any).resultType).toBe('complete');
    expect((response.result as any).ttlMs).toBe(0);
    expect((response.result as any).cacheScope).toBe('private');
    expect((response.result as any)._meta['io.modelcontextprotocol/serverInfo'].name).toBeTruthy();
    expect(server.getSessions()).toHaveLength(0);
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

  it('fails closed on methods removed from the stateless era', async () => {
    const server = createMCPServer({
      name: 'test', version: '1.0.0', transport: 'in-process',
    }, logger);
    const principal = principalFromSecret('modern-token');
    const response = await (server as any).handleRequest({
      jsonrpc: '2.0', id: 10, method: 'resources/subscribe', params: modernParams({ uri: 'ruv://test' }),
    }, freezeRequestContext({
      requestId: 'modern-subscribe',
      transport: 'http',
      principal,
      protocolVersion: MCP_2026_07_28,
    }));

    expect(response.error?.code).toBe(-32601);
  });

  it('validates x-mcp-header annotated tool arguments before execution', async () => {
    const server = createMCPServer({
      name: 'test', version: '1.0.0', transport: 'in-process',
    }, logger);
    let calls = 0;
    server.registerTool({
      name: 'test/tenant',
      description: 'Header bound tool',
      inputSchema: {
        type: 'object',
        properties: {
          tenant: { type: 'string', 'x-mcp-header': 'tenant' } as any,
        },
      },
      handler: async () => {
        calls++;
        return { ok: true };
      },
    });

    const principal = principalFromSecret('modern-token');
    const base = {
      requestId: 'modern-tool',
      transport: 'http' as const,
      principal,
      protocolVersion: MCP_2026_07_28,
    };
    const request: MCPRequest = {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: modernParams({ name: 'test/tenant', arguments: { tenant: 'alpha' } }),
    };

    const rejected = await (server as any).handleRequest(request, freezeRequestContext({
      ...base,
      paramHeaders: { tenant: 'beta' },
    }));
    expect(rejected.error?.code).toBe(MCP_HEADER_MISMATCH);
    expect(calls).toBe(0);

    const accepted = await (server as any).handleRequest(request, freezeRequestContext({
      ...base,
      paramHeaders: { tenant: 'alpha' },
    }));
    expect(accepted.error).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe('MCP 2026 envelope and routing validation', () => {
  it('requires matching protocol version and client capabilities', () => {
    const request: MCPRequest = {
      jsonrpc: '2.0', id: 1, method: 'server/discover', params: modernParams(),
    };
    expect(validateModernEnvelope(request, MCP_2026_07_28).valid).toBe(true);

    const missingCapabilities: MCPRequest = {
      jsonrpc: '2.0', id: 2, method: 'server/discover',
      params: {
        _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_2026_07_28 },
      },
    };
    expect(validateModernEnvelope(missingCapabilities, MCP_2026_07_28).valid).toBe(false);
    expect(validateModernEnvelope(request, '2099-01-01').code).toBe(MCP_HEADER_MISMATCH);
  });

  it('requires Mcp-Method on modern HTTP routing', () => {
    const request: MCPRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const result = validateRoutingHeaders(request, { protocolVersion: MCP_2026_07_28 });
    expect(result.valid).toBe(false);
    expect(result.code).toBe(MCP_HEADER_MISMATCH);
  });

  it('rejects method disagreement before dispatch', () => {
    const request: MCPRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect(validateRoutingHeaders(request, {
      protocolVersion: MCP_2026_07_28,
      routingMethod: 'tools/call',
    }).valid).toBe(false);
  });

  it('rejects routed tool name disagreement before dispatch', () => {
    const request: MCPRequest = {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'safe-tool' },
    };
    expect(validateRoutingHeaders(request, {
      protocolVersion: MCP_2026_07_28,
      routingMethod: 'tools/call', routingName: 'other-tool',
    }).valid).toBe(false);
  });

  it('accepts matching and base64 encoded routing metadata', () => {
    const request: MCPRequest = {
      jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ruv://alpha' },
    };
    expect(validateRoutingHeaders(request, {
      protocolVersion: MCP_2026_07_28,
      routingMethod: 'resources/read',
      routingName: '=?base64?cnV2Oi8vYWxwaGE=?=',
    }).valid).toBe(true);
  });
});
