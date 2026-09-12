/**
 * Encryption-at-rest vault primitives (ADR-096 Phase 1).
 *
 * Goal: provide deterministic encrypt/decrypt of arbitrary Buffers with a
 * symmetric key, using a magic-byte format so readers of older plaintext
 * stores can detect-then-pass-through during the migration window.
 *
 * Phase 1 deliberately ships only the cipher primitives + the env-var key
 * source. Keychain (keytar) and interactive passphrase resolution land in
 * a follow-up iteration so the blast radius of this commit is limited to
 * a single self-contained module with no native dependencies.
 *
 * Wire format (output of encryptBuffer):
 *
 *   +---------+-----------+----------------+--------+
 *   | magic 4 |   iv 12   |  ciphertext N  | tag 16 |
 *   +---------+-----------+----------------+--------+
 *      "RFE1"   random       AES-256-GCM     GCM
 *
 * The magic distinguishes encrypted blobs from plaintext during the
 * incremental migration: readers call isEncryptedBlob() and either
 * decryptBuffer() or treat the bytes as plaintext, so existing
 * .claude-flow/sessions/*.json files keep working unchanged.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// ── Constants ────────────────────────────────────────────────────────────────

/** ASCII "RFE1" — Ruflo File Encrypted v1. 4 bytes. */
export const MAGIC = Buffer.from([0x52, 0x46, 0x45, 0x31]); // "RFE1"
const MAGIC_LEN = MAGIC.length; // 4
const IV_LEN = 12;              // GCM-recommended nonce size
const TAG_LEN = 16;             // GCM auth tag
const KEY_LEN = 32;             // AES-256
const ALG = 'aes-256-gcm' as const;
const MIN_BLOB_LEN = MAGIC_LEN + IV_LEN + TAG_LEN; // empty plaintext still has these

const ENV_ENABLE_FLAG = 'CLAUDE_FLOW_ENCRYPT_AT_REST';
const ENV_KEY_VAR = 'CLAUDE_FLOW_ENCRYPTION_KEY';

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * True when at-rest encryption should be applied to writes.
 *
 * Truthy values: "1", "true", "yes", "on" (case-insensitive). Anything else
 * — including unset — keeps the legacy plaintext path. This is the gate
 * that lets the 1865-test baseline keep passing unchanged while users opt
 * into encryption.
 */
export function isEncryptionEnabled(): boolean {
  const v = process.env[ENV_ENABLE_FLAG];
  if (typeof v !== 'string') return false;
  const norm = v.trim().toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on';
}

/**
 * Resolve a 32-byte encryption key from CLAUDE_FLOW_ENCRYPTION_KEY.
 *
 * Phase 1 supports only the env-var source; keychain and passphrase
 * resolution are deferred to a follow-up iteration (see ADR-096). When
 * encryption is enabled but no key resolves, this throws with a clear
 * message rather than silently falling back to plaintext (fail-closed).
 *
 * Accepted encodings (auto-detected by length):
 *   - 64-char hex (32 bytes)
 *   - 44-char base64 (32 bytes + padding)
 *   - exactly 32 raw bytes (rare; for callers that pre-decode)
 *
 * Anything else is rejected — we'd rather fail loudly than encrypt with a
 * truncated key.
 */
export function getKey(): Buffer {
  const raw = process.env[ENV_KEY_VAR];
  if (!raw) {
    // "0"/"false" are truthy strings but leave encryption disabled, so the
    // canonical gate (not Boolean) decides which message is accurate (#3212).
    const reason = isEncryptionEnabled()
      ? `${ENV_ENABLE_FLAG} is set but ${ENV_KEY_VAR} is not.`
      : `${ENV_KEY_VAR} is required to access encrypted storage, but is not set.`;

    throw new Error(
      `${reason} ` +
      `Provide a 32-byte key as 64-char hex or 44-char base64. ` +
      `See ADR-096 for keychain/passphrase support (coming in a follow-up).`,
    );
  }
  return decodeKey(raw);
}

