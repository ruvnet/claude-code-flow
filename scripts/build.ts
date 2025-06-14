#!/usr/bin/env -S deno run --allow-all

/**
 * Build script for Claude-Flow
 * Creates executable wrapper scripts instead of using deno compile
 */

import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const VERSION = "1.0.49";

async function build() {
  console.log(`🔨 Building Claude-Flow v${VERSION}...`);

  // Ensure bin directory exists
  await ensureDir("bin");

  // Create the main wrapper script
  const wrapperScript = `#!/usr/bin/env bash

# Claude-Flow v${VERSION}
# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Run the CLI using deno
exec deno run --allow-all "$PROJECT_ROOT/src/cli/main.ts" "$@"`;

  // Write the wrapper script
  await Deno.writeTextFile("bin/claude-flow", wrapperScript);
  
  // Make it executable
  if (Deno.build.os !== "windows") {
    await Deno.chmod("bin/claude-flow", 0o755);
  }

  // Create additional wrappers for the other CLI variants
  const variants = [
    { name: "claude-flow-dev", entry: "src/cli/index.ts" },
    { name: "claude-flow-swarm", entry: "src/cli/simple-cli.ts" },
    { name: "claude-flow-swarm-monitor", entry: "src/coordination/swarm-monitor-ui.ts" },
    { name: "claude-flow-swarm-ui", entry: "src/coordination/swarm-ui.ts" }
  ];

  for (const variant of variants) {
    const variantScript = `#!/usr/bin/env bash

# Claude-Flow ${variant.name} v${VERSION}
# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Run the CLI using deno
exec deno run --allow-all "$PROJECT_ROOT/${variant.entry}" "$@"`;

    await Deno.writeTextFile(join("bin", variant.name), variantScript);
    
    if (Deno.build.os !== "windows") {
      await Deno.chmod(join("bin", variant.name), 0o755);
    }
  }

  console.log("✅ Build completed successfully!");
  console.log("\nCreated executables:");
  console.log("  - bin/claude-flow");
  for (const variant of variants) {
    console.log(`  - bin/${variant.name}`);
  }
  console.log("\nYou can now run: ./bin/claude-flow --help");
}

// Run build
if (import.meta.main) {
  try {
    await build();
  } catch (error) {
    console.error("❌ Build failed:", error);
    Deno.exit(1);
  }
}