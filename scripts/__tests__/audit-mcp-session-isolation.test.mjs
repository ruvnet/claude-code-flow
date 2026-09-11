import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditRepository, scanSources } from '../audit-mcp-session-isolation.mjs';

const vulnerable = {
  server: `
    private currentSession?: MCPSession;
    private handleInitialize() {
      const session = this.sessionManager.createSession(this.config.transport);
      this.currentSession = session;
    }
    private handleToolsCall() {
      const context = { sessionId: this.currentSession?.id || 'unknown' };
    }
    private subscribe() {
      const sessionId = this.currentSession?.id;
    }
  `,
  types: `export type RequestHandler = (request: MCPRequest) => Promise<MCPResponse>;`,
  http: `
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    const response = await this.requestHandler(message as MCPRequest);
    private validateAuth(req: Request): { valid: boolean; error?: string } { return { valid: true }; }
  `,
};

const remediated = {
  server: `
    private handleToolsCall(request: MCPRequest, context: MCPRequestContext) {
      const toolContext = { sessionId: context.legacySessionId || 'stateless', metadata: { principal: context.principal } };
    }
  `,
  types: `export type RequestHandler = (request: MCPRequest, context?: MCPRequestContext) => Promise<MCPResponse>;`,
  http: `
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name'],
    const response = await this.requestHandler(message as MCPRequest, requestContext);
    private validateAuth(req: Request): { valid: boolean; principal?: AuthenticatedPrincipal; error?: string } {
      return { valid: true, principal: { subject: 'test' } };
    }
  `,
};

test('detects singleton session and dropped HTTP authority context', () => {
  const report = scanSources(vulnerable);
  assert.equal(report.summary.isolated, false);
  assert.equal(report.summary.critical, 4);
  assert.equal(report.summary.high, 2);
  assert.equal(report.summary.medium, 1);
  assert.equal(report.summary.activeFindings, 7);
});

test('passes when request-local transport and principal context are present', () => {
  const report = scanSources(remediated);
  assert.equal(report.summary.isolated, true);
  assert.equal(report.summary.critical, 0);
  assert.equal(report.summary.high, 0);
  assert.equal(report.summary.activeFindings, 0);
});

test('repository audit reports missing canonical surfaces without throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-session-audit-'));
  const report = auditRepository(root);
  assert.equal(report.missing.length, 3);
  assert.equal(report.summary.isolated, true);
});
