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
 * app must not act on the federation identity just because the same issuer
 * signed it.
 *
 * The audience to expect is this connector's **client_id**, not its resource
 * URL. `auth.cognitum.one` binds `aud` to the requesting OAuth client
 * (services/identity/src/jwt.rs `issue_oauth_access_token`), which is
 * client-audience binding rather than RFC 8707 resource binding. It closes the
 * same confused-deputy hole here because this connector is the only resource
 * its client_id is registered for — a one-client-one-resource assumption that
 * is load-bearing, and the reason `federation:*` must never be added to another
 * client's allowed_scopes.
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
    // Say WHY, precisely. A correctly-signed token that fails only on iss/aud is a
    // very different problem from a forged one, and `auth.cognitum.one` is measured
    // to issue tokens carrying neither claim (minimax-music services/gateway/src/
    // jwks.rs, citing freetokens ADR-0017). Without this, that shows up as a bare
    // "invalid_token" and costs someone an afternoon.
    //
    // This re-verifies the SIGNATURE only, for diagnosis. It never grants: every
    // path below still returns ok:false.
    let detail = String(e?.message || 'token verification failed').slice(0, 200);
    try {
      const { payload } = await jwtVerify(token, keySet(jwksUri), { clockTolerance: 30 });
      const missing = [];
      if (issuer && !payload.iss) missing.push('iss');
      if (audience && !payload.aud) missing.push('aud');
      if (missing.length) {
        detail = `token signature is valid but carries no ${missing.join(' or ')} claim, so it is not bound to this resource`;
        return { ok: false, error: 'invalid_token', description: detail, signatureValid: true, unboundClaims: missing };
      }
      detail = `token signature is valid but ${detail}`;
    } catch { /* signature genuinely bad — keep the original message */ }
    return { ok: false, error: 'invalid_token', description: detail };
  }
}

/** True when the granted scopes cover the one required. */
export function hasScope(scopes, required) {
  return Array.isArray(scopes) && scopes.includes(required);
}
