---
name: list
description: List all active agents
aliases: [ls]
type: command
---

# Agent List Command

List all active agents in the Claude Flow system with filtering options.

## Usage

```bash
npx claude-flow agent list [options]
npx claude-flow agent ls [options]  # Alias
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--all` | `-a` | Include inactive/terminated agents | false |
| `--type` | `-t` | Filter by agent type | All |
| `--status` | `-s` | Filter by status (active, idle, terminated) | active |
| `--format` | | Output format (table, json) | table |

## Examples

```bash
# List all active agents
npx claude-flow agent list

# List all agents including inactive
npx claude-flow agent list --all

# Filter by type
npx claude-flow agent list -t coder

# Filter by status
npx claude-flow agent list -s idle

# JSON output for scripting
npx claude-flow agent list --format json

# Combined filters
npx claude-flow agent list -t researcher -s active
```

## Output

```
Active Agents

+--------------------+-----------+--------+----------+---------------+
| ID                 | Type      | Status | Created  | Last Activity |
+--------------------+-----------+--------+----------+---------------+
| coder-lx7m9k2      | coder     | active | 10:30:15 | 10:45:23      |
| researcher-abc123  | researcher| idle   | 09:15:00 | 10:20:45      |
| tester-def456      | tester    | active | 11:00:00 | 11:12:30      |
+--------------------+-----------+--------+----------+---------------+

Total: 3 agents
```

## JSON Output

```json
{
  "agents": [
    {
      "id": "coder-lx7m9k2",
      "agentType": "coder",
      "status": "active",
      "createdAt": "2026-01-08T10:30:15.000Z",
      "lastActivityAt": "2026-01-08T10:45:23.000Z"
    }
  ],
  "total": 3
}
```

## Status Values

| Status | Description |
|--------|-------------|
| `active` | Agent is currently executing tasks |
| `idle` | Agent is waiting for tasks |
| `terminated` | Agent has been stopped |

## Agent Type Categories

Use `--type` with any of the 87 agent types:

- Core: `coder`, `reviewer`, `tester`, `planner`, `researcher`
- V3: `security-architect`, `memory-specialist`, `performance-engineer`
- Swarm: `hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`
- Consensus: `byzantine-coordinator`, `raft-manager`, `gossip-coordinator`
- GitHub: `pr-manager`, `code-review-swarm`, `release-manager`
- SPARC: `sparc-coordinator`, `specification`, `architecture`
