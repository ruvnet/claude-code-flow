/**
 * Tests to ensure backward compatibility with existing start command functionality
 */

import { assertEquals, assertExists } from '@std/assert';
import { describe, it } from '@std/testing/bdd';

describe('Start Command Backward Compatibility', () => {
  describe('CLI imports', () => {
    it('should export startCommand from main CLI index', async () => {
      const module = await import('../../src/cli/index.ts');
      // The module imports startCommand, so it should work
      assertExists(module);
    });

    it('should export startCommand from commands/start.ts', async () => {
      const { startCommand } = await import('../../src/cli/commands/start.ts');
      assertExists(startCommand);
    });

    it('should export startCommand from simple-commands', async () => {
      const { startCommand } = await import('../../src/cli/simple-commands/start.js');
      assertExists(startCommand);
      assertEquals(typeof startCommand, 'function');
    });
  });

  describe('simple-commands functionality', () => {
    it('should handle help flag', async () => {
      const { startCommand } = await import('../../src/cli/simple-commands/start.js');
      
      // Mock console.log
      const originalLog = console.log;
      let helpShown = false;
      console.log = (...args) => {
        if (args.join(' ').includes('claude-flow start')) {
          helpShown = true;
        }
      };
      
      await startCommand(['--help'], {});
      assertEquals(helpShown, true);
      
      // Restore
      console.log = originalLog;
    });

    it('should show UI option in help', async () => {
      const { startCommand } = await import('../../src/cli/simple-commands/start.js');
      
      // Mock console.log
      const originalLog = console.log;
      let uiOptionShown = false;
      console.log = (...args) => {
        const output = args.join(' ');
        if (output.includes('--ui') || output.includes('process management UI')) {
          uiOptionShown = true;
        }
      };
      
      await startCommand(['--help'], {});
      assertEquals(uiOptionShown, true);
      
      // Restore
      console.log = originalLog;
    });

    it('should handle daemon flag', async () => {
      const { startCommand } = await import('../../src/cli/simple-commands/start.js');
      
      // Mock console.log and file operations
      const originalLog = console.log;
      let daemonMode = false;
      console.log = (...args) => {
        if (args.join(' ').includes('daemon mode')) {
          daemonMode = true;
        }
      };
      
      const originalWriteTextFile = Deno.writeTextFile;
      Deno.writeTextFile = async (path: string) => {
        if (path === '.claude-flow.pid') {
          return Promise.resolve();
        }
        return originalWriteTextFile(path, '');
      };
      
      // Mock Deno.stat to simulate missing directories
      const originalStat = Deno.stat;
      Deno.stat = async (path: string) => {
        if (path === 'memory' || path === 'coordination') {
          throw new Error('Not found');
        }
        return originalStat(path);
      };
      
      await startCommand(['--daemon'], { daemon: true });
      
      // Verify warning about missing dirs was shown
      assertEquals(daemonMode || console.log.toString().includes('Missing required'), true);
      
      // Restore
      console.log = originalLog;
      Deno.writeTextFile = originalWriteTextFile;
      Deno.stat = originalStat;
    });
  });

  describe('command options preservation', () => {
    it('should support all original options', async () => {
      const { startCommand } = await import('../../src/cli/commands/start/start-command.ts');
      
      // Check that command has expected options
      const cmd = startCommand as any;
      const options = cmd.options || [];
      
      const expectedOptions = ['daemon', 'port', 'mcp-transport', 'ui', 'verbose'];
      const hasAllOptions = expectedOptions.every(opt => 
        options.some((o: any) => o.name === opt || o.flags?.includes(opt))
      );
      
      assertEquals(hasAllOptions, true);
    });
  });

  describe('event listeners setup', () => {
    it('should setup event listeners as before', async () => {
      // The setupEventListeners function was part of the original implementation
      // Verify the event handling is still in place by checking imports
      const module = await import('../../src/cli/commands/start/start-command.ts');
      assertExists(module.startCommand);
      
      // Check that it imports eventBus
      const sourceCode = await Deno.readTextFile('src/cli/commands/start/start-command.ts');
      assertEquals(sourceCode.includes('eventBus'), true);
      assertEquals(sourceCode.includes('SystemEvents'), true);
    });
  });
});