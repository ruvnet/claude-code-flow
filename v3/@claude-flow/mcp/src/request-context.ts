import { createHash } from 'crypto';
import type { MCPRequest, MCPResponse, TransportType } from './types.js';

export const MCP_2026_07_28 = '2026-07-28';

export interface AuthenticatedPrincipal {
  readonly subject: string;
  readonly authMethod: 'token' | 'api-key' | 'oauth' | 'none';
}

export interface MCPRequestContext {
  readonly requestId: string;
  readonly transport: TransportType;
  readonly principal: AuthenticatedPrincipal;
  readonly protocolVersion?: string;
  readonly legacySessionId?: string;
  readonly routingMethod?: string;
  readonly routingName?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly remoteAddress?: string;
}

export interface MCPResponseTransportMetadata {
  readonly legacySessionId?: string;
}

const responseMetadata = new WeakMap<MCPResponse, MCPResponseTransportMetadata>();

export function principalFromSecret(
  secret: string,
  authMethod: AuthenticatedPrincipal['authMethod'] = 'token'
): AuthenticatedPrincipal {
  const digest = createHash('sha256').update(secret).digest('hex').slice(0, 24);
  return Object.freeze({ subject: `${authMethod}:${digest}`, authMethod });
}

export function anonymousPrincipal(): AuthenticatedPrincipal {
  return Object.freeze({ subject: 'anonymous', authMethod: 'none' });
}

export function freezeRequestContext(context: MCPRequestContext): MCPRequestContext {
  return Object.freeze({ ...context, principal: Object.freeze({ ...context.principal }) });
}

export function attachResponseTransportMetadata(
  response: MCPResponse,
  metadata: MCPResponseTransportMetadata
): MCPResponse {
  responseMetadata.set(response, Object.freeze({ ...metadata }));
  return response;
}

export function getResponseTransportMetadata(
  response: MCPResponse
): MCPResponseTransportMetadata | undefined {
  return responseMetadata.get(response);
}

export interface RoutingValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

export function validateRoutingHeaders(
  request: MCPRequest,
  context: Pick<MCPRequestContext, 'routingMethod' | 'routingName'>
): RoutingValidationResult {
  if (context.routingMethod && context.routingMethod !== request.method) {
    return {
      valid: false,
      error: `Mcp-Method mismatch: header=${context.routingMethod} body=${request.method}`,
    };
  }

  if (!context.routingName) return { valid: true };

  const params = request.params as { name?: unknown } | undefined;
  const bodyName = typeof params?.name === 'string'
    ? params.name
    : request.method.includes('/') && !request.method.startsWith('tools/')
      ? request.method
      : undefined;

  if (!bodyName || bodyName !== context.routingName) {
    return {
      valid: false,
      error: `Mcp-Name mismatch: header=${context.routingName} body=${bodyName ?? '<none>'}`,
    };
  }

  return { valid: true };
}

export function isModernStatelessContext(context?: MCPRequestContext): boolean {
  return context?.protocolVersion === MCP_2026_07_28;
}

export function authorityKey(context?: MCPRequestContext): string | undefined {
  if (!context) return undefined;
  if (isModernStatelessContext(context)) return `stateless:${context.principal.subject}`;
  if (!context.legacySessionId) return undefined;
  return `${context.principal.subject}:${context.legacySessionId}`;
}
