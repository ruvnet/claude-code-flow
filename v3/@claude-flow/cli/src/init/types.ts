/**
 * V3 Init System Types
 * Configuration options for initializing Claude Code integration
 */

import os from 'os';
import path from 'path';

/**
 * Components that can be initialized
 */
export interface InitComponents {
  /** Create .claude/settings.json with hooks */
  settings: boolean;
  /** Copy skills to .claude/skills/ */
  skills: boolean;
  /** Copy commands to .claude/commands/ */
  commands: boolean;
  /** Copy agents to .claude/agents/ */
  agents: boolean;
  /** Create helper scripts in .claude/helpers/ */
  helpers: boolean;
  /** Configure statusline */
  statusline: boolean;
  /** Create MCP configuration */
  mcp: boolean;
  /** Create .claude-flow/ directory (V3 runtime) */
  runtime: boolean;
  /** Create CLAUDE.md with swarm guidance */
  claudeMd: boolean;
}

/**
 * Hook configuration options
 * Valid Claude Code hook events (23 total):
 *   PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit,
 *   SessionStart, SessionEnd, Stop, SubagentStart, SubagentStop,
 *   PreCompact, PostCompact, Notification, ConfigChange,
 *   InstructionsLoaded, PermissionRequest, WorktreeCreate, WorktreeRemove,
 *   TeammateIdle, TaskCompleted, Elicitation, ElicitationResult
 */
export interface HooksConfig {
  /** Enable PreToolUse hooks */
  preToolUse: boolean;
  /** Enable PostToolUse hooks */
  postToolUse: boolean;
  /** Enable UserPromptSubmit for routing */
  userPromptSubmit: boolean;
  /** Enable SessionStart hooks */
  sessionStart: boolean;
  /** Enable Stop hooks */
  stop: boolean;
  /** Enable PreCompact hooks (context preservation before compaction) */
  preCompact: boolean;
  /** Enable Notification hooks */
  notification: boolean;
  /** Enable TeammateIdle hooks (agent teams auto-assign) */
  teammateIdle: boolean;
  /** Enable TaskCompleted hooks (agent teams pattern learning) */
  taskCompleted: boolean;
  /** Hook timeout in milliseconds */
  timeout: number;
  /** Continue on hook error */
  continueOnError: boolean;
}

/**
 * Skills configuration
 */
export interface SkillsConfig {
  /** Include core skills (swarm, memory, sparc) */
  core: boolean;
  /** Include AgentDB skills */
  agentdb: boolean;
  /** Include GitHub integration skills */
  github: boolean;
  /** Include Flow Nexus skills */
  flowNexus: boolean;
  /** Include browser automation skills (agent-browser) */
  browser: boolean;
  /** Include V3 implementation skills */
  v3: boolean;
  /** Include dual-mode skills (Claude Code + Codex hybrid) */
  dualMode: boolean;
  /** Include all available skills */
  all: boolean;
}

/**
 * Commands configuration
 * ADR-128 Phase 4: new keys for promoted substrate dirs and opt-in categories.
 */
export interface CommandsConfig {
  /** Include core commands */
  core: boolean;
  /** Include analysis commands */
  analysis: boolean;
  /** Include automation commands */
  automation: boolean;
  /** Include github commands */
  github: boolean;
  /** Include hooks commands */
  hooks: boolean;
  /** Include monitoring commands */
  monitoring: boolean;
  /** Include optimization commands */
  optimization: boolean;
  /** Include SPARC commands */
  sparc: boolean;
  // ADR-128 Phase 4 — substrate promotions (default true)
  /** Include agents commands */
  agents?: boolean;
  /** Include coordination commands */
  coordination?: boolean;
  /** Include hive-mind commands */
  hiveMind?: boolean;
  /** Include memory commands */
  memory?: boolean;
  /** Include swarm commands */
  swarm?: boolean;
  /** Include workflows commands */
  workflows?: boolean;
  // ADR-128 Phase 4 — opt-in categories (default false)
  /** Include pair programming commands (opt-in) */
  pair?: boolean;
  /** Include training commands (opt-in) */
  training?: boolean;
  /** Include stream-chain commands (opt-in) */
  streamChain?: boolean;
  /** Include truth commands (opt-in) */
  truth?: boolean;
  /** Include verify commands (opt-in) */
  verify?: boolean;
  /** Include all commands */
  all: boolean;
}

