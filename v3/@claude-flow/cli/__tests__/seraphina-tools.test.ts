import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { seraphinaTools, askSeraphina, SERAPHINA_SYSTEM_PROMPT } from '../src/mcp-tools/seraphina-tools.js';
const sse = (result: unknown) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n`;
describe('seraphina_guidance', () => {
  let llmBody: any; let calls: string[] = [];
  beforeEach(() => {
    calls = []; llmBody = undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push(url); const body = JSON.parse(init.body);
      if (url.endsWith('/v1/messages')) { llmBody = { body, headers: init.headers }; return new Response(JSON.stringify({ model: 'z-ai/glm-5.3-flash', usage: { input_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify({ guidance: 'Assign r1 to ruvzen.', proposals: [{ type: 'Task', forNode: 'ruvzen', description: 'do r1' }], risks: [] }) }] }), { status: 200 }); }
      if (body.method === 'resources/read') return new Response(sse({ contents: [{ text: JSON.stringify(body.params.uri.includes('roster') ? { pk1: { from: 'ruvzen' } } : { r0: { owner: 'pk1' } }) }] }));
      return new Response(sse({ content: [{ text: JSON.stringify({ count: 1, messages: [{ from: 'ruvzen', type: 'Status' }] }) }] }));
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
