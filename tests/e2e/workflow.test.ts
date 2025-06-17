/**
 * End-to-end workflow tests
 */

import { assertEquals } from '@std/assert';
import { delay } from '../../src/utils/helpers.ts';

Deno.test('E2E - CLI should show help', async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-all', 'src/cli/index.ts', '--help'],
    stdout: 'piped',
    stderr: 'piped',
  });

  const { code, stdout } = await command.output();
  const output = new TextDecoder().decode(stdout);

  assertEquals(code, 0);
  assertEquals(output.includes('Claude-Flow: Advanced AI agent orchestration system'), true);
  assertEquals(output.includes('COMMANDS'), true);
});

Deno.test('E2E - Config init should create file', async () => {
  const testFile = './test-config.json';
  
  try {
    // Remove test file if it exists
    try {
      await Deno.remove(testFile);
    } catch {
      // File doesn't exist, which is fine
    }

    const command = new Deno.Command(Deno.execPath(), {
      args: ['run', '--allow-all', 'src/cli/index.ts', 'config', 'init', testFile],
      stdout: 'piped',
      stderr: 'piped',
    });

    const { code, stdout } = await command.output();
    const output = new TextDecoder().decode(stdout);

    assertEquals(code, 0);
    assertEquals(output.includes('Configuration file created'), true);

    // Verify file was created
    const stat = await Deno.stat(testFile);
    assertEquals(stat.isFile, true);

    // Verify content is valid JSON
    const content = await Deno.readTextFile(testFile);
    const config = JSON.parse(content);
    assertEquals(typeof config.orchestrator, 'object');
    assertEquals(typeof config.terminal, 'object');
    assertEquals(typeof config.memory, 'object');
  } finally {
    // Cleanup
    try {
      await Deno.remove(testFile);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test('E2E - Agent spawn command should create profile', async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run', 
      '--allow-all', 
      'src/cli/index.ts', 
      'agent', 
      'spawn', 
      'researcher',
      '--name', 'test-researcher',
      '--priority', '5',
    ],
    stdout: 'piped',
    stderr: 'piped',
  });

  const { code, stdout } = await command.output();
  const output = new TextDecoder().decode(stdout);

  assertEquals(code, 0);
  assertEquals(output.includes('Agent profile created'), true);
  assertEquals(output.includes('"name": "test-researcher"'), true);
  assertEquals(output.includes('"type": "researcher"'), true);
  assertEquals(output.includes('"priority": 5'), true);
});

Deno.test('E2E - Task create command should create task', async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run', 
      '--allow-all', 
      'src/cli/index.ts', 
      'task', 
      'create',
      'analysis',
      'Analyze the test results',
      '--priority', '10',
    ],
    stdout: 'piped',
    stderr: 'piped',
  });

  const { code, stdout } = await command.output();
  const output = new TextDecoder().decode(stdout);

  assertEquals(code, 0);
  assertEquals(output.includes('Task created'), true);
  assertEquals(output.includes('"type": "analysis"'), true);
  assertEquals(output.includes('"description": "Analyze the test results"'), true);
  assertEquals(output.includes('"priority": 10'), true);
});