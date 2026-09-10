/**
 * OAuth 2.1 resource-server side of the connector (RFC 9728 + RFC 8707 audience,
 * bearer usage per RFC 6750).
 *
 * This module holds no client secret and issues nothing. It advertises which
 * authorization server protects this resource, validates the access token that
 * server issued, and maps scopes onto the three tools. The authorization server
 * is Cognitum's (`https://auth.cognitum.one`), which is a public-client + PKCE
 * server — so there is no client secret anywhere in this design, by construction.
 *
 * The Nostr key is not reachable from here. OAuth decides *who may ask*; the
 * signing key answers, and never leaves `signing-key.mjs`.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const SCOPE_READ = 'federation:read';
export const SCOPE_PUBLISH = 'federation:publish';

/**
 * RFC 9728 protected-resource metadata. A client that gets a 401 from /mcp reads
 * this to learn which authorization server to go to.
 */
export function protectedResourceMetadata({ resource, issuer }) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [SCOPE_READ, SCOPE_PUBLISH],
    bearer_methods_supported: ['header'],
    resource_documentation: `${resource}/`,
  };
}

/** The WWW-Authenticate value that points an unauthenticated client at discovery. */
export function challengeHeader(resourceMetadataUrl, { error, description } = {}) {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description}"`);
  return parts.join(', ');
}

let jwks = null, jwksFor = null;
function keySet(jwksUri) {
  // Cached across requests; `jose` handles its own key rotation and refresh.
  if (!jwks || jwksFor !== jwksUri) { jwks = createRemoteJWKSet(new URL(jwksUri)); jwksFor = jwksUri; }
  return jwks;
}

/** Reset the cached key set. Tests only. */
export function _resetJwksForTest() { jwks = null; jwksFor = null; }

/**
 * Verify an access token and return its granted scopes.
 *
 * Audience is checked, not merely parsed: a token minted for another Cognitum
 * resource must not act on the federation identity just because it is signed by
 * the same issuer. That is the whole point of RFC 8707.
 *
 * @returns {Promise<{ ok: true, scopes: string[], subject?: string } | { ok: false, error: string, description: string }>}
 */
export async function verifyAccessToken(token, { issuer, jwksUri, audience }) {
  if (!token) return { ok: false, error: 'invalid_request', description: 'no bearer token' };
  try {
    const { payload } = await jwtVerify(token, keySet(jwksUri), {
      issuer,
      ...(audience ? { audience } : {}),
      clockTolerance: 30,
    });
    // `scope` is the RFC 6749 space-delimited form; `scp` is the array form some
    // servers emit. Accept either rather than silently granting nothing.
    const raw = payload.scope ?? payload.scp ?? '';
    const scopes = Array.isArray(raw) ? raw.map(String) : String(raw).split(/\s+/).filter(Boolean);
    return { ok: true, scopes, subject: payload.sub ? String(payload.sub) : undefined };
  } catch (e) {
    const code = e?.code === 'ERR_JWT_EXPIRED' ? 'invalid_token' : 'invalid_token';
    return { ok: false, error: code, description: String(e?.message || 'token verification failed').slice(0, 200) };
  }
}

/** True when the granted scopes cover the one required. */
export function hasScope(scopes, required) {
  return Array.isArray(scopes) && scopes.includes(required);
}
