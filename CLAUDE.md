# Claude Code Configuration - Ruflo V3

> Public release train: `@claude-flow/cli`, `claude-flow`, and `ruflo`.
> Use package manifests and the registry as version truth; do not copy stale
> version or capability counts into agent guidance.

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files

## Capability Brain and Governed Implementation

Ruflo is the coordination ledger and policy decision point. Claude Code
executes code, tests, commands, and file changes. A Ruflo coordination call
records work; it does not perform the implementation.

When registered, call
`guidance_brain({ mode: "recommend", task: "..." })` before complex Ruflo
work. Use its live registry rather than guessing tool names. Treat
`registered`, `configured`, `reachable`, `healthy`, and `authorized` as
separate facts. If unavailable, continue with compatible guidance tools, CLI
discovery, and these repository instructions.

Use this loop: recall → inspect → route → plan → execute → test → validate →
benchmark → optimize → receipt → handoff → separately authorized publish.

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries

### Key Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@claude-flow/cli` | `v3/@claude-flow/cli/` | CLI entry point (26 commands) |
| `@claude-flow/codex` | `v3/@claude-flow/codex/` | Dual-mode Claude + Codex collaboration |
| `@claude-flow/guidance` | `v3/@claude-flow/guidance/` | Governance control plane |
| `@claude-flow/hooks` | `v3/@claude-flow/hooks/` | 17 hooks + 12 workers |
| `@claude-flow/memory` | `v3/@claude-flow/memory/` | AgentDB + HNSW search |
| `@claude-flow/security` | `v3/@claude-flow/security/` | Input validation, CVE remediation |

## Concurrent Automated Development

- Parallelize independent research, tests, reviews, and non-overlapping
  implementation.
- Never allow two writers in one worktree. Give every writing agent an isolated
  worktree and explicit file ownership.
- Read-only agents may share a checkout; writing agents may not.
- Only the integration owner edits shared manifests and lockfiles or reconciles
  overlapping changes.
- Continue independent local work after spawning agents; wait only when a real
  dependency blocks progress. Do not repeatedly poll.
- A lease or work claim coordinates ownership; it never grants authority.
- Bind tests, benchmarks, policy decisions, and handoffs to an exact clean
  commit or immutable dirty-worktree snapshot.
- Darwin, Flywheel, MetaHarness, memory, and neural systems may propose and
  evaluate candidates, but cannot self-promote or expand tools, network,
  secrets, spend, concurrency, or release authority.

---

## Swarm Orchestration

- MUST initialize the swarm using MCP tools when starting complex tasks
- MUST spawn concurrent agents using Claude Code's Task tool
- Never use MCP tools alone for execution — Task tool agents do the actual work

### MCP + Task Tool in SAME Message

- MUST call MCP tools AND Task tool in ONE message for complex work
- Always call MCP first, then IMMEDIATELY call Task tool to spawn agents

### 3-Tier Model Routing (ADR-026, ADR-143)

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Deterministic codemod | ~1ms | $0 | Structural transforms with **no LLM**: `var-to-const`, `remove-console`, `add-logging` |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks, low complexity (<30%) |
| **3** | Sonnet/Opus | 2-5s | $0.003-0.015 | Complex reasoning, architecture, security (>30%) |

- Always check for `[CODEMOD_AVAILABLE]` or `[TASK_MODEL_RECOMMENDATION]` before spawning agents
- When you see `[CODEMOD_AVAILABLE]`, call the `hooks_codemod` MCP tool (intent + file) — it applies the transform deterministically via the TypeScript compiler at $0, no LLM. Deterministic intents only: `var-to-const`, `remove-console`, `add-logging`
- `add-types`, `add-error-handling`, `async-await` need judgement and route to a model (Tier 2/3) — they are **not** $0 codemods (see ADR-143)
- Agent Booster (`agent-booster`) is a fast-apply merge engine for arbitrary LLM-produced edit snippets, not an intent-transform engine — it is **not** the Tier-1 path

## Swarm Configuration & Anti-Drift

### Anti-Drift Coding Swarm (PREFERRED DEFAULT)

- ALWAYS use hierarchical topology for coding swarms
- Keep maxAgents at 6-8 for tight coordination
- Use specialized strategy for clear role boundaries
- Use `raft` consensus for hive-mind (leader maintains authoritative state)
- Run frequent checkpoints via `post-task` hooks
- Keep shared memory namespace for all agents
- Keep task cycles short with verification gates

```javascript
mcp__ruv-swarm__swarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})
```

## Dual-Mode Collaboration (Claude Code + Codex)

This repository uses **dual-mode orchestration** to run Claude Code (🔵) and OpenAI Codex (🟢) workers in parallel with shared memory coordination. Both platforms collaborate on development tasks with cross-learning.

### Why Dual-Mode?

| Single Platform | Dual-Mode Collaboration |
|----------------|------------------------|
| One model's perspective | Two AI platforms cross-validating |
| Limited reasoning styles | Complementary strengths |
| No external verification | Built-in code review |
| Sequential workflows | Parallel execution |

### Dual-Mode Swarm Protocol

For complex tasks, spawn both Claude and Codex workers in parallel:

```javascript
// STEP 1: Initialize dual-mode swarm
mcp__ruv-swarm__swarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})

// STEP 2: Spawn BOTH platforms in parallel via Task tool
// 🔵 Claude Code workers (architecture, security, testing)
Task("Architect", "Design the implementation. Store design in memory namespace 'collaboration'.", "system-architect")
Task("Tester", "Write tests based on architect's design. Read from 'collaboration' namespace.", "tester")
Task("Reviewer", "Review code quality and security. Store findings in 'collaboration'.", "reviewer")

// 🟢 Codex workers (implementation, optimization)
// Spawn via CLI for Codex platform
Bash("npx claude-flow-codex dual run --worker 'codex:coder:Implement the solution based on architect design' --namespace collaboration")
Bash("npx claude-flow-codex dual run --worker 'codex:optimizer:Optimize performance based on implementation' --namespace collaboration")

// STEP 3: Coordinate via shared memory
Bash("npx claude-flow@v3alpha memory store --namespace collaboration --key 'task-context' --value '[task description]'")
```

### Collaboration Templates (Pre-Built Pipelines)

| Template | Workers | Pipeline |
|----------|---------|----------|
| `feature` | 🔵 Architect → 🟢 Coder → 🔵 Tester → 🟢 Reviewer | Full feature development |
| `security` | 🔵 Analyst → 🟢 Scanner → 🔵 Reporter | Security audit workflow |
| `refactor` | 🔵 Architect → 🟢 Refactorer → 🔵 Tester | Code modernization |
| `bugfix` | 🔵 Researcher → 🟢 Coder → 🔵 Tester | Bug investigation & fix |

### Dual-Mode CLI Commands

```bash
# Run a collaboration template
npx claude-flow-codex dual run feature --task "Add user authentication with OAuth"
npx claude-flow-codex dual run security --target "./src"
npx claude-flow-codex dual run refactor --target "./src/legacy"

# Custom multi-platform swarm
npx claude-flow-codex dual run \
  --worker "claude:architect:Design the API structure" \
  --worker "codex:coder:Implement REST endpoints" \
  --worker "claude:tester:Write integration tests" \
  --worker "codex:reviewer:Review code quality" \
  --namespace "api-feature"

# Check collaboration status
npx claude-flow-codex dual status

# List available templates
npx claude-flow-codex dual templates
```

### Shared Memory Coordination

All workers share state via the `collaboration` namespace:

```bash
# Store context for cross-platform sharing
npx claude-flow@v3alpha memory store --namespace collaboration --key "design-decisions" --value "..."

# Search for patterns across all workers
npx claude-flow@v3alpha memory search --namespace collaboration --query "authentication patterns"

# Retrieve specific findings
npx claude-flow@v3alpha memory retrieve --namespace collaboration --key "security-findings"
```

### Cross-Platform Learning

Both platforms learn from each other's outputs:

```bash
# After successful collaboration, train patterns
npx claude-flow@v3alpha hooks post-task --task-id "dual-[id]" --success true --train-neural true

# Store successful collaboration patterns
npx claude-flow@v3alpha memory store --namespace patterns --key "dual-mode-[pattern]" --value "[what worked]"

# Transfer learnings to both platforms
npx claude-flow@v3alpha hooks transfer store --pattern "dual-collab-success"
```

### Worker Dependency Levels

Workers execute in dependency order:

```
Level 0: [🔵 Architect]           # No dependencies - runs first
Level 1: [🟢 Coder, 🔵 Tester]    # Depends on Architect
Level 2: [🔵 Reviewer]            # Depends on Coder + Tester
Level 3: [🟢 Optimizer]           # Depends on Reviewer approval
```

### Platform Strengths

