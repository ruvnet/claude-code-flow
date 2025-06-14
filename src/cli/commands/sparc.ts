import { success, error, warning, info, type CommandContext } from "../cli-utils.ts";
import { blue, yellow, green, magenta, cyan } from "https://deno.land/std@0.224.0/fmt/colors.ts";

interface SparcMode {
  slug: string;
  name: string;
  roleDefinition: string;
  customInstructions: string;
  groups: string[];
  source: string;
}

interface SparcConfig {
  customModes: SparcMode[];
}

let sparcConfig: SparcConfig | null = null;

async function loadSparcConfig(): Promise<SparcConfig> {
  if (sparcConfig) {
    return sparcConfig;
  }

  try {
    const configPath = ".roomodes";
    const content = await Deno.readTextFile(configPath);
    sparcConfig = JSON.parse(content);
    return sparcConfig!;
  } catch (error) {
    throw new Error(`Failed to load SPARC configuration: ${(error as Error).message}`);
  }
}

export async function sparcAction(ctx: CommandContext): Promise<void> {
  const subcommand = ctx.args[0];

  switch (subcommand) {
    case "modes":
      await listSparcModes(ctx);
      break;
    case "info":
      await showModeInfo(ctx);
      break;
    case "run":
      await runSparcMode(ctx);
      break;
    case "tdd":
      await runTddFlow(ctx);
      break;
    case "workflow":
      await runSparcWorkflow(ctx);
      break;
    default:
      await showSparcHelp();
      break;
  }
}

async function listSparcModes(ctx: CommandContext): Promise<void> {
  try {
    const config = await loadSparcConfig();
    const verbose = ctx.flags.verbose as boolean;

    success("Available SPARC Modes:");
    console.log();

    for (const mode of config.customModes) {
      console.log(`${cyan("•")} ${green(mode.name)} ${blue(`(${mode.slug})`)}`);
      if (verbose) {
        console.log(`  ${mode.roleDefinition}`);
        console.log(`  Tools: ${mode.groups.join(", ")}`);
        console.log();
      }
    }

    if (!verbose) {
      console.log();
      info("Use --verbose for detailed descriptions");
    }
  } catch (err) {
    error(`Failed to list SPARC modes: ${(err as Error).message}`);
  }
}

async function showModeInfo(ctx: CommandContext): Promise<void> {
  const modeSlug = ctx.args[1];
  if (!modeSlug) {
    error("Usage: sparc info <mode-slug>");
    return;
  }

  try {
    const config = await loadSparcConfig();
    const mode = config.customModes.find(m => m.slug === modeSlug);

    if (!mode) {
      error(`Mode not found: ${modeSlug}`);
      console.log("Available modes:");
      for (const m of config.customModes) {
        console.log(`  ${m.slug} - ${m.name}`);
      }
      return;
    }

    success(`SPARC Mode: ${mode.name}`);
    console.log();
    console.log(blue("Role Definition:"));
    console.log(mode.roleDefinition);
    console.log();
    console.log(blue("Custom Instructions:"));
    console.log(mode.customInstructions);
    console.log();
    console.log(blue("Tool Groups:"));
    console.log(mode.groups.join(", "));
    console.log();
    console.log(blue("Source:"));
    console.log(mode.source);

  } catch (err) {
    error(`Failed to show mode info: ${(err as Error).message}`);
  }
}

