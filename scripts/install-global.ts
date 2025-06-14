#!/usr/bin/env -S deno run --allow-all

/**
 * Global installation script for Claude-Flow
 * Creates a proper wrapper that includes config
 */

import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const HOME = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
const DENO_BIN = join(HOME, ".deno", "bin");
const WRAPPER_PATH = join(DENO_BIN, "claude-flow");

// Get the project root directory
const scriptDir = new URL(".", import.meta.url).pathname;
const projectRoot = join(scriptDir, "..");

// Create wrapper script that includes config
const wrapperScript = `#!/usr/bin/env bash

# Claude-Flow global wrapper
# This script ensures the config file is loaded when running globally

# Get the installation directory
INSTALL_DIR="${projectRoot}"

# Run with config file
exec deno run --allow-all --config "$INSTALL_DIR/deno.json" "$INSTALL_DIR/src/cli/main.ts" "$@"
`;

try {
  // Ensure bin directory exists
  await Deno.mkdir(DENO_BIN, { recursive: true });
  
  // Write the wrapper script
  await Deno.writeTextFile(WRAPPER_PATH, wrapperScript);
  
  // Make it executable
  if (Deno.build.os !== "windows") {
    await Deno.chmod(WRAPPER_PATH, 0o755);
  }
  
  console.log(`✅ Successfully installed claude-flow to ${WRAPPER_PATH}`);
  console.log(`\nℹ️  Make sure ${DENO_BIN} is in your PATH:`);
  console.log(`    export PATH="${DENO_BIN}:$PATH"`);
  
} catch (error) {
  console.error("❌ Installation failed:", error);
  Deno.exit(1);
}