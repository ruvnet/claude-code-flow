#!/usr/bin/env node
// Ruflo CLI - thin wrapper around @claude-flow/cli with ruflo branding
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// #2256 / #2561 fast path: --version / -V must NOT trigger heavy imports
// (the downstream @claude-flow/cli dist eagerly loads ruvector + a 23 MB
// ONNX model on cold cache, blocking 60+ s and causing SIGTERM under
// common timeout windows: npx default, MCP stdio 30 s). Resolve version
// from this wrapper's own package.json and exit before any heavy import.
// (bin/cli.js has the same guard for the direct path; needed here too
// because the wrapper imports dist/src/index.js, bypassing bin/cli.js.)
//
// #2561 broadened the guard so `--version --no-color`, `--version --quiet`,
// `--version --format=json`, etc. still hit the fast path. Any argv that
// contains `--version` or `-V` with NO positional command-name token
// before it is treated as a version query. See `src/cli-fast-paths.ts`
// (`isVersionFastPath`) in @claude-flow/cli for the tested reference
// implementation — this inline copy must match it.
{
  const _argv = process.argv.slice(2);
  let _isVersion = false;
  for (const a of _argv) {
    if (a === '--version' || a === '-V') { _isVersion = true; break; }
    if (a === '--') break;             // POSIX end-of-flags separator
    if (a.startsWith('-')) continue;   // any other flag/option token
    break;                             // positional (command) — defer to parser
  }
  if (_isVersion) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
      process.stdout.write(`ruflo v${pkg.version || '0.0.0'}\n`);
    } catch {
      process.stdout.write('ruflo v0.0.0\n');
    }
    process.exit(0);
  }
}

// Walk up from ruflo/bin/ to find @claude-flow/cli in node_modules
function findCliPath() {
  let dir = resolve(__dirname, '..');
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', '@claude-flow', 'cli', 'bin', 'cli.js');
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Convert path to file:// URL for cross-platform ESM import (Windows requires this)
function toImportURL(filePath) {
  return pathToFileURL(filePath).href;
}

const pkgDir = findCliPath();
const cliBase = pkgDir
  ? join(pkgDir, 'node_modules', '@claude-flow', 'cli')
  : resolve(__dirname, '../../v3/@claude-flow/cli');

// MCP mode: delegate to cli.js directly (branding irrelevant for JSON-RPC)
const cliArgs = process.argv.slice(2);
const isExplicitMCP = cliArgs.length >= 1 && cliArgs[0] === 'mcp' && (cliArgs.length === 1 || cliArgs[1] === 'start');
const isMCPMode = !process.stdin.isTTY && (process.argv.length === 2 || isExplicitMCP);

if (isMCPMode) {
  await import(toImportURL(join(cliBase, 'bin', 'cli.js')));
} else {
  // CLI mode: use ruflo branding
  const { CLI } = await import(toImportURL(join(cliBase, 'dist', 'src', 'index.js')));
  const cli = new CLI({
    name: 'ruflo',
    description: 'Ruflo - AI Agent Orchestration Platform',
  });
  cli.run()
    .then(() => {
      // #1641/#1653: Exit cleanly after one-shot commands.
      // HNSW VectorDb, sql.js WASM, and ONNX worker threads keep the
      // event loop alive after the command handler returns.
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error.message);
      process.exit(1);
    });
}
