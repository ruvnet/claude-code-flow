---
name: verification-quality
description: "Comprehensive truth scoring, code quality verification, and automatic rollback system with 0.95 accuracy threshold for ensuring high-quality agent outputs and codebase reliability."
version: "2.0.0"
category: "quality-assurance"
tags: ["verification", "truth-scoring", "quality", "rollback", "metrics", "ci-cd"]
---

# Verification & Quality Assurance Skill

## What This Skill Does

This skill provides a comprehensive verification and quality assurance system that ensures code quality and correctness through:

- **Truth Scoring**: Real-time reliability metrics (0.0-1.0 scale) for code, agents, and tasks
- **Verification Checks**: Automated code correctness, security, and best practices validation
- **Automatic Rollback**: Instant reversion of changes that fail verification (default threshold: 0.95)
- **Quality Metrics**: Statistical analysis with trends, confidence intervals, and improvement tracking
- **CI/CD Integration**: Export capabilities for continuous integration pipelines
- **Real-time Monitoring**: Live dashboards and watch modes for ongoing verification

> **Shipped vs. aspirational.** The *concrete, in-CI* verification stack — the 6 regression-guard jobs + the witness manifest + the tool-discoverability audit — is real and runs on every push. The truth-scoring / auto-rollback / WebSocket-dashboard surface described later in this doc is partly shipped (`ruflo verify` runs the witness checks) and partly design — treat the "CI Guards" section below as the authoritative current state.

## CI Guards — what's actually shipped (current state)

Ruflo's regression protection is three layers, all gated before publish. Authoritative reference: [`verification/README.md`](../../../verification/README.md).