/**
 * Agents configuration
 */
export interface AgentsConfig {
  /** Include core agents (coder, tester, reviewer) */
  core: boolean;
  /** Include consensus agents */
  consensus: boolean;
  /** Include GitHub agents */
  github: boolean;
  /** Include hive-mind agents */
  hiveMind: boolean;
  /** Include SPARC agents */
  sparc: boolean;
  /** Include swarm coordinators */
  swarm: boolean;
  /** Include browser automation agents (agent-browser) */
  browser: boolean;
  /** Include V3-specific agents (security, memory, performance, etc.) */
  v3: boolean;
  /** Include optimization agents */
  optimization: boolean;
  /** Include testing agents */
  testing: boolean;
  /** Include dual-mode agents (Claude Code + Codex hybrid) */
  dualMode: boolean;
  /** Include all agents */
  all: boolean;
}

/**
 * Statusline configuration
 */
export interface StatuslineConfig {
  /** Enable statusline */
  enabled: boolean;
  /** Show V3 progress */
  showProgress: boolean;
  /** Show security status */
  showSecurity: boolean;
  /** Show swarm activity */
  showSwarm: boolean;
  /** Show hooks metrics */
  showHooks: boolean;
  /** Show performance targets */
  showPerformance: boolean;
  /** Refresh interval in milliseconds */
  refreshInterval: number;
}

/**
 * MCP configuration
 */
export interface MCPConfig {
  /** Include claude-flow MCP server */
  claudeFlow: boolean;
  /** Include ruv-swarm MCP server */
  ruvSwarm: boolean;
  /** Include flow-nexus MCP server */
  flowNexus: boolean;
  /** Auto-start MCP server */
  autoStart: boolean;
  /** Server port */
  port: number;
}

/**
 * Runtime configuration (.claude-flow/)
 */
export interface RuntimeConfig {
  /** Swarm topology */
  topology: 'mesh' | 'hierarchical' | 'hierarchical-mesh' | 'adaptive';
  /** Maximum agents */
  maxAgents: number;
  /** Memory backend */
  memoryBackend: 'memory' | 'sqlite' | 'agentdb' | 'hybrid';
  /** Enable HNSW indexing */
  enableHNSW: boolean;
  /** Enable neural learning */
  enableNeural: boolean;
  /** Enable LearningBridge (ADR-049) - connects insights to SONA/ReasoningBank */
  enableLearningBridge?: boolean;
  /** Enable MemoryGraph (ADR-049) - PageRank knowledge graph */
  enableMemoryGraph?: boolean;
  /** Enable AgentMemoryScope (ADR-049) - 3-scope agent memory */
  enableAgentScopes?: boolean;
  /** CLAUDE.md template variant */
  claudeMdTemplate?: ClaudeMdTemplate;
}

/** Template variants for generated CLAUDE.md files */
export type ClaudeMdTemplate = 'minimal' | 'standard' | 'full' | 'security' | 'performance' | 'solo';

/**
 * Embeddings configuration
 */
export interface EmbeddingsConfig {
  /** Enable embedding subsystem */
  enabled: boolean;
  /** ONNX model ID */
  model: 'Xenova/all-MiniLM-L6-v2' | 'Xenova/all-mpnet-base-v2' | 'Xenova/bge-small-en-v1.5' | string;
  /** Enable hyperbolic (Poincaré ball) embeddings */
  hyperbolic: boolean;
  /** Poincaré ball curvature (negative value, typically -1) */
  curvature: number;
  /** Pre-download model during init */
  predownload: boolean;
  /** LRU cache size (number of embeddings) */
  cacheSize: number;
  /** Enable neural substrate integration */
  neuralSubstrate: boolean;
}

/**
 * Detected platform information
 */
export interface PlatformInfo {
  /** Operating system */
  os: 'windows' | 'darwin' | 'linux';
  /** Architecture */
  arch: 'x64' | 'arm64' | 'arm' | 'ia32';
  /** Node.js version */
  nodeVersion: string;
  /** Shell type */
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';
  /** Home directory */
  homeDir: string;
  /** Config directory (platform-specific) */
  configDir: string;
}

/**
 * Detect current platform
 */