async function runSparcMode(ctx: CommandContext): Promise<void> {
  const modeSlug = ctx.args[1];
  const taskDescription = ctx.args.slice(2).join(" ");

  if (!modeSlug || !taskDescription) {
    error("Usage: sparc run <mode-slug> <task-description>");
    return;
  }

  try {
    const config = await loadSparcConfig();
    const mode = config.customModes.find(m => m.slug === modeSlug);

    if (!mode) {
      error(`Mode not found: ${modeSlug}`);
      return;
    }

    // Build the enhanced task prompt using SPARC methodology
    const enhancedTask = buildSparcPrompt(mode, taskDescription, ctx.flags);
    const instanceId = `sparc-${modeSlug}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Build tools based on mode groups
    const tools = buildToolsFromGroups(mode.groups);

    if (ctx.flags.dryRun || ctx.flags["dry-run"]) {
      warning("DRY RUN - SPARC Mode Configuration:");
      console.log(`Mode: ${mode.name} (${mode.slug})`);
      console.log(`Instance ID: ${instanceId}`);
      console.log(`Tools: ${tools}`);
      console.log(`Task: ${taskDescription}`);
      console.log();
      console.log("Enhanced prompt preview:");
      console.log(enhancedTask.substring(0, 300) + "...");
      return;
    }

    success(`Starting SPARC mode: ${mode.name}`);
    console.log(`📝 Instance ID: ${instanceId}`);
    console.log(`🎯 Mode: ${mode.slug}`);
    console.log(`🔧 Tools: ${tools}`);
    console.log(`📋 Task: ${taskDescription}`);
    console.log();

    // Execute Claude with SPARC configuration
    await executeClaudeWithSparc(enhancedTask, tools, instanceId, ctx.flags);

  } catch (err) {
    error(`Failed to run SPARC mode: ${(err as Error).message}`);
  }
}

async function runTddFlow(ctx: CommandContext): Promise<void> {
  const taskDescription = ctx.args.slice(1).join(" ");

  if (!taskDescription) {
    error("Usage: sparc tdd <task-description>");
    return;
  }

  try {
    const config = await loadSparcConfig();

    // Build TDD workflow using SPARC methodology
    const workflow = [
      { mode: "spec-pseudocode", phase: "Specification", description: `Create detailed spec and pseudocode for: ${taskDescription}` },
      { mode: "tdd", phase: "Red", description: `Write failing tests for: ${taskDescription}` },
      { mode: "code", phase: "Green", description: `Implement minimal code to pass tests for: ${taskDescription}` },
      { mode: "refinement-optimization-mode", phase: "Refactor", description: `Refactor and optimize implementation for: ${taskDescription}` },
      { mode: "integration", phase: "Integration", description: `Integrate and verify complete solution for: ${taskDescription}` }
    ];

    if (ctx.flags.dryRun || ctx.flags["dry-run"]) {
      warning("DRY RUN - TDD Workflow:");
      for (const step of workflow) {
        console.log(`${cyan(step.phase)}: ${step.mode} - ${step.description}`);
      }
      return;
    }

    success("Starting SPARC TDD Workflow");
    console.log("Following Test-Driven Development with SPARC methodology");
    console.log();

    for (let i = 0; i < workflow.length; i++) {
      const step = workflow[i];
      const mode = config.customModes.find(m => m.slug === step.mode);

      if (!mode) {
        warning(`Mode not found: ${step.mode}, skipping step`);
        continue;
      }

      info(`Phase ${i + 1}/5: ${step.phase} (${mode.name})`);
      console.log(`📋 ${step.description}`);
      console.log();

      const enhancedTask = buildSparcPrompt(mode, step.description, {
        ...ctx.flags,
        tddPhase: step.phase,
        workflowStep: i + 1,
        totalSteps: workflow.length
      });

      const tools = buildToolsFromGroups(mode.groups);
      const instanceId = `sparc-tdd-${step.phase.toLowerCase()}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

      await executeClaudeWithSparc(enhancedTask, tools, instanceId, ctx.flags);

      // Store phase completion in memory for next step
      if (ctx.flags.sequential !== false) {
        console.log("Phase completed. Press Enter to continue to next phase, or Ctrl+C to stop...");
        await new Promise<void>((resolve) => {
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          
          Deno.stdin.read(new Uint8Array(1)).then(() => resolve());
        });
      }
    }

    success("SPARC TDD Workflow completed!");

  } catch (err) {
    error(`Failed to run TDD flow: ${(err as Error).message}`);
  }
}

