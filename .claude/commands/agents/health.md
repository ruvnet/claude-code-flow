---
name: health
description: Show agent health and metrics
type: command
---

# Agent Health Command

Monitor agent health status, resource usage, and detect issues.

## Usage

```bash
npx claude-flow agent health [agent-id] [options]
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--watch` | `-w` | Continuous monitoring | false |
| `--interval` | `-i` | Watch interval in seconds | 5 |
| `--format` | | Output format (table, json) | table |

## Examples

```bash
# Overall health check
npx claude-flow agent health

# Specific agent health
npx claude-flow agent health coder-lx7m9k2

# Continuous monitoring
npx claude-flow agent health --watch

# Custom interval
npx claude-flow agent health -w -i 10

# JSON output
npx claude-flow agent health --format json
```

## Output

```
Agent Health Status

Overall: HEALTHY

+--------------------+---------+--------+--------+---------+
| Agent              | Status  | Memory | CPU    | Tasks   |
+--------------------+---------+--------+--------+---------+
| coder-lx7m9k2      | healthy | 45MB   | 2.3%   | 5/5     |
| researcher-abc123  | healthy | 38MB   | 1.8%   | 3/3     |
| tester-def456      | warning | 120MB  | 8.5%   | 12/14   |
+--------------------+---------+--------+--------+---------+

Alerts
  - tester-def456: High memory usage (120MB > 100MB threshold)
  - tester-def456: Task failure rate above threshold (14.3%)

Recommendations
  - Consider restarting tester-def456
  - Review failed tasks for error patterns
```

## Health Status Values

| Status | Description |
|--------|-------------|
| `healthy` | All metrics within normal range |
| `warning` | Some metrics approaching thresholds |
| `critical` | Metrics exceeded critical thresholds |
| `unknown` | Unable to determine health |

## Health Checks

### Resource Checks
- Memory usage vs threshold
- CPU utilization
- Active connections
- Queue depth

### Performance Checks
- Response time
- Task success rate
- Error frequency
- Throughput

### Connectivity Checks
- MCP server connection
- Memory backend
- Neural services
- Swarm coordination

## Watch Mode

Continuous monitoring with real-time updates:

```bash
npx claude-flow agent health --watch

# Output updates every 5 seconds:
# [10:30:15] Agent Health: 3 healthy, 0 warning, 0 critical
# [10:30:20] Agent Health: 3 healthy, 0 warning, 0 critical
# [10:30:25] Agent Health: 2 healthy, 1 warning, 0 critical
#   - tester-def456: Memory usage increased to 115MB
```

Press `Ctrl+C` to stop watching.

## JSON Output

```json
{
  "overall": "healthy",
  "agents": [
    {
      "id": "coder-lx7m9k2",
      "status": "healthy",
      "metrics": {
        "memoryMB": 45,
        "cpuPercent": 2.3,
        "tasksCompleted": 5,
        "tasksTotal": 5
      }
    }
  ],
  "alerts": [],
  "recommendations": []
}
```

## Related Commands

- `npx claude-flow agent status` - Detailed agent info
- `npx claude-flow agent metrics` - Performance metrics
- `npx claude-flow doctor` - System-wide health