export function detectPlatform(): PlatformInfo {
  const platform = os.platform();
  const arch = os.arch();
  const homeDir = os.homedir();

  let osType: 'windows' | 'darwin' | 'linux';
  let shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';
  let configDir: string;

  switch (platform) {
    case 'win32':
      osType = 'windows';
      shell = process.env.PSModulePath ? 'powershell' : 'cmd';
      configDir = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
      break;
    case 'darwin':
      osType = 'darwin';
      shell = process.env.SHELL?.includes('zsh') ? 'zsh' : 'bash';
      configDir = path.join(homeDir, 'Library', 'Application Support');
      break;
    default:
      osType = 'linux';
      shell = process.env.SHELL?.includes('zsh') ? 'zsh' : (process.env.SHELL?.includes('bash') ? 'bash' : 'sh');
      configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  }

  return {
    os: osType,
    arch: arch as PlatformInfo['arch'],
    nodeVersion: process.version,
    shell,
    homeDir,
    configDir,
  };
}

/**
 * Complete init options
 */
export interface InitOptions {
  /** Target directory */
  targetDir: string;
  /** Source base directory for skills/commands/agents (optional) */
  sourceBaseDir?: string;
  /** Force overwrite existing files */
  force: boolean;
  /** Run in interactive mode */
  interactive: boolean;
  /** Components to initialize */
  components: InitComponents;
  /** Hooks configuration */
  hooks: HooksConfig;
  /** Skills configuration */
  skills: SkillsConfig;
  /** Commands configuration */
  commands: CommandsConfig;
  /** Agents configuration */
  agents: AgentsConfig;
  /** Statusline configuration */
  statusline: StatuslineConfig;
  /** MCP configuration */
  mcp: MCPConfig;
  /** Runtime configuration */
  runtime: RuntimeConfig;
  /** Embeddings configuration */
  embeddings: EmbeddingsConfig;
  /**
   * Skip the user-global ~/.claude/CLAUDE.md "Ruflo Integration" pointer block.
   * Defaults to false (current behavior — block is appended once, idempotent).
   * Set true via --no-global to keep the global Claude rules file pristine (#1744).
   */
  skipGlobalClaudeMd?: boolean;
  /**
   * #1670 — opt in to writing the `attribution` block in `.claude/settings.json`
   * (Co-Authored-By trailer + PR footer). Defaults to false: most users do not
   * want a third-party Co-Authored-By line silently added to their commits and
   * GitHub contributor graph. Pass `--attribution` to opt in.
   */
  attribution?: boolean;
}

/**
 * Default init options - full V3 setup
 */
export const DEFAULT_INIT_OPTIONS: InitOptions = {
  targetDir: process.cwd(),
  force: false,
  interactive: true,
  components: {
    settings: true,
    skills: true,
    commands: true,
    agents: true,
    helpers: true,
    statusline: true,
    mcp: true,
    runtime: true,
    claudeMd: true,
  },
  hooks: {
    preToolUse: true,
    postToolUse: true,
    userPromptSubmit: true,
    sessionStart: true,
    stop: true,
    preCompact: true,
    notification: true,
    teammateIdle: true,
    taskCompleted: true,
    timeout: 10000,
    continueOnError: true,
  },
  skills: {
    core: true,
    agentdb: true,
    github: true,
    flowNexus: false,
    browser: true,
    v3: true,
    dualMode: false,  // Optional: enable with --dual flag
    all: false,
  },
  commands: {
    core: true,
    analysis: true,
    automation: true,
    github: true,
    hooks: true,
    monitoring: true,
    optimization: true,
    sparc: true,
    // ADR-128 Phase 4 substrate promotions (default true — core swarm substrate)
    agents: true,
    coordination: true,
    hiveMind: true,
    memory: true,
    swarm: true,
    workflows: true,
    // ADR-128 Phase 4 opt-in (default false — not universal)
    pair: false,
    training: false,
    streamChain: false,
    truth: false,
    verify: false,
    all: false,
  },
  agents: {
    core: true,
    consensus: true,
    github: false,    // ADR-128 Phase 3: opt-in via --agents=github or --all-agents
    hiveMind: false,  // ADR-128 Phase 3: opt-in via --all-agents
    sparc: true,
    swarm: true,
    browser: true,
    v3: false,        // ADR-128 Phase 3: opt-in via --agents=v3 or --all-agents
    optimization: false, // ADR-128 Phase 3: opt-in via --all-agents
    testing: true,
    dualMode: false,  // Optional: enable with --dual flag
    all: false,       // ADR-128 Phase 3: was true; use --all-agents to restore
  },
  statusline: {
    enabled: true,
    showProgress: true,
    showSecurity: true,
    showSwarm: true,
    showHooks: true,
    showPerformance: true,
    refreshInterval: 5000,
  },
  mcp: {
    claudeFlow: true,
    ruvSwarm: false,
    flowNexus: false,
    autoStart: false,
    port: 3000,
  },
  runtime: {
    topology: 'hierarchical-mesh',
    maxAgents: 15,
    memoryBackend: 'hybrid',
    enableHNSW: true,
    enableNeural: true,
    enableLearningBridge: true,
    enableMemoryGraph: true,
    enableAgentScopes: true,
  },
  embeddings: {
    enabled: true,
    model: 'Xenova/all-MiniLM-L6-v2',
    hyperbolic: true,
    curvature: -1.0,
    predownload: false,  // Don't auto-download to speed up init
    cacheSize: 256,
    neuralSubstrate: true,
  },
};

