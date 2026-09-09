---
name: status
description: Show detailed status of an agent
type: command
---

# Agent Status Command

Display comprehensive status information for a specific agent including metrics, configuration, and activity.

## Usage

```bash
npx claude-flow agent status <agent-id>
npx claude-flow agent status --id <agent-id>
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--id` | Agent ID (alternative to positional arg) | Required |
| `--format` | Output format (table, json) | table |

## Examples

```bash
# Get status by ID
npx claude-flow agent status coder-lx7m9k2

# Using --id flag
npx claude-flow agent status --id researcher-abc123

# JSON output
npx claude-flow agent status coder-lx7m9k2 --format json
```

## Output

```
+--------------------------------------------------+
|              Agent: coder-lx7m9k2                |
+--------------------------------------------------+
| Type: coder                                      |
| Status: active                                   |
| Created: 1/8/2026, 10:30:15 AM                   |
| Last Activity: 1/8/2026, 10:45:23 AM             |
+--------------------------------------------------+

Metrics
+-------------------------+----------+
| Metric                  |    Value |
+-------------------------+----------+
| Tasks Completed         |       12 |
| Tasks In Progress       |        1 |
| Tasks Failed            |        0 |
| Avg Execution Time      |  245.5ms |
| Uptime                  |   15.3m  |
+-------------------------+----------+
```

## Detailed Information

The status command provides:

### Basic Info
- Agent ID and type
- Current status (active/idle/terminated)
- Creation timestamp
- Last activity timestamp

### Performance Metrics
- Tasks completed successfully
- Tasks currently in progress
- Failed task count
- Average execution time
- Total uptime

### Configuration (when applicable)
- Provider and model
- Timeout settings
- Auto-tools enabled
- Custom capabilities

## JSON Output

```json
{
  "id": "coder-lx7m9k2",
  "agentType": "coder",
  "status": "active",
  "createdAt": "2026-01-08T10:30:15.000Z",
  "lastActivityAt": "2026-01-08T10:45:23.000Z",
  "config": {
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022",
    "timeout": 300,
    "autoTools": true
  },
  "metrics": {
    "tasksCompleted": 12,
    "tasksInProgress": 1,
    "tasksFailed": 0,
    "averageExecutionTime": 245.5,
    "uptime": 918000
  }
}
```

## Related Commands

- `npx claude-flow agent list` - Find agent IDs
- `npx claude-flow agent metrics` - Aggregate metrics
- `npx claude-flow agent health` - Health check
- `npx claude-flow agent logs <id>` - Activity logs
