import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  auditRepository,
  MODERN_VERSION,
  scanText,
} from '../audit-mcp-era.mjs';

test('scanText classifies legacy lifecycle and protocol version', () => {
  const result = scanText(`
    private readonly protocolVersion = '2025-11-25';
    private async handleInitialize() {}
    const id = req.headers['Mcp-Session-Id'];
    this.getOrCreateSession();
  `, 'server.ts');

  assert.deepEqual(result.versions.map((item) => item.version), ['2025-11-25']);
  assert.equal(result.lifecycle.find((item) => item.kind === 'initialize-handler')?.count, 1);
  assert.equal(result.lifecycle.find((item) => item.kind === 'session-header')?.count, 1);
  assert.equal(result.lifecycle.find((item) => item.kind === 'session-create')?.count, 1);
});

test('scanText classifies modern entrypoint and routing markers', () => {
  const result = scanText(`
    const protocolVersion = '${MODERN_VERSION}';
    if (method === 'server/discover') return discover();
    const routedMethod = headers['Mcp-Method'];
    const routedName = headers['Mcp-Name'];
    return { ttlMs: 1000, cacheScope: 'private', traceparent: meta.traceparent };
  `, 'server.ts');

  assert.deepEqual(result.versions.map((item) => item.version), [MODERN_VERSION]);
  assert.deepEqual(
    new Set(result.modern.map((item) => item.kind)),
    new Set(['server-discover', 'mcp-method-header', 'mcp-name-header', 'cache-hint', 'trace-context'])
  );
});

test('auditRepository distinguishes canonical modern readiness without dependencies', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-mcp-audit-'));
  const server = path.join(temp, 'v3/@claude-flow/mcp/src/server.ts');
  fs.mkdirSync(path.dirname(server), { recursive: true });
  fs.writeFileSync(server, `
    export const protocolVersion = '${MODERN_VERSION}';
    export function route(method) {
      if (method === 'server/discover') return { protocolVersion };
      return null;
    }
  `);

  const report = auditRepository(temp, ['v3/@claude-flow/mcp/src']);
  assert.equal(report.summary.canonicalAdvertisesModern, true);
  assert.equal(report.summary.canonicalHasDiscover, true);
  assert.equal(report.summary.filesWithSignals, 1);
});
