/**
 * Custody of the ChatGPT Federation signing key.
 *
 * The key is a 32-byte Nostr secret, delivered ONLY as a Cloud Run secret volume
 * mounted read-only at /secrets/nostr/signing-key (Secret Manager version, immutable
 * and auditable). Three deliberate omissions, each one a rule from the deployment brief:
 *
 *   - no env-var key path. `RUFLO_NOSTR_KEY_HEX`-style injection is what a secret
 *     volume exists to replace; an env var leaks into `/proc`, crash dumps, and every
 *     child process. Only the *path* is configurable, never the value.
 *   - no generate-on-missing fallback. A fresh key would be a pubkey the relay has
 *     never admitted, so every publish would fail with `restricted:` — after the
 *     service had already reported itself healthy under a second, unaudited identity.
 *     Refusing to start is the honest failure.
 *   - no accessor that returns the secret. `load()` hands back a signer; the bytes
 *     stay in this module's closure. There is no code path from an MCP tool to them.
 */
import { readFileSync } from 'node:fs';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';

export const DEFAULT_KEY_PATH = '/secrets/nostr/signing-key';
const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Scrub anything that looks like key material out of a string before it reaches a
 * log line, an MCP error, or an HTTP body. Cheap, and the one place a secret would
 * plausibly escape is an exception message quoting what it failed to parse.
 */
export function redact(s) {
  return String(s ?? '').replace(/[0-9a-fA-F]{64}/g, '[redacted]');
}

/**
 * Read the mounted key and return a signer.
 * @returns {{ pubkey: string, sign: (template: object) => object }}
 */
export function loadSigner(keyPath = process.env.CGF_SIGNING_KEY_PATH || DEFAULT_KEY_PATH) {
  let raw;
  try {
    raw = readFileSync(keyPath, 'utf8').trim();
  } catch (e) {
    // e.message contains the path, never the contents — but redact regardless.
    throw new Error(`signing key unreadable at ${keyPath}: ${redact(e.code || e.message)}`);
  }
  // Accept hex (what Secret Manager holds) and tolerate a trailing newline the
  // console adds when a secret is created by paste rather than by file.
  if (!HEX64.test(raw)) {
    throw new Error(`signing key at ${keyPath} is not 32 bytes of hex (got ${raw.length} chars)`);
  }
  const sk = Uint8Array.from(Buffer.from(raw, 'hex'));
  const pubkey = getPublicKey(sk);
  // Identity pinning. A rotated key is a NEW federation identity: readers tracking
  // the old pubkey see this connector go silent, and the relay refuses its events
  // until the new pubkey is admitted. Pinning the secret *version* on the mount is
  // the primary guard; this is the backstop for the deploy that forgets to, where
  // `:latest` would otherwise roll the identity over on the next cold start with no
  // signal at all. Fail the deploy instead.
  const expected = (process.env.CGF_EXPECTED_PUBKEY || '').trim().toLowerCase();
  if (expected && expected !== pubkey) {
    throw new Error(`mounted key derives ${pubkey}, expected ${expected} — refusing to start under an unexpected federation identity`);
  }
  // `sk` is reachable only from the closure below. Nothing returns it.
  return {
    pubkey,
    sign: (template) => finalizeEvent(template, sk),
  };
}