| Task Type | Preferred Platform | Reason |
|-----------|-------------------|--------|
| Architecture & Design | 🔵 Claude | Strong reasoning, system thinking |
| Implementation | 🟢 Codex | Fast code generation |
| Security Review | 🔵 Claude | Careful analysis, threat modeling |
| Performance Optimization | 🟢 Codex | Code-level optimizations |
| Testing Strategy | 🔵 Claude | Coverage analysis, edge cases |
| Refactoring | 🟢 Codex | Bulk code transformations |

### Programmatic API

```typescript
import { DualModeOrchestrator, CollaborationTemplates } from '@claude-flow/codex';

const orchestrator = new DualModeOrchestrator({
  namespace: 'my-feature',
  memoryBackend: 'hybrid'
});

// Use pre-built template
const workers = CollaborationTemplates.featureDevelopment('Add OAuth login');

// Run collaboration
const results = await orchestrator.runCollaboration(workers, 'Implement OAuth feature');

// Access shared memory
const designDocs = await orchestrator.getMemory('design-decisions');
```

---

## Swarm Protocols & Routing

### Auto-Start Swarm Protocol

When the user requests a complex task (multi-file changes, feature implementation, refactoring), **immediately execute this pattern in a SINGLE message:**

```javascript
// STEP 1: Initialize swarm coordination via MCP
mcp__ruv-swarm__swarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})

// STEP 2: Spawn NAMED agents concurrently — all in ONE message
// Each agent knows WHO to message next in the pipeline
Task({
  prompt: "Research requirements and codebase. SendMessage findings to 'architect' when done.",
  subagent_type: "researcher", name: "researcher", run_in_background: true
})
Task({
  prompt: "Wait for research from 'researcher'. Design implementation. SendMessage design to 'coder'.",
  subagent_type: "system-architect", name: "architect", run_in_background: true
})
Task({
  prompt: "Wait for design from 'architect'. Implement the solution. SendMessage code paths to 'tester'.",
  subagent_type: "coder", name: "coder", run_in_background: true
})
Task({
  prompt: "Wait for implementation from 'coder'. Write tests. SendMessage results to 'reviewer'.",
  subagent_type: "tester", name: "tester", run_in_background: true
})
Task({
  prompt: "Wait for test results from 'tester'. Review code quality and security. Report findings.",
  subagent_type: "reviewer", name: "reviewer", run_in_background: true
})

// STEP 3: Kick off the pipeline
SendMessage({ to: "researcher", summary: "Start research", message: "[task description and context]" })

// STEP 4: Batch todos
TodoWrite({ todos: [
  {content: "Research and analyze requirements", status: "in_progress", activeForm: "Researching"},
  {content: "Design architecture", status: "pending", activeForm: "Designing"},
  {content: "Implement solution", status: "pending", activeForm: "Implementing"},
  {content: "Write tests", status: "pending", activeForm: "Testing"},
  {content: "Review and finalize", status: "pending", activeForm: "Reviewing"}
]})

// Pipeline flow via SendMessage:
// researcher ──→ architect ──→ coder ──→ tester ──→ reviewer
```

### Agent Routing (Anti-Drift)

| Code | Task | Agents |
|------|------|--------|
| 1 | Bug Fix | coordinator, researcher, coder, tester |
| 3 | Feature | coordinator, architect, coder, tester, reviewer |
| 5 | Refactor | coordinator, architect, coder, reviewer |
| 7 | Performance | coordinator, perf-engineer, coder |
| 9 | Security | coordinator, security-architect, auditor |
| 11 | Memory | coordinator, memory-specialist, perf-engineer |
| 13 | Docs | researcher, api-docs |

**Codes 1-11: hierarchical/specialized (anti-drift). Code 13: mesh/balanced**

### Task Complexity Detection

**AUTO-INVOKE SWARM when task involves:**
- Multiple files (3+)
- New feature implementation
- Refactoring across modules
- API changes with tests
- Security-related changes
- Performance optimization
- Database schema changes

**SKIP SWARM for:**
- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes
- Quick questions/exploration

## Project Configuration

This project is configured with Claude Flow V3 (Anti-Drift Defaults):
- **Topology**: hierarchical (prevents drift via central coordination)
- **Max Agents**: 8 (smaller team = less drift)
- **Strategy**: specialized (clear roles, no overlap)
- **Consensus**: raft (leader maintains authoritative state)
- **Memory Backend**: hybrid (SQLite + AgentDB)
- **HNSW Indexing**: Enabled (measured ~1.9x at N=20k, ~3.2x–4.7x at N=5k vs brute force; ANN wins above the crossover)
- **Neural Learning**: Enabled (SONA)

## Development Commands

Local dev/build/test commands as defined in the repo's `package.json` files. Use these instead of inventing equivalents.

### Root (`package.json`)

```bash
# Install (CI uses --legacy-peer-deps)
npm ci --legacy-peer-deps          # Reproducible install used by CI
npm install --legacy-peer-deps     # Local install

# Dev / build
npm run dev                        # tsx watch src/index.ts
npm run build                      # tsc
npm run build:ts                   # cd v3/@claude-flow/cli && npm run build || true

# Test
npm test                           # vitest
npm run test:ui                    # vitest --ui
npm run test:security              # vitest run v3/__tests__/security/

# Lint (delegates to v3 cli)
npm run lint                       # cd v3/@claude-flow/cli && npm run lint || true

# Security
npm run security:audit             # npm audit --audit-level high
npm run security:fix               # npm audit fix
npm run security:test              # alias for test:security

# V3 aggregates
npm run v3:domains                 # build:domains
npm run v3:swarm                   # start:swarm
npm run v3:security                # security:audit && security:test
```

### V3 monorepo (`v3/package.json`, pnpm)

The `v3/` workspace is a pnpm monorepo. Install with `pnpm install --frozen-lockfile` (matches CI in `.github/workflows/v3-ci.yml`).

```bash
cd v3

# Install / build / typecheck (recursive across workspace packages)
pnpm install --frozen-lockfile
pnpm build                         # pnpm -r build
pnpm typecheck                     # pnpm -r typecheck
pnpm clean                         # rm -rf node_modules @claude-flow/*/node_modules claude-flow/node_modules

# Test
pnpm test                          # vitest run
pnpm test:unit                     # vitest run __tests__/unit
pnpm test:integration              # vitest run __tests__/integration
pnpm test:integration:watch        # vitest watch __tests__/integration
pnpm test:integration:memory       # memory-integration.test.ts
pnpm test:integration:swarm        # swarm-integration.test.ts
pnpm test:integration:mcp          # mcp-integration.test.ts
pnpm test:integration:plugin       # plugin-integration.test.ts
pnpm test:integration:workflow     # workflow-integration.test.ts
pnpm test:coverage                 # vitest run --coverage
pnpm test:coverage:integration     # __tests__/integration with coverage

# Per-package test filters
pnpm test:security                 # pnpm --filter @claude-flow/security test
pnpm test:memory                   # pnpm --filter @claude-flow/memory test
pnpm test:swarm                    # pnpm --filter @claude-flow/swarm test

# Benchmarks
pnpm bench                         # pnpm --filter @claude-flow/performance bench
pnpm bench:attention               # pnpm --filter @claude-flow/performance bench:attention

# Versioning / publish
pnpm version:patch                 # pnpm -r exec npm version patch
pnpm version:minor                 # pnpm -r exec npm version minor
pnpm version:major                 # pnpm -r exec npm version major
pnpm publish:dry                   # pnpm --filter claude-flow publish --dry-run --tag v3alpha --no-git-checks
pnpm publish:v3alpha               # pnpm --filter claude-flow publish --tag v3alpha --no-git-checks

# Bun alternates (optional)
pnpm bun:install                   # bun install
pnpm bun:build                     # bun run --filter '*' build
pnpm bun:test                      # bun test
pnpm bun:dev                       # bun run --watch src/index.ts
pnpm bun:publish:dry               # cd claude-flow && bun publish --dry-run --tag v3alpha
pnpm bun:publish:v3alpha           # cd claude-flow && bun publish --tag v3alpha
```

### V3 CLI package (`v3/@claude-flow/cli/package.json`)

```bash
cd v3/@claude-flow/cli
npm run build                      # tsc
npm test                           # vitest run
npm run test:plugin-store          # npx tsx src/plugins/tests/standalone-test.ts
npm run test:pattern-store         # npx tsx src/transfer/store/tests/standalone-test.ts
npm run release                    # npm version prerelease --preid=alpha && npm run publish:all
npm run publish:all                # ./scripts/publish.sh
```

### `ruflo/` umbrella alias (`ruflo/package.json`)

The `ruflo` package is a thin wrapper users run via `npx ruflo@alpha`. Its scripts run the bundled MCP bridge and Docker compose stack.

