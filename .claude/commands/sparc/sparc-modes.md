# SPARC Modes Overview

SPARC (Specification, Pseudocode, Architecture, Refinement, Completion) is a structured
development methodology. The modes below match the actual CLI output of `claude-flow sparc modes`.

## Available Modes

| Mode | Display Name | Description |
|------|-------------|-------------|
| `architect` | Architect | System design and architecture planning |
| `code` | Auto-Coder | Clean, modular code implementation |
| `tdd` | Tester (TDD) | Test-driven development with red-green-refactor |
| `debug` | Debugger | Systematic debugging and troubleshooting |
| `security-review` | Security Reviewer | Security analysis and vulnerability assessment |
| `docs-writer` | Documentation Writer | Comprehensive documentation generation |
| `integration` | System Integrator | System integration and coordination |
| `post-deployment-monitoring-mode` | Deployment Monitor | Post-deployment monitoring and alerting |
| `refinement-optimization-mode` | Optimizer | Performance optimization and refactoring |
| `ask` | Ask | Interactive Q&A and consultation |
| `devops` | DevOps | Deployment and infrastructure management |
| `tutorial` | SPARC Tutorial | Guided SPARC methodology walkthrough |
| `supabase-admin` | Supabase Admin | Supabase database and auth management |
| `spec-pseudocode` | Specification Writer | Requirements and algorithmic planning |
| `mcp` | MCP Integration | External service and MCP tool integration |
| `sparc` | SPARC Orchestrator | Full SPARC methodology orchestration |

> **Note:** These are the correct CLI identifiers for `sparc run` and `sparc info`.
> Earlier versions of this file listed different names (e.g. `coder`, `orchestrator`, `innovator`)
> that do not exist in the CLI. Use the names from the table above.

## Usage

### List all modes
```bash
npx claude-flow sparc modes
```

### Get info on a mode
```bash
npx claude-flow sparc info <mode>
```

### Run a mode
```bash
npx claude-flow sparc run <mode> "task description"
```

### Examples
```bash
# Design system architecture
npx claude-flow sparc run architect "design microservices for payment processing"

# Implement a feature
npx claude-flow sparc run code "implement user authentication"

# Write tests
npx claude-flow sparc run tdd "create tests for registration flow"

# Debug an issue
npx claude-flow sparc run debug "fix memory leak in dashboard component"

# Security audit
npx claude-flow sparc run security-review "audit API endpoints for OWASP top 10"

# Optimize performance
npx claude-flow sparc run refinement-optimization-mode "reduce bundle size"
```

### Using MCP Tools (when inside Claude Code)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "architect",
  task_description: "design microservices"
}
```