| Layer | What | CI job(s) in `.github/workflows/v3-ci.yml` | ADR |
|---|---|---|---|
| **1 — install/behavioral smoke** | Exercise user-visible failure modes against a real build | `smoke-install-no-bsqlite` (npm install on platforms w/o prebuilds), `plugin-hooks-smoke` (#1859/#1862 — hook flag parsing), `mcp-protocol-smoke` (#1874 — HTTP MCP wire format), `memory-import-smoke` (#1883/#1884 — WSL path + key sanitization), `mcp-roundtrip-smoke` (#1889 paired-tool round-trip + #1863 cli-no-crash + ADR-095 G2 consensus-transport) | ADR-102 |
| **1 — discoverability gate** | Every MCP tool description must answer "use this over native when?" | `tool-descriptions-audit` — `scripts/audit-tool-descriptions.mjs`, baseline at `verification/mcp-tool-baseline.json` (monotone-decreasing: noGuidance / tooShort / duplicates) | ADR-112 |
| **2 — cryptographic witness** | Every documented fix's load-bearing marker must still be present in dist; Ed25519-signed, per-OS bundles | `witness-verify` (ubuntu/macos/windows) — `plugins/ruflo-core/scripts/witness/verify.mjs` against `verification/<os>/manifest.md.json` | ADR-103 |
| **3 — temporal history** | When was a regression introduced | `verification/<os>/history.jsonl` + `history.mjs` (`summary` / `regressions` / `timeline`) | ADR-103 |

### Run the guards locally

```bash
# Tool-description discoverability audit (ADR-112)
node scripts/audit-tool-descriptions.mjs                       # fails if any baseline count rises
node scripts/audit-tool-descriptions.mjs --update-baseline     # lock the new floor after a fix lands

# Behavioral smokes (each builds what it needs; safe to run individually)
node plugins/ruflo-core/scripts/test-hooks.mjs "node $PWD/v3/@claude-flow/cli/bin/cli.js"
node plugins/ruflo-core/scripts/test-mcp-protocol.mjs
node plugins/ruflo-core/scripts/test-memory-import.mjs
node plugins/ruflo-core/scripts/test-mcp-roundtrips.mjs        # #1889 paired-tool round-trip
node plugins/ruflo-core/scripts/test-cli-no-crash.mjs          # #1863 unhandled-exception class
node plugins/ruflo-core/scripts/test-consensus-transport.mjs   # ADR-095 G2 consensus transport

# Witness manifest — regenerate + verify
node scripts/regen-witness.mjs
node plugins/ruflo-core/scripts/witness/verify.mjs --manifest verification/macos/manifest.md.json

# Temporal history
node plugins/ruflo-core/scripts/witness/history.mjs --history verification/macos/history.jsonl summary
node plugins/ruflo-core/scripts/witness/history.mjs --history verification/macos/history.jsonl regressions
```

### Adding a new guard

1. **Behavioral smoke** → write `plugins/ruflo-core/scripts/test-<name>.mjs`. Pattern: static dist-scan first (fast, always completes), behavioral probe second with an internal timeout + a process-level watchdog so CI never hangs. Add a step to the relevant job in `v3-ci.yml`.
2. **Static gate with a baseline** → write `scripts/audit-<name>.mjs` that scans, counts violations, and fails if the count exceeds a monotone-decreasing baseline in `verification/<name>-baseline.json`. Support `--update-baseline`. Add a CI job; wire it into `witness-verify` `needs[]` if it should gate `publish`.
3. **Documented-fix marker** → append `{ id, desc, file, marker }` to `verification/witness-fixes.json`, run `node scripts/regen-witness.mjs`. The marker must be a substring the fix specifically creates (not a generic pattern like `'function'`).

## Prerequisites

- Ruflo installed (`npx ruflo@alpha`)
- Git repository (for rollback features)
- Node.js 18+ (for dashboard features)
- `@noble/ed25519` (for the witness verifier — a single runtime dep, `npm i @noble/ed25519`)

## Quick Start

```bash
# View current truth scores
npx ruflo@alpha truth

# Run verification check
npx ruflo@alpha verify check

# Verify specific file with custom threshold
npx ruflo@alpha verify check --file src$app.js --threshold 0.98

# Rollback last failed verification
npx ruflo@alpha verify rollback --last-good
```

---

## Complete Guide

### Truth Scoring System

#### View Truth Metrics

Display comprehensive quality and reliability metrics for your codebase and agent tasks.

**Basic Usage:**
```bash
# View current truth scores (default: table format)
npx ruflo@alpha truth

# View scores for specific time period
npx ruflo@alpha truth --period 7d

# View scores for specific agent
npx ruflo@alpha truth --agent coder --period 24h

# Find files$tasks below threshold
npx ruflo@alpha truth --threshold 0.8
```

**Output Formats:**
```bash
# Table format (default)
npx ruflo@alpha truth --format table

# JSON for programmatic access
npx ruflo@alpha truth --format json

# CSV for spreadsheet analysis
npx ruflo@alpha truth --format csv

# HTML report with visualizations
npx ruflo@alpha truth --format html --export report.html
```

**Real-time Monitoring:**
```bash
# Watch mode with live updates
npx ruflo@alpha truth --watch

# Export metrics automatically
npx ruflo@alpha truth --export .claude-flow$metrics$truth-$(date +%Y%m%d).json
```

#### Truth Score Dashboard

Example dashboard output:
```
📊 Truth Metrics Dashboard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Overall Truth Score: 0.947 ✅
Trend: ↗️ +2.3% (7d)

Top Performers:
  verification-agent   0.982 ⭐
  code-analyzer       0.971 ⭐
  test-generator      0.958 ✅

Needs Attention:
  refactor-agent      0.821 ⚠️
  docs-generator      0.794 ⚠️

Recent Tasks:
  task-456  0.991 ✅  "Implement auth"
  task-455  0.967 ✅  "Add tests"
  task-454  0.743 ❌  "Refactor API"
```

#### Metrics Explained

**Truth Scores (0.0-1.0):**
- `1.0-0.95`: Excellent ⭐ (production-ready)
- `0.94-0.85`: Good ✅ (acceptable quality)
- `0.84-0.75`: Warning ⚠️ (needs attention)
- `<0.75`: Critical ❌ (requires immediate action)

**Trend Indicators:**
- ↗️ Improving (positive trend)
- → Stable (consistent performance)
- ↘️ Declining (quality regression detected)

**Statistics:**
- **Mean Score**: Average truth score across all measurements
- **Median Score**: Middle value (less affected by outliers)
- **Standard Deviation**: Consistency of scores (lower = more consistent)
- **Confidence Interval**: Statistical reliability of measurements

### Verification Checks

#### Run Verification

Execute comprehensive verification checks on code, tasks, or agent outputs.

**File Verification:**
```bash
# Verify single file
npx ruflo@alpha verify check --file src$app.js

# Verify directory recursively
npx ruflo@alpha verify check --directory src/

# Verify with auto-fix enabled
npx ruflo@alpha verify check --file src$utils.js --auto-fix

# Verify current working directory
npx ruflo@alpha verify check
```

**Task Verification:**
```bash
# Verify specific task output
npx ruflo@alpha verify check --task task-123

# Verify with custom threshold
npx ruflo@alpha verify check --task task-456 --threshold 0.99

# Verbose output for debugging
npx ruflo@alpha verify check --task task-789 --verbose
```

**Batch Verification:**
```bash
# Verify multiple files in parallel
npx ruflo@alpha verify batch --files "*.js" --parallel

# Verify with pattern matching
npx ruflo@alpha verify batch --pattern "src/**/*.ts"

# Integration test suite
npx ruflo@alpha verify integration --test-suite full
```

#### Verification Criteria

The verification system evaluates:

1. **Code Correctness**
   - Syntax validation
   - Type checking (TypeScript)
   - Logic flow analysis
   - Error handling completeness

2. **Best Practices**
   - Code style adherence
   - SOLID principles
   - Design patterns usage
   - Modularity and reusability

3. **Security**
   - Vulnerability scanning
   - Secret detection
   - Input validation
   - Authentication$authorization checks

4. **Performance**
   - Algorithmic complexity
   - Memory usage patterns
   - Database query optimization
   - Bundle size impact

5. **Documentation**
   - JSDoc/TypeDoc completeness
   - README accuracy
   - API documentation
   - Code comments quality

#### JSON Output for CI/CD

```bash
# Get structured JSON output
npx ruflo@alpha verify check --json > verification.json

# Example JSON structure:
{
  "overallScore": 0.947,
  "passed": true,
  "threshold": 0.95,
  "checks": [
    {
      "name": "code-correctness",
      "score": 0.98,
      "passed": true
    },
    {
      "name": "security",
      "score": 0.91,
      "passed": false,
      "issues": [...]
    }
  ]
}
```

### Automatic Rollback

#### Rollback Failed Changes

Automatically revert changes that fail verification checks.

**Basic Rollback:**
```bash
# Rollback to last known good state
npx ruflo@alpha verify rollback --last-good

# Rollback to specific commit
npx ruflo@alpha verify rollback --to-commit abc123

# Interactive rollback with preview
npx ruflo@alpha verify rollback --interactive
```

**Smart Rollback:**
```bash
# Rollback only failed files (preserve good changes)
npx ruflo@alpha verify rollback --selective

# Rollback with automatic backup
npx ruflo@alpha verify rollback --backup-first

# Dry-run mode (preview without executing)
npx ruflo@alpha verify rollback --dry-run
```

**Rollback Performance:**
- Git-based rollback: <1 second
- Selective file rollback: <500ms
- Backup creation: Automatic before rollback

### Verification Reports

#### Generate Reports

Create detailed verification reports with metrics and visualizations.

**Report Formats:**
```bash
# JSON report
npx ruflo@alpha verify report --format json

# HTML report with charts
npx ruflo@alpha verify report --export metrics.html --format html

# CSV for data analysis
npx ruflo@alpha verify report --format csv --export metrics.csv

# Markdown summary
npx ruflo@alpha verify report --format markdown
```

**Time-based Reports:**
```bash
# Last 24 hours
npx ruflo@alpha verify report --period 24h

# Last 7 days
npx ruflo@alpha verify report --period 7d

# Last 30 days with trends
npx ruflo@alpha verify report --period 30d --include-trends

# Custom date range
npx ruflo@alpha verify report --from 2025-01-01 --to 2025-01-31
```

**Report Content:**
- Overall truth scores
- Per-agent performance metrics
- Task completion quality
- Verification pass$fail rates
- Rollback frequency
- Quality improvement trends
- Statistical confidence intervals

### Interactive Dashboard

#### Launch Dashboard

Run interactive web-based verification dashboard with real-time updates.

```bash
# Launch dashboard on default port (3000)
npx ruflo@alpha verify dashboard

# Custom port
npx ruflo@alpha verify dashboard --port 8080

# Export dashboard data
npx ruflo@alpha verify dashboard --export

# Dashboard with auto-refresh
npx ruflo@alpha verify dashboard --refresh 5s
```

**Dashboard Features:**
- Real-time truth score updates (WebSocket)
- Interactive charts and graphs
- Agent performance comparison
- Task history timeline
- Rollback history viewer
- Export to PDF/HTML
- Filter by time period$agent$score

### Configuration

#### Default Configuration

Set verification preferences in `.claude-flow$config.json`:

```json
{
  "verification": {
    "threshold": 0.95,
    "autoRollback": true,
    "gitIntegration": true,
    "hooks": {
      "preCommit": true,
      "preTask": true,
      "postEdit": true
    },
    "checks": {
      "codeCorrectness": true,
      "security": true,
      "performance": true,
      "documentation": true,
      "bestPractices": true
    }
  },
  "truth": {
    "defaultFormat": "table",
    "defaultPeriod": "24h",
    "warningThreshold": 0.85,
    "criticalThreshold": 0.75,
    "autoExport": {
      "enabled": true,
      "path": ".claude-flow$metrics$truth-daily.json"
    }
  }
}
```

#### Threshold Configuration

**Adjust verification strictness:**
```bash
# Strict mode (99% accuracy required)
npx ruflo@alpha verify check --threshold 0.99

# Lenient mode (90% acceptable)
npx ruflo@alpha verify check --threshold 0.90

# Set default threshold
npx ruflo@alpha config set verification.threshold 0.98
```

**Per-environment thresholds:**
```json
{
  "verification": {
    "thresholds": {
      "production": 0.99,
      "staging": 0.95,
      "development": 0.90
    }
  }
}
```

### Integration Examples

#### CI/CD Integration

**GitHub Actions:**
```yaml
name: verification-quality

on: [push, pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions$checkout@v3

      - name: Install Dependencies
        run: npm install

      - name: Run Verification
        run: |
          npx ruflo@alpha verify check --json > verification.json

      - name: Check Truth Score
        run: |
          score=$(jq '.overallScore' verification.json)
          if (( $(echo "$score < 0.95" | bc -l) )); then
            echo "Truth score too low: $score"
            exit 1
          fi

      - name: Upload Report
        uses: actions$upload-artifact@v3
        with:
          name: verification-report
          path: verification.json
```

**GitLab CI:**
```yaml
verify:
  stage: test
  script:
    - npx ruflo@alpha verify check --threshold 0.95 --json > verification.json
    - |
      score=$(jq '.overallScore' verification.json)
      if [ $(echo "$score < 0.95" | bc) -eq 1 ]; then
        echo "Verification failed with score: $score"
        exit 1
      fi
  artifacts:
    paths:
      - verification.json
    reports:
      junit: verification.json
```

#### Swarm Integration

Run verification automatically during swarm operations:

```bash
# Swarm with verification enabled
npx ruflo@alpha swarm --verify --threshold 0.98

# Hive Mind with auto-rollback
npx ruflo@alpha hive-mind --verify --rollback-on-fail

# Training pipeline with verification
npx ruflo@alpha train --verify --threshold 0.99
```

#### Pair Programming Integration

Enable real-time verification during collaborative development:

```bash
# Pair with verification
npx ruflo@alpha pair --verify --real-time

# Pair with custom threshold
npx ruflo@alpha pair --verify --threshold 0.97 --auto-fix
```

### Advanced Workflows

#### Continuous Verification

Monitor codebase continuously during development:

```bash
# Watch directory for changes
npx ruflo@alpha verify watch --directory src/

# Watch with auto-fix
npx ruflo@alpha verify watch --directory src/ --auto-fix

# Watch with notifications
npx ruflo@alpha verify watch --notify --threshold 0.95
```

#### Monitoring Integration

Send metrics to external monitoring systems:

```bash
# Export to Prometheus
npx ruflo@alpha truth --format json | \
  curl -X POST https:/$pushgateway.example.com$metrics$job$claude-flow \
  -d @-

# Send to DataDog
npx ruflo@alpha verify report --format json | \
  curl -X POST "https:/$api.datadoghq.com$api$v1$series?api_key=${DD_API_KEY}" \
  -H "Content-Type: application$json" \
  -d @-

# Custom webhook
npx ruflo@alpha truth --format json | \
  curl -X POST https:/$metrics.example.com$api$truth \
  -H "Content-Type: application$json" \
  -d @-
```

#### Pre-commit Hooks

Automatically verify before commits:

```bash
# Install pre-commit hook
npx ruflo@alpha verify install-hook --pre-commit

# .git$hooks$pre-commit example:
#!$bin$bash
npx ruflo@alpha verify check --threshold 0.95 --json > $tmp$verify.json

score=$(jq '.overallScore' $tmp$verify.json)
if (( $(echo "$score < 0.95" | bc -l) )); then
  echo "❌ Verification failed with score: $score"
  echo "Run 'npx ruflo@alpha verify check --verbose' for details"
  exit 1
fi

echo "✅ Verification passed with score: $score"
```

### Performance Metrics

**Verification Speed:**
- Single file check: <100ms
- Directory scan: <500ms (per 100 files)
- Full codebase analysis: <5s (typical project)
- Truth score calculation: <50ms

**Rollback Speed:**
- Git-based rollback: <1s
- Selective file rollback: <500ms
- Backup creation: <2s

**Dashboard Performance:**
- Initial load: <1s
- Real-time updates: <100ms latency (WebSocket)
- Chart rendering: 60 FPS

### Troubleshooting

#### Common Issues

**Low Truth Scores:**
```bash
# Get detailed breakdown
npx ruflo@alpha truth --verbose --threshold 0.0

# Check specific criteria
npx ruflo@alpha verify check --verbose

# View agent-specific issues
npx ruflo@alpha truth --agent <agent-name> --format json
```

**Rollback Failures:**
```bash
# Check git status
git status

# View rollback history
npx ruflo@alpha verify rollback --history

# Manual rollback
git reset --hard HEAD~1
```

**Verification Timeouts:**
```bash
# Increase timeout
npx ruflo@alpha verify check --timeout 60s

# Verify in batches
npx ruflo@alpha verify batch --batch-size 10
```

### Exit Codes

Verification commands return standard exit codes:

- `0`: Verification passed (score ≥ threshold)
- `1`: Verification failed (score < threshold)
- `2`: Error during verification (invalid input, system error)

### Related Commands

- `npx ruflo@alpha pair` - Collaborative development with verification
- `npx ruflo@alpha train` - Training with verification feedback
- `npx ruflo@alpha swarm` - Multi-agent coordination with quality checks
- `npx ruflo@alpha report` - Generate comprehensive project reports

### Best Practices

1. **Set Appropriate Thresholds**: Use 0.99 for critical code, 0.95 for standard, 0.90 for experimental
2. **Enable Auto-rollback**: Prevent bad code from persisting
3. **Monitor Trends**: Track improvement over time, not just current scores
4. **Integrate with CI/CD**: Make verification part of your pipeline
5. **Use Watch Mode**: Get immediate feedback during development
6. **Export Metrics**: Track quality metrics in your monitoring system
7. **Review Rollbacks**: Understand why changes were rejected
8. **Train Agents**: Use verification feedback to improve agent performance

### Additional Resources

- Truth Scoring Algorithm: See `$docs$truth-scoring.md`
- Verification Criteria: See `$docs$verification-criteria.md`
- Integration Examples: See `$examples$verification/`
- API Reference: See `$docs$api$verification.md`
