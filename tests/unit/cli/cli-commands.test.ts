/**
 * Comprehensive unit tests for CLI Commands
 * Tests all CLI commands with mock interactions and argument validation
 */

import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { spy, stub } from "@std/testing/mock";

import { 
  AsyncTestUtils, 
  TestAssertions,
  MockFactory,
  FileSystemTestUtils
} from '../../utils/test-utils.ts';
import { generateCLITestScenarios } from '../../fixtures/generators.ts';
import { setupTestEnv, cleanupTestEnv, TEST_CONFIG } from '../../test.config.ts';

// Mock CLI infrastructure
interface CLICommand {
  name: string;
  description: string;
  handler: (args: any) => Promise<number>;
  options?: Array<{
    name: string;
    description: string;
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
    default?: any;
  }>;
}

interface CLIContext {
  commands: Map<string, CLICommand>;
  globalOptions: any;
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

// Mock CLI framework
class MockCLI {
  private context: CLIContext;

  constructor() {
    this.context = {
      commands: new Map(),
      globalOptions: {},
      stdout: [],
      stderr: [],
      exitCode: 0,
    };
  }

  command(cmd: CLICommand): void {
    this.context.commands.set(cmd.name, cmd);
  }

  async execute(args: string[]): Promise<number> {
    try {
      const [commandName, ...commandArgs] = args;
      const command = this.context.commands.get(commandName);
      
      if (!command) {
        this.stderr(`Unknown command: ${commandName}`);
        return 1;
      }

      const parsedArgs = this.parseArgs(command, commandArgs);
      const exitCode = await command.handler(parsedArgs);
      
      this.context.exitCode = exitCode;
      return exitCode;
    } catch (error) {
      this.stderr(`Error: ${error.message}`);
      return 1;
    }
  }

  private parseArgs(command: CLICommand, args: string[]): any {
    const parsed: any = {};
    const options = command.options || [];
    
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      
      if (arg.startsWith('--')) {
        const optName = arg.slice(2);
        const option = options.find(opt => opt.name === optName);
        
        if (!option) {
          throw new Error(`Unknown option: ${optName}`);
        }
        
        if (option.type === 'boolean') {
          parsed[optName] = true;
        } else {
          const value = args[++i];
          if (!value || value.startsWith('--')) {
            throw new Error(`Option --${optName} requires a value`);
          }
          
          parsed[optName] = option.type === 'number' ? Number(value) : value;
        }
      } else {
        // Positional argument
        if (!parsed._positional) parsed._positional = [];
        parsed._positional.push(arg);
      }
    }
    
    // Set defaults and check required options
    for (const option of options) {
      if (!(option.name in parsed)) {
        if (option.required) {
          throw new Error(`Missing required option: --${option.name}`);
        }
        if (option.default !== undefined) {
          parsed[option.name] = option.default;
        }
      }
    }
    
    return parsed;
  }

  stdout(message: string): void {
    this.context.stdout.push(message);
    console.log(message);
  }

  stderr(message: string): void {
    this.context.stderr.push(message);
    console.error(message);
  }

  getOutput(): { stdout: string[]; stderr: string[]; exitCode: number } {
    return {
      stdout: [...this.context.stdout],
      stderr: [...this.context.stderr],
      exitCode: this.context.exitCode,
    };
  }

  clearOutput(): void {
    this.context.stdout = [];
    this.context.stderr = [];
    this.context.exitCode = 0;
  }
}

