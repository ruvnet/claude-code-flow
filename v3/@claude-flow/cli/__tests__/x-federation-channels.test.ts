/**
 * ADR-386 client-side channels: key custody, id derivation, grant round trip,
 * and the tool contract. Crypto cases skip when the optional `nostr-tools`
 * dependency is absent (the root Test Suite installs only root dependencies).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  publicChannelId, privateChannelId, newChannelKey, isPrivateChannel,
  readStore, writeStore, xFederationChannelTools, CHANNEL_ID_RE,
} from '../src/mcp-tools/x-federation-channels.js';

const nt: any = await import('nostr-tools/pure').catch(() => null);
const n44: any = await import('nostr-tools').then((m: any) => m.nip44).catch(() => null);

describe('channel ids (ADR-386)', () => {
  it('public ids carry the name; private ids are derived from the key and carry nothing', () => {
    expect(publicChannelId('release-3-41')).toBe('pub:release-3-41');
    expect(() => publicChannelId('Bad Name')).toThrow(/channel name/);
    const key = newChannelKey();
    const id = privateChannelId(key);
    expect(id).toMatch(/^prv:[0-9a-f]{16}$/);
    expect(privateChannelId(key)).toBe(id);
    expect(privateChannelId(newChannelKey())).not.toBe(id);
    expect(CHANNEL_ID_RE.test(id)).toBe(true);
    expect(isPrivateChannel(id)).toBe(true);
    expect(isPrivateChannel('pub:ops')).toBe(false);
    expect(() => privateChannelId('abcd')).toThrow(/32 bytes/);
  });
});

describe('local channel key store', () => {
  it('writes 0600 and round-trips; a missing file reads as empty, not a throw', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'ch-')), 'channels.json');
    expect(readStore(f)).toEqual({});
    const key = newChannelKey(); const id = privateChannelId(key);
    writeStore({ [id]: { key, name: 'ops', at: new Date().toISOString() } }, f);
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readStore(f)[id].key).toBe(key);
  });
});

describe.skipIf(!nt || !n44)('grant sealing', () => {
  it('only the addressed pubkey can open a sealed channel key', () => {
    const key = newChannelKey();
    const granter = nt.generateSecretKey(), member = nt.generateSecretKey(), outsider = nt.generateSecretKey();
    const sealed = n44.v2.encrypt(key, n44.v2.utils.getConversationKey(granter, nt.getPublicKey(member)));
    expect(sealed).not.toContain(key);
    const opened = n44.v2.decrypt(sealed, n44.v2.utils.getConversationKey(member, nt.getPublicKey(granter)));
    expect(opened).toBe(key);
    expect(privateChannelId(opened)).toBe(privateChannelId(key));
    expect(() => n44.v2.decrypt(sealed, n44.v2.utils.getConversationKey(outsider, nt.getPublicKey(granter)))).toThrow();
  });

  it('a message sealed under the channel key is opaque without it', () => {
    const key = Uint8Array.from(Buffer.from(newChannelKey(), 'hex'));
    const ct = n44.v2.encrypt(JSON.stringify({ type: 'Task', taskId: 'secret-1' }), key);
    expect(ct).not.toContain('secret-1');
    expect(JSON.parse(n44.v2.decrypt(ct, key)).taskId).toBe('secret-1');
    const other = Uint8Array.from(Buffer.from(newChannelKey(), 'hex'));
    expect(() => n44.v2.decrypt(ct, other)).toThrow();
  });
});

describe('tool contract', () => {
  const byName = (n: string) => xFederationChannelTools.find((t) => t.name === n)!;

  it('registers the six client channel tools with ADR-112 descriptions', () => {
    for (const n of ['create', 'grant', 'accept', 'publish', 'read', 'list']) {
      const t = byName(`x_federation_channel_${n}`);
      expect(t, n).toBeTruthy();
      expect(t.description).toMatch(/Use when|Use this/);
      expect(t.description).toMatch(/wrong/);
    }
  });

  it('rejects malformed channel ids and non-private grants before any network call', async () => {
    await expect(byName('x_federation_channel_read').handler({ channel: 'not a channel' } as never, {} as never)).rejects.toThrow(/pub:<name> or prv:/);
    await expect(byName('x_federation_channel_publish').handler({ channel: 'nope', msgType: 'X', payload: {} } as never, {} as never)).rejects.toThrow(/pub:<name> or prv:/);
    await expect(byName('x_federation_channel_grant').handler({ channel: 'pub:ops', pubkey: 'a'.repeat(64) } as never, {} as never)).rejects.toThrow(/only private channels/);
    await expect(byName('x_federation_channel_grant').handler({ channel: 'prv:0123456789abcdef', pubkey: 'zz' } as never, {} as never)).rejects.toThrow(/64 hex/);
  });

  it('creating a public channel touches no key material', async () => {
    const r = await byName('x_federation_channel_create').handler({ name: 'ops', visibility: 'public' } as never, {} as never) as Record<string, unknown>;
    expect(r.channel).toBe('pub:ops');
    expect(r).not.toHaveProperty('keyStoredAt');
  });
});
