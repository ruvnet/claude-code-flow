/**
 * Tests for src/encryption/vault.ts (ADR-096 Phase 1).
 *
 * These pin the wire format + cipher contract so future iterations can't
 * silently change either without a coordinated migration. The format is
 * meant to be stable across versions — every encrypted file shipped before
 * a format change has to keep decrypting under the new code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  MAGIC,
  decodeKey,
  decryptBuffer,
  encryptBuffer,
  getKey,
  isEncryptedBlob,
  isEncryptionEnabled,
} from '../src/encryption/vault.js';

// Per-test env reset — these tests mutate process.env and must not leak.
const SAVED_ENV: Record<string, string | undefined> = {};
function saveEnv(...names: string[]) {
  for (const n of names) SAVED_ENV[n] = process.env[n];
}
function restoreEnv() {
  for (const [n, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
}

describe('vault (ADR-096 Phase 1)', () => {
  beforeEach(() => {
    saveEnv('CLAUDE_FLOW_ENCRYPT_AT_REST', 'CLAUDE_FLOW_ENCRYPTION_KEY');
  });
  afterEach(() => {
    restoreEnv();
  });

  describe('isEncryptionEnabled', () => {
    it('is false when the env var is unset', () => {
      delete process.env.CLAUDE_FLOW_ENCRYPT_AT_REST;
      expect(isEncryptionEnabled()).toBe(false);
    });

    it.each(['1', 'true', 'TRUE', 'yes', 'on', '  on  '])(
      'is true for "%s"',
      (v) => {
        process.env.CLAUDE_FLOW_ENCRYPT_AT_REST = v;
        expect(isEncryptionEnabled()).toBe(true);
      },
    );

    it.each(['0', 'false', 'no', 'off', 'maybe', ''])(
      'is false for "%s"',
      (v) => {
        process.env.CLAUDE_FLOW_ENCRYPT_AT_REST = v;
        expect(isEncryptionEnabled()).toBe(false);
      },
    );
  });

  describe('decodeKey', () => {
    it('decodes 64-char hex', () => {
      const hex = 'a'.repeat(64);
      expect(decodeKey(hex).length).toBe(32);
    });

    it('decodes 44-char base64 (padded)', () => {
      const b64 = randomBytes(32).toString('base64');
      expect(b64).toMatch(/=$/);
      expect(decodeKey(b64).length).toBe(32);
    });

    it('decodes 43-char base64 (unpadded)', () => {
      const b64 = randomBytes(32).toString('base64').replace(/=+$/, '');
      expect(decodeKey(b64).length).toBe(32);
    });

    it('rejects too-short hex', () => {
      expect(() => decodeKey('a'.repeat(63))).toThrow(/Invalid/);
    });

    it('rejects too-long hex', () => {
      expect(() => decodeKey('a'.repeat(65))).toThrow(/Invalid/);
    });

    it('rejects non-hex / non-base64 garbage', () => {
      expect(() => decodeKey('not a key at all!!!')).toThrow(/Invalid/);
    });

    it('rejects base64 of the wrong length (16 bytes)', () => {
      const b64 = randomBytes(16).toString('base64');
      expect(() => decodeKey(b64)).toThrow(/Invalid/);
    });

    it('trims surrounding whitespace before validating', () => {
      const hex = 'b'.repeat(64);
      expect(decodeKey(`  ${hex}\n`).length).toBe(32);
    });
  });

  describe('getKey', () => {
    it('throws with a clear message when the env var is unset', () => {
      delete process.env.CLAUDE_FLOW_ENCRYPTION_KEY;
      expect(() => getKey()).toThrow(/CLAUDE_FLOW_ENCRYPTION_KEY/);
    });

    it('names the flag when encryption is enabled but the key is missing', () => {
      process.env.CLAUDE_FLOW_ENCRYPT_AT_REST = '1';
      delete process.env.CLAUDE_FLOW_ENCRYPTION_KEY;
      expect(() => getKey()).toThrow(
        /CLAUDE_FLOW_ENCRYPT_AT_REST is set but CLAUDE_FLOW_ENCRYPTION_KEY is not/,
      );
    });

    it('does not claim the flag is set when it is unset (RFE1-on-disk case, #3212)', () => {
      delete process.env.CLAUDE_FLOW_ENCRYPT_AT_REST;
      delete process.env.CLAUDE_FLOW_ENCRYPTION_KEY;
      expect(() => getKey()).toThrow(
        /required to access encrypted storage/,
      );
      expect(() => getKey()).not.toThrow(/is set but/);
    });

    it.each(['0', 'false', 'no', 'off'])(
      'does not claim the flag is set for disabled value "%s" (#3212)',
      (v) => {
        process.env.CLAUDE_FLOW_ENCRYPT_AT_REST = v;
        delete process.env.CLAUDE_FLOW_ENCRYPTION_KEY;
        expect(() => getKey()).not.toThrow(/is set but/);
        expect(() => getKey()).toThrow(
          /required to access encrypted storage/,
        );
      },
    );

    it('returns a 32-byte buffer when the env var holds valid hex', () => {
      process.env.CLAUDE_FLOW_ENCRYPTION_KEY = 'c'.repeat(64);
      expect(getKey().length).toBe(32);
    });
  });

  describe('encrypt / decrypt round-trip', () => {
    const key = randomBytes(32);

    it('round-trips an empty buffer', () => {
      const blob = encryptBuffer(Buffer.alloc(0), key);
      expect(decryptBuffer(blob, key).length).toBe(0);
    });

    it('round-trips small text', () => {
      const plain = Buffer.from('hello world', 'utf-8');
      expect(decryptBuffer(encryptBuffer(plain, key), key).equals(plain)).toBe(
        true,
      );
    });

    it('round-trips JSON the way session-tools writes it', () => {
      const obj = { sessionId: 'sess-1', name: 'audit', stats: { tasks: 5 } };
      const plain = Buffer.from(JSON.stringify(obj, null, 2), 'utf-8');
      const round = JSON.parse(
        decryptBuffer(encryptBuffer(plain, key), key).toString('utf-8'),
      );
      expect(round).toEqual(obj);
    });

    it('round-trips a large random buffer (megabyte-scale)', () => {
      const plain = randomBytes(1_048_576); // 1MB
      expect(decryptBuffer(encryptBuffer(plain, key), key).equals(plain)).toBe(
        true,
      );
    });

    it('produces different ciphertext for the same plaintext (random IV)', () => {
      const plain = Buffer.from('repeated', 'utf-8');
      const a = encryptBuffer(plain, key);
      const b = encryptBuffer(plain, key);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('wire format', () => {
    it('begins with the RFE1 magic', () => {
      const blob = encryptBuffer(Buffer.from('x', 'utf-8'), randomBytes(32));
      expect(blob.subarray(0, 4)).toEqual(MAGIC);
    });

    it('has at least magic+iv+tag bytes (32) for any plaintext', () => {
      const blob = encryptBuffer(Buffer.alloc(0), randomBytes(32));
      // magic(4) + iv(12) + tag(16) = 32 minimum
      expect(blob.length).toBeGreaterThanOrEqual(32);
    });
  });

  describe('isEncryptedBlob', () => {
    it('detects a freshly-encrypted blob', () => {
      const blob = encryptBuffer(Buffer.from('hi', 'utf-8'), randomBytes(32));
      expect(isEncryptedBlob(blob)).toBe(true);
    });

    it('returns false for plaintext JSON', () => {
      expect(isEncryptedBlob(Buffer.from('{"a":1}', 'utf-8'))).toBe(false);
    });

    it('returns false for the SQLite header', () => {
      // Real .swarm/memory.db files start with "SQLite format 3\0"
      expect(isEncryptedBlob(Buffer.from('SQLite format 3\0', 'utf-8'))).toBe(
        false,
      );
    });

    it('returns false for a blob shorter than the magic+iv+tag minimum', () => {
      expect(isEncryptedBlob(MAGIC)).toBe(false); // magic alone, but length < 32
    });

    it('returns false for a non-Buffer input', () => {
      expect(isEncryptedBlob('not a buffer' as unknown as Buffer)).toBe(false);
    });
  });

  describe('tamper detection', () => {
    const key = randomBytes(32);

    it('rejects a blob with a flipped ciphertext byte', () => {
      const plain = Buffer.from('sensitive data', 'utf-8');
      const blob = Buffer.from(encryptBuffer(plain, key));
      // Flip a byte inside the ciphertext region (after magic+iv, before tag)
      blob[20] ^= 0xff;
      expect(() => decryptBuffer(blob, key)).toThrow();
    });

    it('rejects a blob with a flipped auth-tag byte', () => {
      const blob = Buffer.from(
        encryptBuffer(Buffer.from('payload', 'utf-8'), key),
      );
      blob[blob.length - 1] ^= 0xff;
      expect(() => decryptBuffer(blob, key)).toThrow();
    });

    it('rejects a blob with a flipped IV byte', () => {
      const blob = Buffer.from(
        encryptBuffer(Buffer.from('payload', 'utf-8'), key),
      );
      blob[5] ^= 0xff; // inside the IV region (offset 4..15)
      expect(() => decryptBuffer(blob, key)).toThrow();
    });

    it('rejects a blob with a corrupted magic', () => {
      const blob = Buffer.from(
        encryptBuffer(Buffer.from('payload', 'utf-8'), key),
      );
      blob[0] = 0x00; // break the magic
      expect(() => decryptBuffer(blob, key)).toThrow(/bad magic/);
    });

    it('rejects a blob shorter than the minimum length', () => {
      expect(() => decryptBuffer(Buffer.alloc(10), key)).toThrow(/too short/);
    });

    it('rejects a wrong-key decrypt (GCM auth fails)', () => {
      const blob = encryptBuffer(Buffer.from('payload', 'utf-8'), key);
      const wrongKey = randomBytes(32);
      expect(() => decryptBuffer(blob, wrongKey)).toThrow();
    });
  });

  describe('input validation', () => {
    const key = randomBytes(32);

    it('encryptBuffer rejects a non-Buffer plaintext', () => {
      expect(() =>
        encryptBuffer('string' as unknown as Buffer, key),
      ).toThrow(/Buffer/);
    });

    it('encryptBuffer rejects a wrong-size key', () => {
      expect(() =>
        encryptBuffer(Buffer.from('x'), randomBytes(16)),
      ).toThrow(/32-byte/);
    });

    it('decryptBuffer rejects a non-Buffer blob', () => {
      expect(() =>
        decryptBuffer('string' as unknown as Buffer, key),
      ).toThrow(/Buffer/);
    });

    it('decryptBuffer rejects a wrong-size key', () => {
      const blob = encryptBuffer(Buffer.from('x'), key);
      expect(() => decryptBuffer(blob, randomBytes(16))).toThrow(/32-byte/);
    });
  });
});
