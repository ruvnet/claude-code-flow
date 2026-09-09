#!/usr/bin/env node
/**
 * @claude-flow/cli - CLI Entry Point
 *
 * Claude Flow V3 Command Line Interface
 *
 * Auto-detects MCP mode when stdin is piped and no args provided.
 * This allows: echo '{"jsonrpc":"2.0",...}' | npx @claude-flow/cli
 */

import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// #2253 / #2256: Console filter installed BEFORE any other import. Two jobs:
//
// 1. Suppress the cosmetic "[AgentDB Patch] Controller index not found"
//    warning from agentic-flow (it expects agentdb v1.x but we use v3).
//    Tight match — must include BOTH the prefix AND the specific text;
//    other [AgentDB Patch] messages flow through. Audit log
//    audit_1776483149979 flagged a broader filter as too aggressive.
//
// 2. Redirect noisy stdout writes from upstream embedder libraries
//    (ruvector ONNX loader, ruvector-onnx-embeddings-wasm parallel
//    embedder) to stderr. Those libraries use console.log for progress
//    messages — "Loading model:", "  Downloading: …", "🚀 Initializing N
//    workers" — which corrupts MCP JSON-RPC stdio (#2253) and is noise
//    on stdout. stderr is the right channel for progress to a TTY user,
//    and the MCP stdio framer reads stdout only.
//
// This MUST be installed before `import('../dist/src/index.js')` so the
// patch is in place before agentic-flow / ruvector load transitively.
const _origWarn = console.warn;
const _origLog = console.log;
const _origError = console.error;

// #2726 — Some MCP clients place every advertised schema in every model
// request. Keep "all" as the backwards-compatible default, but honor the
// same category/namespace/exact-name selector as `mcp start --tools`.
function _filterAdvertisedMcpTools(tools) {
  const argv = process.argv.slice(2);
  const toolsIndex = argv.findIndex((arg) => arg === '--tools');
  const inlineTools = argv.find((arg) => arg.startsWith('--tools='));
  const configured = process.env.CLAUDE_FLOW_MCP_TOOLS
    || (toolsIndex >= 0 ? argv[toolsIndex + 1] : undefined)
    || (inlineTools ? inlineTools.slice('--tools='.length) : undefined);
  if (!configured || configured.trim().toLowerCase() === 'all') return tools;
  const selectors = new Set(
    configured.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  if (selectors.size === 0) return tools;
  return tools.filter((tool) => {
    const name = tool.name.toLowerCase();
    const category = typeof tool.category === 'string' ? tool.category.toLowerCase() : '';
    return selectors.has(name)
      || selectors.has(category)
      || Array.from(selectors).some((selector) => name.startsWith(`${selector}_`));
  });
}
const _isCosmeticAgentdbPatchNoise = (msg) =>
  msg.includes('[AgentDB Patch]') && msg.includes('Controller index not found');
const _STDERR_REDIRECT_PREFIXES = [
  'Loading model: ',
  '  Downloading: ',
  '  Cache hit: ',
  '  Disk cache hit: ',
  'Model cache cleared',
  '🚀 Initializing ',
  '✅ ',
];
// agentdb's EmbeddingService.initialize() prints this cluster when
// `@xenova/transformers` fails to load (commonly: macOS arm64 without
// `brew install vips` — sharp can't resolve libvips). The warnings claim
// agentdb is "falling back to mock embeddings", but memory-bridge.ts's
// rescueAgentdbEmbedder swaps the embedder over to ruvector ONNX in
// that exact case, so the user is NOT on mocks. The warnings are stale
// and misleading; drop them. Match anchored to exact upstream prefixes
// (agentdb/dist/controllers/EmbeddingService.js:48–56) so unrelated
// warnings always flow through.
const _AGENTDB_MOCK_FALLBACK_DROP_PREFIXES = [
  'Transformers.js initialization failed:',
  '   Falling back to mock embeddings for testing',
  '   This is normal if:',
  '     - Running offline/without internet access',
  '     - Model not yet downloaded',
  '     - Network connectivity issues',
  '   To use real embeddings:',
  '     - Ensure internet connectivity for first',
  '     - Or pre-download: npx agentdb',
];
const _shouldRedirectToStderr = (msg) => {
  for (const prefix of _STDERR_REDIRECT_PREFIXES) {
    if (msg.startsWith(prefix)) return true;
  }
  return false;
};
const _isAgentdbMockFallbackNoise = (msg) => {
  for (const prefix of _AGENTDB_MOCK_FALLBACK_DROP_PREFIXES) {
    if (msg.startsWith(prefix)) return true;
  }
  return false;
};
console.warn = (...args) => {
  const head = String(args[0] ?? '');
  if (_isCosmeticAgentdbPatchNoise(head)) return;
  if (_isAgentdbMockFallbackNoise(head)) return;
  _origWarn.apply(console, args);
};
console.log = (...args) => {
  const head = String(args[0] ?? '');
  if (_isCosmeticAgentdbPatchNoise(head)) return;
  if (_shouldRedirectToStderr(head)) {
    _origError.apply(console, args);
    return;
  }
  _origLog.apply(console, args);
};

// #2256 fast path: --version / -V / --help / -h must NOT trigger heavy
// imports (agentic-flow, ruvector ONNX, etc.) — those eagerly download a
// 23 MB ONNX model on cold cache, blocking 60+ s and causing SIGTERM
// under common timeout windows (npx default, MCP stdio 30 s). Resolve
// version directly from package.json and exit before any heavy import.
{
  const _argv = process.argv.slice(2);
  if (_argv.length === 1 && (_argv[0] === '--version' || _argv[0] === '-V')) {
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
      process.stdout.write(`ruflo v${pkg.version || '0.0.0'}\n`);
    } catch {
      process.stdout.write('ruflo v0.0.0\n');
    }
    process.exit(0);
  }
  // --help / -h with no other args also stays lightweight — fall through
  // to the existing fast help path inside index.ts; we don't short-circuit
  // here because some users pass `<command> --help` which needs lazy command
  // loading. The version short-circuit is the only one safe to inline.
}

