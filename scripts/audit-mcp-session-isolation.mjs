#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_FILES = Object.freeze({
  server: 'v3/@claude-flow/mcp/src/server.ts',
  types: 'v3/@claude-flow/mcp/src/types.ts',
  http: 'v3/@claude-flow/mcp/src/transport/http.ts',
});

const CHECKS = Object.freeze([
  {
    id: 'server.singleton-current-session',
    file: 'server',
    severity: 'critical',
    unsafe: /\bcurrentSession\??\s*:\s*MCPSession|\bcurrentSession\s*=\s*session/g,
    safe: /AsyncLocalStorage<MCPRequestContext>[\s\S]{0,1200}authoritySessions\s*=\s*new\s+Map<string,\s*string>/g,
    message: 'server owns mutable singleton currentSession state without a request-local authority map',
  },
  {
    id: 'server.tool-context-from-singleton-session',
    file: 'server',
    severity: 'critical',
    unsafe: /sessionId:\s*this\.currentSession\?\.id/g,
    message: 'tool or sampling authority context is derived from singleton currentSession',
  },
  {
    id: 'server.subscription-from-singleton-session',
    file: 'server',
    severity: 'high',
    unsafe: /const\s+sessionId\s*=\s*this\.currentSession\?\.id/g,
    message: 'resource subscription ownership is derived from singleton currentSession',
  },
  {
    id: 'types.request-handler-has-no-context',
    file: 'types',
    severity: 'critical',
    unsafe: /type\s+RequestHandler\s*=\s*\(request:\s*MCPRequest\)\s*=>/g,
    safe: /type\s+RequestHandler\s*=\s*\(\s*request:\s*MCPRequest\s*,\s*context\??:/g,
    message: 'transport request handler cannot pass request-local protocol or principal context',
  },
  {
    id: 'http.drops-request-context',
    file: 'http',
    severity: 'critical',
    unsafe: /this\.requestHandler\(message\s+as\s+MCPRequest\)/g,
    safe: /this\.requestHandler\(message\s+as\s+MCPRequest\s*,/g,
    message: 'HTTP transport dispatches only the JSON body and drops request-local headers and principal context',
  },
  {
    id: 'http.auth-has-no-principal',
    file: 'http',
    severity: 'high',
    unsafe: /validateAuth\(req:\s*Request\):\s*\{\s*valid:\s*boolean;\s*error\?:\s*string\s*\}/g,
    safe: /validateAuth\(req:\s*Request\):[^\n]*(principal|subject|identity)/gi,
    message: 'authentication returns a boolean verdict without a request-local principal identity',
  },
  {
    id: 'http.modern-routing-headers-not-cors-allowlisted',
    file: 'http',
    severity: 'medium',
    unsafe: /allowedHeaders:\s*\[[^\]]*'Content-Type'[^\]]*'Authorization'[^\]]*'X-Request-ID'[^\]]*\]/g,
    safe: /allowedHeaders:\s*\[[^\]]*['"]MCP-Protocol-Version['"][^\]]*['"]Mcp-Method['"][^\]]*['"]Mcp-Name['"][^\]]*\]/gis,
    message: 'CORS allowlist does not expose the MCP 2026 routing/version headers',
  },
]);

function count(text, regex) {
  regex.lastIndex = 0;
  return [...text.matchAll(regex)].length;
}

export function scanSources(sources) {
  const findings = [];
  for (const check of CHECKS) {
    const text = sources[check.file] ?? '';
    const unsafeCount = count(text, check.unsafe);
    const safeCount = check.safe ? count(text, check.safe) : 0;
    const active = unsafeCount > 0 && safeCount === 0;
    findings.push({
      id: check.id,
      severity: check.severity,
      active,
      unsafeCount,
      safeCount,
      message: check.message,
    });
  }

  const critical = findings.filter((item) => item.active && item.severity === 'critical').length;
  const high = findings.filter((item) => item.active && item.severity === 'high').length;
  const medium = findings.filter((item) => item.active && item.severity === 'medium').length;

  return {
    schema: 'ruflo.mcp-session-isolation-audit/v1',
    summary: {
      isolated: critical === 0 && high === 0,
      activeFindings: findings.filter((item) => item.active).length,
      critical,
      high,
      medium,
    },
    findings,
  };
}

export function auditRepository(repoRoot, files = DEFAULT_FILES) {
  const root = path.resolve(repoRoot);
  const sources = {};
  const missing = [];

  for (const [key, rel] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    if (!fs.existsSync(absolute)) {
      missing.push(rel);
      sources[key] = '';
      continue;
    }
    sources[key] = fs.readFileSync(absolute, 'utf8');
  }

  return {
    ...scanSources(sources),
    repoRoot: root,
    files,
    missing,
  };
}

export function formatHuman(report) {
  const lines = [
    'RuFlo MCP request-local isolation audit',
    `Isolated: ${report.summary.isolated}`,
    `Active findings: ${report.summary.activeFindings}`,
    `Critical: ${report.summary.critical}`,
    `High: ${report.summary.high}`,
    `Medium: ${report.summary.medium}`,
  ];

  if (report.missing?.length) {
    lines.push(`Missing files: ${report.missing.join(', ')}`);
  }

  for (const item of report.findings) {
    lines.push(`${item.active ? 'FAIL' : 'PASS'} ${item.severity.toUpperCase()} ${item.id}: ${item.message}`);
  }

  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { root: process.cwd(), json: false, assertIsolated: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--assert-isolated') options.assertIsolated = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root requires a path');
      options.root = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/audit-mcp-session-isolation.mjs [--root PATH] [--json] [--assert-isolated]',
    '',
    'Audits the canonical MCP server, transport types, and HTTP transport for request-local',
    'principal/protocol context and singleton-session aliasing. The audit is read-only.',
    '',
    '--assert-isolated exits nonzero while critical/high isolation findings remain.',
  ].join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const report = auditRepository(options.root);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatHuman(report));
    if (report.missing.length > 0) process.exitCode = 2;
    else if (options.assertIsolated && !report.summary.isolated) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