/**
 * Minimal init options
 */
export const MINIMAL_INIT_OPTIONS: InitOptions = {
  ...DEFAULT_INIT_OPTIONS,
  components: {
    settings: true,
    skills: true,
    commands: false,
    agents: false,
    helpers: false,
    statusline: false,
    mcp: true,
    runtime: true,
    claudeMd: true,
  },
  hooks: {
    ...DEFAULT_INIT_OPTIONS.hooks,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    teammateIdle: false,
    taskCompleted: false,
  },
  skills: {
    core: true,
    agentdb: false,
    github: false,
    flowNexus: false,
    browser: false,
    v3: false,
    dualMode: false,
    all: false,
  },
  agents: {
    core: true,
    consensus: false,
    github: false,
    hiveMind: false,
    sparc: false,
    swarm: false,
    browser: false,
    v3: false,
    optimization: false,
    testing: false,
    dualMode: false,
    all: false,
  },
  runtime: {
    topology: 'mesh',
    maxAgents: 5,
    memoryBackend: 'memory',
    enableHNSW: false,
    enableNeural: false,
    enableLearningBridge: false,
    enableMemoryGraph: false,
    enableAgentScopes: false,
  },
  embeddings: {
    enabled: false,
    model: 'Xenova/all-MiniLM-L6-v2',
    hyperbolic: false,
    curvature: -1.0,
    predownload: false,
    cacheSize: 128,
    neuralSubstrate: false,
  },
};

/**
 * Full init options (everything enabled)
 */
export const FULL_INIT_OPTIONS: InitOptions = {
  ...DEFAULT_INIT_OPTIONS,
  components: {
    settings: true,
    skills: true,
    commands: true,
    agents: true,
    helpers: true,
    statusline: true,
    mcp: true,
    runtime: true,
    claudeMd: true,
  },
  skills: {
    core: true,
    agentdb: true,
    github: true,
    flowNexus: true,
    browser: true,
    v3: true,
    dualMode: true,  // Include in full init
    all: true,
  },
  commands: {
    ...DEFAULT_INIT_OPTIONS.commands,
    all: true,
  },
  agents: {
    ...DEFAULT_INIT_OPTIONS.agents,
    all: true,
  },
  mcp: {
    claudeFlow: true,
    ruvSwarm: true,
    flowNexus: true,
    autoStart: false,
    port: 3000,
  },
  embeddings: {
    enabled: true,
    model: 'Xenova/all-MiniLM-L6-v2',
    hyperbolic: true,
    curvature: -1.0,
    predownload: true,  // Pre-download for full init
    cacheSize: 256,
    neuralSubstrate: true,
  },
};

/**
 * Init result
 */
export interface InitResult {
  success: boolean;
  platform: PlatformInfo;
  created: {
    directories: string[];
    files: string[];
  };
  skipped: string[];
  errors: string[];
  summary: {
    skillsCount: number;
    commandsCount: number;
    agentsCount: number;
    hooksEnabled: number;
  };
  /**
   * Advisory-only findings from settings-risk-scanner.ts: dangerous-looking
   * hook commands or Bash allow-rules found in a *pre-existing*
   * settings.json this init carried forward unexamined. Never blocks
   * init — surfaced so a user can review before trusting it.
   */
  warnings?: string[];
}
