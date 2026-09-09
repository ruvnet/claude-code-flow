/**
 * Regression test: bin/cli.js auto-detected MCP mode must exit on SIGTERM/SIGINT.
 *
 * Catches the case where a long-running stdio MCP server kept alive by stdin
 * does not respond to termination signals and survives parent death as an
 * orphaned process (PPID=1).
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(__dirname, '..', 'bin', 'cli.js');
const DIST = resolve(__dirname, '..', 'dist', 'src', 'mcp-client.js');

describe('bin/cli.js — signal handling in MCP mode', () => {
  it.runIf(existsSync(DIST))('exits cleanly when SIGTERM is sent', async () => {
    const child = spawn(process.execPath, [CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    // Wait for the server to print its initialization line on stderr.
    await new Promise<void>((resolve) => {
      const onData = (buf: Buffer) => {
        if (buf.toString().includes('Starting in stdio mode')) {
          child.stderr?.off('data', onData);
          resolve();
        }
      };
      child.stderr?.on('data', onData);
      setTimeout(() => resolve(), 2000);
    });

    const exitCode = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(-1);
      }, 5000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
      child.kill('SIGTERM');
    });

    expect(exitCode).toBe(0);
  }, 10_000);

  it.runIf(existsSync(DIST))('exits cleanly when SIGINT is sent', async () => {
    const child = spawn(process.execPath, [CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    await new Promise<void>((resolve) => {
      const onData = (buf: Buffer) => {
        if (buf.toString().includes('Starting in stdio mode')) {
          child.stderr?.off('data', onData);
          resolve();
        }
      };
      child.stderr?.on('data', onData);
      setTimeout(() => resolve(), 2000);
    });

    const exitCode = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(-1);
      }, 5000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
      child.kill('SIGINT');
    });

    expect(exitCode).toBe(0);
  }, 10_000);
});