```bash
cd ruflo

# Bridge (Node MCP server)
npm run dev                        # node src/mcp-bridge/index.js
npm run dev:bridge                 # node --watch src/mcp-bridge/index.js
npm run dev:test                   # node src/mcp-bridge/test-harness.js
npm start                          # node src/mcp-bridge/index.js
npm run install:bridge             # cd src/mcp-bridge && npm install

# Docker compose
npm run docker:up                  # docker compose up -d
npm run docker:down                # docker compose down
npm run docker:build               # docker compose build
npm run docker:logs                # docker compose logs -f

# Generators / packaging
npm run generate:config            # node src/scripts/generate-config.js
npm run generate:welcome           # node src/scripts/generate-welcome.js
npm run deploy                     # bash src/scripts/deploy.sh
npm run package:rvf                # bash src/scripts/package-rvf.sh
```

### Repo helper scripts (`scripts/`)

```bash
bash scripts/install.sh                       # Local install / setup
bash scripts/cleanup-v3.sh                    # Reset v3 build artifacts
bash scripts/verify-appliance.sh              # Appliance smoke verification
node scripts/inventory-capabilities.mjs       # Generate capability inventory
node scripts/regenerate-witness.mjs           # Rebuild witness file
node scripts/sign-witness-from-inventory.mjs  # Sign witness from inventory
```

## V3 CLI Commands (26 Commands, 140+ Subcommands)

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization with wizard, presets, skills, hooks |
| `agent` | 8 | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm` | 6 | Multi-agent swarm coordination and orchestration |
| `memory` | 11 | AgentDB memory with HNSW vector search (measured ~1.9x–4.7x vs brute force above crossover) |
| `mcp` | 9 | MCP server management and tool execution |
| `task` | 6 | Task creation, assignment, and lifecycle |
| `session` | 7 | Session state management and persistence |
| `config` | 7 | Configuration management and provider setup |
| `status` | 3 | System status monitoring with watch mode |
| `start` | 3 | Service startup and quick launch |
| `workflow` | 6 | Workflow execution and template management |
| `hooks` | 17 | Self-learning hooks + 12 background workers |
| `hive-mind` | 6 | Queen-led Byzantine fault-tolerant consensus |

### Advanced Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `daemon` | 5 | Background worker daemon (start, stop, status, trigger, enable) |
| `neural` | 5 | Neural pattern training (train, status, patterns, predict, optimize) |
| `security` | 6 | Security scanning (scan, audit, cve, threats, validate, report) |
| `performance` | 5 | Performance profiling (benchmark, profile, metrics, optimize, report) |
| `providers` | 5 | AI providers (list, add, remove, test, configure) |
| `plugins` | 5 | Plugin management (list, install, uninstall, enable, disable) |
| `deployment` | 5 | Deployment management (deploy, rollback, status, environments, release) |
| `embeddings` | 4 | Vector embeddings (embed, batch, search, init) — agentic-flow ONNX backend (speedup unverified, no benchmark) |
| `claims` | 4 | Claims-based authorization (check, grant, revoke, list) |
| `migrate` | 5 | V2 to V3 migration with rollback support |
| `process` | 4 | Background process management |
| `doctor` | 1 | System diagnostics with health checks |
| `completions` | 4 | Shell completions (bash, zsh, fish, powershell) |

### Quick CLI Examples

```bash
# Initialize project
npx claude-flow@v3alpha init --wizard

# Start daemon with background workers
npx claude-flow@v3alpha daemon start

# Spawn an agent
npx claude-flow@v3alpha agent spawn -t coder --name my-coder

# Initialize swarm
npx claude-flow@v3alpha swarm init --v3-mode

# Search memory (HNSW-indexed)
npx claude-flow@v3alpha memory search -q "authentication patterns"

# System diagnostics
npx claude-flow@v3alpha doctor --fix

# Security scan
npx claude-flow@v3alpha security scan --depth full

# Performance benchmark
npx claude-flow@v3alpha performance benchmark --suite all
```

## Headless Background Instances (claude -p)

Use `claude -p` (print/pipe mode) to spawn headless Claude instances for parallel background work. These run non-interactively and return results to stdout.

### Basic Usage

```bash
# Single headless task
claude -p "Analyze the authentication module for security issues"

# With model selection
claude -p --model haiku "Format this config file"
claude -p --model opus "Design the database schema for user management"

# With output format
claude -p --output-format json "List all TODO comments in src/"
claude -p --output-format stream-json "Refactor the error handling in api.ts"

# With budget limits
claude -p --max-budget-usd 0.50 "Run comprehensive security audit"

# With specific tools allowed
claude -p --allowedTools "Read,Grep,Glob" "Find all files that import the auth module"

# Skip permissions (sandboxed environments only)
claude -p --dangerously-skip-permissions "Fix all lint errors in src/"
```

### Parallel Background Execution

```bash
# Spawn multiple headless instances in parallel
claude -p "Analyze src/auth/ for vulnerabilities" &
claude -p "Write tests for src/api/endpoints.ts" &
claude -p "Review src/models/ for performance issues" &
wait  # Wait for all to complete

# With results captured
SECURITY=$(claude -p "Security audit of auth module" &)
TESTS=$(claude -p "Generate test coverage report" &)
PERF=$(claude -p "Profile memory usage in workers" &)
wait
echo "$SECURITY" "$TESTS" "$PERF"
```

### Session Continuation

```bash
# Start a task, resume later
claude -p --session-id "abc-123" "Start analyzing the codebase"
claude -p --resume "abc-123" "Continue with the test files"

# Fork a session for parallel exploration
claude -p --resume "abc-123" --fork-session "Try approach A: event sourcing"
claude -p --resume "abc-123" --fork-session "Try approach B: CQRS pattern"
```

### Key Flags

| Flag | Purpose |
|------|---------|
| `-p, --print` | Non-interactive mode, print and exit |
| `--model <model>` | Select model (haiku, sonnet, opus) |
| `--output-format <fmt>` | Output: text, json, stream-json |
| `--max-budget-usd <amt>` | Spending cap per invocation |
| `--allowedTools <tools>` | Restrict available tools |
| `--append-system-prompt` | Add custom instructions |
| `--resume <id>` | Continue a previous session |
| `--fork-session` | Branch from resumed session |
| `--fallback-model <model>` | Auto-fallback if primary overloaded |
| `--permission-mode <mode>` | acceptEdits, bypassPermissions, plan, etc. |
| `--mcp-config <json>` | Load MCP servers from JSON |

## Available Agents (60+ Types)

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### V3 Specialized Agents
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### @claude-flow/security Module
CVE remediation, input validation, path security:
- `InputValidator` — Zod-based validation at boundaries
- `PathValidator` — Path traversal prevention
- `SafeExecutor` — Command injection protection
- `PasswordHasher` — bcrypt hashing
- `TokenGenerator` — Secure token generation

### Token Optimizer (Agent Booster)
Integrates agentic-flow optimizations for 30-50% token reduction:
```typescript
import { getTokenOptimizer } from '@claude-flow/integration';
const optimizer = await getTokenOptimizer();

// Compact context (32% fewer tokens)
const ctx = await optimizer.getCompactContext("auth patterns");

// 352x faster edits = fewer retries
await optimizer.optimizedEdit(file, old, new, "typescript");

// Optimal config (100% success rate)
const config = optimizer.getOptimalConfig(agentCount);
```
| Feature | Token Savings |
|---------|---------------|
| ReasoningBank retrieval | -32% |
| Agent Booster edits | -15% |
| Cache (95% hit rate) | -10% |
| Optimal batch size | -20% |

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`, `collective-intelligence-coordinator`, `swarm-memory-manager`

### Consensus & Distributed
`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`, `consensus-builder`, `crdt-synchronizer`, `quorum-manager`, `security-manager`

### Performance & Optimization
`perf-analyzer`, `performance-benchmarker`, `task-orchestrator`, `memory-coordinator`, `smart-agent`

### GitHub & Repository
`github-modes`, `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`, `workflow-automation`, `project-board-sync`, `repo-architect`, `multi-repo-swarm`

### SPARC Methodology
`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`, `refinement`

### Specialized Development
`backend-dev`, `mobile-dev`, `ml-developer`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

### Testing & Validation
`tdd-london-swarm`, `production-validator`

## Agent Teams & Comms System

Agent Teams turns Claude Code into a multi-agent system where named agents communicate in real-time via `SendMessage`. The comms system is the primary coordination mechanism — agents talk to each other, not just to the lead.

### Architecture

```
Team Lead (you)
  ├── SendMessage ←→ architect (named agent)
  ├── SendMessage ←→ developer (named agent)
  ├── SendMessage ←→ tester (named agent)
  └── SendMessage ←→ reviewer (named agent)
       ↕ agents can message each other by name
```

### Core Principle: Named Agents + SendMessage

Every agent MUST have a `name` so it's addressable. Communication happens via `SendMessage`, not polling or shared memory.

