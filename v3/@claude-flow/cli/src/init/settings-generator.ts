/**
 * Settings.json Generator
 * Creates .claude/settings.json with V3-optimized hook configurations
 */

import type { InitOptions, HooksConfig, PlatformInfo } from './types.js';
import { detectPlatform } from './types.js';

/**
 * Generate the complete settings.json content
 */
export function generateSettings(options: InitOptions): object {
  const settings: Record<string, unknown> = {};

  // Add hooks if enabled. CRITICAL (#1744 #3): only emit the hooks block when
  // the helpers directory will also be bundled. The hook commands point at
  // .claude/helpers/hook-handler.cjs; if that file isn't created (as in
  // --minimal where components.helpers=false), every hook fires and silently
  // fails to find its handler. Either bundle the helpers OR drop the hooks —
  // the option this fix takes is the latter (minimal stays minimal).
  if (options.components.settings && options.components.helpers) {
    settings.hooks = generateHooksConfig(options.hooks);
  }

  // Add statusLine configuration if enabled
  if (options.statusline.enabled) {
    settings.statusLine = generateStatusLineConfig(options);
  }

  // Add permissions
  settings.permissions = {
    allow: [
      'Bash(npx @claude-flow*)',
      'Bash(npx claude-flow*)',
      'Bash(node .claude/*)',
      'mcp__claude-flow__*',
    ],
    deny: [
      'Read(./.env)',
      'Read(./.env.*)',
    ],
  };

  // #1670 — RuFlo attribution (Co-Authored-By trailer + PR footer) is now
  // OPT-IN. Default behavior no longer injects a third-party Co-Authored-By
  // line into the user's commits — that pattern silently inflated GitHub
  // contributor graphs and was hard to undo without rewriting history. Pass
  // `--attribution` (or `attribution: true` in InitOptions) to enable.
  //
  // #2078 — when the user DOES opt in, write a no-reply bot email so GitHub
  // treats this as a tool, not a personal contribution. Personal emails get
  // added to user repos' contributor graphs even when the trailer is opt-in.
  // `ruflo-bot@users.noreply.github.com` is GitHub's no-reply convention and
  // is excluded from contributor graphs / mapped to a tool identity.
  if (options.attribution === true) {
    settings.attribution = {
      commit: 'Co-Authored-By: ruflo-bot <ruflo-bot@users.noreply.github.com>',
      pr: '🤖 Generated with [RuFlo](https://github.com/ruvnet/ruflo)',
    };
  }

  // Note: Claude Code expects 'model' to be a string, not an object
  // Additional ruflo-specific model preferences live in claudeFlow.modelPreferences below
  settings.model = 'claude-sonnet-5';

  // Add Agent Teams configuration (experimental feature)
  settings.env = {
    // Enable Claude Code Agent Teams for multi-agent coordination
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Claude Flow specific environment
    CLAUDE_FLOW_V3_ENABLED: 'true',
    CLAUDE_FLOW_HOOKS_ENABLED: 'true',
  };

  // Detect platform for platform-aware configuration
  const platform = detectPlatform();

  // Add V3-specific settings
  settings.claudeFlow = {
    version: '3.0.0',
    enabled: true,
    platform: {
      os: platform.os,
      arch: platform.arch,
      shell: platform.shell,
    },
    modelPreferences: {
      default: 'claude-sonnet-5',
      routing: 'claude-haiku-4-5-20251001',
    },
    agentTeams: {
      enabled: true,
      teammateMode: 'auto', // 'auto' | 'in-process' | 'tmux'
      taskListEnabled: true,
      mailboxEnabled: true,
      coordination: {
        // #3031: Liveness alone is not authority. Keep idle assignment off
        // until the scheduler can prove task ownership, agent scope, and a
        // refusal/back-off state. Users may explicitly opt in after supplying
        // those controls in their host configuration.
        autoAssignOnIdle: false,
        trainPatternsOnComplete: true, // Train neural patterns when tasks complete
        notifyLeadOnComplete: true,   // Notify team lead when tasks complete
        sharedMemoryNamespace: 'agent-teams', // Memory namespace for team coordination
      },
      hooks: {
        teammateIdle: {
          enabled: true,
          autoAssign: false,
          checkTaskList: true,
        },
        taskCompleted: {
          enabled: true,
          trainPatterns: true,
          notifyLead: true,
        },
      },
    },
    swarm: {
      topology: options.runtime.topology,
      maxAgents: options.runtime.maxAgents,
    },
    memory: {
      backend: options.runtime.memoryBackend,
      enableHNSW: options.runtime.enableHNSW,
      learningBridge: { enabled: options.runtime.enableLearningBridge ?? true },
      memoryGraph: { enabled: options.runtime.enableMemoryGraph ?? true },
      agentScopes: { enabled: options.runtime.enableAgentScopes ?? true },
    },
    neural: {
      enabled: options.runtime.enableNeural,
    },
    daemon: {
      autoStart: false,  // Opt-in only — prevents unintended token consumption (#1427, #1330)
      workers: [
        'map',           // Codebase mapping
        'audit',         // Security auditing (critical priority)
        'optimize',      // Performance optimization (high priority)
      ],
      schedules: {
        audit: { interval: '4h', priority: 'critical' },
        optimize: { interval: '2h', priority: 'high' },
      },
    },
    learning: {
      enabled: true,
      autoTrain: true,
      patterns: ['coordination', 'optimization', 'prediction'],
      retention: {
        shortTerm: '24h',
        longTerm: '30d',
      },
    },
    adr: {
      autoGenerate: true,
      directory: '/docs/adr',
      template: 'madr',
    },
    ddd: {
      trackDomains: true,
      validateBoundedContexts: true,
      directory: '/docs/ddd',
    },
    security: {
      autoScan: true,
      scanOnEdit: true,
      cveCheck: true,
      threatModel: true,
    },
  };

  return settings;
}