async function runSparcWorkflow(ctx: CommandContext): Promise<void> {
  const workflowFile = ctx.args[1];

  if (!workflowFile) {
    error("Usage: sparc workflow <workflow-file.json>");
    return;
  }

  try {
    const workflowContent = await Deno.readTextFile(workflowFile);
    const workflow = JSON.parse(workflowContent);

    if (!workflow.steps || !Array.isArray(workflow.steps)) {
      error("Invalid workflow file: missing 'steps' array");
      return;
    }

    const config = await loadSparcConfig();

    success(`Loading SPARC workflow: ${workflow.name || "Unnamed"}`);
    console.log(`📋 Steps: ${workflow.steps.length}`);
    console.log(`📝 Description: ${workflow.description || "No description"}`);
    console.log();

    if (ctx.flags.dryRun || ctx.flags["dry-run"]) {
      warning("DRY RUN - Workflow Steps:");
      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        console.log(`${i + 1}. ${cyan(step.mode)} - ${step.description || step.task}`);
      }
      return;
    }

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const mode = config.customModes.find(m => m.slug === step.mode);

      if (!mode) {
        warning(`Mode not found: ${step.mode}, skipping step ${i + 1}`);
        continue;
      }

      info(`Step ${i + 1}/${workflow.steps.length}: ${mode.name}`);
      console.log(`📋 ${step.description || step.task}`);
      console.log();

      const enhancedTask = buildSparcPrompt(mode, step.description || step.task, {
        ...ctx.flags,
        workflowStep: i + 1,
        totalSteps: workflow.steps.length,
        workflowName: workflow.name
      });

      const tools = buildToolsFromGroups(mode.groups);
      const instanceId = `sparc-workflow-${i + 1}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

      await executeClaudeWithSparc(enhancedTask, tools, instanceId, ctx.flags);

      if (workflow.sequential !== false && i < workflow.steps.length - 1) {
        console.log("Step completed. Press Enter to continue, or Ctrl+C to stop...");
        await new Promise<void>((resolve) => {
          Deno.stdin.read(new Uint8Array(1)).then(() => resolve());
        });
      }
    }

    success("SPARC workflow completed!");

  } catch (err) {
    error(`Failed to run workflow: ${(err as Error).message}`);
  }
}

function buildSparcPrompt(mode: SparcMode, taskDescription: string, flags: any): string {
  const memoryNamespace = flags.namespace || mode.slug || "default";
  
  return `# SPARC Development Mode: ${mode.name}

## Your Role
${mode.roleDefinition}

## Your Task
${taskDescription}

## Mode-Specific Instructions
${mode.customInstructions}

## SPARC Development Environment

You are working within the SPARC (Specification, Pseudocode, Architecture, Refinement, Completion) methodology using claude-flow orchestration features.

### Available Development Tools
- **Memory Persistence**: Use \`npx claude-flow memory store <key> "<value>"\` to save progress and findings
- **Memory Retrieval**: Use \`npx claude-flow memory query <search>\` to access previous work
- **Namespace**: Your work is stored in the "${memoryNamespace}" namespace

### SPARC Methodology Integration
${flags.tddPhase ? `
**Current TDD Phase**: ${flags.tddPhase}
- Follow the Red-Green-Refactor cycle
- Store test results and refactoring notes in memory
` : ''}

${flags.workflowStep ? `
**Workflow Progress**: Step ${flags.workflowStep} of ${flags.totalSteps}
- Review previous steps: \`npx claude-flow memory query previous_steps\`
- Store this step's output: \`npx claude-flow memory store step_${flags.workflowStep}_output "<results>"\`
` : ''}

### Best Practices
1. **Modular Development**: Keep all files under 500 lines
2. **Environment Safety**: Never hardcode secrets or environment values
3. **Memory Usage**: Store key findings and decisions in memory for future reference
4. **Tool Integration**: Use \`new_task\` for subtasks and \`attempt_completion\` when finished

### Memory Commands Examples
\`\`\`bash
# Store your progress
npx claude-flow memory store ${memoryNamespace}_progress "Current status and findings"

# Check for previous work
npx claude-flow memory query ${memoryNamespace}

# Store phase-specific results
npx claude-flow memory store ${memoryNamespace}_${flags.tddPhase || 'results'} "Phase output and decisions"
\`\`\`

### Integration with Other SPARC Modes
When working with other SPARC modes, use memory to:
- Share findings with spec-pseudocode mode
- Pass requirements to architect mode  
- Coordinate with code and tdd modes
- Communicate results to integration mode

Now proceed with your task following the SPARC methodology and your specific role instructions.`;
}