```javascript
// STEP 1: Spawn named agents (all in ONE message, background)
Task({
  prompt: "Design the API. When done, send your design to 'developer' via SendMessage.",
  subagent_type: "system-architect",
  name: "architect",
  run_in_background: true
})
Task({
  prompt: "Wait for architect's design via SendMessage. Then implement it. Send code to 'tester'.",
  subagent_type: "coder",
  name: "developer",
  run_in_background: true
})
Task({
  prompt: "Wait for developer's code via SendMessage. Write tests. Send results to 'reviewer'.",
  subagent_type: "tester",
  name: "tester",
  run_in_background: true
})

// STEP 2: Kick off the pipeline by messaging the first agent
SendMessage({
  to: "architect",
  summary: "Start API design",
  message: "Design a REST API for user management with CRUD endpoints. Send the design to 'developer' when done."
})
```

### SendMessage Protocol

```javascript
// Lead → Teammate: assign work
SendMessage({ to: "developer", summary: "Implement auth", message: "Build OAuth2 flow..." })

// Lead → Teammate: redirect priorities
SendMessage({ to: "developer", summary: "Prioritize auth", message: "Auth endpoint is blocking tester, do it first." })

// Lead → Teammate: provide context from another agent's results
SendMessage({ to: "tester", summary: "Architect output", message: "The architect designed these endpoints: [details]. Write tests for them." })

// Lead → Teammate: graceful shutdown
SendMessage({ to: "developer", message: { type: "shutdown_request" } })
```

### Coordination Patterns

**Pipeline (A → B → C)** — each agent messages the next when done:
```
architect ──SendMessage──→ developer ──SendMessage──→ tester ──SendMessage──→ reviewer
```
Tell each agent WHO to message next in their prompt.

**Fan-out / Fan-in** — lead spawns parallel agents, collects results:
```
         ┌→ researcher-1 ──→┐
lead ────┼→ researcher-2 ──→├──→ lead synthesizes
         └→ researcher-3 ──→┘
```
Spawn with `run_in_background: true`. Results arrive as task completions.

**Supervisor / Worker** — lead assigns, workers report back:
```
lead ←──SendMessage──→ worker-1
lead ←──SendMessage──→ worker-2
lead ←──SendMessage──→ worker-3
```
Lead sends tasks via SendMessage, workers respond with results.

### Agent Prompt Template (Comms-Aware)

When spawning agents that need to coordinate, include comms instructions:

```javascript
Task({
  prompt: `You are the architect for this feature team.

YOUR TASK: Design the database schema for user management.

COMMS PROTOCOL:
- When your design is ready, send it to "developer" via SendMessage
- If you need clarification, message the team lead (just output text)
- Include file paths and key decisions in your message

DELIVERABLE: Schema design with entity relationships, indexes, and migration plan.`,
  subagent_type: "system-architect",
  name: "architect",
  run_in_background: true
})
```

### Full Team Spawn Example

```javascript
// Create shared task list first
TaskCreate({ subject: "Design schema", description: "...", activeForm: "Designing" })
TaskCreate({ subject: "Implement models", description: "...", activeForm: "Implementing" })
TaskCreate({ subject: "Write tests", description: "...", activeForm: "Testing" })
TaskCreate({ subject: "Security review", description: "...", activeForm: "Reviewing" })

// Spawn ALL named agents in ONE message
Task({
  prompt: "Design the schema. SendMessage to 'developer' with your design when done. Update task #1.",
  subagent_type: "system-architect", name: "architect", run_in_background: true
})
Task({
  prompt: "Wait for schema from 'architect'. Implement models + endpoints. SendMessage to 'tester'. Update task #2.",
  subagent_type: "coder", name: "developer", run_in_background: true
})
Task({
  prompt: "Wait for code from 'developer'. Write integration tests. SendMessage results to 'security'. Update task #3.",
  subagent_type: "tester", name: "tester", run_in_background: true
})
Task({
  prompt: "Wait for test results from 'tester'. Review for vulnerabilities. Update task #4.",
  subagent_type: "security-auditor", name: "security", run_in_background: true
})
```

### Agent Teams Hooks

| Hook | Trigger | Purpose |
|------|---------|---------|
| `TeammateIdle` | Teammate finishes turn | Auto-assign pending tasks via SendMessage |
| `TaskCompleted` | Task marked complete | Train patterns, notify lead via SendMessage |

```bash
npx claude-flow@v3alpha hooks teammate-idle --auto-assign true
npx claude-flow@v3alpha hooks task-completed -i task-123 --train-patterns true
```

### Rules

1. **Always name agents** — use `name: "role-name"` so they're addressable
2. **Comms over memory** — use SendMessage for real-time coordination, memory for persistence
3. **Pipeline prompts** — tell each agent WHO to message next and WHAT to send
4. **Spawn all at once** — all Task calls in ONE message with `run_in_background: true`
5. **Don't poll** — agents message back when done; wait for task completion notifications
6. **Graceful shutdown** — send `{ type: "shutdown_request" }` before TeamDelete
7. **Lead synthesizes** — when agents complete, review ALL results before responding to user

## V3 Hooks System (17 Hooks + 12 Workers)

### Hook Categories

| Category | Hooks | Purpose |
|----------|-------|---------|
| **Core** | `pre-edit`, `post-edit`, `pre-command`, `post-command`, `pre-task`, `post-task` | Tool lifecycle |
| **Session** | `session-start`, `session-end`, `session-restore`, `notify` | Context management |
| **Intelligence** | `route`, `explain`, `pretrain`, `build-agents`, `transfer` | Neural learning |
| **Learning** | `intelligence` (trajectory-start/step/end, pattern-store/search, stats, attention) | Reinforcement |
| **Agent Teams** | `teammate-idle`, `task-completed` | Multi-agent coordination |

### 12 Background Workers

| Worker | Priority | Description |
|--------|----------|-------------|
| `ultralearn` | normal | Deep knowledge acquisition |
| `optimize` | high | Performance optimization |
| `consolidate` | low | Memory consolidation |
| `predict` | normal | Predictive preloading |
| `audit` | critical | Security analysis |
| `map` | normal | Codebase mapping |
| `preload` | low | Resource preloading |
| `deepdive` | normal | Deep code analysis |
| `document` | normal | Auto-documentation |
| `refactor` | normal | Refactoring suggestions |
| `benchmark` | normal | Performance benchmarking |
| `testgaps` | normal | Test coverage analysis |

### Essential Hook Commands

```bash
# Core hooks
npx claude-flow@v3alpha hooks pre-task --description "[task]"
npx claude-flow@v3alpha hooks post-task --task-id "[id]" --success true
npx claude-flow@v3alpha hooks post-edit --file "[file]" --train-patterns

# Session management
npx claude-flow@v3alpha hooks session-start --session-id "[id]"
npx claude-flow@v3alpha hooks session-end --export-metrics true
npx claude-flow@v3alpha hooks session-restore --session-id "[id]"

# Intelligence routing
npx claude-flow@v3alpha hooks route --task "[task]"
npx claude-flow@v3alpha hooks explain --topic "[topic]"

# Neural learning
npx claude-flow@v3alpha hooks pretrain --model-type moe --epochs 10
npx claude-flow@v3alpha hooks build-agents --agent-types coder,tester

# Background workers
npx claude-flow@v3alpha hooks worker list
npx claude-flow@v3alpha hooks worker dispatch --trigger audit
npx claude-flow@v3alpha hooks worker status
```

## Intelligence System (RuVector)

