#!/usr/bin/env -S deno run --allow-all

/**
 * Test runner specifically for the init command tests
 * Runs all unit, integration, and performance tests for the init command
 */

import { parseArgs } from "@std/cli";
import { join } from "@std/path/mod.ts";
import { exists } from "@std/fs/mod.ts";

interface TestSuite {
  name: string;
  path: string;
  type: "unit" | "integration" | "performance";
  description: string;
}

const TEST_SUITES: TestSuite[] = [
  {
    name: "init-command",
    path: "tests/unit/cli/commands/init/init-command.test.ts",
    type: "unit",
    description: "Core init command functionality"
  },
  {
    name: "templates",
    path: "tests/unit/cli/commands/init/templates.test.ts",
    type: "unit",
    description: "Template generation and content validation"
  },
  {
    name: "sparc-structure",
    path: "tests/unit/cli/commands/init/sparc-structure.test.ts",
    type: "unit",
    description: "SPARC structure creation and validation"
  },
  {
    name: "validation",
    path: "tests/unit/cli/commands/init/validation.test.ts",
    type: "unit",
    description: "File integrity and configuration validation"
  },
  {
    name: "rollback",
    path: "tests/unit/cli/commands/init/rollback.test.ts",
    type: "unit",
    description: "Error handling and rollback functionality"
  },
  {
    name: "full-init-flow",
    path: "tests/integration/cli/init/full-init-flow.test.ts",
    type: "integration",
    description: "Complete initialization flow integration"
  },
  {
    name: "selective-modes",
    path: "tests/integration/cli/init/selective-modes.test.ts",
    type: "integration",
    description: "Selective mode initialization (minimal, SPARC, etc.)"
  },
  {
    name: "e2e-workflow",
    path: "tests/integration/cli/init/e2e-workflow.test.ts",
    type: "integration",
    description: "End-to-end workflow and real-world scenarios"
  },
  {
    name: "init-performance",
    path: "tests/performance/cli/init/init-performance.test.ts",
    type: "performance",
    description: "Performance and resource usage validation"
  }
];