function buildToolsFromGroups(groups: string[]): string {
  const toolMappings: Record<string, string[]> = {
    read: ["View", "LS", "GlobTool", "GrepTool"],
    edit: ["Edit", "Replace", "MultiEdit", "Write"],
    browser: ["WebFetch"],
    mcp: ["mcp_tools"],
    command: ["Bash", "Terminal"]
  };

  const tools = new Set<string>();
  
  // Always include basic tools
  tools.add("View");
  tools.add("Edit");
  tools.add("Bash");

  for (const group of groups) {
    if (Array.isArray(group)) {
      // Handle nested group definitions
      const groupName = group[0];
      if (toolMappings[groupName]) {
        toolMappings[groupName].forEach(tool => tools.add(tool));
      }
    } else if (toolMappings[group]) {
      toolMappings[group].forEach(tool => tools.add(tool));
    }
  }

  return Array.from(tools).join(",");
}

async function executeClaudeWithSparc(
  enhancedTask: string, 
  tools: string, 
  instanceId: string, 
  flags: any
): Promise<void> {
  const claudeArgs = [enhancedTask];
  claudeArgs.push("--allowedTools", tools);

  if (flags.noPermissions || flags["no-permissions"]) {
    claudeArgs.push("--dangerously-skip-permissions");
  }

  if (flags.config) {
    claudeArgs.push("--mcp-config", flags.config);
  }

  if (flags.verbose) {
    claudeArgs.push("--verbose");
  }

  try {
    const command = new Deno.Command("claude", {
      args: claudeArgs,
      env: {
        ...Deno.env.toObject(),
        CLAUDE_INSTANCE_ID: instanceId,
        CLAUDE_SPARC_MODE: "true",
        CLAUDE_FLOW_MEMORY_ENABLED: "true",
        CLAUDE_FLOW_MEMORY_NAMESPACE: flags.namespace || "sparc",
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const child = command.spawn();
    const status = await child.status;

    if (status.success) {
      success(`SPARC instance ${instanceId} completed successfully`);
    } else {
      error(`SPARC instance ${instanceId} exited with code ${status.code}`);
    }
  } catch (err) {
    error(`Failed to execute Claude: ${err.message}`);
  }
}

async function showSparcHelp(): Promise<void> {
  console.log(`${cyan("SPARC")} - ${green("Specification, Pseudocode, Architecture, Refinement, Completion")}`);
  console.log();
  console.log("SPARC development methodology with TDD and multi-agent coordination.");
  console.log();
  console.log(blue("Commands:"));
  console.log("  modes                    List all available SPARC modes");
  console.log("  info <mode>              Show detailed information about a mode");
  console.log("  run <mode> <task>        Execute a task using a specific SPARC mode");
  console.log("  tdd <task>               Run full TDD workflow using SPARC methodology");
  console.log("  workflow <file>          Execute a custom SPARC workflow from JSON file");
  console.log();
  console.log(blue("Common Modes:"));
  console.log("  spec-pseudocode          Create specifications and pseudocode");
  console.log("  architect                Design system architecture");
  console.log("  code                     Implement code solutions");
  console.log("  tdd                      Test-driven development");
  console.log("  debug                    Debug and troubleshoot issues");
  console.log("  security-review          Security analysis and review");
  console.log("  docs-writer              Documentation creation");
  console.log("  integration              System integration and testing");
  console.log();
  console.log(blue("Options:"));
  console.log("  --namespace <ns>         Memory namespace for this session");
  console.log("  --no-permissions         Skip permission prompts");
  console.log("  --config <file>          MCP configuration file");
  console.log("  --verbose               Enable verbose output");
  console.log("  --dry-run               Preview what would be executed");
  console.log("  --sequential            Wait between workflow steps (default: true)");
  console.log();
  console.log(blue("Examples:"));
  console.log(`  ${yellow("claude-flow sparc modes")}                              # List all modes`);
  console.log(`  ${yellow("claude-flow sparc run code")} "implement user auth"      # Run specific mode`);
  console.log(`  ${yellow("claude-flow sparc tdd")} "payment processing system"    # Full TDD workflow`);
  console.log(`  ${yellow("claude-flow sparc workflow")} project-workflow.json     # Custom workflow`);
  console.log();
  console.log(blue("TDD Workflow:"));
  console.log("  1. Specification - Define requirements and create pseudocode");
  console.log("  2. Red Phase - Write failing tests");
  console.log("  3. Green Phase - Implement minimal code to pass tests");
  console.log("  4. Refactor Phase - Optimize and clean up code");
  console.log("  5. Integration - Verify complete solution");
  console.log();
  console.log("For more information: https://github.com/ruvnet/claude-code-flow/docs/sparc.md");
}