V3 includes the RuVector Intelligence System (measured numbers: see [audit](docs/reviews/intelligence-system-audit-2026-05-29.md) + [`scripts/benchmark-intelligence.mjs`](scripts/benchmark-intelligence.mjs)):
- **SONA**: Self-Optimizing Neural Architecture (measured 0.0043ms/adapt, target <0.05ms met)
- **MoE**: Mixture of Experts for specialized routing (gate converges — confidence 0.13→0.88 after rewards)
- **HNSW**: measured ~1.9x at N=20k, ~3.2x–4.7x at N=5k vs brute force (recall@10 ~0.99); ANN wins above the crossover, ruvector NAPI backend (WASM not active on test host)
- **EWC++**: Elastic Weight Consolidation (prevents forgetting)
- **Flash Attention**: integration available; speedup dropped from docs pending an in-tree benchmark (was: 2.49x–7.47x, inherited unverified from upstream — removed to avoid a credibility claim we can't reproduce)

The 4-step intelligence pipeline:
1. **RETRIEVE** — Fetch relevant patterns via HNSW
2. **JUDGE** — Evaluate with verdicts (success/failure)
3. **DISTILL** — Extract key learnings via LoRA
4. **CONSOLIDATE** — Prevent catastrophic forgetting via EWC++

## Embeddings Package (v3.0.0-alpha.12)

Features:
- **sql.js**: Cross-platform SQLite persistent cache (WASM, no native compilation)
- **Document chunking**: Configurable overlap and size
- **Normalization**: L2, L1, min-max, z-score
- **Hyperbolic embeddings**: Poincare ball model for hierarchical data
- **agentic-flow ONNX integration**: speedup unverified (no benchmark; backend reported `onnx`, model all-MiniLM-L6-v2, 384-dim)
- **Neural substrate**: Integration with RuVector

## Hive-Mind Consensus

### Topologies
- `hierarchical` — Queen controls workers directly
- `mesh` — Fully connected peer network
- `hierarchical-mesh` — Hybrid (recommended)
- `adaptive` — Dynamic based on load

### Consensus Strategies
- `byzantine` — BFT (tolerates f < n/3 faulty)
- `raft` — Leader-based (tolerates f < n/2)
- `gossip` — Epidemic for eventual consistency
- `crdt` — Conflict-free replicated data types
- `quorum` — Configurable quorum-based

## V3 Performance Targets

> Source of truth: [`docs/reviews/intelligence-system-audit-2026-05-29.md`](docs/reviews/intelligence-system-audit-2026-05-29.md) + [`scripts/benchmark-intelligence.mjs`](scripts/benchmark-intelligence.mjs). Numbers below are measured unless marked "target/unverified".

| Metric | Measured / Target | Status |
|--------|-------------------|--------|
| HNSW Search | ~1.9x at N=20k, ~3.2x–4.7x at N=5k vs brute force (recall@10 ~0.99); ties/loses below crossover | **Measured** (ruvector NAPI; 150x-12,500x NOT reproduced — was brute-force fallback) |
| Int8 Quantization | 3.84x compression, reconstruction cosine 0.99999 | **Measured** |
| RaBitQ Quantization | 32x compression, 0.60ms/query (14,760-vec index) | **Measured** |
| SONA Adaptation | 0.0043ms/adapt (target <0.05ms met) | **Measured** |
| MoE Gate | converges — confidence 0.13→0.88, Q 0→99.8 after rewards | **Measured** |
| Flash Attention | integration available; measured speedup pending benchmark | **Not measured** — prior "2.49x–7.47x" figure was inherited from upstream marketing, never reproduced in-tree; dropped to avoid a credibility claim we can't verify |
| MCP Response | <100ms | target |
| CLI Startup | <500ms | target |

## Environment Variables

```bash
# Configuration
CLAUDE_FLOW_CONFIG=./claude-flow.config.json
CLAUDE_FLOW_LOG_LEVEL=info

# Provider API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# MCP Server
CLAUDE_FLOW_MCP_PORT=3000
CLAUDE_FLOW_MCP_HOST=localhost
CLAUDE_FLOW_MCP_TRANSPORT=stdio

# Memory
CLAUDE_FLOW_MEMORY_BACKEND=hybrid
CLAUDE_FLOW_MEMORY_PATH=./data/memory
```

## Doctor Health Checks

Run `npx claude-flow@v3alpha doctor` to check:
- Node.js version (20+)
- npm version (9+)
- Git installation
- Config file validity
- Daemon status
- Memory database
- API keys
- MCP servers
- Disk space
- TypeScript installation

## Quick Setup

```bash
# Add MCP servers
claude mcp add claude-flow -- npx -y ruflo@latest mcp start
claude mcp add ruv-swarm npx ruv-swarm mcp start  # Optional
claude mcp add flow-nexus npx flow-nexus@latest mcp start  # Optional

# Start daemon
npx claude-flow@v3alpha daemon start

# Run doctor
npx claude-flow@v3alpha doctor --fix
```

## Claude Code vs MCP Tools

### Claude Code Handles ALL EXECUTION:
- **Task tool**: Spawn and run agents concurrently
- File operations (Read, Write, Edit, MultiEdit, Glob, Grep)
- Code generation and programming
- Bash commands and system operations
- TodoWrite and task management
- Git operations

### MCP Tools ONLY COORDINATE:
- Swarm initialization (topology setup)
- Agent type definitions
- Task orchestration
- Memory management
- Neural features
- Performance tracking

- Keep MCP for coordination strategy only — use Claude Code's Task tool for real execution

## Claude Code ↔ AgentDB Memory Bridge

Claude Code's auto-memory (`~/.claude/projects/*/memory/*.md`) is bridged to AgentDB with ONNX vector embeddings for semantic search.

### MCP Tools

| Tool | Description |
|------|-------------|
| `memory_import_claude` | Import Claude Code memories into AgentDB with 384-dim ONNX embeddings. Use `allProjects: true` to import from ALL projects. |
| `memory_bridge_status` | Show bridge health — Claude files, AgentDB entries, SONA state, connection status |
| `memory_search_unified` | Semantic search across ALL namespaces (claude-memories, auto-memory, patterns, tasks, feedback) |

### Auto-Import on Session Start

The `SessionStart` hook automatically imports current project's memories into AgentDB. For manual import of all projects:

```bash
# Via MCP tool (from Claude Code)
memory_import_claude({ allProjects: true })

# Via helper hook (from terminal)
node .claude/helpers/auto-memory-hook.mjs import-all
```

### Unified Search

Search across both Claude Code memories and AgentDB entries:

```bash
# Via MCP tool
memory_search_unified({ query: "authentication security", limit: 5 })

# Results include source attribution: claude-code, auto-memory, or agentdb
```

### Intelligence Pipeline

| Component | Status | Details |
|-----------|--------|---------|
| ONNX Embeddings | Active | all-MiniLM-L6-v2, 384 dimensions |
| SONA Learning | Active | Pattern matching + trajectory recording |
| ReasoningBank | Active | Pattern storage with file persistence |
| AgentDB sql.js | Active | SQLite with vector_indexes table |

## Publishing to npm

### Versioning policy (stable releases — alpha series ended at 3.7.0-alpha.81, 2026-05-23)

- **From 3.7.0 onward we ship stable semver**, NOT alpha pre-releases.
- Bump rules (semver discipline):
  - **PATCH** (3.7.0 → 3.7.1): bug fixes only, no API change, no schema change
  - **MINOR** (3.7.0 → 3.8.0): backward-compatible additions (new MCP tool, new flag, new agent type)
  - **MAJOR** (3.x → 4.0.0): breaking change in CLI surface, MCP tool signature, file layout, or default behavior
- Default tag is `latest` (no `--tag alpha`). The `alpha` and `v3alpha` dist-tags continue to exist for historical compatibility — point them at the same version as `latest`.
- Never publish a pre-release (`-alpha.N`, `-beta.N`, `-rc.N`) unless the user explicitly asks for a pre-release flow.

### Publishing Rules

- The normal public release train is exactly THREE packages:
  `@claude-flow/cli`, `claude-flow`, and `ruflo`.
- Internal `@claude-flow/*` components are bundled into the public artifacts;
  do not publish them standalone as part of the normal release.
- MUST update ALL dist-tags for ALL THREE packages after publishing (latest + alpha + v3alpha all point to the same version)
- Publish order: `@claude-flow/cli` first, then `claude-flow` (umbrella), then `ruflo` (alias umbrella)
- MUST run verification for ALL THREE before telling user publishing is complete
- Run `node scripts/audit-umbrella-version-lockstep.mjs` before packing or
  publishing.
- Publish from a clean reviewed commit/tag-equivalent worktree. Do not ship
  unrelated uncommitted changes.
- A fresh worktree has two separate dependency trees to install before anything
  builds: `npm install` at repo root (npm workspaces), AND `pnpm install` inside
  `v3/` (a separate pnpm workspace — root `prepare-root-publish.mjs` shells out to
  `pnpm --filter` to build `v3/@claude-flow/{shared,hooks,guidance}`, which fails
  with `spawn ENOENT` on `tsc` if `v3/node_modules` was never populated).
- Use the existing authenticated `ruvnet` npm session. Do not replace it with a
  token from another GCP project.

**`npm publish` auth — FIXED (2026-07-30):** use the `NPM_TOKEN` secret directly,
via a throwaway `.npmrc` with `NPM_CONFIG_USERCONFIG` — same pattern as the
helpers-signing-key handling. It is mirrored in two GCP projects — `ruv-dev`
(version 3+) and `cognitum-20260110` (version 7+) — so either project's copy
is current; use whichever `gcloud` session is already authenticated. This is a
granular access token ("ruflo publishjing", expires 2026-10-28) with
`package: write` + `bypass_2fa: true`, scoped broadly enough to cover
`@claude-flow/cli`, `claude-flow`, and `ruflo` (plus the `cognitum`/
`cognitum-one` orgs). Confirmed end-to-end against the real registry (not just
a permissions probe): `npm publish` for `@claude-flow/cli` succeeded via this
token with zero OTP/WebAuthn prompt, and
`npm dist-tag add` against both a scoped (`@claude-flow/cli`) and unscoped
(`claude-flow`) package also went through with no prompt.

**Why the earlier `NPM_TOKEN` version failed:** versions 1/2 of that secret
were older classic automation tokens, and npm has been restricting tokens that
bypass 2FA for writes account-wide (the login flow prints this notice —
`gh.io/npm-gat-bypass2fa-deprecation`). Version 3 is a **granular access
token** created explicitly for this purpose, which is npm's supported
replacement path (its own 2FA-bypass flag still works for a granular token,
unlike the deprecated classic automation tokens). If this token's `bypass_2fa`
flag or scope ever gets narrowed/expired (check expiry above), the fallback
is the WebAuthn dance below — but try this path first every time.

```bash
gcloud secrets versions access latest --secret=NPM_TOKEN --project=ruv-dev > /tmp/.npmrc-publish-raw
printf '//registry.npmjs.org/:_authToken=%s\n' "$(cat /tmp/.npmrc-publish-raw)" > /tmp/.npmrc-publish
rm -f /tmp/.npmrc-publish-raw
NPM_CONFIG_USERCONFIG=/tmp/.npmrc-publish npm publish   # from the package dir, with signing-key env vars for @claude-flow/cli
NPM_CONFIG_USERCONFIG=/tmp/.npmrc-publish npm dist-tag add <pkg>@<version> alpha
NPM_CONFIG_USERCONFIG=/tmp/.npmrc-publish npm dist-tag add <pkg>@<version> v3alpha
shred -u /tmp/.npmrc-publish 2>/dev/null || rm -f /tmp/.npmrc-publish   # ALWAYS clean up, same discipline as the signing key
```

**Fallback — WebAuthn procedure, if the token above is dead:** the `ruvnet`
account's 2FA method is a WebAuthn security key, not TOTP (no numeric
`--otp=<code>` exists). This must be driven by the human (an agent cannot
approve a WebAuthn browser prompt):
1. Human goes to npmjs.com → account 2FA settings → turns OFF "Require
   two-factor authentication for write actions" (narrows to auth-only, not a
   full 2FA disable), then runs `npm login` in their own terminal to refresh
   the session under the new setting.