describe('CLI Commands - Comprehensive Tests', () => {
  let cli: MockCLI;
  let tempDir: string;
  let fakeTime: FakeTime;

  beforeEach(async () => {
    setupTestEnv();
    cli = new MockCLI();
    tempDir = await FileSystemTestUtils.createTempDir('cli-test-');
    fakeTime = new FakeTime();
    
    // Set up test configuration
    await Deno.writeTextFile(
      `${tempDir}/test-config.json`,
      JSON.stringify(TEST_CONFIG.env)
    );
  });

  afterEach(async () => {
    fakeTime.restore();
    await FileSystemTestUtils.cleanup([tempDir]);
    await cleanupTestEnv();
  });

  describe('Start Command', () => {
    beforeEach(() => {
      cli.command({
        name: 'start',
        description: 'Start the Claude-Flow orchestrator',
        options: [
          { name: 'config', type: 'string', description: 'Configuration file path' },
          { name: 'port', type: 'number', description: 'Server port', default: 8080 },
          { name: 'daemon', type: 'boolean', description: 'Run as daemon' },
          { name: 'log-level', type: 'string', description: 'Log level', default: 'info' },
        ],
        handler: async (args) => {
          cli.stdout('Claude-Flow orchestrator starting...');
          
          if (args.config) {
            cli.stdout(`Using config file: ${args.config}`);
          }
          
          cli.stdout(`Server listening on port ${args.port}`);
          
          if (args.daemon) {
            cli.stdout('Running in daemon mode');
          }
          
          cli.stdout(`Log level: ${args['log-level']}`);
          cli.stdout('Orchestrator started successfully');
          
          return 0;
        },
      });
    });

    it('should start with default options', async () => {
      const exitCode = await cli.execute(['start']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'orchestrator starting');
      assertStringIncludes(output.stdout.join(' '), 'port 8080');
      assertStringIncludes(output.stdout.join(' '), 'Log level: info');
    });

    it('should start with custom configuration', async () => {
      const exitCode = await cli.execute([
        'start',
        '--config', `${tempDir}/test-config.json`,
        '--port', '9000',
        '--log-level', 'debug'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'test-config.json');
      assertStringIncludes(output.stdout.join(' '), 'port 9000');
      assertStringIncludes(output.stdout.join(' '), 'Log level: debug');
    });

    it('should handle daemon mode', async () => {
      const exitCode = await cli.execute(['start', '--daemon']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'daemon mode');
    });

    it('should validate port numbers', async () => {
      const exitCode = await cli.execute(['start', '--port', 'invalid']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 1);
      assertStringIncludes(output.stderr.join(' '), 'Error');
    });
  });

  describe('Agent Command', () => {
    beforeEach(() => {
      cli.command({
        name: 'agent',
        description: 'Manage Claude agents',
        options: [
          { name: 'action', type: 'string', required: true, description: 'Action: create, list, delete' },
          { name: 'name', type: 'string', description: 'Agent name' },
          { name: 'role', type: 'string', description: 'Agent role' },
          { name: 'capabilities', type: 'string', description: 'Agent capabilities (comma-separated)' },
        ],
        handler: async (args) => {
          switch (args.action) {
            case 'create':
              if (!args.name) {
                throw new Error('Agent name is required for create action');
              }
              cli.stdout(`Creating agent: ${args.name}`);
              if (args.role) cli.stdout(`Role: ${args.role}`);
              if (args.capabilities) cli.stdout(`Capabilities: ${args.capabilities}`);
              cli.stdout(`Agent "${args.name}" created successfully`);
              break;
              
            case 'list':
              cli.stdout('Active agents:');
              cli.stdout('- agent-1 (role: developer)');
              cli.stdout('- agent-2 (role: tester)');
              break;
              
            case 'delete':
              if (!args.name) {
                throw new Error('Agent name is required for delete action');
              }
              cli.stdout(`Deleting agent: ${args.name}`);
              cli.stdout(`Agent "${args.name}" deleted successfully`);
              break;
              
            default:
              throw new Error(`Unknown action: ${args.action}`);
          }
          
          return 0;
        },
      });
    });

    it('should create an agent with basic options', async () => {
      const exitCode = await cli.execute([
        'agent',
        '--action', 'create',
        '--name', 'test-agent'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Creating agent: test-agent');
      assertStringIncludes(output.stdout.join(' '), 'created successfully');
    });

    it('should create an agent with full configuration', async () => {
      const exitCode = await cli.execute([
        'agent',
        '--action', 'create',
        '--name', 'full-agent',
        '--role', 'analyzer',
        '--capabilities', 'code-analysis,testing,documentation'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Creating agent: full-agent');
      assertStringIncludes(output.stdout.join(' '), 'Role: analyzer');
      assertStringIncludes(output.stdout.join(' '), 'Capabilities: code-analysis,testing,documentation');
    });

    it('should list existing agents', async () => {
      const exitCode = await cli.execute(['agent', '--action', 'list']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Active agents:');
      assertStringIncludes(output.stdout.join(' '), 'agent-1');
      assertStringIncludes(output.stdout.join(' '), 'agent-2');
    });

    it('should delete an agent', async () => {
      const exitCode = await cli.execute([
        'agent',
        '--action', 'delete',
        '--name', 'old-agent'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Deleting agent: old-agent');
      assertStringIncludes(output.stdout.join(' '), 'deleted successfully');
    });

    it('should require name for create and delete actions', async () => {
      const createResult = await cli.execute(['agent', '--action', 'create']);
      assertEquals(createResult, 1);
      
      const deleteResult = await cli.execute(['agent', '--action', 'delete']);
      assertEquals(deleteResult, 1);
    });

    it('should handle unknown actions', async () => {
      const exitCode = await cli.execute(['agent', '--action', 'unknown']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 1);
      assertStringIncludes(output.stderr.join(' '), 'Unknown action: unknown');
    });
  });

  describe('Task Command', () => {
    beforeEach(() => {
      cli.command({
        name: 'task',
        description: 'Manage tasks',
        options: [
          { name: 'action', type: 'string', required: true, description: 'Action: run, list, cancel' },
          { name: 'command', type: 'string', description: 'Command to execute' },
          { name: 'agent', type: 'string', description: 'Target agent name' },
          { name: 'priority', type: 'string', description: 'Task priority', default: 'medium' },
          { name: 'timeout', type: 'number', description: 'Task timeout in seconds' },
          { name: 'id', type: 'string', description: 'Task ID' },
        ],
        handler: async (args) => {
          switch (args.action) {
            case 'run':
              if (!args.command) {
                throw new Error('Command is required for run action');
              }
              
              const taskId = `task-${Date.now()}`;
              cli.stdout(`Running task: ${taskId}`);
              cli.stdout(`Command: ${args.command}`);
              if (args.agent) cli.stdout(`Agent: ${args.agent}`);
              cli.stdout(`Priority: ${args.priority}`);
              if (args.timeout) cli.stdout(`Timeout: ${args.timeout}s`);
              
              // Simulate task execution
              cli.stdout('Task execution started...');
              await AsyncTestUtils.delay(100);
              cli.stdout('Task completed successfully');
              cli.stdout(`Result: Command executed: ${args.command}`);
              break;
              
            case 'list':
              cli.stdout('Active tasks:');
              cli.stdout('- task-001: Running command "echo hello" (agent: agent-1)');
              cli.stdout('- task-002: Completed command "ls -la" (agent: agent-2)');
              break;
              
            case 'cancel':
              if (!args.id) {
                throw new Error('Task ID is required for cancel action');
              }
              cli.stdout(`Cancelling task: ${args.id}`);
              cli.stdout(`Task ${args.id} cancelled successfully`);
              break;
              
            default:
              throw new Error(`Unknown action: ${args.action}`);
          }
          
          return 0;
        },
      });
    });

    it('should run a simple task', async () => {
      const exitCode = await cli.execute([
        'task',
        '--action', 'run',
        '--command', 'echo "Hello World"'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Running task:');
      assertStringIncludes(output.stdout.join(' '), 'Command: echo "Hello World"');
      assertStringIncludes(output.stdout.join(' '), 'completed successfully');
    });

    it('should run a task with full configuration', async () => {
      const exitCode = await cli.execute([
        'task',
        '--action', 'run',
        '--command', 'npm test',
        '--agent', 'test-agent',
        '--priority', 'high',
        '--timeout', '300'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Command: npm test');
      assertStringIncludes(output.stdout.join(' '), 'Agent: test-agent');
      assertStringIncludes(output.stdout.join(' '), 'Priority: high');
      assertStringIncludes(output.stdout.join(' '), 'Timeout: 300s');
    });

    it('should list active tasks', async () => {
      const exitCode = await cli.execute(['task', '--action', 'list']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Active tasks:');
      assertStringIncludes(output.stdout.join(' '), 'task-001');
      assertStringIncludes(output.stdout.join(' '), 'task-002');
    });

    it('should cancel a task', async () => {
      const exitCode = await cli.execute([
        'task',
        '--action', 'cancel',
        '--id', 'task-123'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Cancelling task: task-123');
      assertStringIncludes(output.stdout.join(' '), 'cancelled successfully');
    });

    it('should require command for run action', async () => {
      const exitCode = await cli.execute(['task', '--action', 'run']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 1);
      assertStringIncludes(output.stderr.join(' '), 'Command is required');
    });

    it('should require task ID for cancel action', async () => {
      const exitCode = await cli.execute(['task', '--action', 'cancel']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 1);
      assertStringIncludes(output.stderr.join(' '), 'Task ID is required');
    });
  });

  describe('Memory Command', () => {
    beforeEach(() => {
      cli.command({
        name: 'memory',
        description: 'Manage memory banks',
        options: [
          { name: 'action', type: 'string', required: true, description: 'Action: set, get, list, delete' },
          { name: 'key', type: 'string', description: 'Memory key' },
          { name: 'value', type: 'string', description: 'Memory value' },
          { name: 'namespace', type: 'string', description: 'Memory namespace', default: 'default' },
          { name: 'tags', type: 'string', description: 'Comma-separated tags' },
        ],
        handler: async (args) => {
          switch (args.action) {
            case 'set':
              if (!args.key || !args.value) {
                throw new Error('Key and value are required for set action');
              }
              cli.stdout(`Setting memory: ${args.namespace}:${args.key}`);
              cli.stdout(`Value: ${args.value}`);
              if (args.tags) cli.stdout(`Tags: ${args.tags}`);
              cli.stdout('Memory entry stored successfully');
              break;
              
            case 'get':
              if (!args.key) {
                throw new Error('Key is required for get action');
              }
              cli.stdout(`Retrieving memory: ${args.namespace}:${args.key}`);
              cli.stdout(`Value: example-value-for-${args.key}`);
              break;
              
            case 'list':
              cli.stdout(`Memory entries in namespace '${args.namespace}':`);
              cli.stdout('- key1: value1 [tags: test, example]');
              cli.stdout('- key2: value2 [tags: demo]');
              break;
              
            case 'delete':
              if (!args.key) {
                throw new Error('Key is required for delete action');
              }
              cli.stdout(`Deleting memory: ${args.namespace}:${args.key}`);
              cli.stdout('Memory entry deleted successfully');
              break;
              
            default:
              throw new Error(`Unknown action: ${args.action}`);
          }
          
          return 0;
        },
      });
    });

    it('should set a memory entry', async () => {
      const exitCode = await cli.execute([
        'memory',
        '--action', 'set',
        '--key', 'test-key',
        '--value', 'test-value'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Setting memory: default:test-key');
      assertStringIncludes(output.stdout.join(' '), 'Value: test-value');
      assertStringIncludes(output.stdout.join(' '), 'stored successfully');
    });

    it('should set a memory entry with namespace and tags', async () => {
      const exitCode = await cli.execute([
        'memory',
        '--action', 'set',
        '--key', 'project-key',
        '--value', 'project-value',
        '--namespace', 'project',
        '--tags', 'important,work'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Setting memory: project:project-key');
      assertStringIncludes(output.stdout.join(' '), 'Tags: important,work');
    });

    it('should retrieve a memory entry', async () => {
      const exitCode = await cli.execute([
        'memory',
        '--action', 'get',
        '--key', 'existing-key'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Retrieving memory: default:existing-key');
      assertStringIncludes(output.stdout.join(' '), 'Value: example-value-for-existing-key');
    });

    it('should list memory entries', async () => {
      const exitCode = await cli.execute(['memory', '--action', 'list']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Memory entries in namespace');
      assertStringIncludes(output.stdout.join(' '), 'key1: value1');
      assertStringIncludes(output.stdout.join(' '), 'key2: value2');
    });

    it('should delete a memory entry', async () => {
      const exitCode = await cli.execute([
        'memory',
        '--action', 'delete',
        '--key', 'old-key'
      ]);
      
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Deleting memory: default:old-key');
      assertStringIncludes(output.stdout.join(' '), 'deleted successfully');
    });

    it('should require key and value for set action', async () => {
      const exitCode1 = await cli.execute(['memory', '--action', 'set', '--key', 'test']);
      assertEquals(exitCode1, 1);
      
      cli.clearOutput();
      
      const exitCode2 = await cli.execute(['memory', '--action', 'set', '--value', 'test']);
      assertEquals(exitCode2, 1);
    });

    it('should require key for get and delete actions', async () => {
      const exitCode1 = await cli.execute(['memory', '--action', 'get']);
      assertEquals(exitCode1, 1);
      
      cli.clearOutput();
      
      const exitCode2 = await cli.execute(['memory', '--action', 'delete']);
      assertEquals(exitCode2, 1);
    });
  });

  describe('Global Options and Help', () => {
    beforeEach(() => {
      cli.command({
        name: 'help',
        description: 'Show help information',
        options: [
          { name: 'command', type: 'string', description: 'Command to get help for' },
        ],
        handler: async (args) => {
          if (args.command) {
            cli.stdout(`Help for command: ${args.command}`);
            cli.stdout('Usage, options, and examples would be shown here');
          } else {
            cli.stdout('Claude-Flow CLI');
            cli.stdout('Usage: claude-flow <command> [options]');
            cli.stdout('');
            cli.stdout('Commands:');
            cli.stdout('  start     Start the orchestrator');
            cli.stdout('  agent     Manage agents');
            cli.stdout('  task      Manage tasks');
            cli.stdout('  memory    Manage memory');
            cli.stdout('  help      Show help');
          }
          return 0;
        },
      });

      cli.command({
        name: 'version',
        description: 'Show version information',
        handler: async () => {
          cli.stdout('Claude-Flow v1.0.0');
          cli.stdout('Deno Runtime v1.40.0');
          cli.stdout('Build: 2024-01-01T00:00:00Z');
          return 0;
        },
      });
    });

    it('should show general help', async () => {
      const exitCode = await cli.execute(['help']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Claude-Flow CLI');
      assertStringIncludes(output.stdout.join(' '), 'Commands:');
      assertStringIncludes(output.stdout.join(' '), 'start');
      assertStringIncludes(output.stdout.join(' '), 'agent');
      assertStringIncludes(output.stdout.join(' '), 'task');
      assertStringIncludes(output.stdout.join(' '), 'memory');
    });

    it('should show command-specific help', async () => {
      const exitCode = await cli.execute(['help', '--command', 'start']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Help for command: start');
    });

    it('should show version information', async () => {
      const exitCode = await cli.execute(['version']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 0);
      assertStringIncludes(output.stdout.join(' '), 'Claude-Flow v1.0.0');
      assertStringIncludes(output.stdout.join(' '), 'Deno Runtime');
      assertStringIncludes(output.stdout.join(' '), 'Build:');
    });

    it('should handle unknown commands', async () => {
      const exitCode = await cli.execute(['unknown-command']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 1);
      assertStringIncludes(output.stderr.join(' '), 'Unknown command: unknown-command');
    });

    it('should handle invalid options', async () => {
      const exitCode = await cli.execute(['help', '--invalid-option', 'value']);
      const output = cli.getOutput();
      
      assertEquals(exitCode, 1);
      assertStringIncludes(output.stderr.join(' '), 'Unknown option: invalid-option');
    });
  });

  describe('CLI Integration Scenarios', () => {
    beforeEach(() => {
      // Set up all commands for integration testing
      const commands = [
        {
          name: 'start',
          description: 'Start orchestrator',
          handler: async () => { cli.stdout('Started'); return 0; },
        },
        {
          name: 'agent',
          description: 'Manage agents',
          options: [
            { name: 'action', type: 'string', required: true },
            { name: 'name', type: 'string' },
          ],
          handler: async (args) => {
            cli.stdout(`Agent ${args.action} ${args.name || ''}`);
            return 0;
          },
        },
        {
          name: 'task',
          description: 'Manage tasks',
          options: [
            { name: 'action', type: 'string', required: true },
            { name: 'command', type: 'string' },
          ],
          handler: async (args) => {
            cli.stdout(`Task ${args.action} ${args.command || ''}`);
            return 0;
          },
        },
      ];

      commands.forEach(cmd => cli.command(cmd as CLICommand));
    });

    it('should handle workflow scenarios', async () => {
      const scenarios = generateCLITestScenarios();
      
      for (const scenario of scenarios) {
        cli.clearOutput();
        
        const exitCode = await cli.execute(scenario.command);
        const output = cli.getOutput();
        
        assertEquals(exitCode, scenario.expectedExitCode);
        
        if (scenario.expectedOutput) {
          const outputText = output.stdout.join(' ');
          const errorText = output.stderr.join(' ');
          const allOutput = outputText + ' ' + errorText;
          
          assertStringIncludes(allOutput, scenario.expectedOutput);
        }
        
        console.log(`Scenario passed: ${scenario.command.join(' ')}`);
      }
    });

    it('should handle piped commands and complex workflows', async () => {
      // Simulate a complex workflow
      const workflow = [
        ['start'],
        ['agent', '--action', 'create', '--name', 'workflow-agent'],
        ['task', '--action', 'run', '--command', 'echo workflow-test'],
        ['agent', '--action', 'list'],
        ['task', '--action', 'list'],
      ];

      const results = [];
      
      for (const command of workflow) {
        cli.clearOutput();
        const exitCode = await cli.execute(command);
        const output = cli.getOutput();
        
        results.push({
          command,
          exitCode,
          output: output.stdout.concat(output.stderr),
        });
      }
      
      // All commands in workflow should succeed
      results.forEach(result => {
        assertEquals(result.exitCode, 0);
      });
      
      console.log(`Workflow completed with ${results.length} steps`);
    });

    it('should handle concurrent CLI operations', async () => {
      const concurrentCommands = [
        ['agent', '--action', 'create', '--name', 'concurrent-1'],
        ['agent', '--action', 'create', '--name', 'concurrent-2'],
        ['agent', '--action', 'create', '--name', 'concurrent-3'],
        ['task', '--action', 'run', '--command', 'echo concurrent-test-1'],
        ['task', '--action', 'run', '--command', 'echo concurrent-test-2'],
      ];

      const promises = concurrentCommands.map(async (command, index) => {
        // Create separate CLI instance for each concurrent operation
        const concurrentCLI = new MockCLI();
        
        // Set up commands
        concurrentCLI.command({
          name: 'agent',
          description: 'Manage agents',
          options: [
            { name: 'action', type: 'string', required: true },
            { name: 'name', type: 'string' },
          ],
          handler: async (args) => {
            await AsyncTestUtils.delay(Math.random() * 100); // Simulate processing time
            concurrentCLI.stdout(`Agent ${args.action} ${args.name || ''} (concurrent-${index})`);
            return 0;
          },
        });

        concurrentCLI.command({
          name: 'task',
          description: 'Manage tasks',
          options: [
            { name: 'action', type: 'string', required: true },
            { name: 'command', type: 'string' },
          ],
          handler: async (args) => {
            await AsyncTestUtils.delay(Math.random() * 100); // Simulate processing time
            concurrentCLI.stdout(`Task ${args.action} ${args.command || ''} (concurrent-${index})`);
            return 0;
          },
        });

        const exitCode = await concurrentCLI.execute(command);
        return { command, exitCode, output: concurrentCLI.getOutput() };
      });

      const results = await Promise.all(promises);
      
      // All concurrent operations should succeed
      results.forEach(result => {
        assertEquals(result.exitCode, 0);
        assertExists(result.output.stdout[0]);
      });
      
      console.log(`${results.length} concurrent CLI operations completed successfully`);
    });

    it('should handle error recovery in CLI workflows', async () => {
      // Simulate a workflow with intentional errors
      const errorWorkflow = [
        ['start'], // Should succeed
        ['agent', '--action', 'invalid'], // Should fail
        ['agent', '--action', 'create', '--name', 'recovery-agent'], // Should succeed
        ['task'], // Should fail (missing required options)
        ['task', '--action', 'run', '--command', 'echo recovery-test'], // Should succeed
      ];

      const expectedResults = [0, 1, 0, 1, 0]; // Expected exit codes
      const actualResults = [];
      
      for (const [index, command] of errorWorkflow.entries()) {
        cli.clearOutput();
        const exitCode = await cli.execute(command);
        actualResults.push(exitCode);
        
        console.log(`Step ${index + 1}: ${command.join(' ')} -> exit code ${exitCode}`);
      }
      
      assertEquals(actualResults, expectedResults);
      
      // Verify that successful commands completed despite intervening errors
      assertEquals(actualResults.filter(code => code === 0).length, 3);
      assertEquals(actualResults.filter(code => code === 1).length, 2);
    });
  });

  describe('Performance and Responsiveness', () => {
    beforeEach(() => {
      cli.command({
        name: 'perf-test',
        description: 'Performance test command',
        options: [
          { name: 'iterations', type: 'number', default: 100 },
          { name: 'delay', type: 'number', default: 0 },
        ],
        handler: async (args) => {
          for (let i = 0; i < args.iterations; i++) {
            if (args.delay > 0) {
              await AsyncTestUtils.delay(args.delay);
            }
            
            if (i % 10 === 0) {
              cli.stdout(`Progress: ${i}/${args.iterations}`);
            }
          }
          
          cli.stdout(`Performance test completed: ${args.iterations} iterations`);
          return 0;
        },
      });
    });

    it('should handle fast command execution', async () => {
      const { result, duration } = await PerformanceTestUtils.measureTime(async () => {
        return cli.execute(['perf-test', '--iterations', '10', '--delay', '0']);
      });
      
      assertEquals(result, 0);
      TestAssertions.assertInRange(duration, 0, 1000); // Should complete within 1 second
      
      console.log(`Fast CLI execution: ${duration.toFixed(2)}ms`);
    });

    it('should handle command timeouts gracefully', async () => {
      const timeoutPromise = AsyncTestUtils.withTimeout(
        cli.execute(['perf-test', '--iterations', '1000', '--delay', '10']),
        2000 // 2 second timeout
      );

      await TestAssertions.assertThrowsAsync(
        () => timeoutPromise,
        Error,
        'timeout'
      );
    });

    it('should handle multiple rapid commands', async () => {
      const rapidCommands = Array.from({ length: 20 }, (_, i) => 
        ['perf-test', '--iterations', '5', '--delay', '1']
      );

      const { stats } = await PerformanceTestUtils.benchmark(
        () => cli.execute(['perf-test', '--iterations', '5', '--delay', '1']),
        { iterations: 20, concurrency: 5 }
      );

      TestAssertions.assertInRange(stats.mean, 0, 200); // Should be reasonably fast
      
      console.log(`Rapid CLI commands: ${stats.mean.toFixed(2)}ms average`);
    });
  });
});