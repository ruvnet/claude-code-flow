// claude-flow-commands.js - Claude-Flow specific slash commands

// Helper function to check file existence (simplified for this module)
async function checkFileExists(filePath) {
  try {
    await Deno.stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error; // Re-throw other errors
  }
}

// Create Claude-Flow specific commands
export async function createClaudeFlowCommands(workingDir, force = false, merge = false) {
  // Helper for consistent logging and file writing
  const writeFile = async (filePath, content, commandName) => {
    const fileExists = await checkFileExists(filePath);
    if (fileExists && !force) {
      // If merge were true for these, specific merge logic would be needed.
      // For now, these command files are typically overwritten or skipped.
      console.warn(`⚠️  Warning: ${commandName} command file (${filePath}) already exists. Use --force to overwrite.`);
      return;
    }
    await Deno.writeTextFile(filePath, content);
    console.log(`  ✓ ${fileExists && force ? 'Overwrote' : 'Created'} slash command: /${commandName} at ${filePath}`);
  };

  const commandsToCreate = [];

  // Help command
  const helpCommandContent = `---
name: claude-flow-help
description: Show Claude-Flow commands and usage
---

# Claude-Flow Commands

## 🌊 Claude-Flow: Agent Orchestration Platform

Claude-Flow is the ultimate multi-terminal orchestration platform that revolutionizes how you work with Claude Code.

## Core Commands

### 🚀 System Management
- \`./claude-flow start\` - Start orchestration system
- \`./claude-flow start --ui\` - Start with interactive process management UI
- \`./claude-flow status\` - Check system status
- \`./claude-flow monitor\` - Real-time monitoring
- \`./claude-flow stop\` - Stop orchestration

### 🤖 Agent Management
- \`./claude-flow agent spawn <type>\` - Create new agent
- \`./claude-flow agent list\` - List active agents
- \`./claude-flow agent info <id>\` - Agent details
- \`./claude-flow agent terminate <id>\` - Stop agent

### 📋 Task Management
- \`./claude-flow task create <type> "description"\` - Create task
- \`./claude-flow task list\` - List all tasks
- \`./claude-flow task status <id>\` - Task status
- \`./claude-flow task cancel <id>\` - Cancel task
- \`./claude-flow task workflow <file>\` - Execute workflow

### 🧠 Memory Operations
- \`./claude-flow memory store "key" "value"\` - Store data
- \`./claude-flow memory query "search"\` - Search memory
- \`./claude-flow memory stats\` - Memory statistics
- \`./claude-flow memory export <file>\` - Export memory
- \`./claude-flow memory import <file>\` - Import memory

### ⚡ SPARC Development
- \`./claude-flow sparc "task"\` - Run SPARC orchestrator
- \`./claude-flow sparc modes\` - List all 17+ SPARC modes
- \`./claude-flow sparc run <mode> "task"\` - Run specific mode
- \`./claude-flow sparc tdd "feature"\` - TDD workflow
- \`./claude-flow sparc info <mode>\` - Mode details

### 🐝 Swarm Coordination
- \`./claude-flow swarm "task" --strategy <type>\` - Start swarm
- \`./claude-flow swarm "task" --background\` - Long-running swarm
- \`./claude-flow swarm "task" --monitor\` - With monitoring
- \`./claude-flow swarm "task" --ui\` - Interactive UI
- \`./claude-flow swarm "task" --distributed\` - Distributed coordination

### 🌍 MCP Integration
- \`./claude-flow mcp status\` - MCP server status
- \`./claude-flow mcp tools\` - List available tools
- \`./claude-flow mcp config\` - Show configuration
- \`./claude-flow mcp logs\` - View MCP logs

### 🤖 Claude Integration
- \`./claude-flow claude spawn "task"\` - Spawn Claude with enhanced guidance
- \`./claude-flow claude batch <file>\` - Execute workflow configuration

## 🌟 Quick Examples

### Initialize with SPARC:
\`\`\`bash
npx -y claude-flow@latest init --sparc
\`\`\`

### Start a development swarm:
\`\`\`bash
./claude-flow swarm "Build REST API" --strategy development --monitor --review
\`\`\`

### Run TDD workflow:
\`\`\`bash
./claude-flow sparc tdd "user authentication"
\`\`\`

### Store project context:
\`\`\`bash
./claude-flow memory store "project_requirements" "e-commerce platform specs" --namespace project
\`\`\`

### Spawn specialized agents:
\`\`\`bash
./claude-flow agent spawn researcher --name "Senior Researcher" --priority 8
./claude-flow agent spawn developer --name "Lead Developer" --priority 9
\`\`\`

## 🎯 Best Practices
- Use \`./claude-flow\` instead of \`npx claude-flow\` after initialization
- Store important context in memory for cross-session persistence
- Use swarm mode for complex tasks requiring multiple agents
- Enable monitoring for real-time progress tracking
- Use background mode for tasks > 30 minutes

## 📚 Resources
- Documentation: https://github.com/ruvnet/claude-code-flow/docs
- Examples: https://github.com/ruvnet/claude-code-flow/examples
- Issues: https://github.com/ruvnet/claude-code-flow/issues
`;
  commandsToCreate.push({
    filePath: `${workingDir}/.claude/commands/claude-flow-help.md`,
    content: helpCommandContent,
    name: 'claude-flow-help'
  });

  // Memory command
  const memoryCommandContent = `---
name: claude-flow-memory
description: Interact with Claude-Flow memory system
---

# 🧠 Claude-Flow Memory System

The memory system provides persistent storage for cross-session and cross-agent collaboration with CRDT-based conflict resolution.

## Store Information
\`\`\`bash
# Store with default namespace
./claude-flow memory store "key" "value"

# Store with specific namespace
./claude-flow memory store "architecture_decisions" "microservices with API gateway" --namespace arch
\`\`\`

## Query Memory
\`\`\`bash
# Search across all namespaces
./claude-flow memory query "authentication"

# Search with filters
./claude-flow memory query "API design" --namespace arch --limit 10
\`\`\`

## Memory Statistics
\`\`\`bash
# Show overall statistics
./claude-flow memory stats

# Show namespace-specific stats
./claude-flow memory stats --namespace project
\`\`\`

## Export/Import
\`\`\`bash
# Export all memory
./claude-flow memory export full-backup.json

# Export specific namespace
./claude-flow memory export project-backup.json --namespace project

# Import memory
./claude-flow memory import backup.json
\`\`\`

## Cleanup Operations
\`\`\`bash
# Clean entries older than 30 days
./claude-flow memory cleanup --days 30

# Clean specific namespace
./claude-flow memory cleanup --namespace temp --days 7
\`\`\`

## 🗂️ Namespaces
- **default** - General storage
- **agents** - Agent-specific data and state
- **tasks** - Task information and results
- **sessions** - Session history and context
- **swarm** - Swarm coordination and objectives
- **project** - Project-specific context
- **spec** - Requirements and specifications
- **arch** - Architecture decisions
- **impl** - Implementation notes
- **test** - Test results and coverage
- **debug** - Debug logs and fixes

## 🎯 Best Practices

### Naming Conventions
- Use descriptive, searchable keys
- Include timestamp for time-sensitive data
- Prefix with component name for clarity

### Organization
- Use namespaces to categorize data
- Store related data together
- Keep values concise but complete

### Maintenance
- Regular backups with export
- Clean old data periodically
- Monitor storage statistics
- Compress large values

## Examples

### Store SPARC context:
\`\`\`bash
./claude-flow memory store "spec_auth_requirements" "OAuth2 + JWT with refresh tokens" --namespace spec
./claude-flow memory store "arch_api_design" "RESTful microservices with GraphQL gateway" --namespace arch
./claude-flow memory store "test_coverage_auth" "95% coverage, all tests passing" --namespace test
\`\`\`

### Query project decisions:
\`\`\`bash
./claude-flow memory query "authentication" --namespace arch --limit 5
./claude-flow memory query "test results" --namespace test
\`\`\`

### Backup project memory:
\`\`\`bash
./claude-flow memory export project-$(date +%Y%m%d).json --namespace project
\`\`\`
`;
  commandsToCreate.push({
    filePath: `${workingDir}/.claude/commands/claude-flow-memory.md`,
    content: memoryCommandContent,
    name: 'claude-flow-memory'
  });
  
  // Swarm command
  const swarmCommandContent = `---
name: claude-flow-swarm
description: Coordinate multi-agent swarms for complex tasks
---

# 🐝 Claude-Flow Swarm Coordination

Advanced multi-agent coordination system with timeout-free execution, distributed memory sharing, and intelligent load balancing.

## Basic Usage
\`\`\`bash
./claude-flow swarm "your complex task" --strategy <type> [options]
\`\`\`

## 🎯 Swarm Strategies
- **auto** - Automatic strategy selection based on task analysis
- **development** - Code implementation with review and testing
- **research** - Information gathering and synthesis
- **analysis** - Data processing and pattern identification
- **testing** - Comprehensive quality assurance
- **optimization** - Performance tuning and refactoring
- **maintenance** - System updates and bug fixes

## 🤖 Agent Types
- **coordinator** - Plans and delegates tasks to other agents
- **developer** - Writes code and implements solutions
- **researcher** - Gathers and analyzes information
- **analyzer** - Identifies patterns and generates insights
- **tester** - Creates and runs tests for quality assurance
- **reviewer** - Performs code and design reviews
- **documenter** - Creates documentation and guides
- **monitor** - Tracks performance and system health
- **specialist** - Domain-specific expert agents

## 🔄 Coordination Modes
- **centralized** - Single coordinator manages all agents (default)
- **distributed** - Multiple coordinators share management
- **hierarchical** - Tree structure with nested coordination
- **mesh** - Peer-to-peer agent collaboration
- **hybrid** - Mixed coordination strategies

## ⚙️ Common Options
- \`--strategy <type>\` - Execution strategy
- \`--mode <type>\` - Coordination mode
- \`--max-agents <n>\` - Maximum concurrent agents (default: 5)
- \`--timeout <minutes>\` - Timeout in minutes (default: 60)
- \`--background\` - Run in background for tasks > 30 minutes
- \`--monitor\` - Enable real-time monitoring
- \`--ui\` - Launch terminal UI interface
- \`--parallel\` - Enable parallel execution
- \`--distributed\` - Enable distributed coordination
- \`--review\` - Enable peer review process
- \`--testing\` - Include automated testing
- \`--encryption\` - Enable data encryption
- \`--verbose\` - Detailed logging output
- \`--dry-run\` - Show configuration without executing

## 🌟 Examples

### Development Swarm with Review
\`\`\`bash
./claude-flow swarm "Build e-commerce REST API" \\
  --strategy development \\
  --monitor \\
  --review \\
  --testing
\`\`\`

### Long-Running Research Swarm
\`\`\`bash
./claude-flow swarm "Analyze AI market trends 2024-2025" \\
  --strategy research \\
  --background \\
  --distributed \\
  --max-agents 8
\`\`\`

### Performance Optimization Swarm
\`\`\`bash
./claude-flow swarm "Optimize database queries and API performance" \\
  --strategy optimization \\
  --testing \\
  --parallel \\
  --monitor
\`\`\`

### Enterprise Development Swarm
\`\`\`bash
./claude-flow swarm "Implement secure payment processing system" \\
  --strategy development \\
  --mode distributed \\
  --max-agents 10 \\
  --parallel \\
  --monitor \\
  --review \\
  --testing \\
  --encryption \\
  --verbose
\`\`\`

### Testing and QA Swarm
\`\`\`bash
./claude-flow swarm "Comprehensive security audit and testing" \\
  --strategy testing \\
  --review \\
  --verbose \\
  --max-agents 6
\`\`\`

## 📊 Monitoring and Control

### Real-time monitoring:
\`\`\`bash
# Monitor swarm activity
./claude-flow monitor

# Monitor specific component
./claude-flow monitor --focus swarm
\`\`\`

### Check swarm status:
\`\`\`bash
# Overall system status
./claude-flow status

# Detailed swarm status
./claude-flow status --verbose
\`\`\`

### View agent activity:
\`\`\`bash
# List all agents
./claude-flow agent list

# Agent details
./claude-flow agent info <agent-id>
\`\`\`

## 💾 Memory Integration

Swarms automatically use distributed memory for collaboration:

\`\`\`bash
# Store swarm objectives
./claude-flow memory store "swarm_objective" "Build scalable API" --namespace swarm

# Query swarm progress
./claude-flow memory query "swarm_progress" --namespace swarm

# Export swarm memory
./claude-flow memory export swarm-results.json --namespace swarm
\`\`\`

## 🎯 Key Features

### Timeout-Free Execution
- Background mode for long-running tasks
- State persistence across sessions
- Automatic checkpoint recovery

### Work Stealing & Load Balancing
- Dynamic task redistribution
- Automatic agent scaling
- Resource-aware scheduling

### Circuit Breakers & Fault Tolerance
- Automatic retry with exponential backoff
- Graceful degradation
- Health monitoring and recovery

### Real-Time Collaboration
- Cross-agent communication
- Shared memory access
- Event-driven coordination

### Enterprise Security
- Role-based access control
- Audit logging
- Data encryption
- Input validation

## 🔧 Advanced Configuration

### Dry run to preview:
\`\`\`bash
./claude-flow swarm "Test task" --dry-run --strategy development
\`\`\`

### Custom quality thresholds:
\`\`\`bash
./claude-flow swarm "High quality API" \\
  --strategy development \\
  --quality-threshold 0.95
\`\`\`

### Scheduling algorithms:
- FIFO (First In, First Out)
- Priority-based
- Deadline-driven
- Shortest Job First
- Critical Path
- Resource-aware
- Adaptive

For detailed documentation, see: https://github.com/ruvnet/claude-code-flow/docs/swarm-system.md
`;
  commandsToCreate.push({
    filePath: `${workingDir}/.claude/commands/claude-flow-swarm.md`,
    content: swarmCommandContent,
    name: 'claude-flow-swarm'
  });

  for (const cmd of commandsToCreate) {
    await writeFile(cmd.filePath, cmd.content, cmd.name);
  }
}