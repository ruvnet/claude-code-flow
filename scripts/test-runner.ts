#!/usr/bin/env -S deno run --allow-all
/**
 * Comprehensive test runner for Claude-Flow
 * Runs all tests with coverage and generates reports
 */

import { parseArgs } from "https://deno.land/std@0.220.0/cli/parse_args.ts";
import { exists } from "https://deno.land/std@0.220.0/fs/exists.ts";
import { ensureDir } from "https://deno.land/std@0.220.0/fs/ensure_dir.ts";

interface TestSuite {
  name: string;
  pattern: string;
  description: string;
  timeout?: number;
  parallel?: boolean;
}

const TEST_SUITES: TestSuite[] = [
  {
    name: "unit",
    pattern: "tests/unit/**/*.test.ts",
    description: "Unit tests for individual components",
    timeout: 30000,
    parallel: true,
  },
  {
    name: "integration", 
    pattern: "tests/integration/**/*.test.ts",
    description: "Integration tests for component interactions",
    timeout: 60000,
    parallel: true,
  },
  {
    name: "e2e",
    pattern: "tests/e2e/**/*.test.ts", 
    description: "End-to-end CLI and workflow tests",
    timeout: 120000,
    parallel: false,
  },
];

interface TestOptions {
  suites: string[];
  coverage: boolean;
  watch: boolean;
  filter?: string;
  parallel: boolean;
  verbose: boolean;
  outputDir: string;
  failFast: boolean;
  updateSnapshots: boolean;
}

class TestRunner {
  private options: TestOptions;

  constructor(options: TestOptions) {
    this.options = options;
  }

  async run(): Promise<boolean> {
    console.log("🧪 Claude-Flow Test Runner");
    console.log("=".repeat(50));

    // Ensure output directory exists
    await ensureDir(this.options.outputDir);

    let allPassed = true;
    const results: Array<{ suite: string; passed: boolean; duration: number }> = [];

    // Run each test suite
    for (const suiteName of this.options.suites) {
      const suite = TEST_SUITES.find(s => s.name === suiteName);
      if (!suite) {
        console.error(`❌ Unknown test suite: ${suiteName}`);
        allPassed = false;
        continue;
      }

      console.log(`\n📋 Running ${suite.name} tests: ${suite.description}`);
      
      const startTime = Date.now();
      const passed = await this.runSuite(suite);
      const duration = Date.now() - startTime;
      
      results.push({ suite: suiteName, passed, duration });
      
      if (!passed) {
        allPassed = false;
        
        if (this.options.failFast) {
          console.log("\n💥 Fail-fast enabled, stopping test execution");
          break;
        }
      }
    }

    // Generate reports
    await this.generateReports(results);

    // Print summary
    this.printSummary(results, allPassed);

    return allPassed;
  }