/**
 * Detect if we're on Windows for platform-aware hook commands.
 */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Build a hook command that resolves to the right helpers dir on every
 * install layout. `ruflo init` can land helpers either project-locally
 * (`<project>/.claude/helpers/…`, when run from a project root) or globally
 * (`$HOME/.claude/helpers/…`, when settings.json gets merged into the
 * user-level Claude Code config). The earlier `${CLAUDE_PROJECT_DIR:-.}`
 * form assumed project-local — so any global-install user hit
 * `MODULE_NOT_FOUND` on every Bash/Edit/Session hook (#1943).
 *
 * The fix is a tiny POSIX `sh` probe: try `$CLAUDE_PROJECT_DIR/.claude/...`
 * first, fall back to `$HOME/.claude/...` if it's missing. Both modes work,
 * the global install never crashes, and project-local overrides still take
 * precedence when present. On Windows, the same probe via `cmd /c` (the %~%
 * fallback uses `IF EXIST`).
 */
function hookCmd(script: string, subcommand: string): string {
  if (IS_WINDOWS) {
    // cmd.exe equivalent of the sh probe below. `IF EXIST` checks the
    // project-local path; falls back to %USERPROFILE% if missing.
    return `cmd /c "IF EXIST \"%CLAUDE_PROJECT_DIR%\\${script.replace(/\//g, '\\')}\" (node \"%CLAUDE_PROJECT_DIR%\\${script.replace(/\//g, '\\')}\" ${subcommand}) ELSE (node \"%USERPROFILE%\\${script.replace(/\//g, '\\')}\" ${subcommand})"`;
  }
  // POSIX sh: prefer project-local helpers, fall back to $HOME/.claude/.
  // The fallback handles `ruflo init`'s global-install path where helpers
  // live at `$HOME/.claude/helpers/` but Claude Code still sets
  // `CLAUDE_PROJECT_DIR` to the *project* root (which has no helpers).
  // eslint-disable-next-line no-template-curly-in-string
  const projVar = '${CLAUDE_PROJECT_DIR:-.}';
  // eslint-disable-next-line no-template-curly-in-string
  const homeVar = '${HOME}';
  return `sh -c 'D="${projVar}"; [ -f "$D/${script}" ] || D="${homeVar}"; exec node "$D/${script}" ${subcommand}'`;
}

/** Shorthand for CJS hook-handler commands */
function hookHandlerCmd(subcommand: string): string {
  return hookCmd('.claude/helpers/hook-handler.cjs', subcommand);
}

/** Shorthand for ESM auto-memory-hook commands */
function autoMemoryCmd(subcommand: string): string {
  return hookCmd('.claude/helpers/auto-memory-hook.mjs', subcommand);
}

/**
 * Generate statusLine configuration for Claude Code
 * Uses local helper script for cross-platform compatibility (no npx cold-start)
 */
function generateStatusLineConfig(_options: InitOptions): object {
  // Claude Code pipes JSON session data to the script via stdin.
  // Valid fields: type, command, padding (optional).
  // The script runs after each assistant message (debounced 300ms).
  //
  // ruflo#1948 + #1973: the previous `sh -c 'D="${CLAUDE_PROJECT_DIR:-.}"; …'`
  // form requires a POSIX shell on PATH. On native Windows (no
  // Git-Bash / WSL), `sh` either isn't found or its quoting gets
  // mangled, producing weird artifacts like files named `0)` or
  // `toastr.error('ESD...` from misparsed tokens leaking back into
  // the file system. NEVER use `cmd /c` for statusline — Claude Code
  // manages stdin directly for statusline commands and `cmd /c`
  // blocks the stdin forwarding.
  //
  // Solution: emit a platform-appropriate command at init time.
  //   POSIX:   `sh -c 'D="…"; … exec node "$D/<script>"'` (existing)
  //   Windows: a Node.js one-liner that resolves the path internally
  //            using `process.env.CLAUDE_PROJECT_DIR` with a HOME
  //            fallback — no shell-quoting hazards because the
  //            resolution happens inside node, not in the shell.
  const script = '.claude/helpers/statusline.cjs';

  if (process.platform === 'win32') {
    // The Node CLI's `-e` flag avoids all shell-quoting pitfalls.
    // We write the path resolution in JS:
    //   const fs = require('fs'); const p = require('path');
    //   const d = process.env.CLAUDE_PROJECT_DIR || '.';
    //   const f = p.join(d, '.claude/helpers/statusline.cjs');
    //   const home = process.env.USERPROFILE || process.env.HOME || '.';
    //   const h = p.join(home, '.claude/helpers/statusline.cjs');
    //   require(fs.existsSync(f) ? f : h);
    // …compressed onto one line. Double-quotes around the -e arg are
    // safe on cmd.exe; the inner JS uses single-quotes for strings.
    const js =
      "const fs=require('fs'),p=require('path');" +
      `const d=process.env.CLAUDE_PROJECT_DIR||'.';` +
      `const f=p.join(d,'${script}');` +
      `const h=p.join(process.env.USERPROFILE||process.env.HOME||'.', '${script}');` +
      'require(fs.existsSync(f)?f:h);';
    return {
      type: 'command',
      command: `node -e "${js}"`,
    };
  }

  // Same project-local / $HOME fallback as `hookCmd()` (see #1943).
  // eslint-disable-next-line no-template-curly-in-string
  const projVar = '${CLAUDE_PROJECT_DIR:-.}';
  // eslint-disable-next-line no-template-curly-in-string
  const homeVar = '${HOME}';
  return {
    type: 'command',
    command: `sh -c 'D="${projVar}"; [ -f "$D/${script}" ] || D="${homeVar}"; exec node "$D/${script}"'`,
  };
}

/**
 * Generate hooks configuration
 * Uses local hook-handler.cjs for cross-platform compatibility.
 * All hooks invoke scripts directly via `node <script> <subcommand>`,
 * working identically on Windows, macOS, and Linux.
 */
function generateHooksConfig(config: HooksConfig): object {
  const hooks: Record<string, unknown[]> = {};

  // Node.js scripts handle errors internally via try/catch.
  // No shell-level error suppression needed (2>/dev/null || true breaks Windows).

  // PreToolUse — validate commands and edits before execution
  if (config.preToolUse) {
    hooks.PreToolUse = [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('pre-bash'),
            timeout: config.timeout,
          },
        ],
      },
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('pre-edit'),
            timeout: config.timeout,
          },
        ],
      },
    ];
  }

  // PostToolUse — record edits and commands for session metrics / learning
  if (config.postToolUse) {
    hooks.PostToolUse = [
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('post-edit'),
            timeout: 10000,
          },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('post-bash'),
            timeout: config.timeout,
          },
        ],
      },
    ];
  }

  // UserPromptSubmit — intelligent task routing
  if (config.userPromptSubmit) {
    hooks.UserPromptSubmit = [
      {
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('route'),
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // SessionStart — restore session state + import auto memory
  if (config.sessionStart) {
    hooks.SessionStart = [
      {
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('session-restore'),
            timeout: 15000,
          },
          {
            type: 'command',
            command: autoMemoryCmd('import'),
            timeout: 8000,
          },
        ],
      },
    ];
  }

  // SessionEnd — persist session state
  if (config.sessionStart) {
    hooks.SessionEnd = [
      {
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('session-end'),
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // Stop — sync auto memory on exit
  if (config.stop) {
    hooks.Stop = [
      {
        hooks: [
          {
            type: 'command',
            command: autoMemoryCmd('sync'),
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // PreCompact — preserve context before compaction
  if (config.preCompact) {
    hooks.PreCompact = [
      {
        matcher: 'manual',
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('compact-manual'),
          },
          {
            type: 'command',
            command: hookHandlerCmd('session-end'),
            timeout: 10000,
          },
        ],
      },
      {
        matcher: 'auto',
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('compact-auto'),
          },
          {
            type: 'command',
            command: hookHandlerCmd('session-end'),
            timeout: 6000,
          },
        ],
      },
    ];
  }

  // SubagentStart — status update when a sub-agent is spawned
  hooks.SubagentStart = [
    {
      hooks: [
        {
          type: 'command',
          command: hookHandlerCmd('status'),
          timeout: 3000,
        },
      ],
    },
  ];

  // SubagentStop — track agent completion for metrics
  // NOTE: The valid event is "SubagentStop" (not "SubagentEnd")
  hooks.SubagentStop = [
    {
      hooks: [
        {
          type: 'command',
          command: hookHandlerCmd('post-task'),
          timeout: 10000,
        },
      ],
    },
  ];

  // Notification — capture Claude Code notifications for logging
  if (config.notification) {
    hooks.Notification = [
      {
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('notify'),
            timeout: 3000,
          },
        ],
      },
    ];
  }

  // NOTE: TeammateIdle, TaskCompleted, and PostCompact are NOT accepted by
  // Claude Code's settings.json validator (rejected as "Invalid key in record").
  // Agent Teams coordination lives in claudeFlow.agentTeams.hooks instead.

  return hooks;
}

/**
 * Generate settings.json as formatted string
 */
export function generateSettingsJson(options: InitOptions): string {
  const settings = generateSettings(options);
  return JSON.stringify(settings, null, 2);
}
