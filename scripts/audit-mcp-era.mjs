#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MODERN_VERSION = '2026-07-28';

export const DEFAULT_RUNTIME_ROOTS = Object.freeze([
  'v3/@claude-flow/mcp/src',
  'v3/@claude-flow/shared/src/mcp',
  'v3/mcp',
  'v3/@claude-flow/cli/bin',
  'ruflo/src/mcp-bridge',
  'ruflo/src/ruvocal/src/lib/wasm',
]);

export const CANONICAL_SERVER = 'v3/@claude-flow/mcp/src/server.ts';

const RUNTIME_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

const PROTOCOL_LITERAL =
  /(?:protocolVersion|MCP[-_ ]Protocol[-_ ]Version)[^'"`\n]{0,80}['"`](\d{4}-\d{2}-\d{2})['"`]/gi;

const LIFECYCLE_MARKERS = Object.freeze([
  ['session-header', /Mcp-Session-Id|MCP-Session-Id|MCP_SESSION_ID/g],
  ['initialize-handler', /\bhandleInitialize\b/g],
  ['session-create', /\bgetOrCreateSession\b|\binitializeSession\b/g],
  ['initialized-notification', /['"`]initialized['"`]/g],
]);

const MODERN_MARKERS = Object.freeze([
  ['server-discover', /server\/discover/g],
  ['mcp-method-header', /Mcp-Method|MCP-Method/g],
  ['mcp-name-header', /Mcp-Name|MCP-Name/g],
  ['cache-hint', /\bttlMs\b|\bcacheScope\b/g],
  ['trace-context', /\btraceparent\b|\btracestate\b/g],
]);

function normalizeRel(value) {
  return value.split(path.sep).join('/');
}

function collectMatches(text, regex) {
  regex.lastIndex = 0;
  const matches = [];
  for (const match of text.matchAll(regex)) {
    matches.push({ value: match[0], index: match.index ?? -1 });
  }
  return matches;
}

export function scanText(text, file = '<memory>') {
  const versions = [];
  PROTOCOL_LITERAL.lastIndex = 0;
  for (const match of text.matchAll(PROTOCOL_LITERAL)) {
    versions.push({
      version: match[1],
      index: match.index ?? -1,
    });
  }

  const lifecycle = [];
  for (const [kind, regex] of LIFECYCLE_MARKERS) {
    const matches = collectMatches(text, regex);
    if (matches.length > 0) {
      lifecycle.push({ kind, count: matches.length });
    }
  }

  const modern = [];
  for (const [kind, regex] of MODERN_MARKERS) {
    const matches = collectMatches(text, regex);
    if (matches.length > 0) {
      modern.push({ kind, count: matches.length });
    }
  }

  return {
    file: normalizeRel(file),
    versions,
    lifecycle,
    modern,
  };
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) return RUNTIME_EXTENSIONS.has(path.extname(dir)) ? [dir] : [];

  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile() && RUNTIME_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

export function auditRepository(repoRoot, runtimeRoots = DEFAULT_RUNTIME_ROOTS) {
  const resolvedRoot = path.resolve(repoRoot);
  const files = new Set();
  for (const relativeRoot of runtimeRoots) {
    const target = path.join(resolvedRoot, relativeRoot);
    for (const file of walkFiles(target)) files.add(file);
  }

  const reports = [...files]
    .sort()
    .map((file) => scanText(fs.readFileSync(file, 'utf8'), path.relative(resolvedRoot, file)))
    .filter((report) =>
      report.versions.length > 0 ||
      report.lifecycle.length > 0 ||
      report.modern.length > 0
    );

  const versionCounts = {};
  const lifecycleCounts = {};
  const modernCounts = {};

  for (const report of reports) {
    for (const item of report.versions) {
      versionCounts[item.version] = (versionCounts[item.version] ?? 0) + 1;
    }
    for (const item of report.lifecycle) {
      lifecycleCounts[item.kind] = (lifecycleCounts[item.kind] ?? 0) + item.count;
    }
    for (const item of report.modern) {
      modernCounts[item.kind] = (modernCounts[item.kind] ?? 0) + item.count;
    }
  }

  const canonical = reports.find((report) => report.file === CANONICAL_SERVER);
  const canonicalVersions = canonical?.versions.map((item) => item.version) ?? [];
  const canonicalModern = new Set(canonical?.modern.map((item) => item.kind) ?? []);

  return {
    schema: 'ruflo.mcp-era-audit/v1',
    modernVersion: MODERN_VERSION,
    repoRoot: resolvedRoot,
    runtimeRoots: [...runtimeRoots],
    summary: {
      filesWithSignals: reports.length,
      versionCounts,
      lifecycleCounts,
      modernCounts,
      canonicalServer: CANONICAL_SERVER,
      canonicalAdvertisesModern: canonicalVersions.includes(MODERN_VERSION),
      canonicalHasDiscover: canonicalModern.has('server-discover'),
    },
    files: reports,
  };
}

export function formatHuman(report) {
  const lines = [
    'RuFlo MCP protocol era audit',
    `Modern target: ${report.modernVersion}`,
    `Runtime files with signals: ${report.summary.filesWithSignals}`,
    `Protocol versions: ${JSON.stringify(report.summary.versionCounts)}`,
    `Legacy lifecycle markers: ${JSON.stringify(report.summary.lifecycleCounts)}`,
    `Modern markers: ${JSON.stringify(report.summary.modernCounts)}`,
    `Canonical server: ${report.summary.canonicalServer}`,
    `Canonical advertises modern: ${report.summary.canonicalAdvertisesModern}`,
    `Canonical has server/discover: ${report.summary.canonicalHasDiscover}`,
  ];

  for (const file of report.files) {
    lines.push(
      '',
      file.file,
      `  versions: ${file.versions.map((item) => item.version).join(', ') || 'none'}`,
      `  lifecycle: ${file.lifecycle.map((item) => `${item.kind}:${item.count}`).join(', ') || 'none'}`,
      `  modern: ${file.modern.map((item) => `${item.kind}:${item.count}`).join(', ') || 'none'}`
    );
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    json: false,
    assertModernEntrypoint: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--assert-modern-entrypoint') options.assertModernEntrypoint = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root requires a path');
      options.root = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/audit-mcp-era.mjs [--root PATH] [--json] [--assert-modern-entrypoint]',
    '',
    'Audits runtime MCP surfaces for protocol versions, legacy lifecycle markers,',
    'and modern 2026-07-28 wire markers. It does not mutate the repository.',
    '',
    '--assert-modern-entrypoint exits nonzero until the canonical MCP server both',
    'advertises 2026-07-28 and implements server/discover.',
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = auditRepository(options.root);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatHuman(report));

  if (
    options.assertModernEntrypoint &&
    (!report.summary.canonicalAdvertisesModern || !report.summary.canonicalHasDiscover)
  ) {
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  try {
    main();
  } catch (error) {
    console.error(`audit-mcp-era: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