  private async runSuite(suite: TestSuite): Promise<boolean> {
    const args = [
      "test",
      "--allow-all",
      "--unstable-temporal",
    ];

    // Add no-check if enabled
    if (this.options.noCheck) {
      args.push("--no-check");
    }

    // Note: Sanitizer options need to be set as test annotations in the test files

    // Add coverage if enabled
    if (this.options.coverage) {
      args.push("--coverage", `${this.options.outputDir}/coverage`);
    }

    // Add parallel execution
    if (this.options.parallel && suite.parallel) {
      args.push("--parallel");
    }

    // Note: Deno test doesn't support --timeout flag directly

    // Add filter if specified
    if (this.options.filter) {
      args.push("--filter", this.options.filter);
    }

    // Add verbose output
    if (this.options.verbose) {
      args.push("--verbose");
    }

    // Add fail-fast
    if (this.options.failFast) {
      args.push("--fail-fast");
    }

    // Add update snapshots
    if (this.options.updateSnapshots) {
      args.push("--update-snapshots");
    }

    // Add test pattern
    args.push(suite.pattern);

    console.log(`  Command: deno ${args.join(" ")}`);

    const command = new Deno.Command(Deno.execPath(), {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const start = Date.now();
    const { code, stdout, stderr } = await command.output();
    const duration = Date.now() - start;

    const output = new TextDecoder().decode(stdout);
    const errorOutput = new TextDecoder().decode(stderr);

    // Write output to files
    const suiteOutputFile = `${this.options.outputDir}/${suite.name}-output.txt`;
    await Deno.writeTextFile(suiteOutputFile, output);
    
    if (errorOutput) {
      const suiteErrorFile = `${this.options.outputDir}/${suite.name}-errors.txt`;
      await Deno.writeTextFile(suiteErrorFile, errorOutput);
    }

    // Print output in real-time if verbose
    if (this.options.verbose) {
      console.log(output);
      if (errorOutput) {
        console.error(errorOutput);
      }
    }

    const passed = code === 0;
    const status = passed ? "✅ PASSED" : "❌ FAILED";
    const durationStr = `${duration}ms`;
    
    console.log(`  ${status} (${durationStr})`);

    if (!passed && !this.options.verbose) {
      console.log("  Error output:");
      console.log(errorOutput);
    }

    return passed;
  }

  private async generateReports(results: Array<{ suite: string; passed: boolean; duration: number }>): Promise<void> {
    console.log("\n📊 Generating test reports...");

    // Generate coverage report if enabled
    if (this.options.coverage) {
      await this.generateCoverageReport();
    }

    // Generate JUnit XML report
    await this.generateJUnitReport(results);

    // Generate HTML report
    await this.generateHTMLReport(results);

    // Generate JSON report
    await this.generateJSONReport(results);
  }

  private async generateCoverageReport(): Promise<void> {
    const coverageDir = `${this.options.outputDir}/coverage`;
    
    if (await exists(coverageDir)) {
      console.log("  Generating coverage reports...");

      // Generate HTML coverage report
      const htmlCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "coverage",
          coverageDir,
          "--html",
          `--output=${this.options.outputDir}/coverage-html`,
        ],
        stdout: "piped",
        stderr: "piped",
      });

      await htmlCommand.output();

      // Generate LCOV coverage report
      const lcovCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "coverage",
          coverageDir,
          "--lcov",
          `--output=${this.options.outputDir}/coverage.lcov`,
        ],
        stdout: "piped", 
        stderr: "piped",
      });

      await lcovCommand.output();

      // Generate text coverage summary
      const textCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "coverage",
          coverageDir,
          "--detailed",
        ],
        stdout: "piped",
        stderr: "piped",
      });

      const { stdout } = await textCommand.output();
      const coverageSummary = new TextDecoder().decode(stdout);
      
      await Deno.writeTextFile(
        `${this.options.outputDir}/coverage-summary.txt`, 
        coverageSummary
      );

      console.log("  ✅ Coverage reports generated");
    }
  }

  private async generateJUnitReport(results: Array<{ suite: string; passed: boolean; duration: number }>): Promise<void> {
    const testsuites = results.map(result => {
      const errors = result.passed ? 0 : 1;
      const failures = result.passed ? 0 : 1;
      
      return `    <testsuite name="${result.suite}" tests="1" errors="${errors}" failures="${failures}" time="${result.duration / 1000}">
      <testcase name="${result.suite}-tests" classname="Claude-Flow.${result.suite}" time="${result.duration / 1000}">
        ${!result.passed ? '<failure message="Test suite failed" type="TestFailure">Test suite execution failed</failure>' : ''}
      </testcase>
    </testsuite>`;
    }).join('\n');

    const totalTests = results.length;
    const totalErrors = results.filter(r => !r.passed).length;
    const totalFailures = totalErrors;
    const totalTime = results.reduce((sum, r) => sum + r.duration, 0) / 1000;

    const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Claude-Flow" tests="${totalTests}" errors="${totalErrors}" failures="${totalFailures}" time="${totalTime}">
${testsuites}
</testsuites>`;

    await Deno.writeTextFile(`${this.options.outputDir}/junit.xml`, junit);
    console.log("  ✅ JUnit XML report generated");
  }

  private async generateHTMLReport(results: Array<{ suite: string; passed: boolean; duration: number }>): Promise<void> {
    const suiteRows = results.map(result => {
      const status = result.passed ? "✅ PASSED" : "❌ FAILED";
      const statusClass = result.passed ? "passed" : "failed";
      
      return `
        <tr class="${statusClass}">
          <td>${result.suite}</td>
          <td>${status}</td>
          <td>${result.duration}ms</td>
        </tr>`;
    }).join('');

    const totalTests = results.length;
    const passedTests = results.filter(r => r.passed).length;
    const failedTests = totalTests - passedTests;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
    const timestamp = new Date().toISOString();

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Claude-Flow Test Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .summary { display: flex; gap: 20px; margin-bottom: 20px; }
        .metric { background: white; padding: 15px; border-radius: 5px; border: 1px solid #ddd; text-align: center; }
        .metric h3 { margin: 0; color: #333; }
        .metric .value { font-size: 24px; font-weight: bold; margin: 10px 0; }
        .passed .value { color: #28a745; }
        .failed .value { color: #dc3545; }
        .total .value { color: #007bff; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background-color: #f8f9fa; }
        .passed { background-color: #d4edda; }
        .failed { background-color: #f8d7da; }
        .footer { margin-top: 30px; text-align: center; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🧪 Claude-Flow Test Report</h1>
        <p>Generated on: ${timestamp}</p>
    </div>
    
    <div class="summary">
        <div class="metric total">
            <h3>Total Tests</h3>
            <div class="value">${totalTests}</div>
        </div>
        <div class="metric passed">
            <h3>Passed</h3>
            <div class="value">${passedTests}</div>
        </div>
        <div class="metric failed">
            <h3>Failed</h3>
            <div class="value">${failedTests}</div>
        </div>
        <div class="metric total">
            <h3>Duration</h3>
            <div class="value">${totalDuration}ms</div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Test Suite</th>
                <th>Status</th>
                <th>Duration</th>
            </tr>
        </thead>
        <tbody>
            ${suiteRows}
        </tbody>
    </table>

    <div class="footer">
        <p>Claude-Flow Test Suite - Advanced AI Agent Orchestration System</p>
    </div>
</body>
</html>`;

    await Deno.writeTextFile(`${this.options.outputDir}/report.html`, html);
    console.log("  ✅ HTML report generated");
  }

  private async generateJSONReport(results: Array<{ suite: string; passed: boolean; duration: number }>): Promise<void> {
    const report = {
      timestamp: new Date().toISOString(),
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      duration: results.reduce((sum, r) => sum + r.duration, 0),
      suites: results,
      environment: {
        deno: Deno.version.deno,
        v8: Deno.version.v8,
        typescript: Deno.version.typescript,
        platform: Deno.build.os,
        arch: Deno.build.arch,
      },
      options: this.options,
    };

    await Deno.writeTextFile(
      `${this.options.outputDir}/report.json`, 
      JSON.stringify(report, null, 2)
    );
    console.log("  ✅ JSON report generated");
  }

  private printSummary(results: Array<{ suite: string; passed: boolean; duration: number }>, allPassed: boolean): void {
    console.log("\n" + "=".repeat(50));
    console.log("📊 TEST SUMMARY");
    console.log("=".repeat(50));

    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = total - passed;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    console.log(`Total Suites: ${total}`);
    console.log(`Passed: ${passed} ✅`);
    console.log(`Failed: ${failed} ${failed > 0 ? '❌' : '✅'}`);
    console.log(`Total Duration: ${totalDuration}ms`);

    if (this.options.coverage) {
      console.log(`Coverage Report: ${this.options.outputDir}/coverage-html/index.html`);
    }

    console.log(`Detailed Report: ${this.options.outputDir}/report.html`);

    const overallStatus = allPassed ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED";
    console.log(`\n${overallStatus}`);
    
    if (!allPassed) {
      console.log("\nFailed suites:");
      results.filter(r => !r.passed).forEach(r => {
        console.log(`  - ${r.suite}`);
      });
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["suites", "filter", "output-dir"],
    boolean: [
      "coverage", 
      "watch", 
      "parallel", 
      "verbose", 
      "fail-fast", 
      "update-snapshots",
      "help"
    ],
    default: {
      suites: "unit,integration,e2e",
      coverage: true,
      watch: false,
      parallel: true,
      verbose: false,
      "fail-fast": false,
      "update-snapshots": false,
      "output-dir": "./test-results",
    },
    alias: {
      h: "help",
      c: "coverage",
      w: "watch",
      p: "parallel",
      v: "verbose",
      f: "filter",
      o: "output-dir",
    },
  });

  if (args.help) {
    console.log(`
🧪 Claude-Flow Test Runner

USAGE:
  test-runner.ts [OPTIONS]

OPTIONS:
  --suites, -s      Test suites to run (comma-separated)
                    Available: ${TEST_SUITES.map(s => s.name).join(", ")}
                    Default: unit,integration,e2e

  --coverage, -c    Generate coverage reports (default: true)
  --watch, -w       Watch mode for continuous testing
  --parallel, -p    Run tests in parallel (default: true)
  --verbose, -v     Verbose output
  --fail-fast       Stop on first failure
  --filter, -f      Filter tests by pattern
  --output-dir, -o  Output directory for reports (default: ./test-results)
  --update-snapshots Update test snapshots
  --help, -h        Show this help

EXAMPLES:
  # Run all tests with coverage
  ./scripts/test-runner.ts

  # Run only unit tests
  ./scripts/test-runner.ts --suites unit

  # Run tests with filter
  ./scripts/test-runner.ts --filter "orchestrator"

  # Run in watch mode
  ./scripts/test-runner.ts --watch --suites unit

  # Run without coverage
  ./scripts/test-runner.ts --no-coverage
`);
    return;
  }

  const options: TestOptions = {
    suites: args.suites.split(",").map(s => s.trim()),
    coverage: args.coverage,
    watch: args.watch,
    filter: args.filter,
    parallel: args.parallel,
    verbose: args.verbose,
    outputDir: args["output-dir"],
    failFast: args["fail-fast"],
    updateSnapshots: args["update-snapshots"],
    noCheck: args["no-check"],
  };

  // Validate suites
  const validSuites = TEST_SUITES.map(s => s.name);
  const invalidSuites = options.suites.filter(s => !validSuites.includes(s));
  
  if (invalidSuites.length > 0) {
    console.error(`❌ Invalid test suites: ${invalidSuites.join(", ")}`);
    console.error(`Available suites: ${validSuites.join(", ")}`);
    Deno.exit(1);
  }

  const runner = new TestRunner(options);

  if (options.watch) {
    console.log("👀 Watch mode enabled - tests will re-run on file changes");
    
    // Simple watch implementation
    const watcher = Deno.watchFs(["./src", "./tests"], { recursive: true });
    
    // Run tests initially
    await runner.run();
    
    for await (const event of watcher) {
      if (event.kind === "modify" && event.paths.some(p => p.endsWith(".ts"))) {
        console.log("\n🔄 Files changed, re-running tests...");
        await runner.run();
      }
    }
  } else {
    const success = await runner.run();
    Deno.exit(success ? 0 : 1);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error("❌ Test runner failed:", error);
    Deno.exit(1);
  });
}