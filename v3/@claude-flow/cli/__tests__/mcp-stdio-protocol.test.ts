/**
 * MCP Stdio Protocol Tests (#898)
 *
 * Verifies that the MCP server follows the JSON-RPC / MCP protocol correctly
 * in stdio mode. The server must NOT send any messages to stdout before
 * receiving the client's `initialize` request.
 *
 * These tests verify the source code structure to ensure the fix stays in
 * place. Direct runtime tests of MCPServerManager are not feasible here
 * because the module has optional dependencies (@claude-flow/mcp) that
 * Vite cannot resolve in the test environment.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC_PATH = resolve(__dirname, '..', 'src', 'mcp-server.ts');
const source = readFileSync(SRC_PATH, 'utf-8');

// Extract the startStdioServer method body and the code before stdin handler
const methodStart = source.indexOf('private async startStdioServer');
const stdinHandler = source.indexOf("process.stdin.on('data'", methodStart);
const preInputCode = source.slice(methodStart, stdinHandler);

describe('MCP stdio protocol compliance (#898)', () => {
  it('startStdioServer should not call console.log before receiving stdin input', () => {
    // Before the fix, the server sent a JSON-RPC `server.initialized`
    // notification via console.log() before the client sent anything.
    // After the fix, NO console.log() calls should exist in the pre-input
    // code — only console.error() (which goes to stderr, safe for MCP).
    const consoleLogCalls = preInputCode.match(/console\.log\(/g);
    expect(consoleLogCalls).toBeNull();
  });

  it('startStdioServer should not send a server.initialized notification before stdin data arrives', () => {
    // Regardless of the write mechanism (console.log, writeFrame, or any
    // future helper), the server must not emit `server.initialized` before
    // the client's `initialize` request. Matching the method name directly
    // (rather than just the write call) keeps this test valid even if the
    // stdout-writing mechanism changes again.
    expect(preInputCode).not.toContain("method: 'server.initialized'");
  });

  it('startStdioServer should use console.error for all pre-input logging', () => {
    // Metadata (arch, platform, version, sessionId) should go to stderr
    expect(preInputCode).toContain('console.error(JSON.stringify');

    // There should be multiple console.error calls for logging
    const errorCalls = preInputCode.match(/console\.error\(/g);
    expect(errorCalls).not.toBeNull();
    expect(errorCalls!.length).toBeGreaterThanOrEqual(1);
  });

  it('should have a comment explaining why server.initialized was removed', () => {
    // Ensure the rationale is documented in the code
    expect(preInputCode).toContain('#898');
    expect(preInputCode).toContain('MCP protocol');
  });

  it('handleMCPMessage should have an initialize case that returns capabilities', () => {
    // Find the handleMCPMessage method
    const handlerStart = source.indexOf('private async handleMCPMessage');
    expect(handlerStart).toBeGreaterThan(-1);

    // Find the end of the method (next private/public method or end of class)
    const nextMethod = source.indexOf('\n  /**', handlerStart + 1);
    const handlerBody = source.slice(handlerStart, nextMethod > -1 ? nextMethod : undefined);

    // The initialize handler should exist
    expect(handlerBody).toContain("case 'initialize':");

    // It should return protocolVersion and capabilities
    expect(handlerBody).toContain('protocolVersion');
    expect(handlerBody).toContain('capabilities');
    expect(handlerBody).toContain('serverInfo');
  });

  it('handleMCPMessage should handle notifications/initialized from client', () => {
    const handlerStart = source.indexOf('private async handleMCPMessage');
    const nextMethod = source.indexOf('\n  /**', handlerStart + 1);
    const handlerBody = source.slice(handlerStart, nextMethod > -1 ? nextMethod : undefined);

    // Should handle the client's initialized notification
    expect(handlerBody).toContain("case 'notifications/initialized':");

    // Should return null (no response for notifications)
    expect(handlerBody).toContain('return null');
  });

  it('stdin message handler should only use console.log for JSON-RPC responses', () => {
    // Find the stdin.on('data') handler
    const stdinSection = source.slice(stdinHandler);
    const stdinEnd = stdinSection.indexOf("process.stdin.on('end'");
    const stdinBody = stdinSection.slice(0, stdinEnd > -1 ? stdinEnd : undefined);

    // All console.log calls in the stdin handler should be for JSON-RPC responses
    const logCalls = stdinBody.match(/console\.log\(.*\)/g) || [];
    for (const call of logCalls) {
      // Each console.log should contain JSON.stringify (sending JSON-RPC)
      expect(call).toContain('JSON.stringify');
    }
  });
});
