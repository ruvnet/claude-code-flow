---
name: pool
description: Manage agent pool for scaling
type: command
---

# Agent Pool Command

Manage the agent pool for automatic scaling and resource optimization.

## Usage

```bash
npx claude-flow agent pool [options]
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--size` | `-s` | Set pool size | Current |
| `--min` | | Minimum pool size | 1 |
| `--max` | | Maximum pool size | 10 |
| `--auto-scale` | | Enable auto-scaling | true |
| `--warmup` | | Pre-warm agents | false |

## Examples

```bash
# View current pool status
npx claude-flow agent pool

# Set pool size
npx claude-flow agent pool --size 5

# Configure auto-scaling
npx claude-flow agent pool --min 2 --max 15 --auto-scale

# Pre-warm agents for fast response
npx claude-flow agent pool --warmup

# Disable auto-scaling
npx claude-flow agent pool --auto-scale false
```

## Output

```
Agent Pool Configuration

+----------------+----------+
| Setting        | Value    |
+----------------+----------+
| Current Size   | 3        |
| Min Size       | 1        |
| Max Size       | 10       |
| Auto-Scale     | enabled  |
| Warmup         | disabled |
+----------------+----------+

Pool Status
+------------+--------+------+-------+
| Type       | Active | Idle | Total |
+------------+--------+------+-------+
| coder      | 1      | 1    | 2     |
| researcher | 1      | 0    | 1     |
+------------+--------+------+-------+

Auto-Scale Rules
  - Scale up when: Queue > 5 tasks
  - Scale down when: Idle > 5 minutes
  - Cooldown: 60 seconds
```

## Auto-Scaling Behavior

### Scale Up Triggers
- Task queue exceeds threshold
- Response time increases
- Error rate increases

### Scale Down Triggers
- Agents idle for extended period
- Task queue empty
- Resource pressure

## Pre-Warming

Pre-warm agents to reduce cold-start latency:

```bash
npx claude-flow agent pool --warmup

# Pre-warms default agent types:
# - coder (2 instances)
# - researcher (1 instance)
# - tester (1 instance)
```

## Pool Configuration File

Configure in `.claude-flow/config.yaml`:

```yaml
agent:
  pool:
    minSize: 2
    maxSize: 15
    autoScale: true
    warmup:
      enabled: true
      types:
        - type: coder
          count: 2
        - type: researcher
          count: 1
    scaleRules:
      scaleUpThreshold: 5
      scaleDownIdleTime: 300
      cooldownPeriod: 60
```

## Related Commands

- `npx claude-flow agent spawn` - Manual agent spawning
- `npx claude-flow agent list` - View active agents
- `npx claude-flow swarm scale` - Swarm-level scaling
