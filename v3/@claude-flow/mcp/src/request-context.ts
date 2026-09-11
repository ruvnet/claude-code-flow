import { createHash } from 'crypto';
import type { MCPRequest, MCPResponse, TransportType } from './types.js';

export const MCP_2026_07_28 = '2026-07-28';
export const MCP_HEADER_MISMATCH = -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/;
const MODERN_NAMED_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);

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
  readonly paramHeaders?: Readonly<Record<string, string>>;
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
  const digest = createHash('sha256').update(secret).digest('hex');
  return Object.freeze({ subject: `${authMethod}:${digest}`, authMethod });
}

export function anonymousPrincipal(): AuthenticatedPrincipal {
  return Object.freeze({ subject: 'anonymous', authMethod: 'none' });
}

export function freezeRequestContext(context: MCPRequestContext): MCPRequestContext {
  return Object.freeze({
    ...context,
    principal: Object.freeze({ ...context.principal }),
    paramHeaders: context.paramHeaders
      ? Object.freeze({ ...context.paramHeaders })
      : undefined,
  });
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

export interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly code?: number;
}

export function decodeMcpHeaderValue(value: string): string {
  if (!value.startsWith('=?base64?')) return value;
  const match = BASE64_SENTINEL.exec(value);
  if (!match) throw new Error('Malformed MCP base64 header sentinel');
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(Buffer.from(match[1], 'base64'))) {
    throw new Error('Invalid MCP base64 header encoding');
  }
  return decoded;
}

function expectedRoutingName(request: MCPRequest): string | undefined {
  const params = request.params as { name?: unknown; uri?: unknown } | undefined;
  if (request.method === 'resources/read') {
    return typeof params?.uri === 'string' ? params.uri : undefined;
  }
  if (request.method === 'tools/call' || request.method === 'prompts/get') {
    return typeof params?.name === 'string' ? params.name : undefined;
  }
  return undefined;
}

export function validateRoutingHeaders(
  request: MCPRequest,
  context: Pick<MCPRequestContext, 'routingMethod' | 'routingName' | 'protocolVersion'>,
  requireModernHeaders = context.protocolVersion === MCP_2026_07_28
): ValidationResult {
  if (requireModernHeaders && !context.routingMethod) {
    return {
      valid: false,
      code: MCP_HEADER_MISMATCH,
      error: 'Mcp-Method is required for MCP 2026-07-28 HTTP requests',
    };
  }

  if (context.routingMethod && context.routingMethod !== request.method) {
    return {
      valid: false,
      code: MCP_HEADER_MISMATCH,
      error: `Mcp-Method mismatch: header=${context.routingMethod} body=${request.method}`,
    };
  }

  const requiresName = requireModernHeaders && MODERN_NAMED_METHODS.has(request.method);
  if (requiresName && !context.routingName) {
    return {
      valid: false,
      code: MCP_HEADER_MISMATCH,
      error: `Mcp-Name is required for ${request.method}`,
    };
  }

  if (!context.routingName) return { valid: true };

  const bodyName = expectedRoutingName(request);
  if (!bodyName) {
    return {
      valid: false,
      code: MCP_HEADER_MISMATCH,
      error: `Mcp-Name is not valid for method ${request.method}`,
    };
  }

  let decodedHeader: string;
  try {
    decodedHeader = decodeMcpHeaderValue(context.routingName);
  } catch (error) {
    return {
      valid: false,
      code: MCP_HEADER_MISMATCH,
      error: error instanceof Error ? error.message : 'Invalid Mcp-Name encoding',
    };
  }

  if (bodyName !== decodedHeader) {
    return {
      valid: false,
      code: MCP_HEADER_MISMATCH,
      error: `Mcp-Name mismatch: header=${decodedHeader} body=${bodyName}`,
    };
  }

  return { valid: true };
}

export function bodyProtocolVersion(request: MCPRequest): string | undefined {
  const meta = (request.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const version = meta?.['io.modelcontextprotocol/protocolVersion'];
  return typeof version === 'string' ? version : undefined;
}

export function validateModernEnvelope(
  request: MCPRequest,
  headerVersion?: string
): ValidationResult {
  const params = request.params as { _meta?: Record<string, unknown> } | undefined;
  const meta = params?._meta;
  const bodyVersion = bodyProtocolVersion(request);

  if (!headerVersion || !bodyVersion || headerVersion !== bodyVersion) {
    return {
      valid: false,
      code: MCP_HEADER_MISMATCH,
      error: `MCP protocol version mismatch: header=${headerVersion ?? '<missing>'} body=${bodyVersion ?? '<missing>'}`,
    };
  }

  if (headerVersion !== MCP_2026_07_28) {
    return {
      valid: false,
      code: MCP_UNSUPPORTED_PROTOCOL_VERSION,
      error: `Unsupported MCP protocol version: ${headerVersion}`,
    };
  }

  const clientCapabilities = meta?.['io.modelcontextprotocol/clientCapabilities'];
  if (!clientCapabilities || typeof clientCapabilities !== 'object' || Array.isArray(clientCapabilities)) {
    return {
      valid: false,
      code: -32602,
      error: 'Modern MCP requests require _meta.io.modelcontextprotocol/clientCapabilities',
    };
  }

  const clientInfo = meta?.['io.modelcontextprotocol/clientInfo'];
  if (clientInfo !== undefined) {
    if (!clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo)) {
      return { valid: false, code: -32602, error: 'Invalid MCP clientInfo metadata' };
    }
    const info = clientInfo as Record<string, unknown>;
    if (typeof info.name !== 'string' || typeof info.version !== 'string') {
      return { valid: false, code: -32602, error: 'MCP clientInfo requires string name and version' };
    }
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
