#!/usr/bin/env -S deno run --allow-all
/**
 * Test script for Claude Swarm Mode functionality
 */

import { colors } from '@cliffy/ansi/colors';

async function runTest(name: string, command: string[], expectedPatterns: string[]): Promise<boolean> {
  console.log(colors.blue(`\nTesting: ${name}`));
  console.log(colors.gray(`Command: ${command.join(' ')}`));
  
  try {
    const cmd = new Deno.Command(command[0], {
      args: command.slice(1),
      stdout: 'piped',
      stderr: 'piped',
    });
    
    const { code, stdout, stderr } = await cmd.output();
    const output = new TextDecoder().decode(stdout);
    const errorOutput = new TextDecoder().decode(stderr);
    
    if (code !== 0 && !name.includes("dry-run")) {
      console.log(colors.red(`❌ Command failed with code ${code}`));
      if (errorOutput) {
        console.log(colors.red(`Error: ${errorOutput}`));
      }
      return false;
    }
    
    // Check for expected patterns in output
    let allPatternsFound = true;
    for (const pattern of expectedPatterns) {
      if (!output.includes(pattern)) {
        console.log(colors.red(`❌ Expected pattern not found: "${pattern}"`));
        allPatternsFound = false;
      }
    }
    
    if (allPatternsFound) {
      console.log(colors.green(`✅ Test passed`));
      return true;
    } else {
      console.log(colors.red(`❌ Test failed`));
      console.log(colors.gray(`Output: ${output.substring(0, 200)}...`));
      return false;
    }
    
  } catch (error) {
    console.log(colors.red(`❌ Error running test: ${(error as Error).message}`));
    return false;
  }
}

async function main() {
  console.log(colors.bold('Claude-Flow Swarm Mode Test Suite'));
  console.log('='.repeat(50));
  
  const tests = [
    {
      name: "Swarm demo dry-run",
      command: ["./swarm-demo.ts", "Build a REST API", "--dry-run"],
      patterns: ["DRY RUN", "Swarm ID:", "Objective: Build a REST API"],
    },
    {
      name: "CLI swarm command dry-run",
      command: ["deno", "run", "--allow-all", "./src/cli/main.ts", "swarm", "Test objective", "--dry-run"],
      patterns: ["DRY RUN", "Swarm ID:", "Objective: Test objective"],
    },
    {
      name: "CLI swarm help",
      command: ["deno", "run", "--allow-all", "./src/cli/main.ts", "help", "swarm"],
      patterns: ["Claude Swarm Mode", "self-orchestrating Claude agent swarms"],
    },
    {
      name: "Swarm with research strategy",
      command: ["./swarm-demo.ts", "Research test", "--strategy", "research", "--dry-run"],
      patterns: ["Strategy: research", "DRY RUN"],
    },
    {
      name: "Swarm with all options",
      command: [
        "./swarm-demo.ts", 
        "Complex task", 
        "--max-agents", "10",
        "--max-depth", "4",
        "--research",
        "--parallel",
        "--review",
        "--coordinator",
        "--dry-run"
      ],
      patterns: [
        "Max Agents: 10",
        "Max Depth: 4",
        "Research: true",
        "Parallel: true",
        "Review Mode: true",
        "Coordinator: true"
      ],
    },
  ];
  
  let passedTests = 0;
  let failedTests = 0;
  
  for (const test of tests) {
    const passed = await runTest(test.name, test.command, test.patterns);
    if (passed) {
      passedTests++;
    } else {
      failedTests++;
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log(colors.bold('Test Summary:'));
  console.log(colors.green(`✅ Passed: ${passedTests}`));
  console.log(colors.red(`❌ Failed: ${failedTests}`));
  console.log(colors.blue(`📊 Total: ${tests.length}`));
  
  if (failedTests === 0) {
    console.log(colors.green('\n🎉 All tests passed!'));
  } else {
    console.log(colors.red('\n⚠️  Some tests failed'));
  }
  
  // Additional manual test instructions
  console.log('\n' + colors.bold('Manual Testing Instructions:'));
  console.log('1. Test with actual Claude CLI (if available):');
  console.log('   ./swarm-demo.ts "Build a simple calculator"');
  console.log('   ./bin/claude-flow swarm "Create a REST API"');
  console.log('\n2. Test various strategies:');
  console.log('   ./swarm-demo.ts "Research best practices" --strategy research');
  console.log('   ./swarm-demo.ts "Implement feature" --strategy development');
  console.log('\n3. Test complex scenarios:');
  console.log('   ./swarm-demo.ts "Migrate to microservices" --coordinator --review --parallel');
}

if (import.meta.main) {
  await main();
}