/**
 * Decode a key string. Exposed for testing and for the future passphrase
 * resolver, which will scrypt-derive a Buffer and hand it back through here
 * to share the same length-check.
 */
export function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // Hex first — strict 64 chars [0-9a-fA-F]
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  // Base64 — accept padded 44-char or unpadded 43-char forms
  if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === KEY_LEN) return buf;
  }
  throw new Error(
    `Invalid ${ENV_KEY_VAR}: expected 32-byte key as 64-char hex or 44-char base64`,
  );
}

/**
 * Encrypt a plaintext Buffer with AES-256-GCM. Returns the wire-format
 * blob: magic(4) || iv(12) || ciphertext(N) || tag(16).
 *
 * The IV is freshly randomized per call. Reusing a (key, iv) pair under
 * GCM is catastrophic — every call MUST produce a different IV. Node's
 * randomBytes is csprng-backed so this is automatic; the function takes
 * no IV input deliberately.
 */
export function encryptBuffer(plaintext: Buffer, key: Buffer): Buffer {
  if (!Buffer.isBuffer(plaintext)) {
    throw new TypeError('encryptBuffer: plaintext must be a Buffer');
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw new TypeError(`encryptBuffer: key must be a ${KEY_LEN}-byte Buffer`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, ciphertext, tag]);
}

/**
 * Decrypt a wire-format blob. Verifies the magic byte (sanity), parses
 * iv + ciphertext + tag, runs AES-256-GCM decrypt, and lets the GCM
 * auth tag fail loudly on tamper (Node throws "Unsupported state or
 * unable to authenticate data" — we let that propagate).
 *
 * Pre-condition: caller has already determined this is an encrypted
 * blob via isEncryptedBlob(). decryptBuffer throws on bad magic so a
 * mistaken plaintext blob still fails loudly rather than producing
 * garbage.
 */
export function decryptBuffer(blob: Buffer, key: Buffer): Buffer {
  if (!Buffer.isBuffer(blob)) {
    throw new TypeError('decryptBuffer: blob must be a Buffer');
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw new TypeError(`decryptBuffer: key must be a ${KEY_LEN}-byte Buffer`);
  }
  if (blob.length < MIN_BLOB_LEN) {
    throw new Error(
      `decryptBuffer: blob too short (${blob.length}B; need >= ${MIN_BLOB_LEN}B)`,
    );
  }
  const magic = blob.subarray(0, MAGIC_LEN);
  // timingSafeEqual to avoid an oracle on the magic bytes specifically;
  // not strictly required (the magic isn't secret) but cheap and correct.
  if (!timingSafeEqual(magic, MAGIC)) {
    throw new Error(
      'decryptBuffer: bad magic — blob is not Ruflo-encrypted (RFE1)',
    );
  }
  const iv = blob.subarray(MAGIC_LEN, MAGIC_LEN + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(MAGIC_LEN + IV_LEN, blob.length - TAG_LEN);

  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Magic-byte sniff. True iff the blob starts with the RFE1 magic AND is
 * long enough to be a valid encrypted blob. Used by readers during the
 * incremental migration: legacy plaintext files return false and flow
 * through the existing read path unchanged.
 *
 * Note: this is a heuristic. A plaintext file that happens to start with
 * "RFE1" would be misdetected — we accept that vanishingly small risk
 * because (a) the four bytes 0x52,0x46,0x45,0x31 are an unusual prefix
 * for JSON (`{`, `[`) or SQLite (`SQLite format 3`), and (b) decryption
 * will then fail with a clear error rather than silently corrupt.
 */
export function isEncryptedBlob(blob: Buffer): boolean {
  if (!Buffer.isBuffer(blob)) return false;
  if (blob.length < MIN_BLOB_LEN) return false;
  return timingSafeEqual(blob.subarray(0, MAGIC_LEN), MAGIC);
}
