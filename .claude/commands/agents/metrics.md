---
name: metrics
description: Show agent performance metrics
type: command
---

# Agent Metrics Command

Display comprehensive performance metrics for agents including V3 performance gains.

## Usage

```bash
npx claude-flow agent metrics [agent-id] [options]
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--period` | `-p` | Time period (1h, 24h, 7d, 30d) | 24h |
| `--format` | | Output format (table, json) | table |

## Examples

```bash
# Overall metrics for last 24 hours
npx claude-flow agent metrics

# Metrics for specific agent
npx claude-flow agent metrics coder-lx7m9k2

# Last hour
npx claude-flow agent metrics -p 1h

# Last 7 days
npx claude-flow agent metrics --period 7d

# JSON output
npx claude-flow agent metrics --format json
```

## Output

```
Agent Metrics (24h)

+--------------------+----------+
| Metric             |    Value |
+--------------------+----------+
| Total Agents       |        4 |
| Active Agents      |        3 |
| Tasks Completed    |      127 |
| Success Rate       |    96.2% |
| Total Tokens       | 1,234,567|
| Avg Response Time  |    1.45s |
+--------------------+----------+

By Agent Type
+------------+-------+-------+---------+
| Type       | Count | Tasks | Success |
+------------+-------+-------+---------+
| coder      |     2 |    45 |     97% |
| researcher |     1 |    32 |     95% |
| tester     |     1 |    50 |     98% |
+------------+-------+-------+---------+

V3 Performance Gains
  - Flash Attention: 2.8x speedup
  - Memory Reduction: 52%
  - Search: 150x faster
```

## Metrics Explained

### Summary Metrics
| Metric | Description |
|--------|-------------|
| Total Agents | All agents spawned in period |
| Active Agents | Currently running agents |
| Tasks Completed | Successfully completed tasks |
| Success Rate | Percentage of successful tasks |
| Total Tokens | Token usage across all agents |
| Avg Response Time | Mean task completion time |

### V3 Performance Gains
| Metric | Target | Description |
|--------|--------|-------------|
| Flash Attention | 2.49x-7.47x | Neural attention speedup |
| Memory Reduction | 50-75% | Quantization savings |
| HNSW Search | 150x-12,500x | Vector search improvement |
| SONA Adaptation | <0.05ms | Real-time learning |

## JSON Output

```json
{
  "period": "24h",
  "summary": {
    "totalAgents": 4,
    "activeAgents": 3,
    "tasksCompleted": 127,
    "avgSuccessRate": "96.2%",
    "totalTokens": 1234567,
    "avgResponseTime": "1.45s"
  },
  "byType": [
    { "type": "coder", "count": 2, "tasks": 45, "successRate": "97%" }
  ],
  "performance": {
    "flashAttention": "2.8x speedup",
    "memoryReduction": "52%",
    "searchImprovement": "150x faster"
  }
}
```

## Related Commands

- `npx claude-flow agent status` - Individual agent metrics
- `npx claude-flow performance benchmark` - Full performance suite
- `npx claude-flow status` - System-wide status