2. Agent can then run `npm publish` directly via Bash with no further prompt.
3. **`npm dist-tag add` still requires a fresh WebAuthn approval PER CALL**
   regardless of the write-2FA setting — 6 individual browser approvals for a
   3-package release (alpha + v3alpha × 3), not 1. Tell the human up front.
- After every dist-tag call (or if unsure), verify with
  `npm view <pkg> dist-tags --json` — don't trust the CLI's own stdout alone, since
  a WebAuthn prompt that's still pending in the browser produces no terminal
  output an agent can see.
- Confirm the version actually landed (`npm view <pkg>@<version> version`) before
  telling the user publishing succeeded, same reasoning: a mid-publish approval
  that never gets answered fails silently from an agent's point of view.

**Helpers signing key (required for `@claude-flow/cli` publish):** `npm publish`'s
`prepublishOnly` runs `scripts/sign-helpers.mjs`, which needs a private key to sign
`.claude/helpers/helpers.manifest.json`. The secret lives in GCP Secret Manager in the
**`ruv-dev`** project (not `cognitum-20260110` or `claude-flow` — checked both, not there),
secret name `ruflo-helpers-signing-key`:

```bash
cd v3/@claude-flow/cli
RUFLO_HELPERS_SIGNING_SECRET=ruflo-helpers-signing-key RUFLO_HELPERS_SIGNING_PROJECT=ruv-dev \
  npm publish
```

(`ruv-dev` also holds `ruflo-config-signing-key`; do not replace the existing
authenticated npm session with a token from another project.)

