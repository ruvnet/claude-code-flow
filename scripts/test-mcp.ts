#!/usr/bin/env -S deno run --allow-all

/**
 * MCP Test Runner
 * Comprehensive test suite for the MCP implementation
 */

import { parseArgs } from '@std/cli';
import { join } from '@std/path';

interface TestConfig {
  unit: boolean;
  integration: boolean;
  coverage: boolean;
  watch: boolean;
  filter?: string;
  verbose: boolean;
}

async function runTests(config: TestConfig): Promise<void> {
  const testFiles: string[] = [];
  
  if (config.unit) {
    console.log('🔍 Discovering unit tests...');
    const unitTests = await discoverTests('tests/unit', config.filter);
    testFiles.push(...unitTests);
  }
  
  if (config.integration) {
    console.log('🔍 Discovering integration tests...');
    const integrationTests = await discoverTests('tests/integration', config.filter);
    testFiles.push(...integrationTests);
  }
  
  if (testFiles.length === 0) {
    console.log('❌ No test files found');
    Deno.exit(1);
  }
  
  console.log(`📋 Found ${testFiles.length} test files:`);
  for (const file of testFiles) {
    console.log(`  - ${file}`);
  }
  console.log();
  
  // Build Deno test command
  const args = [
    'test',
    '--allow-all',
    '--unstable',
    ...testFiles,
  ];
  
  if (config.coverage) {
    args.push('--coverage=coverage');
  }
  
  if (config.watch) {
    args.push('--watch');
  }
  
  if (config.verbose) {
    args.push('--verbose');
  }
  
  console.log('🧪 Running tests...');
  console.log(`Command: deno ${args.join(' ')}`);
  console.log();
  
  const process = new Deno.Command('deno', {
    args,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  
  const { code } = await process.output();
  
  if (config.coverage && code === 0) {
    console.log('\n📊 Generating coverage report...');
    
    const coverageProcess = new Deno.Command('deno', {
      args: ['coverage', '--html', 'coverage'],
      stdout: 'inherit',
      stderr: 'inherit',
    });
    
    await coverageProcess.output();
    console.log('Coverage report generated in coverage/html/');
  }
  
  if (code !== 0) {
    console.log('\n❌ Tests failed');
    Deno.exit(code);
  }
  
  console.log('\n✅ All tests passed!');
}

async function discoverTests(baseDir: string, filter?: string): Promise<string[]> {
  const testFiles: string[] = [];
  
  try {
    for await (const entry of Deno.readDir(baseDir)) {
      if (entry.isDirectory) {
        const subDirTests = await discoverTests(
          join(baseDir, entry.name),
          filter
        );
        testFiles.push(...subDirTests);
      } else if (entry.name.endsWith('.test.ts')) {
        const filePath = join(baseDir, entry.name);
        
        if (!filter || filePath.includes(filter)) {
          testFiles.push(filePath);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  
  return testFiles;
}

async function validateEnvironment(): Promise<void> {
  console.log('🔧 Validating environment...');
  
  // Check Deno version
  const { code, stdout } = await new Deno.Command('deno', {
    args: ['--version'],
    stdout: 'piped',
  }).output();
  
  if (code !== 0) {
    console.error('❌ Deno not found');
    Deno.exit(1);
  }
  
  const versionOutput = new TextDecoder().decode(stdout);
  console.log(`✅ ${versionOutput.split('\n')[0]}`);
  
  // Check required files exist
  const requiredFiles = [
    'src/mcp/server.ts',
    'src/mcp/tools.ts',
    'src/mcp/transports/stdio.ts',
    'src/mcp/transports/http.ts',
    'src/mcp/session-manager.ts',
    'src/mcp/auth.ts',
    'src/mcp/load-balancer.ts',
  ];
  
  for (const file of requiredFiles) {
    try {
      await Deno.stat(file);
      console.log(`✅ ${file}`);
    } catch {
      console.error(`❌ Missing required file: ${file}`);
      Deno.exit(1);
    }
  }
  
  console.log();
}

function printUsage(): void {
  console.log(`
MCP Test Runner

Usage: deno run --allow-all scripts/test-mcp.ts [options]

Options:
  --unit            Run unit tests (default: true if no other type specified)
  --integration     Run integration tests
  --all             Run all tests (unit + integration)
  --coverage        Generate coverage report
  --watch           Watch files and re-run tests on changes
  --filter <term>   Filter test files by name
  --verbose         Verbose test output
  --help, -h        Show this help message

Examples:
  deno run --allow-all scripts/test-mcp.ts
  deno run --allow-all scripts/test-mcp.ts --all --coverage
  deno run --allow-all scripts/test-mcp.ts --integration
  deno run --allow-all scripts/test-mcp.ts --filter server
  deno run --allow-all scripts/test-mcp.ts --watch --verbose
`);
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: [
      'unit',
      'integration',
      'all',
      'coverage',
      'watch',
      'verbose',
      'help',
      'h',
    ],
    string: [
      'filter',
    ],
    alias: {
      h: 'help',
    },
  });
  
  if (args.help || args.h) {
    printUsage();
    return;
  }
  
  await validateEnvironment();
  
  const config: TestConfig = {
    unit: args.unit || args.all || (!args.integration && !args.all),
    integration: args.integration || args.all,
    coverage: args.coverage,
    watch: args.watch,
    filter: args.filter,
    verbose: args.verbose,
  };
  
  console.log('⚙️  Test Configuration:');
  console.log(`  Unit tests: ${config.unit}`);
  console.log(`  Integration tests: ${config.integration}`);
  console.log(`  Coverage: ${config.coverage}`);
  console.log(`  Watch mode: ${config.watch}`);
  console.log(`  Filter: ${config.filter || 'none'}`);
  console.log(`  Verbose: ${config.verbose}`);
  console.log();
  
  await runTests(config);
}

// Performance monitoring
const startTime = performance.now();

process.on?.('exit', () => {
  const duration = performance.now() - startTime;
  console.log(`\n⏱️  Total execution time: ${(duration / 1000).toFixed(2)}s`);
});

if (import.meta.main) {
  await main();
}