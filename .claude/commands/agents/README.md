# Agents Commands

Complete agent management commands for Claude Flow V3.

## Available Commands

| Command | Description |
|---------|-------------|
| [spawn](./spawn.md) | Spawn new agents with V3 capabilities |
| [list](./list.md) | List all active agents |
| [status](./status.md) | Show detailed agent status |
| [stop](./stop.md) | Stop running agents |
| [metrics](./metrics.md) | View performance metrics |
| [pool](./pool.md) | Manage agent pool scaling |
| [health](./health.md) | Monitor agent health |
| [logs](./logs.md) | View agent activity logs |

## Reference

| Reference | Description |
|-----------|-------------|
| [agent-types](./agent-types.md) | All 87 available agent types |
| [agent-capabilities](./agent-capabilities.md) | Capability matrix by agent |
| [agent-coordination](./agent-coordination.md) | Multi-agent coordination patterns |
| [agent-spawning](./agent-spawning.md) | Best practices for spawning |

## Quick Start

```bash
# Spawn a coder agent
npx claude-flow agent spawn -t coder --name my-coder

# List all active agents
npx claude-flow agent list

# Check agent health
npx claude-flow agent health

# View metrics
npx claude-flow agent metrics --period 24h
```

## V3 Agent Categories

- **Core**: coder, reviewer, tester, planner, researcher
- **V3 Specialized**: security-architect, memory-specialist, performance-engineer
- **Swarm**: hierarchical-coordinator, mesh-coordinator, adaptive-coordinator
- **Consensus**: byzantine-coordinator, raft-manager, gossip-coordinator
- **GitHub**: pr-manager, code-review-swarm, release-manager
- **SPARC**: sparc-coordinator, specification, architecture, refinement