**Handling the signing key without leaking it (learned 2026-07-14, hard way):**
an earlier Windows path invoked `gcloud` without its required `.cmd` suffix. The
fallback command printed the PEM into captured tool output and a session transcript.
GCP secret v1 was destroyed and a fresh v2 was rotated in (commit 0052b1b06 /
PR #2673). `sign-helpers.mjs` now selects `gcloud.cmd` on Windows and supports a
stdin-only fallback. **Rules:**
- NEVER invoke `gcloud secrets versions access` in a way that lets the payload reach
  tool output. Use the built-in `RUFLO_HELPERS_SIGNING_SECRET` path above, or pipe
  directly into the signer:
  `gcloud secrets versions access latest --secret=ruflo-helpers-signing-key --project=ruv-dev | node scripts/sign-helpers.mjs --stdin-key`.
- `--stdin-key` refuses interactive entry, validates Ed25519 key type, and never
  echoes parser input. A local file via `RUFLO_HELPERS_SIGNING_KEY` remains the
  air-gapped fallback.
- If a rotation IS needed, keep the private half in `~/.ruflo/helpers-signing.key`
  only, print ONLY the public half (via `Ed25519 pub export` from Node crypto), upload
  new private via `gcloud secrets versions add … --data-file=`, then
  `gcloud secrets versions destroy <old>` to make the old irrecoverable.

**Windows `prepublishOnly` failure (learned 2026-07-14):** the CLI's `prepublishOnly`
chain (`cp ../../../README.md ./README.md && rm -rf plugins && mkdir -p plugins && cp -r ...`)
is POSIX-shell-only. On Windows, npm runs it via `cmd.exe /d /s /c` which chokes on
`mkdir -p` (interprets `-p` as a directory name) and `cp -r` (no such command). Two
workarounds until the script is rewritten in cross-platform Node:
1. Run the prep steps manually in Git Bash, then `npm publish --ignore-scripts`.
2. Or use a POSIX shell for the whole publish: `SHELL=bash npm publish` — but this
   doesn't always take effect on Windows depending on npm version.
Option 1 is what worked for v3.29.0. Track proper fix in ruvnet/ruflo issue for
cross-platform prepublish.

**Concurrent-session helper corruption (real, observed, be paranoid):** multiple Claude Code
sessions can have their own `npm exec @claude-flow/cli@latest mcp start` MCP server running
concurrently with `cwd` inside this repo (check with `readlink /proc/<pid>/cwd` on
`pgrep -f "npm exec @claude-flow/cli@latest mcp start"`). If one of those resolved an older
cached `@latest` (predating the `semver.gte` downgrade-guard in
`helper-refresh.ts:autoRefreshHelpersIfStale`), it will silently overwrite this repo's
hand-maintained `.claude/helpers/hook-handler.cjs` / `intelligence.cjs` (root AND package
copies) — and `helpers.manifest.json` + `.helpers-version` — with its own older bundled
content, mid-session, with no warning. Observed live 2026-07-13: this happened *twice* in
one publish flow, once right after a manual revert and once right after signing (silently
invalidating a freshly-signed manifest). **Mitigation:** never trust the on-disk state of
those files between tool calls — `git diff --stat` them immediately before any `git add`/
`sign-helpers.mjs`/`npm publish` step, `git checkout HEAD --` revert if dirty, and chain
revert → sign → verify → add → commit as ONE bash invocation (`&&`-joined) to minimize the
race window. `npm publish`'s own `prepublishOnly` re-signs fresh at pack time regardless, so
what matters is the on-disk state at the *exact moment* `npm publish` runs, not before.

```bash
# Replace 3.7.1 below with your chosen stable version (patch/minor/major per the rules above)

# STEP 1: Build and publish @claude-flow/cli
cd v3/@claude-flow/cli
npm version 3.7.1 --no-git-tag-version
npm run build
npm publish                              # default tag is `latest` — no --tag flag
npm dist-tag add @claude-flow/cli@3.7.1 alpha     # historical compat
npm dist-tag add @claude-flow/cli@3.7.1 v3alpha   # historical compat

# STEP 2: Publish claude-flow umbrella
cd /Users/cohen/Projects/ruflo                    # or your repo root
npm version 3.7.1 --no-git-tag-version
npm publish
npm dist-tag add claude-flow@3.7.1 alpha
npm dist-tag add claude-flow@3.7.1 v3alpha

# STEP 3: Publish ruflo wrapper (CRITICAL — DON'T FORGET — this is what users run)
cd ruflo
npm version 3.7.1 --no-git-tag-version
npm publish
npm dist-tag add ruflo@3.7.1 alpha
npm dist-tag add ruflo@3.7.1 v3alpha
```

**Verification (run before telling user publishing is complete):**

```bash
for pkg in @claude-flow/cli claude-flow ruflo; do
  echo "$pkg: $(npm view $pkg@latest version)"
  npm view $pkg dist-tags --json
done
# All three must show latest === alpha === v3alpha === new version
```

### All Tags That Must Be Updated

| Package | Tag | Command Users Run |
|---------|-----|-------------------|
| `@claude-flow/cli` | `latest` | `npx @claude-flow/cli@latest` |
| `@claude-flow/cli` | `alpha` | `npx @claude-flow/cli@alpha` (legacy compat) |
| `@claude-flow/cli` | `v3alpha` | `npx @claude-flow/cli@v3alpha` (legacy compat) |
| `claude-flow` | `latest` | `npx claude-flow@latest` |
| `claude-flow` | `alpha` | `npx claude-flow@alpha` (legacy compat) |
| `claude-flow` | `v3alpha` | `npx claude-flow@v3alpha` (legacy compat) |
| `ruflo` | `latest` | `npx ruflo@latest` |
| `ruflo` | `alpha` | `npx ruflo@alpha` (legacy compat) |
| `ruflo` | `v3alpha` | `npx ruflo@v3alpha` (legacy compat) |

- Never forget the `ruflo` package — it's the thin wrapper users actually run via `npx ruflo`
- The legacy `alpha` and `v3alpha` tags MUST stay pointed at the latest stable so old install commands keep working
- `ruflo` source is in `/ruflo/` — it depends on `@claude-flow/cli`
- Also remember to update `ruflo/package.json` overrides when adding new pinned transitives (see #2112 lesson — root overrides do NOT propagate to the published `ruflo` wrapper)

### GitHub Release after publish

Every stable bump SHOULD have a matching `gh release create v<version>` with consolidated release notes pointing at the gist if one exists. Example:

```bash
git tag v3.7.1 main
git push origin v3.7.1
gh release create v3.7.1 --title "v3.7.1 — <one-line headline>" \
  --notes-file /tmp/release-notes.md
```

## Plugin Registry Maintenance (IPFS/Pinata)

The plugin registry is stored on IPFS via Pinata for decentralized, immutable distribution.

### Registry Location
- **Current CID**: Stored in `v3/@claude-flow/cli/src/plugins/store/discovery.ts`
- **Gateway**: `https://gateway.pinata.cloud/ipfs/{CID}`
- **Format**: JSON with plugin metadata, categories, featured/trending lists

### Required Environment Variables
Add to `.env` (NEVER commit actual values):
```bash
PINATA_API_KEY=your-api-key
PINATA_API_SECRET=your-api-secret
PINATA_API_JWT=your-jwt-token
```

## Plugin Registry Operations

### Adding a New Plugin to Registry

1. **Fetch current registry**:
```bash
curl -s "https://gateway.pinata.cloud/ipfs/$(grep LIVE_REGISTRY_CID v3/@claude-flow/cli/src/plugins/store/discovery.ts | cut -d"'" -f2)" > /tmp/registry.json
```

2. **Add plugin entry** to the `plugins` array:
```json
{
  "id": "@claude-flow/your-plugin",
  "name": "@claude-flow/your-plugin",
  "displayName": "Your Plugin",
  "description": "Plugin description",
  "version": "1.0.0-alpha.1",
  "size": 100000,
  "checksum": "sha256:abc123",
  "author": {"id": "claude-flow-team", "displayName": "Claude Flow Team", "verified": true},
  "license": "MIT",
  "categories": ["official"],
  "tags": ["your", "tags"],
  "downloads": 0,
  "rating": 5,
  "lastUpdated": "2026-01-25T00:00:00.000Z",
  "minClaudeFlowVersion": "3.0.0",
  "type": "integration",
  "hooks": [],
  "commands": [],
  "permissions": ["memory"],
  "exports": ["YourExport"],
  "verified": true,
  "trustLevel": "official"
}
```

3. **Update counts and arrays**:
   - Increment `totalPlugins`
   - Add to `official` array
   - Add to `featured`/`newest` if applicable
   - Update category `pluginCount`

4. **Upload to Pinata** (read credentials from .env):
```bash
# Source credentials from .env
PINATA_JWT=$(grep "^PINATA_API_JWT=" .env | cut -d'=' -f2-)

# Upload updated registry
curl -X POST "https://api.pinata.cloud/pinning/pinJSONToIPFS" \
  -H "Authorization: Bearer $PINATA_JWT" \
  -H "Content-Type: application/json" \
  -d @/tmp/registry.json
```

5. **Update discovery.ts** with new CID:
```typescript
export const LIVE_REGISTRY_CID = 'NEW_CID_FROM_PINATA';
```

6. **Also update demo registry** in discovery.ts `demoPluginRegistry` for offline fallback

### Security Rules
- NEVER hardcode API keys in scripts or source files
- NEVER commit .env (already in .gitignore)
- Always source credentials from environment at runtime
- Always delete temporary scripts after one-time uploads

### Verification
```bash
# Verify new registry is accessible
curl -s "https://gateway.pinata.cloud/ipfs/{NEW_CID}" | jq '.totalPlugins'
```

## MetaHarness Integration (ADR-150)

Ruflo integrates with the upstream `metaharness` / `@metaharness/*` ecosystem as a sibling agent-harness scaffolding system (same author, designed around ruflo's primitives). MetaHarness packages are optional peer dependencies and are never required at runtime.

### Architectural constraint (load-bearing)

**Ruflo remains operational if every MetaHarness package is removed.** Four rules:
1. **Removable**: `npm ls --without @metaharness/*` must still produce a working CLI
2. **Optional in package.json**: `@metaharness/*` packages MUST be optional peers, never normal dependencies
3. **Graceful degradation**: every code path that touches MetaHarness catches `MODULE_NOT_FOUND` and falls back
4. **CI gate**: `.github/workflows/no-metaharness-smoke.yml` enforces all three by static grep + runtime drill on every PR

### Command + tool surface

```bash
# CLI subcommands (npx ruflo metaharness …)
npx ruflo metaharness score                      # 5-dim readiness scorecard
npx ruflo metaharness genome                     # 7-section categorical report
npx ruflo metaharness mcp-scan --fail-on high    # static security findings
npx ruflo metaharness threat-model               # enterprise threat report
npx ruflo metaharness oia-audit --alert-on-worst high
                                                 # composite weekly audit → memory
npx ruflo metaharness audit-list --since 30d     # enumerate audit records
npx ruflo metaharness audit-trend \              # diff two audits (drift)
  --baseline-key <a> --current-key <b> --alert-on-worsening \
  --alert-on-distance-below 0.85               # iter 38 — structural-distance gate (ADR-152 §3.1)
npx ruflo metaharness similarity \               # iter 36 — ADR-152 §3.1 weighted similarity
  --a a.json --b b.json [--per-dimension] [--alert-below 0.5]
npx ruflo metaharness drift-from-history \       # iter 53 — 1-command drift (composes 3 primitives)
  [--baseline-since 7d] [--baseline-key <key>] [--baseline-file <path>] \
  [--threshold 0.95] [--alert-on-new-severity high] [--dry-run]
                                                 # iter 66 — --baseline-key skips audit-list (~14x faster)
                                                 # iter 67 — --baseline-file skips memory entirely (~19x faster)
                                                 # iter 78 — --alert-on-new-severity adds orthogonal finding-severity gate
npx ruflo metaharness mint --name foo --template vertical:coding --confirm
npx ruflo metaharness redblue init               # @metaharness/redblue — scaffold redblue.yaml
npx ruflo metaharness redblue run --mock-judge --tests 10
                                                 # $0 marker-fixture path (CI / offline)
npx ruflo metaharness redblue run --tests 50 --patch
                                                 # real model judge (needs OPENROUTER_API_KEY,
                                                 #   capped by max_cost_usd, default $3)
npx ruflo metaharness redblue attack prompt --count 3
                                                 # preview generated attack cases (no target call)
npx ruflo metaharness redblue patch --mock-judge # baseline → blue-team patch → retest delta
npx ruflo metaharness redblue report --in report.json
                                                 # render existing report as markdown
npx ruflo metaharness learn --host claude-code --model haiku --slice slices/lite.json
                                                 # metaharness@0.3.0 / upstream ADR-235 —
                                                 #   GEPA learning run; $0 dry-run default,
                                                 #   --run to spend; needs a metaharness
                                                 #   repo checkout (--repo / $METAHARNESS_REPO)
npx ruflo metaharness gepa --op genome           # darwin@0.8.0 GEPA library — load + validate
                                                 #   the shipped cand-6 genome (or --path <f>)
npx ruflo metaharness gepa --op render           # genome → the system prompt it compiles to
npx ruflo metaharness gepa --op analyze --transcript run.json
                                                 # classify failure modes in a transcript
npx ruflo metaharness evolve --bench .harness/bench.json
                                                 # Darwin proposes candidates; governed gates decide
npx ruflo metaharness bench verify --path .harness/bench.json
                                                 # create or verify stable benchmark corpora
npx ruflo metaharness flywheel run --proposer auto --max-concurrency 2
                                                 # bounded concurrent evaluation; does not promote
npx ruflo metaharness flywheel receipts          # inspect immutable evaluation receipts
npx ruflo metaharness flywheel promote <receipt-id> \
  --public-key ./approved-ed25519-public.pem --confirm
                                                 # explicit policy-authorized atomic promotion

# Dedicated command
npx ruflo eject --name my-harness                # lift ruflo project → standalone harness
                                                 # dry-run by default; refuses in-repo target

# Doctor health check
npx ruflo doctor --component metaharness         # report metaharness availability + version

# MCP tools (callable by Claude Code agents)
mcp__claude-flow__metaharness_score
mcp__claude-flow__metaharness_genome
mcp__claude-flow__metaharness_mcp_scan
mcp__claude-flow__metaharness_threat_model
mcp__claude-flow__metaharness_oia_audit
mcp__claude-flow__metaharness_audit_list
mcp__claude-flow__metaharness_audit_trend
mcp__claude-flow__metaharness_similarity          # iter 36 — ADR-152 §3.1 genome similarity
mcp__claude-flow__metaharness_drift_from_history  # iter 53 — 1-command drift detection
mcp__claude-flow__metaharness_bench               # ADR-153 — create/verify bench suites for evolve --bench
mcp__claude-flow__metaharness_evolve              # MAP-Elites driver — evolve a harness across bench suites
mcp__claude-flow__metaharness_security_bench      # security-focused benchmark suite gate
mcp__claude-flow__metaharness_redblue             # @metaharness/redblue — adversarial red/blue LLM testing (init|run|patch|attack|report)
mcp__claude-flow__metaharness_learn               # metaharness@0.3.0 — GEPA learning run ($0 dry-run default; run=true to spend)
mcp__claude-flow__metaharness_gepa                # darwin@0.8.0 — GEPA genome ops (genome|validate|render|analyze); gepaOptimize stays library-only
mcp__claude-flow__metaharness_flywheel            # ADR-322 — evaluate concurrently, inspect receipts/ledger, or explicitly promote
```

### Routing integration (ADR-148/149)

`@metaharness/router@~0.3.2` is wired as the cost-optimal model router behind the `CLAUDE_FLOW_ROUTER_NEURAL=1` triple-gate. The `routedBy` field on every routing decision carries `'metaharness-knn' | 'metaharness-krr' | 'fastgrnn'` when the neural path is active.

### SelfEvolvingRouter parallel-logging (ADR-150 Phase 2)

When `CLAUDE_FLOW_ROUTER_PARALLEL_LOG=1` is set, every `route()` call writes a paired-decision row (bandit pick + neural-augmented pick + outcome) to `.swarm/router-parallel.jsonl`. Analyze with:

```bash
node plugins/ruflo-metaharness/scripts/router-parallel-analyze.mjs \
  --input .swarm/router-parallel.jsonl --strict
```

The 3-criteria AND-gate from ADR-150 review-round-1: `quality > 2% AND cost < 1% AND latency < 5%`. Exit 1 in `--strict` mode if any criterion fails — promotion gate.

### CI workflows

- `metaharness-ci.yml` — score / mcp-scan / router-compat / eject-dryrun jobs on every PR touching `plugins/ruflo-metaharness/**`
- `no-metaharness-smoke.yml` — enforces the four architectural-constraint rules above on every PR
- `oia-audit-weekly.yml` — Sundays 04:17 UTC, runs composite audit, uploads 90-day artifact

### Cross-references

- [ADR-150](v3/docs/adr/ADR-150-metaharness-integration-surfaces.md) — decision + implementation notes
- [Issue #2399](https://github.com/ruvnet/ruflo/issues/2399) — phase tracker
- [Research gist](https://gist.github.com/ruvnet/19d166ff9acf368c9da4172d91ac9113) — graded evidence
- Upstream: `github.com/ruvnet/agent-harness-generator`

## Optional Plugins (20 Available)

Plugins are distributed via IPFS and can be installed with the CLI. Browse and install from the official registry:

```bash
# List all available plugins
npx claude-flow@v3alpha plugins list

# Install a plugin
npx claude-flow@v3alpha plugins install @claude-flow/plugin-name

# Enable/disable
npx claude-flow@v3alpha plugins enable @claude-flow/plugin-name
npx claude-flow@v3alpha plugins disable @claude-flow/plugin-name
```

### Core Plugins

| Plugin | Version | Description |
|--------|---------|-------------|
| `@claude-flow/embeddings` | 3.0.0-alpha.1 | Vector embeddings with sql.js, HNSW, hyperbolic support |
| `@claude-flow/security` | 3.0.0-alpha.1 | Input validation, path security, CVE remediation |
| `@claude-flow/claims` | 3.0.0-alpha.8 | Claims-based authorization (check, grant, revoke, list) |
| `@claude-flow/neural` | 3.0.0-alpha.7 | Neural pattern training (SONA, MoE, EWC++) |
| `@claude-flow/plugins` | 3.0.0-alpha.1 | Plugin system core (manager, discovery, store) |
| `@claude-flow/performance` | 3.0.0-alpha.1 | Performance profiling and benchmarking |

### Integration Plugins

| Plugin | Version | Description |
|--------|---------|-------------|
| `@claude-flow/plugin-agentic-qe` | 3.0.0-alpha.4 | Agentic quality engineering integration |
| `@claude-flow/plugin-prime-radiant` | 0.1.5 | Prime Radiant intelligence integration |
| `@claude-flow/plugin-gastown-bridge` | 3.0.0-alpha.1 | Gastown bridge protocol integration |
| `@claude-flow/teammate-plugin` | 1.0.0-alpha.1 | Multi-agent teammate coordination |
| `@claude-flow/plugin-code-intelligence` | 0.1.0 | Advanced code analysis and intelligence |
| `@claude-flow/plugin-test-intelligence` | 0.1.0 | Intelligent test generation and gap analysis |
| `@claude-flow/plugin-perf-optimizer` | 0.1.0 | Performance optimization automation |
| `@claude-flow/plugin-neural-coordinator` | 0.1.0 | Neural network coordination across agents |
| `@claude-flow/plugin-cognitive-kernel` | 0.1.0 | Core cognitive processing kernel |
| `@claude-flow/plugin-quantum-optimizer` | 0.1.0 | Quantum-inspired optimization algorithms |
| `@claude-flow/plugin-hyperbolic-reasoning` | 0.1.0 | Hyperbolic space reasoning for hierarchical data |

### Domain-Specific Plugins

| Plugin | Version | Description |
|--------|---------|-------------|
| `@claude-flow/plugin-healthcare-clinical` | 0.1.0 | Healthcare clinical workflow automation |
| `@claude-flow/plugin-financial-risk` | 0.1.0 | Financial risk assessment and modeling |
| `@claude-flow/plugin-legal-contracts` | 0.1.0 | Legal contract analysis and generation |

### Plugin Development

```bash
# Create a new plugin from template
npx claude-flow@v3alpha plugins create my-plugin

# Test locally
npx claude-flow@v3alpha plugins install ./path/to/my-plugin

# Publish to registry (requires Pinata credentials)
npx claude-flow@v3alpha plugins publish
```

Registry source: IPFS via Pinata (`QmXbfEAaR7D2Ujm4GAkbwcGZQMHqAMpwDoje4583uNP834`)

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues

---

Remember: **Claude Flow coordinates, Claude Code creates!**

## Gateway-Delegated Development (meta-llm dev-bridge)

For complex reasoning, architecture decisions, or hard bug-fixes, **delegate via the
`metallm_delegate` MCP tool rather than solving inline.** The meta-llm gateway governs the
work: it routes cheap-tier-first, escalates genuinely-hard tasks to the frontier (Fable),
and meters every call — so delegation is cost-governed and preserves the main session's context.

- **Default to `cognitum-auto`** — the gateway picks the tier by difficulty. Only pass an
  explicit tier (`cognitum-low|mid|high`) when you must force one.
- Prompt-wrapping does **not** inflate cost — the gateway normalizes host scaffolds so an
  everyday sub-task still routes to the cheap tier. Trust `cognitum-auto`.
- Use **`metallm_delegate`** for agentic sub-tasks needing tools/files in a working dir
  (its `cwd` is sandboxed); use **`metallm_ask`** for a single-shot question — it returns
  the gateway's real metered cost + resolved tier/model in-band.
- Reserve the main (inline) session for orchestration, integration, and final review;
  push expensive per-sub-task reasoning through the gateway.

**Setup (per developer, local — never committed):** register the `metallm-dev-bridge` MCP
server via a local `.mcp.json` (gitignored) and export your gateway key as `COGNITUM_DEV_KEY`
in your shell. Build steps + the exact `.mcp.json` block are in the internal meta-llm
dev-bridge README. **Never commit the key or an inline gateway URL.**

### `ask` vs `delegate` — pick by task shape (load-bearing)

**Use `metallm_ask` for single-shot facts, summaries, classification, and small code
questions. Use `metallm_delegate` only when the task needs autonomous multi-step execution
or isolated agent context.**

Why the split is strict: `metallm_delegate` spawns a full `claude -p` sub-agent, which loads
its entire harness context **even for a trivial task** — measured floor ≈ **$0.26/call**
(~43k input tokens) before any real work. `metallm_ask` is a single gateway completion —
measured ≈ **$0.0001** for a small query, ~2500× cheaper. So delegating casually is
expensive at volume; `delegate` pays off only when offloading the sub-task's context from
the main session is worth the floor. When in doubt, `ask`.

Routing caveat (tracked): `metallm_ask` **auto** currently over-tiers some trivial prompts to
`mid` (sonnet-5) instead of `low` — the bridge's `/v1/messages` path may miss ADR-236
host-normalization (meta-llm issue #38). Forced tiers work correctly; cost impact is small
per call but real at volume.