// Check if we should run in MCP server mode
// Conditions:
//   1. stdin is being piped AND no CLI arguments provided (auto-detect)
//   2. stdin is being piped AND args are "mcp start" (explicit, e.g. npx claude-flow@alpha mcp start)
//   3. EXCEPT — if the user explicitly passed --transport <non-stdio>
//      (e.g. -t http), defer to the parser. Without this, every smoke
//      test or non-TTY caller of `mcp start -t http` got force-routed
//      into stdio mode and never hit the HTTP server (#1874 follow-up).
const cliArgs = process.argv.slice(2);
const isExplicitMCP = cliArgs.length >= 1 && cliArgs[0] === 'mcp' && (cliArgs.length === 1 || cliArgs[1] === 'start');
const explicitNonStdioTransport = cliArgs.some((a, i) => {
  // -t <value> | --transport <value>
  if ((a === '-t' || a === '--transport') && cliArgs[i + 1] && cliArgs[i + 1] !== 'stdio') return true;
  // --transport=<value>
  if (/^--transport=/.test(a) && !/^--transport=stdio$/.test(a)) return true;
  return false;
});
const isMCPMode = !process.stdin.isTTY
  && !explicitNonStdioTransport
  && (process.argv.length === 2 || isExplicitMCP);

if (isMCPMode) {
  // Run MCP server mode
  const { listMCPTools, callMCPTool, hasTool } = await import('../dist/src/mcp-client.js');

  const VERSION = '3.0.0';
  const sessionId = `mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;

  console.error(
    `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Starting in stdio mode`
  );

  // Audit-flagged DoS protection (audit_1776483149979): cap the
  // newline-buffered stdin parser so a malicious client cannot pipe
  // gigabytes of un-newlined data and exhaust memory before
  // JSON.parse runs. 10MB is far above any legitimate MCP message
  // (the protocol's largest realistic payloads — tool descriptions,
  // batch search results — top out at ~1MB).
  const MCP_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    if (buffer.length > MCP_MAX_BUFFER_BYTES) {
      // Drop the buffer + emit a protocol-level error so the client
      // sees the rejection rather than a silent OOM.
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Buffered stdin exceeds ${MCP_MAX_BUFFER_BYTES} bytes without newline; resetting`,
        },
      }));
      buffer = '';
      return;
    }
    let lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }));
          continue;
        }
        try {
          const response = await handleMessage(message);
          if (response) {
            console.log(JSON.stringify(response));
          }
        } catch (error) {
          // #1606: Return proper internal error instead of parse error
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
          }));
        }
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });

  // Exit cleanly when the parent process sends a termination signal.
  // Without these handlers, the auto-detected MCP server can survive the
  // parent's death (e.g. when the client is killed with SIGKILL and the
  // stdin pipe is not closed gracefully) and accumulate as an orphaned
  // process under PPID=1. The explicit `mcp-server.js` entrypoint already
  // registers these handlers — this brings the auto-detect path to parity.
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  async function handleMessage(message) {
    if (!message.method) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32600, message: 'Invalid Request: missing method' },
      };
    }

    const params = message.params || {};

    switch (message.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'ruflo', version: VERSION },
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: true, listChanged: true },
            },
          },
        };

      case 'tools/list': {
        const tools = _filterAdvertisedMcpTools(listMCPTools());
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        };
      }

      case 'tools/call': {
        const toolName = params.name;
        const toolParams = params.arguments || {};

        if (!hasTool(toolName)) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Tool not found: ${toolName}` },
          };
        }

        try {
          const result = await callMCPTool(toolName, toolParams, { sessionId });
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Tool execution failed',
            },
          };
        }
      }

      case 'notifications/initialized':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id: message.id, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        };
    }
  }
} else {
  // Run normal CLI mode
  const { CLI } = await import('../dist/src/index.js');
  const cli = new CLI();
  cli.run()
    .then(() => {
      // #1552: Exit cleanly after one-shot commands.
      // Long-running commands (daemon foreground, mcp, status --watch) never resolve,
      // so this only fires for normal CLI commands.
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error.message);
      process.exit(1);
    });
}
