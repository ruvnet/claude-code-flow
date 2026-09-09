---
name: logs
description: Show agent activity logs
type: command
---

# Agent Logs Command

View activity logs and history for agents.

## Usage

```bash
npx claude-flow agent logs <agent-id> [options]
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--lines` | `-n` | Number of lines to show | 50 |
| `--follow` | `-f` | Follow log output | false |
| `--level` | `-l` | Log level filter (debug, info, warn, error) | info |
| `--since` | | Show logs since timestamp/duration | - |
| `--format` | | Output format (text, json) | text |

## Examples

```bash
# View last 50 lines
npx claude-flow agent logs coder-lx7m9k2

# View last 100 lines
npx claude-flow agent logs coder-lx7m9k2 -n 100

# Follow logs (live)
npx claude-flow agent logs coder-lx7m9k2 --follow

# Filter by level
npx claude-flow agent logs coder-lx7m9k2 -l error

# Logs since time
npx claude-flow agent logs coder-lx7m9k2 --since "1h"
npx claude-flow agent logs coder-lx7m9k2 --since "2026-01-08T10:00:00"

# JSON output
npx claude-flow agent logs coder-lx7m9k2 --format json
```

## Output

```
Logs for coder-lx7m9k2

2026-01-08 10:30:15 [INFO]  Agent spawned: type=coder, name=coder-lx7m9k2
2026-01-08 10:30:16 [INFO]  Connected to swarm: topology=hierarchical
2026-01-08 10:30:17 [INFO]  Task received: implement-auth-feature
2026-01-08 10:30:18 [DEBUG] Loading context from memory
2026-01-08 10:32:45 [INFO]  Task completed: implement-auth-feature (success)
2026-01-08 10:32:46 [INFO]  Metrics updated: tasks=1, success_rate=100%
2026-01-08 10:33:00 [INFO]  Task received: write-auth-tests
2026-01-08 10:35:23 [INFO]  Task completed: write-auth-tests (success)
2026-01-08 10:35:24 [WARN]  Memory usage approaching threshold: 85MB/100MB
```

## Log Levels

| Level | Description |
|-------|-------------|
| `debug` | Detailed debugging information |
| `info` | General operational messages |
| `warn` | Warning conditions |
| `error` | Error conditions |

## Follow Mode

Real-time log streaming:

```bash
npx claude-flow agent logs coder-lx7m9k2 --follow

# New logs appear as they occur:
# 2026-01-08 10:40:15 [INFO]  Task received: refactor-auth
# 2026-01-08 10:42:30 [INFO]  Code changes: 3 files modified
# ...
```

Press `Ctrl+C` to stop following.

## Time Filters

```bash
# Last hour
npx claude-flow agent logs coder-lx7m9k2 --since "1h"

# Last 30 minutes
npx claude-flow agent logs coder-lx7m9k2 --since "30m"

# Specific timestamp
npx claude-flow agent logs coder-lx7m9k2 --since "2026-01-08T09:00:00"

# Today's logs
npx claude-flow agent logs coder-lx7m9k2 --since "today"
```

## JSON Output

```json
{
  "agentId": "coder-lx7m9k2",
  "logs": [
    {
      "timestamp": "2026-01-08T10:30:15.000Z",
      "level": "info",
      "message": "Agent spawned",
      "metadata": {
        "type": "coder",
        "name": "coder-lx7m9k2"
      }
    }
  ],
  "total": 50
}
```

## Related Commands

- `npx claude-flow agent status` - Current agent status
- `npx claude-flow agent health` - Health monitoring
- `npx claude-flow agent metrics` - Performance metrics
