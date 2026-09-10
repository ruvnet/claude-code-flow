import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { loadOrCreateKey, nip98Header, xFederationJoinTools } from '../src/mcp-tools/x-federation-join.js';
const nt = { generateSecretKey, getPublicKey, finalizeEvent } as any;
describe('x_federation_join (self-service invite path)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('creates a 0600 key on first use and reuses it after', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'xj-')), 'nostr.key');
    const a = loadOrCreateKey(nt, f); const b = loadOrCreateKey(nt, f);
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(a.pubkey).toBe(b.pubkey);
    expect(existsSync(f)).toBe(true); expect(statSync(f).mode & 0o777).toBe(0o600);
  });
  it('builds a valid NIP-98 header bound to url+method+payload hash', () => {
    const sk = generateSecretKey(); const h = nip98Header(nt, sk, 'https://r/api/invites/claim', 'POST', '{"code":"v2.x"}');
    const ev = JSON.parse(Buffer.from(h.replace(/^Nostr /, ''), 'base64').toString());
    expect(ev.kind).toBe(27235); expect(verifyEvent(ev)).toBe(true); expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(ev.tags).toEqual(expect.arrayContaining([['u', 'https://r/api/invites/claim'], ['method', 'POST']]));
    expect(ev.tags.find((t: string[]) => t[0] === 'payload')[1]).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects malformed invite codes before any network call', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    await expect(xFederationJoinTools[0].handler({ code: 'not-a-code' }, {} as any)).rejects.toThrow(/v2\./);
    expect(f).not.toHaveBeenCalled();
  });
  it('is registered with an ADR-112 description and requires code', () => {
    const t = xFederationJoinTools[0]; expect(t.name).toBe('x_federation_join');
    expect(t.description).toMatch(/Use when/); expect(t.description).toMatch(/wrong/); expect((t.inputSchema as any).required).toEqual(['code']);
  });
});
