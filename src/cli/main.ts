#!/usr/bin/env -S deno run --allow-all
/**
 * Claude-Flow CLI - Main entry point
 */

import { CLI } from "./cli-core.ts";
import { setupCommands } from "./commands/index.ts";

const VERSION = "1.0.50";

async function main() {
  const cli = new CLI("claude-flow", "Advanced AI Agent Orchestration System");
  
  // Setup all commands
  setupCommands(cli);
  
  // Run the CLI
  await cli.run();
}

if (import.meta.main) {
  await main();
}