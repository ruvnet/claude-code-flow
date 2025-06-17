/**
 * Test utilities for Claude-Flow
 */

import { assertEquals, assertExists, assertRejects, assertThrows } from '@std/assert';
import { describe, it, beforeEach, afterEach, beforeAll, afterAll } from '@std/testing/bdd';
import { spy, stub, assertSpyCall, assertSpyCalls } from '@std/testing/mock';
import { FakeTime } from '@std/testing/time';

export {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
  describe,
  it,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  spy,
  stub,
  assertSpyCall,
  assertSpyCalls,
  FakeTime,
};

/**
 * Creates a test fixture
 */
export function createFixture<T>(factory: () => T): {
  get(): T;
  reset(): void;
} {
  let instance: T;

  return {
    get(): T {
      if (!instance) {
        instance = factory();
      }
      return instance;
    },
    reset(): void {
      instance = factory();
    },
  };
}

/**
 * Waits for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error('Timeout waiting for condition');
}

/**
 * Creates a deferred promise for testing
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
} {
  let resolve: (value: T) => void;
  let reject: (reason?: any) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve: resolve!, reject: reject! };
}

/**
 * Captures console output during test
 */
export function captureConsole(): {
  getOutput(): string[];
  getErrors(): string[];
  restore(): void;
} {
  const output: string[] = [];
  const errors: string[] = [];

  const originalLog = console.log;
  const originalError = console.error;
  const originalDebug = console.debug;
  const originalInfo = console.info;
  const originalWarn = console.warn;

  console.log = (...args: any[]) => output.push(args.join(' '));
  console.error = (...args: any[]) => errors.push(args.join(' '));
  console.debug = (...args: any[]) => output.push(args.join(' '));
  console.info = (...args: any[]) => output.push(args.join(' '));
  console.warn = (...args: any[]) => output.push(args.join(' '));

  return {
    getOutput: () => [...output],
    getErrors: () => [...errors],
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.debug = originalDebug;
      console.info = originalInfo;
      console.warn = originalWarn;
    },
  };
}

/**
 * Creates a test file in a temporary directory
 */
export async function createTestFile(
  path: string,
  content: string,
): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const filePath = `${tempDir}/${path}`;
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(filePath, content);
  
  return filePath;
}

/**
 * Runs a CLI command and captures output
 */
export async function runCommand(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cmdOptions: Deno.CommandOptions = {
    args: ['run', '--allow-all', 'src/cli/index.ts', ...args],
    stdout: 'piped',
    stderr: 'piped',
  };

  if (options.stdin) {
    cmdOptions.stdin = 'piped';
  }

  if (options.env) {
    cmdOptions.env = options.env;
  }

  const cmd = new Deno.Command(Deno.execPath(), cmdOptions);

  const child = cmd.spawn();

  if (options.stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }

  const output = await child.output();
  
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

/**
 * Test data builder for common types
 */
export class TestDataBuilder {
  static agentProfile(overrides = {}) {
    return {
      id: 'agent-1',
      name: 'Test Agent',
      type: 'coordinator' as const,
      capabilities: ['task-management', 'coordination'],
      systemPrompt: 'You are a test agent',
      maxConcurrentTasks: 5,
      priority: 10,
      environment: {},
      workingDirectory: '/tmp',
      shell: '/bin/bash',
      metadata: {},
      ...overrides,
    };
  }

  static task(overrides = {}) {
    return {
      id: 'task-1',
      type: 'test',
      description: 'Test task',
      priority: 50,
      dependencies: [],
      status: 'pending' as const,
      input: { test: true },
      createdAt: new Date(),
      metadata: {},
      ...overrides,
    };
  }

  static config(overrides = {}) {
    return {
      orchestrator: {
        maxConcurrentAgents: 10,
        taskQueueSize: 100,
        healthCheckInterval: 30000,
        shutdownTimeout: 30000,
        maintenanceInterval: 300000,
        metricsInterval: 60000,
        persistSessions: false,
        dataDir: './tests/data',
        sessionRetentionMs: 3600000,
        taskHistoryRetentionMs: 86400000,
        taskMaxRetries: 3,
      },
      terminal: {
        type: 'native' as const,
        poolSize: 5,
        recycleAfter: 10,
        healthCheckInterval: 60000,
        commandTimeout: 300000,
      },
      memory: {
        backend: 'sqlite' as const,
        cacheSizeMB: 10,
        syncInterval: 5000,
        conflictResolution: 'last-write' as const,
        retentionDays: 1,
        sqlitePath: ':memory:',
        markdownDir: './tests/data/memory',
      },
      coordination: {
        maxRetries: 3,
        retryDelay: 100,
        deadlockDetection: true,
        resourceTimeout: 60000,
        messageTimeout: 30000,
      },
      mcp: {
        transport: 'stdio' as const,
        port: 8081,
        tlsEnabled: false,
      },
      logging: {
        level: 'error' as const,
        format: 'json' as const,
        destination: 'console' as const,
      },
      ...overrides,
    };
  }
}

/**
 * Assertion helpers
 */
export function assertEventEmitted(
  events: Array<{ event: string; data: any }>,
  eventName: string,
  matcher?: (data: any) => boolean,
): void {
  const emitted = events.find((e) => e.event === eventName);
  assertExists(emitted, `Expected event '${eventName}' to be emitted`);
  
  if (matcher && !matcher(emitted.data)) {
    throw new Error(`Event '${eventName}' data did not match expected criteria`);
  }
}

export function assertNoEventEmitted(
  events: Array<{ event: string; data: any }>,
  eventName: string,
): void {
  const emitted = events.find((e) => e.event === eventName);
  assertEquals(emitted, undefined, `Expected event '${eventName}' not to be emitted`);
}