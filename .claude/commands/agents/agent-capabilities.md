---
name: agent-capabilities
description: Capability matrix for all agent types
type: reference
---

# Agent Capabilities Reference

Matrix of agent capabilities and their specializations for Claude Flow V3.

## Capability Matrix

### Core Development

| Agent | Code | Test | Review | Design | Research |
|-------|:----:|:----:|:------:|:------:|:--------:|
| coder | **5** | 3 | 2 | 2 | 2 |
| reviewer | 3 | 2 | **5** | 3 | 2 |
| tester | 2 | **5** | 2 | 1 | 2 |
| planner | 2 | 1 | 2 | **5** | 4 |
| researcher | 2 | 1 | 2 | 3 | **5** |

### V3 Specialized

| Agent | Security | Memory | Performance | Architecture |
|-------|:--------:|:------:|:-----------:|:------------:|
| security-architect | **5** | 2 | 3 | **5** |
| security-auditor | **5** | 2 | 2 | 3 |
| memory-specialist | 3 | **5** | 4 | 3 |
| performance-engineer | 2 | 3 | **5** | 4 |
| core-architect | 3 | 3 | 3 | **5** |

### Swarm Coordination

| Agent | Coordination | Consensus | Scaling | Fault Tolerance |
|-------|:------------:|:---------:|:-------:|:---------------:|
| hierarchical-coordinator | **5** | 4 | 4 | 4 |
| mesh-coordinator | 4 | 4 | **5** | 4 |
| adaptive-coordinator | **5** | 4 | **5** | 4 |
| collective-intelligence-coordinator | 4 | **5** | 4 | 4 |

### GitHub Integration

| Agent | PR | Issues | CI/CD | Release | Review |
|-------|:--:|:------:|:-----:|:-------:|:------:|
| pr-manager | **5** | 3 | 2 | 3 | 4 |
| code-review-swarm | 4 | 2 | 2 | 2 | **5** |
| issue-tracker | 2 | **5** | 2 | 2 | 2 |
| release-manager | 3 | 3 | 4 | **5** | 2 |
| workflow-automation | 2 | 3 | **5** | 4 | 2 |

## Capability Levels

| Level | Description |
|-------|-------------|
| **5** | Expert - Primary specialization |
| 4 | Advanced - Strong capability |
| 3 | Intermediate - Good capability |
| 2 | Basic - Limited capability |
| 1 | Minimal - Not a focus |

## V3 Performance Capabilities

| Capability | Agents | Performance Gain |
|------------|--------|------------------|
| Flash Attention | memory-specialist, performance-engineer | 2.49x-7.47x |
| HNSW Search | memory-specialist | 150x-12,500x |
| Quantization | performance-engineer | 50-75% memory |
| SONA Adaptation | sona-learning-optimizer | <0.05ms |

## Consensus Capabilities

| Agent | BFT | Raft | Gossip | CRDT |
|-------|:---:|:----:|:------:|:----:|
| byzantine-coordinator | **5** | 2 | 2 | 2 |
| raft-manager | 2 | **5** | 2 | 2 |
| gossip-coordinator | 2 | 2 | **5** | 3 |
| crdt-synchronizer | 2 | 2 | 3 | **5** |
| quorum-manager | 4 | 4 | 3 | 3 |

## Tool Access by Agent Type

### Code Tools
```
coder: Read, Write, Edit, MultiEdit, Glob, Grep, Bash
reviewer: Read, Glob, Grep
tester: Read, Write, Bash, Glob
```

### Swarm Tools
```
hierarchical-coordinator: mcp__claude-flow__swarm_*, mcp__claude-flow__agent_*
mesh-coordinator: mcp__claude-flow__swarm_*, mcp__claude-flow__coordination_*
adaptive-coordinator: mcp__claude-flow__topology_*, mcp__claude-flow__swarm_*
```

### GitHub Tools
```
pr-manager: mcp__github__*, Bash (gh CLI)
code-review-swarm: mcp__github__*, mcp__claude-flow__swarm_*
release-manager: mcp__github__*, mcp__claude-flow__workflow_*
```

## Querying Capabilities

```bash
# List all capabilities for an agent type
npx claude-flow agent spawn -t coder --help

# View agent definition
cat .claude/agents/core/coder.md
```

## Capability-Based Selection

### For Security Tasks
1. `security-architect` - Design and threat modeling
2. `security-auditor` - Vulnerability assessment
3. `security-manager` - Consensus security

### For Performance Tasks
1. `performance-engineer` - Optimization
2. `memory-specialist` - Memory/search optimization
3. `performance-analyzer` - Bottleneck analysis

### For Multi-Agent Coordination
1. `hierarchical-coordinator` - Complex hierarchical tasks
2. `mesh-coordinator` - Research and exploration
3. `adaptive-coordinator` - Dynamic requirements

### For GitHub Workflows
1. `pr-manager` - PR lifecycle
2. `code-review-swarm` - Comprehensive reviews
3. `workflow-automation` - CI/CD automation

## See Also

- [agent-types](./agent-types.md) - All 87 agent types
- [agent-coordination](./agent-coordination.md) - Coordination patterns
- [spawn](./spawn.md) - Spawn command