async function runTests(
  suites: TestSuite[],
  options: {
    verbose?: boolean;
    coverage?: boolean;
    failFast?: boolean;
    parallel?: boolean;
  } = {}
): Promise<boolean> {
  console.log(`🧪 Running ${suites.length} test suite(s) for init command\n`);

  const results: Array<{ suite: TestSuite; success: boolean; duration: number; output: string }> = [];
  
  for (const suite of suites) {
    console.log(`📋 Running ${suite.name} (${suite.type}): ${suite.description}`);
    
    // Check if test file exists
    if (!await exists(suite.path)) {
      console.log(`   ❌ Test file not found: ${suite.path}`);
      results.push({ suite, success: false, duration: 0, output: "Test file not found" });
      if (options.failFast) break;
      continue;
    }

    const startTime = performance.now();
    
    const denoArgs = [
      "test",
      "--allow-all",
      "--no-check",
      suite.path
    ];

    if (options.coverage) {
      denoArgs.push("--coverage=coverage");
    }

    if (options.failFast) {
      denoArgs.push("--fail-fast");
    }

    const command = new Deno.Command("deno", {
      args: denoArgs,
      stdout: options.verbose ? "inherit" : "piped",
      stderr: options.verbose ? "inherit" : "piped"
    });

    try {
      const result = await command.output();
      const endTime = performance.now();
      const duration = endTime - startTime;

      const output = options.verbose ? "" : 
        new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);

      if (result.success) {
        console.log(`   ✅ Passed in ${duration.toFixed(2)}ms`);
      } else {
        console.log(`   ❌ Failed in ${duration.toFixed(2)}ms`);
        if (!options.verbose) {
          console.log(`   Error output:\n${output}`);
        }
      }

      results.push({ suite, success: result.success, duration, output });

      if (!result.success && options.failFast) {
        break;
      }
    } catch (error) {
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      console.log(`   ❌ Error running test: ${error.message}`);
      results.push({ 
        suite, 
        success: false, 
        duration, 
        output: `Error: ${error.message}` 
      });

      if (options.failFast) {
        break;
      }
    }
  }

  // Summary
  console.log("\n📊 Test Results Summary:");
  console.log("=" .repeat(60));

  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => r.success === false).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`Total suites: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total time: ${(totalDuration / 1000).toFixed(2)}s`);

  if (failed > 0) {
    console.log("\n❌ Failed test suites:");
    for (const result of results) {
      if (!result.success) {
        console.log(`   - ${result.suite.name}: ${result.suite.description}`);
      }
    }
  }

  // Generate coverage report if requested
  if (options.coverage && passed > 0) {
    console.log("\n📈 Generating coverage report...");
    try {
      const coverageCommand = new Deno.Command("deno", {
        args: ["coverage", "coverage", "--html"],
        stdout: "inherit",
        stderr: "inherit"
      });
      await coverageCommand.output();
      console.log("Coverage report generated in coverage/ directory");
    } catch (error) {
      console.log(`Error generating coverage: ${error.message}`);
    }
  }

  return failed === 0;
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "verbose", "coverage", "fail-fast", "unit", "integration", "performance", "list"],
    string: ["suite"],
    alias: {
      h: "help",
      v: "verbose",
      c: "coverage",
      f: "fail-fast",
      s: "suite",
      l: "list"
    }
  });

  if (args.help) {
    console.log(`
🧪 Init Command Test Runner

Usage: deno run --allow-all scripts/test-init-command.ts [options]

Options:
  -h, --help          Show this help message
  -v, --verbose       Show detailed test output
  -c, --coverage      Generate coverage report
  -f, --fail-fast     Stop on first failure
  -s, --suite <name>  Run specific test suite
  -l, --list          List available test suites
  --unit              Run only unit tests
  --integration       Run only integration tests
  --performance       Run only performance tests

Examples:
  ./scripts/test-init-command.ts                    # Run all tests
  ./scripts/test-init-command.ts --unit             # Run only unit tests
  ./scripts/test-init-command.ts --suite templates  # Run specific suite
  ./scripts/test-init-command.ts --coverage         # Run with coverage
    `);
    return;
  }

  if (args.list) {
    console.log("📋 Available test suites:\n");
    for (const suite of TEST_SUITES) {
      console.log(`  ${suite.name.padEnd(20)} (${suite.type.padEnd(11)}) - ${suite.description}`);
    }
    return;
  }

  let suitesToRun = TEST_SUITES;

  // Filter by type
  if (args.unit) {
    suitesToRun = suitesToRun.filter(suite => suite.type === "unit");
  } else if (args.integration) {
    suitesToRun = suitesToRun.filter(suite => suite.type === "integration");
  } else if (args.performance) {
    suitesToRun = suitesToRun.filter(suite => suite.type === "performance");
  }

  // Filter by specific suite
  if (args.suite) {
    const requestedSuite = suitesToRun.find(suite => suite.name === args.suite);
    if (!requestedSuite) {
      console.error(`❌ Test suite '${args.suite}' not found.`);
      console.log("\nAvailable suites:");
      for (const suite of TEST_SUITES) {
        console.log(`  - ${suite.name}`);
      }
      Deno.exit(1);
    }
    suitesToRun = [requestedSuite];
  }

  if (suitesToRun.length === 0) {
    console.error("❌ No test suites to run");
    Deno.exit(1);
  }

  console.log(`🚀 Claude Flow Init Command Test Suite`);
  console.log(`Running ${suitesToRun.length} test suite(s)\n`);

  const success = await runTests(suitesToRun, {
    verbose: args.verbose,
    coverage: args.coverage,
    failFast: args["fail-fast"]
  });

  if (success) {
    console.log("\n✅ All tests passed!");
    Deno.exit(0);
  } else {
    console.log("\n❌ Some tests failed!");
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}