import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { xFederationTools } from '../src/mcp-tools/x-federation-tools.js';

const tool = (n: string) => xFederationTools.find((t) => t.name === n)!;
const sse = (result: unknown) => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`;
const toolResult = (obj: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], isError });

describe('x_federation_* (ruflo → x.ruv.io gateway)', () => {
  let calls: Array<{ url: string; body: any }> = [];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (body.method === 'tools/call') {
        if (body.params.name === 'federation_sync') return new Response(sse(toolResult({ count: 1, messages: [{ from: 'ruvzen' }] })));
        if (body.params.arguments?.adminToken === 'wrong') return new Response(sse(toolResult({ error: 'admin token required or invalid' }, true)));
        return new Response(sse(toolResult({ ok: true, echo: body.params.arguments })));
      }
      if (body.method === 'resources/read') return new Response(sse({ contents: [{ uri: body.params.uri, text: JSON.stringify({ uri: body.params.uri }) }] }));
      return new Response(sse({}));
    }));
    delete process.env.RUFLO_X_ADMIN_TOKEN; delete process.env.RUFLO_X_GATEWAY_URL;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('registers the expected tool set with ADR-112 style descriptions', () => {
    const names = xFederationTools.map((t) => t.name).sort();
    expect(names).toEqual(['x_federation_admit', 'x_federation_claims', 'x_federation_invite_mint', 'x_federation_publish', 'x_federation_registry', 'x_federation_roster', 'x_federation_sync'].sort());
    for (const t of xFederationTools) { expect(t.description).toMatch(/Use when/); expect(t.description).toMatch(/wrong because/); }
  });
  it('sync posts a JSON-RPC tools/call to <gateway>/mcp and parses the SSE data frame', async () => {
    const out = await tool('x_federation_sync').handler({ sinceSeconds: 60, limit: 5 }, {} as any);
    expect(calls[0].url).toBe('https://x.ruv.io/mcp');
    expect(calls[0].body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'federation_sync', arguments: { sinceSeconds: 60, limit: 5 } } });
    expect(out).toEqual({ count: 1, messages: [{ from: 'ruvzen' }] });
  });
  it('honours RUFLO_X_GATEWAY_URL and strips a trailing slash', async () => {
    process.env.RUFLO_X_GATEWAY_URL = 'https://gw.example/';
    await tool('x_federation_roster').handler({}, {} as any);
    expect(calls[0].url).toBe('https://gw.example/mcp');
  });
  it('gatewayUrl tool arg takes precedence over RUFLO_X_GATEWAY_URL (ADR-125) and is not forwarded to the gateway', async () => {
    process.env.RUFLO_X_GATEWAY_URL = 'https://env.example';
    await tool('x_federation_sync').handler({ gatewayUrl: 'https://arg.example', limit: 1 }, {} as any);
    expect(calls[0].url).toBe('https://arg.example/mcp');
    expect(calls[0].body.params.arguments).toEqual({ limit: 1 });
  });
  it('roster/claims/registry read the matching ruv:// resource', async () => {
    for (const [t, uri] of [['x_federation_roster', 'ruv://swarm/roster'], ['x_federation_claims', 'ruv://claims/board'], ['x_federation_registry', 'ruv://federation/registry']] as const) {
      calls = [];
      const out = await tool(t).handler({}, {} as any);
      expect(calls[0].body).toMatchObject({ method: 'resources/read', params: { uri } });
      expect(out).toEqual({ uri });
    }
  });
  it('gateway-identity writes refuse to run without RUFLO_X_ADMIN_TOKEN (fail closed, no network call)', async () => {
    for (const t of ['x_federation_publish', 'x_federation_invite_mint', 'x_federation_admit']) {
      await expect(tool(t).handler({ msgType: 'Status', payload: {}, pubkey: 'a'.repeat(64) }, {} as any)).rejects.toThrow(/RUFLO_X_ADMIN_TOKEN/);
    }
    expect(calls).toHaveLength(0);
  });
  it('gateway-identity writes forward the admin token and surface gateway isError as a thrown error', async () => {
    process.env.RUFLO_X_ADMIN_TOKEN = 'wrong';
    await expect(tool('x_federation_invite_mint').handler({ maxUses: 1 }, {} as any)).rejects.toThrow(/admin token required or invalid/);
    process.env.RUFLO_X_ADMIN_TOKEN = 'right';
    const out = (await tool('x_federation_admit').handler({ pubkey: 'b'.repeat(64), role: 'member' }, {} as any)) as any;
    expect(calls.at(-1)!.body.params.arguments.adminToken).toBe('right');
    expect(out.echo.pubkey).toBe('b'.repeat(64));
  });
});
