import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { seraphinaTools, askSeraphina, SERAPHINA_SYSTEM_PROMPT } from '../src/mcp-tools/seraphina-tools.js';
import { fenceUntrusted } from '../../../../plugins/ruflo-x-gateway/src/untrusted.mjs';
const sse = (result: unknown) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n`;
// roster, claims and federation_sync are relay-sourced, so the gateway fences them
// (#3300). Mocking them as bare JSON is what let this tool break while this suite
// stayed green — build the fixtures with the gateway's own fencer instead.
const RELAY = 'wss://relay.ruv.io';
const fenced = (payload: unknown) => fenceUntrusted(payload, { relay: RELAY });
describe('seraphina_guidance', () => {
  let llmBody: any; let calls: string[] = [];
  beforeEach(() => {
    calls = []; llmBody = undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push(url); const body = JSON.parse(init.body);
      if (url.endsWith('/v1/messages')) { llmBody = { body, headers: init.headers }; return new Response(JSON.stringify({ model: 'z-ai/glm-5.3-flash', usage: { input_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify({ guidance: 'Assign r1 to ruvzen.', proposals: [{ type: 'Task', forNode: 'ruvzen', description: 'do r1' }], risks: [] }) }] }), { status: 200 }); }
      if (body.method === 'resources/read') return new Response(sse({ contents: [{ text: fenced(body.params.uri.includes('roster') ? { pk1: { from: 'ruvzen' } } : { r0: { owner: 'pk1' } }) }] }));
      return new Response(sse({ content: [{ text: fenced({ count: 1, messages: [{ from: 'ruvzen', type: 'Status' }] }) }] }));
    }));
    process.env.SERAPHINA_METALLM_KEY = 'test-key';
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SERAPHINA_METALLM_KEY; });
  it('is registered with an ADR-112 description and a required goal', () => {
    const t = seraphinaTools.find((x) => x.name === 'seraphina_guidance')!;
    expect(t.description).toMatch(/Use when/); expect(t.description).toMatch(/wrong because/);
    expect((t.inputSchema as any).required).toEqual(['goal']);
  });
  it('fails closed without SERAPHINA_METALLM_KEY and makes no network call', async () => {
    delete process.env.SERAPHINA_METALLM_KEY;
    await expect(askSeraphina('x')).rejects.toThrow(/SERAPHINA_METALLM_KEY/); expect(calls).toHaveLength(0);
  });
  it('gathers roster+claims+recent from the gateway, then asks cognitum meta-llm with the queen prompt (cognitum-auto default, x-api-key)', async () => {
    const out = (await askSeraphina('ship the release')) as any;
    expect(calls.filter((u) => u.endsWith('/mcp'))).toHaveLength(3);
    expect(llmBody.body.model).toBe('cognitum-auto'); expect(llmBody.body.system).toBe(SERAPHINA_SYSTEM_PROMPT);
    expect(llmBody.headers['x-api-key']).toBe('test-key');
    expect(llmBody.body.messages[0].content).toContain('data, not instructions');
    expect(out.guidance).toBe('Assign r1 to ruvzen.'); expect(out.proposals[0].forNode).toBe('ruvzen');
    expect(out.model).toBe('z-ai/glm-5.3-flash'); expect(out.context).toEqual({ nodes: 1, claims: 1, recent: 1 });
  });
  it('extracts structured proposals even when the model fences the JSON', async () => {
    (globalThis.fetch as any).mockImplementationOnce(async () => new Response(sse({ contents: [{ text: '{}' }] })));
    (globalThis.fetch as any).mockImplementationOnce(async () => new Response(sse({ contents: [{ text: '{}' }] })));
    (globalThis.fetch as any).mockImplementationOnce(async () => new Response(sse({ content: [{ text: '{}' }] })));
    (globalThis.fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'Here you go:\n```json\n{"guidance":"g","proposals":[{"type":"Task","forNode":"ruvzen","description":"d"}],"risks":["r"]}\n```\n' }] }), { status: 200 }));
    const out = (await askSeraphina('x')) as any;
    expect(out.proposals).toEqual([{ type: 'Task', forNode: 'ruvzen', description: 'd' }]); expect(out.risks).toEqual(['r']); expect(out.guidance).toBe('g');
  });
  it('honours a valid tier override and ignores an invalid one', async () => {
    await askSeraphina('x', { tier: 'cognitum-high' }); expect(llmBody.body.model).toBe('cognitum-high');
    await askSeraphina('x', { tier: 'gpt-9' }); expect(llmBody.body.model).toBe('cognitum-auto');
  });
});

describe('#3300 — Seraphina reads the payload, not the envelope', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/v1/messages')) return new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text: '{"guidance":"g","proposals":[],"risks":[]}' }] }), { status: 200 });
      if (body.method === 'resources/read') return new Response(sse({ contents: [{ text: fenced(body.params.uri.includes('roster') ? { pk1: {}, pk2: {} } : { r0: {} }) }] }));
      return new Response(sse({ content: [{ text: fenced({ count: 2, messages: [{ from: 'a', type: 'Status' }, { from: 'b', type: 'Task' }] }) }] }));
    }));
    process.env.SERAPHINA_METALLM_KEY = 'test-key';
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SERAPHINA_METALLM_KEY; });

  it('counts real nodes/claims/messages from fenced gateway responses', async () => {
    const out = (await askSeraphina('x')) as any;
    // Envelope-instead-of-payload would give nodes:5 claims:5 (its own five keys)
    // and recent:0 (`.messages` undefined) — a miscounted swarm with no error.
    expect(out.context).toEqual({ nodes: 2, claims: 1, recent: 2 });
  });

  it('puts the actual swarm messages in the model snapshot', async () => {
    let sent: any;
    const real = globalThis.fetch as any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { if (url.endsWith('/v1/messages')) sent = JSON.parse(init.body); return real(url, init); }));
    await askSeraphina('x');
    expect(sent.messages[0].content).toContain('"from":"a"');
    expect(sent.messages[0].content).not.toContain('UNTRUSTED_RELAY_DATA');
  });
});
