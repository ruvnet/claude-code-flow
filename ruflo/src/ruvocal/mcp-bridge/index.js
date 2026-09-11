import express from "express";
import { spawn } from "child_process";
import { randomUUID, timingSafeEqual } from "crypto";
import { createOperationsGroup, toolMatchesGroup, projectBackendTools, backendInvocation } from "./operations-tools.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

const CLOUD_FUNCTIONS = {
  search: process.env.SEARCH_API_URL || null,
  research: process.env.RESEARCH_API_URL || null,
};

const PORT = parseInt(process.env.PORT || "3001", 10);
const BIND_HOST = process.env.MCP_BIND_HOST || "127.0.0.1";

// =============================================================================
// TOOL GROUPS — Enable/disable categories of tools independently
// =============================================================================
// Groups map tool name prefixes from backends to logical categories.
// Each group can be toggled via env var. The AI sees only enabled tools.

const TOOL_GROUPS = {
  // ADR-042: explicit read-only additions; never expose a metaharness_ wildcard.
  operations: createOperationsGroup(),
  // --- Core (always on, built-in) ---
  core: {
    enabled: true, // cannot be disabled
    description: "Search, research, and guidance tools",
    source: "builtin",
  },

  // --- Intelligence (ruvector) ---
  intelligence: {
    enabled: process.env.MCP_GROUP_INTELLIGENCE !== "false",
    description: "Self-learning intelligence — routing, memory, pattern training (ruvector)",
    source: "ruvector",
    prefixes: ["hooks_"],
  },

  // --- Agents & Orchestration (ruflo) ---
  agents: {
    enabled: process.env.MCP_GROUP_AGENTS !== "false",
    description: "Agent lifecycle, swarm coordination, task management, workflows (ruflo)",
    source: "ruflo",
    prefixes: ["agent_", "swarm_", "task_", "session_", "hive-mind_", "workflow_", "coordination_"],
  },

  // --- Memory & Knowledge (ruflo) ---
  memory: {
    enabled: process.env.MCP_GROUP_MEMORY !== "false",
    description: "Vector memory, AgentDB, embeddings, semantic search (ruflo)",
    source: "ruflo",
    prefixes: ["memory_", "agentdb_", "embeddings_"],
  },

  // --- Dev Tools (ruflo) ---
  devtools: {
    enabled: process.env.MCP_GROUP_DEVTOOLS !== "false",
    description: "Hooks, code analysis, performance profiling, GitHub integration (ruflo)",
    source: "ruflo",
    prefixes: ["hooks_", "analyze_", "performance_", "github_", "terminal_", "config_", "system_", "progress_"],
  },

  // --- Security & Safety (ruflo) ---
  security: {
    enabled: process.env.MCP_GROUP_SECURITY === "true",
    description: "AI defence, PII detection, claims management, pattern transfer (ruflo)",
    source: "ruflo",
    prefixes: ["aidefence_", "claims_", "transfer_"],
  },

  // --- Browser Automation (ruflo) ---
  browser: {
    enabled: process.env.MCP_GROUP_BROWSER === "true",
    description: "Headless browser control — navigate, click, fill, screenshot (ruflo)",
    source: "ruflo",
    prefixes: ["browser_"],
  },

  // --- Neural & DAA (ruflo) ---
  neural: {
    enabled: process.env.MCP_GROUP_NEURAL === "true",
    description: "Neural network training, DAA autonomous agents, cognitive patterns (ruflo)",
    source: "ruflo",
    prefixes: ["neural_", "daa_"],
  },

  // --- Agentic Flow (agentic-flow@alpha) ---
  "agentic-flow": {
    enabled: process.env.MCP_GROUP_AGENTIC_FLOW === "true",
    description: "Execute 66+ specialized agents, batch code editing, AgentDB patterns (agentic-flow)",
    source: "agentic-flow",
    prefixes: ["agentic_flow_", "agent_booster_", "agentdb_"],
  },

  // --- Claude Code ---
  "claude-code": {
    enabled: process.env.MCP_GROUP_CLAUDE_CODE === "true",
    description: "Anthropic Claude Code — file editing, bash execution, code analysis (requires ANTHROPIC_API_KEY)",
    source: "claude",
  },

  // --- Gemini MCP ---
  gemini: {
    enabled: process.env.MCP_GROUP_GEMINI === "true",
    description: "Google Gemini conversation context, multimodal capabilities (requires GOOGLE_API_KEY)",
    source: "gemini-mcp",
  },

  // --- OpenAI Codex ---
  codex: {
    enabled: process.env.MCP_GROUP_CODEX === "true",
    description: "OpenAI Codex coding agent — code generation and execution (requires OPENAI_API_KEY)",
    source: "codex",
  },
};

// =============================================================================
// STDIO MCP CLIENT — Connects to external MCP servers via child process
// =============================================================================

class StdioMcpClient {
  constructor(name, command, args = []) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.process = null;
    this.tools = [];
    this.ready = false;
    this.pending = new Map();
    this.buffer = "";
  }

  async start() {
    return new Promise((resolve) => {
      try {
        this.process = spawn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        this.process.stdout.on("data", (data) => this._onData(data.toString()));
        this.process.stderr.on("data", (data) => {
          const msg = data.toString().trim();
          if (msg && !msg.startsWith("npm WARN")) console.error(`[${this.name}] ${msg}`);
        });
        this.process.on("error", (err) => {
          console.error(`[${this.name}] spawn error:`, err.message);
          this.ready = false;
          resolve(false);
        });
        this.process.on("exit", (code) => {
          console.log(`[${this.name}] exited with code ${code}`);
          this.ready = false;
        });

        this._send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcp-bridge", version: "2.0.0" },
        }).then((result) => {
          if (result && !result.error) {
            this._notify("notifications/initialized", {});
            return this._send("tools/list", {});
          }
          return null;
        }).then((result) => {
          if (result && result.tools) {
            this.tools = result.tools.map(t => ({
              ...t,
              _originalName: t.name,
              _backend: this.name,
            }));
            this.ready = true;
            console.log(`[${this.name}] ${this.tools.length} tools loaded`);
          }
          resolve(this.ready);
        }).catch((err) => {
          console.error(`[${this.name}] init failed:`, err.message);
          resolve(false);
        });

        setTimeout(() => { if (!this.ready) resolve(false); }, 60000);
      } catch (err) {
        console.error(`[${this.name}] failed to start:`, err.message);
        resolve(false);
      }
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg.result || msg.error || {});
        }
      } catch { /* skip non-JSON */ }
    }
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        return reject(new Error(`${this.name} process not running`));
      }
      const id = randomUUID();
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(msg);
      // initialize is the cold-start gate for backends like ruflo/ruvector
      // which boot a full claude-flow / ruvector kernel — on Cloud Run with
      // npx fetching artifacts it can take 45-60s. Other RPC methods are
      // post-init and stay snappy.
      const timeoutMs = method === "initialize" ? 120000 : 30000;
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${this.name} timeout for ${method}`));
        }
      }, timeoutMs);
    });
  }

  _notify(method, params) {
    if (!this.process || this.process.killed) return;
    this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(originalName, args) {
    if (!this.ready) return { error: `${this.name} backend not available` };
    try {
      return await this._send("tools/call", { name: originalName, arguments: args });
    } catch (err) {
      return { error: err.message };
    }
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.ready = false;
    this.tools = [];
  }
}

// =============================================================================
// BACKEND REGISTRY
// =============================================================================

const BACKEND_DEFS = [
  { name: "ruvector",       command: "npx", args: ["-y", "ruvector", "mcp", "start"],   groups: ["intelligence"] },
  { name: "ruflo",          command: "npx", args: ["-y", "ruflo", "mcp", "start"],      groups: ["agents", "memory", "devtools", "security", "browser", "neural", "operations"] },
  { name: "agentic-flow",   command: "npx", args: ["-y", "agentic-flow@alpha", "mcp", "start"], groups: ["agentic-flow"] },
  { name: "claude",         command: "claude", args: ["mcp", "serve"],                  groups: ["claude-code"] },
  { name: "gemini-mcp",     command: "npx", args: ["-y", "gemini-mcp-server"],          groups: ["gemini"] },
  { name: "codex",          command: "npx", args: ["-y", "@openai/codex", "mcp-server"], groups: ["codex"] },
];

const mcpBackends = new Map();
let allBackendTools = []; // all tools from all backends (pre-filter)

function isBackendNeeded(backendDef) {
  return backendDef.groups.some(g => TOOL_GROUPS[g]?.enabled);
}

// Filter tools from a backend based on which groups are enabled
function filterToolsByGroups(tools, backendName) {
  const enabledGroups = Object.entries(TOOL_GROUPS)
    .filter(([, g]) => g.enabled && g.source === backendName);

  if (enabledGroups.length === 0) return [];

  return tools.filter(tool => enabledGroups.some(([, group]) => toolMatchesGroup(tool, group)));
}

// Get the final filtered tool list with namespaced names
function getActiveTools() {
  const filtered = [];
  for (const [backendName, client] of mcpBackends) {
    if (!client.ready) continue;
    const accepted = filterToolsByGroups(projectBackendTools(client.tools, backendName), backendName);
    for (const t of accepted) {
      filtered.push({ ...t, name: `${backendName}__${t._originalName}` });
    }
  }
  return filtered;
}

async function initBackends() {
  const needed = BACKEND_DEFS.filter(isBackendNeeded);
  if (needed.length === 0) return;

  console.log(`Starting ${needed.length} MCP backends: ${needed.map(b => b.name).join(", ")}`);

  await Promise.allSettled(
    needed.map(async (b) => {
      const client = new StdioMcpClient(b.name, b.command, b.args);
      const ok = await client.start();
      if (ok) {
        mcpBackends.set(b.name, client);
      } else {
        console.warn(`[${b.name}] failed to start`);
      }
    })
  );

  allBackendTools = getActiveTools();
  console.log(`MCP backends: ${mcpBackends.size} active, ${allBackendTools.length} tools (filtered by groups)`);
}

process.on("SIGTERM", () => { for (const [, c] of mcpBackends) c.stop(); process.exit(0); });
process.on("SIGINT", () => { for (const [, c] of mcpBackends) c.stop(); process.exit(0); });

// =============================================================================
// BUILT-IN TOOLS (core group — always on)
// =============================================================================

const BUILTIN_TOOLS = [
  {
    name: "search",
    description: "Search your knowledge base for relevant information.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Max results (default 5)", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "web_research",
    description: "Search the web, fact-check claims, compare items, or conduct deep research. Actions: 'search' (quick), 'research' (deep report), 'compare' (side-by-side), 'fact_check' (verify claims), 'goap' (comprehensive multi-step research with verification).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "research", "compare", "fact_check", "goap"], description: "Research action type", default: "search" },
        query: { type: "string", description: "Search query or topic" },
        items: { type: "array", items: { type: "string" }, description: "Items to compare (for 'compare')" },
        claim: { type: "string", description: "Claim to verify (for 'fact_check')" },
        verify: { type: "boolean", description: "Verify results in goap mode", default: true },
      },
      required: ["query"],
    },
  },
  {
    name: "guidance",
    description: "Get instructions on how to use the available tool groups and services. Call this FIRST when unsure which tool to use, when a user asks 'what can you do?', or when you need to understand a specific tool group. Returns structured guidance for the AI on tool selection and usage patterns.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["overview", "groups", "intelligence", "agents", "memory", "devtools", "security", "browser", "neural", "agentic-flow", "claude-code", "gemini", "codex", "tool"],
          description: "What to get guidance on. Use 'overview' for capabilities summary, 'groups' to see all tool groups and their status, or a specific group name for detailed usage instructions.",
          default: "overview",
        },
        tool_name: { type: "string", description: "Specific tool name to get detailed usage info (when topic='tool')" },
      },
    },
  },
];

// =============================================================================
// GUIDANCE ENGINE — AI-facing instruction system
// =============================================================================

function getGuidance(topic, toolName) {
  const activeGroups = Object.entries(TOOL_GROUPS).filter(([, g]) => g.enabled);
  const inactiveGroups = Object.entries(TOOL_GROUPS).filter(([, g]) => !g.enabled);
  const externalTools = getActiveTools();

  if (topic === "overview") {
    return {
      guidance: `# Tool Capabilities Overview

You have access to ${BUILTIN_TOOLS.length + externalTools.length} tools organized into ${activeGroups.length} active groups.

## Active Groups
${activeGroups.map(([name, g]) => {
  const count = getToolsForGroup(name).length;
  return `- **${name}** (${count} tools) — ${g.description}`;
}).join("\n")}

## Inactive Groups (can be enabled)
${inactiveGroups.map(([name, g]) => `- **${name}** — ${g.description}`).join("\n") || "None"}

## Quick Decision Guide
- **Knowledge questions** → use \`search\` first, then \`web_research\` if needed
- **Current events / facts** → use \`web_research\` with action 'search' or 'goap'
- **Complex research** → use \`web_research\` with action 'goap' (multi-step pipeline)
- **"What can you do?"** → call \`guidance\` with topic 'groups'
- **Memory / recall** → use tools from the \`memory\` group
- **Agent orchestration** → use tools from the \`agents\` group
- **Code analysis / performance** → use tools from the \`devtools\` group

## Rules
1. Call tools FIRST, then present results conversationally
2. Never show raw JSON — synthesize results naturally
3. For complex questions, prefer GOAP pipeline (web_research action='goap')
4. Call \`guidance\` with a specific group name to learn how to use that group's tools`,
      topic: "overview",
    };
  }

  if (topic === "groups") {
    const groupList = Object.entries(TOOL_GROUPS).map(([name, g]) => {
      const status = g.enabled ? "ACTIVE" : "INACTIVE";
      const toolCount = getToolsForGroup(name).length;
      return `| ${name} | ${status} | ${toolCount} | ${g.description} |`;
    });

    return {
      guidance: `# Tool Groups\n\n| Group | Status | Tools | Description |\n|-------|--------|-------|-------------|\n${groupList.join("\n")}`,
      topic: "groups",
    };
  }

  // Specific group guidance
  const groupGuides = {
    intelligence: `# Intelligence Group (ruvector)

Self-learning intelligence tools for routing and vector memory.

## Key Tools
- **ruvector__hooks_route** — Route a task to the best agent type. Call with a task description.
- **ruvector__hooks_remember** — Store context/knowledge in vector memory for later recall.
- **ruvector__hooks_recall** — Search vector memory semantically. Good for finding past context.
- **ruvector__hooks_pretrain** — Bootstrap intelligence from a code repository.
- **ruvector__hooks_build_agents** — Generate optimized agent configurations.
- **ruvector__hooks_stats** — Get intelligence statistics and learning metrics.

## When to Use
- Before starting complex tasks: route to find the best agent approach
- To store important findings for cross-session memory
- To recall previously stored patterns or solutions`,

    agents: `# Agents & Orchestration Group (ruflo)

Multi-agent lifecycle management, swarm coordination, and task workflows.

## Key Tools
- **ruflo__agent_spawn** — Create a new agent with specific capabilities
- **ruflo__agent_list** — List all active agents
- **ruflo__swarm_init** — Initialize a swarm with a topology (mesh, hierarchical, ring, star)
- **ruflo__task_create** — Create and assign tasks
- **ruflo__workflow_create** — Define multi-step workflows
- **ruflo__workflow_execute** — Execute a workflow
- **ruflo__hive-mind_init** — Start collective intelligence coordination
- **ruflo__coordination_orchestrate** — Multi-agent coordination

## When to Use
- Complex tasks requiring multiple agents working together
- Pipeline workflows with sequential or parallel steps
- Distributed task management`,

    memory: `# Memory & Knowledge Group (ruflo)

Vector storage, semantic search, AgentDB pattern learning, and embeddings.

## Key Tools
- **ruflo__memory_store** — Store a value with vector embedding for semantic search
- **ruflo__memory_search** — Semantic search across stored memories (HNSW-indexed)
- **ruflo__memory_list** — List stored memory entries
- **ruflo__agentdb_pattern-store** — Store a reasoning pattern for learning
- **ruflo__agentdb_pattern-search** — Search for similar reasoning patterns
- **ruflo__agentdb_context-synthesize** — Synthesize context from stored memories
- **ruflo__embeddings_generate** — Generate vector embeddings for text
- **ruflo__embeddings_search** — Semantic similarity search

## When to Use
- Persistent knowledge storage across sessions
- Finding similar past solutions or patterns
- Building semantic search over custom data`,

    devtools: `# Dev Tools Group (ruflo)

Code analysis, performance profiling, GitHub integration, and terminal access.

## Key Tools
- **ruflo__analyze_diff** — Analyze git diff for risk and change classification
- **ruflo__performance_benchmark** — Run performance benchmarks
- **ruflo__performance_bottleneck** — Detect performance bottlenecks
- **ruflo__github_repo_analyze** — Analyze a GitHub repository
- **ruflo__github_pr_manage** — Manage pull requests
- **ruflo__terminal_execute** — Execute commands in a terminal session

## When to Use
- Code review and change risk assessment
- Performance analysis and optimization
- GitHub repository management`,

    security: `# Security & Safety Group (ruflo)

AI defence, PII detection, and claims-based authorization.

## Key Tools
- **ruflo__aidefence_scan** — Scan text for AI manipulation attempts
- **ruflo__aidefence_has_pii** — Check for PII (emails, phones, SSNs)
- **ruflo__aidefence_is_safe** — Quick safety check on input
- **ruflo__claims_claim** — Claim an issue for work
- **ruflo__claims_board** — Visual board of all claims

## When to Use
- Input validation and safety checking
- PII detection before processing sensitive data
- Work item management across agents`,

    browser: `# Browser Automation Group (ruflo)

Headless browser control for web interaction and testing.

## Key Tools
- **ruflo__browser_open** — Navigate to a URL
- **ruflo__browser_click** — Click elements by reference
- **ruflo__browser_fill** — Fill form inputs
- **ruflo__browser_screenshot** — Capture page screenshots
- **ruflo__browser_snapshot** — Get accessibility tree for AI parsing
- **ruflo__browser_eval** — Execute JavaScript in page context

## When to Use
- Web scraping and data extraction
- Automated testing (E2E)
- Form filling and web interaction`,

    neural: `# Neural & DAA Group (ruflo)

Neural network operations and Decentralized Autonomous Agents.

## Key Tools
- **ruflo__neural_train** — Train a neural model
- **ruflo__neural_predict** — Make predictions
- **ruflo__daa_agent_create** — Create an autonomous agent
- **ruflo__daa_workflow_create** — Create autonomous workflows
- **ruflo__daa_knowledge_share** — Share knowledge between agents

## When to Use
- Pattern learning and prediction
- Autonomous agent workflows
- Knowledge transfer between agents`,

    "agentic-flow": `# Agentic Flow Group (agentic-flow@alpha)

Execute 66+ specialized agents with boosted code editing and AgentDB.

## Key Tools
- **agentic-flow__agentic_flow_agent** — Execute any of 66+ specialized agents
- **agentic-flow__agentic_flow_list_agents** — List available agent types
- **agentic-flow__agent_booster_edit_file** — 352x faster code editing
- **agentic-flow__agent_booster_batch_edit** — Multi-file refactoring
- **agentic-flow__agentdb_pattern_store** — Store reasoning patterns
- **agentic-flow__agentdb_pattern_search** — Search similar patterns

## When to Use
- Complex code generation with specialized agents
- Batch code refactoring across files
- Agent selection when you need the right specialist`,

    "claude-code": `# Claude Code Group

Anthropic Claude Code MCP server — full coding agent capabilities.

Requires: ANTHROPIC_API_KEY environment variable.

## Capabilities
- File reading and editing
- Bash command execution
- Code analysis and generation
- Project exploration

## When to Use
- When you need a second AI perspective on code
- Complex refactoring tasks
- Code review and analysis`,

    gemini: `# Gemini MCP Group

Google Gemini with conversation context management.

Requires: GOOGLE_API_KEY environment variable (already set for Gemini models).

## Capabilities
- Conversation context management
- Multimodal processing
- Google Search grounding

## When to Use
- Extended context conversations
- Multimodal content processing`,

    codex: `# Codex Group

OpenAI Codex coding agent.

Requires: OPENAI_API_KEY environment variable (already set for OpenAI models).

## Capabilities
- Code generation and execution
- Code completion
- Code explanation

## When to Use
- Code generation tasks
- Quick code completions
- Code explanation and documentation`,
  };

  if (topic === "tool" && toolName) {
    const allTools = [...BUILTIN_TOOLS, ...externalTools];
    const tool = allTools.find(t => t.name === toolName);
    if (tool) {
      const props = Object.entries(tool.inputSchema?.properties || {})
        .map(([k, v]) => `- **${k}** (${v.type}) — ${v.description || ""}`)
        .join("\n");
      return { guidance: `# ${tool.name}\n\n${tool.description}\n\n## Parameters\n${props}`, topic: "tool" };
    }
    return { guidance: `Tool '${toolName}' not found. Call guidance with topic='groups' to see available tools.`, topic: "tool" };
  }

  if (groupGuides[topic]) {
    const group = TOOL_GROUPS[topic];
    if (!group?.enabled) {
      return { guidance: `# ${topic} — INACTIVE\n\n${group?.description || ""}\n\nThis group is not enabled. Set the appropriate MCP_GROUP_* env var to "true" to activate it.`, topic };
    }
    return { guidance: groupGuides[topic], topic };
  }

  return { guidance: `Unknown topic '${topic}'. Use 'overview', 'groups', or a specific group name.`, topic };
}

// =============================================================================
// GEMINI GROUNDED SEARCH — Uses Gemini's built-in Google Search when no
// dedicated search Cloud Function is configured
// =============================================================================

async function geminiGroundedSearch(query, mode = "search") {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return { error: "No GOOGLE_API_KEY configured for search" };

  // Empty/missing query produces a 400 from Gemini's generateContent endpoint.
  // Return a structured error so the model can recover with a real query.
  if (!query || typeof query !== "string" || !query.trim()) {
    return {
      error: "search requires a non-empty query string",
      hint: "Call this tool again with { query: 'your search terms' }. For comparisons use { action: 'compare', query: 'item A vs item B' }; for fact-checking use { action: 'fact_check', claim: 'the claim text' }.",
    };
  }

  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const systemInstructions = {
    search: `You are a helpful search assistant. Answer the query using Google Search results. Include key facts, sources, and relevant details. Be concise but thorough.`,
    research: `You are a research analyst. Provide a comprehensive research report on the topic using Google Search results. Include: key findings, analysis, multiple perspectives, and source citations. Be thorough.`,
    compare: `You are a comparison analyst. Compare the items using Google Search results. Create a structured comparison with pros/cons, key differences, and a recommendation.`,
    fact_check: `You are a fact-checker. Verify the claim using Google Search results. Provide a verdict (TRUE/FALSE/PARTIALLY TRUE/UNVERIFIABLE), evidence, and sources.`,
  };

  const prompt = mode === "fact_check"
    ? `Fact-check this claim: "${query}"`
    : mode === "compare"
      ? `Compare these items: ${query}`
      : mode === "research"
        ? `Research this topic thoroughly: ${query}`
        : query;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstructions[mode] || systemInstructions.search }] },
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[gemini-search] API error ${resp.status}:`, errText.substring(0, 200));
      return { error: `Search API error: ${resp.status}` };
    }

    const data = await resp.json();
    const candidate = data.candidates?.[0];
    const answer = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join("\n") || "";

    // Extract grounding metadata (sources)
    const grounding = candidate?.groundingMetadata || {};
    const chunks = grounding.groundingChunks || [];
    const sources = chunks
      .filter(c => c.web)
      .map(c => ({ title: c.web.title || "", url: c.web.uri || "" }))
      .filter(s => s.url);

    // Extract search queries used
    const searchQueries = (grounding.webSearchQueries || []);

    return {
      success: true,
      answer,
      sources: sources.slice(0, 8),
      searchQueries,
      groundingMetadata: { sources, searchQueries },
      mode,
    };
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return { error: "Search timed out" };
    return { error: err.message };
  }
}

// =============================================================================
// SSRF GUARD — Reject requests to private/loopback ranges (CWE-918)
// =============================================================================

const PRIVATE_IP_RE = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|::1|fc|fd)/i;

function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`SSRF guard: invalid URL — ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`SSRF guard: only HTTPS URLs are permitted, got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (PRIVATE_IP_RE.test(host) || host === "localhost" || host.endsWith(".local")) {
    throw new Error(`SSRF guard: private/loopback host rejected — ${host}`);
  }
}

// =============================================================================
// HELPER — Call a backend Cloud Function / API
// =============================================================================

async function callCloudFunction(url, payload, timeoutMs = 25000) {
  // Validate the URL before making any network request.
  assertSafeUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await resp.json();
  } catch (err) {
    if (err.name === "AbortError") return { error: "Request timed out", timeout: timeoutMs };
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// GOAP SEARCH PIPELINE
// =============================================================================

async function executeGoapSearch(query, args) {
  const researchUrl = CLOUD_FUNCTIONS.research;
  if (!researchUrl) return { error: "GOAP requires a 'research' URL in CLOUD_FUNCTIONS" };

  const startTime = Date.now();

  const composeResult = await callCloudFunction(researchUrl, {
    action: "search",
    query: `Break this question into 3-4 distinct search queries that would help answer it comprehensively. Return ONLY the queries, one per line:\n\n${query}`,
  }, 30000);

  let searchQueries = [query];
  if (composeResult && !composeResult.error) {
    const answer = composeResult.result?.answer || composeResult.answer || "";
    const lines = answer.split("\n").map(l => l.replace(/^[\d\-\*\.\)]+\s*/, "").trim()).filter(l => l.length > 5 && l.length < 200);
    if (lines.length >= 2) searchQueries = lines.slice(0, 4);
  }

  const searchResults = await Promise.all(
    searchQueries.map(q => callCloudFunction(researchUrl, { action: "search", query: q }, 30000))
  );

  const allSources = [], allAnswers = [];
  for (let i = 0; i < searchResults.length; i++) {
    const r = searchResults[i];
    if (r && !r.error && r.success !== false) {
      const answer = r.result?.answer || r.answer || "";
      if (answer) allAnswers.push({ query: searchQueries[i], answer });
      const gm = r.result?.groundingMetadata || r.groundingMetadata || {};
      if (gm.sources) allSources.push(...gm.sources);
    }
  }

  const uniqueSources = [];
  const seenUrls = new Set();
  for (const src of allSources) {
    const url = src.url || src.uri || "";
    if (url && !seenUrls.has(url)) { seenUrls.add(url); uniqueSources.push(src); }
  }

  const synthesisInput = allAnswers.map(a => `## ${a.query}\n${a.answer}`).join("\n\n");
  const synthesisResult = await callCloudFunction(researchUrl, {
    action: "research",
    topic: `Synthesize these findings into a comprehensive answer to: "${query}"\n\nFindings:\n${synthesisInput}`,
  }, 60000);

  const synthesizedAnswer = synthesisResult?.result?.answer || synthesisResult?.answer || synthesisInput;
  const synthGm = synthesisResult?.result?.groundingMetadata || {};
  if (synthGm.sources) {
    for (const src of synthGm.sources) {
      const url = src.url || src.uri || "";
      if (url && !seenUrls.has(url)) { seenUrls.add(url); uniqueSources.push(src); }
    }
  }

  let verification = { verified: true, confidence: "high" };
  if (args.verify !== false && synthesizedAnswer.length > 100) {
    const vr = await callCloudFunction(researchUrl, {
      action: "fact_check", claim: synthesizedAnswer.substring(0, 500),
    }, 30000);
    if (vr && !vr.error && vr.result) {
      verification = {
        verified: vr.result.verdict !== "FALSE",
        verdict: vr.result.verdict,
        confidence: vr.result.confidence || "medium",
        details: vr.result.analysis,
      };
    }
  }

  return {
    answer: synthesizedAnswer, pipeline: "goap",
    steps: { queries_composed: searchQueries.length, searches_executed: searchResults.filter(r => !r?.error).length, sources_found: uniqueSources.length, verification },
    sources: uniqueSources.slice(0, 10), searchQueries, duration_ms: Date.now() - startTime,
  };
}

// =============================================================================
// GOAP SEARCH PIPELINE — Gemini fallback (no Cloud Function needed)
// =============================================================================

async function executeGoapSearchGemini(query, args) {
  const startTime = Date.now();

  // Step 1: Decompose into sub-queries
  const decompose = await geminiGroundedSearch(
    `Break this question into 3-4 distinct search queries that would help answer it comprehensively. Return ONLY the queries, one per line:\n\n${query}`,
    "search"
  );

  let searchQueries = [query];
  if (decompose?.answer) {
    const lines = decompose.answer.split("\n")
      .map(l => l.replace(/^[\d\-\*\.\)]+\s*/, "").trim())
      .filter(l => l.length > 5 && l.length < 200);
    if (lines.length >= 2) searchQueries = lines.slice(0, 4);
  }

  // Step 2: Parallel searches
  const searchResults = await Promise.all(
    searchQueries.map(q => geminiGroundedSearch(q, "search"))
  );

  const allSources = [], allAnswers = [];
  for (let i = 0; i < searchResults.length; i++) {
    const r = searchResults[i];
    if (r && !r.error && r.answer) {
      allAnswers.push({ query: searchQueries[i], answer: r.answer });
      if (r.sources) allSources.push(...r.sources);
    }
  }

  // Dedupe sources
  const seenUrls = new Set();
  const uniqueSources = allSources.filter(s => {
    if (seenUrls.has(s.url)) return false;
    seenUrls.add(s.url);
    return true;
  });

  // Step 3: Synthesize
  const synthesisInput = allAnswers.map(a => `## ${a.query}\n${a.answer}`).join("\n\n");
  const synthesis = await geminiGroundedSearch(
    `Synthesize these findings into a comprehensive answer to: "${query}"\n\nFindings:\n${synthesisInput}`,
    "research"
  );

  const finalAnswer = synthesis?.answer || synthesisInput;
  if (synthesis?.sources) {
    for (const s of synthesis.sources) {
      if (!seenUrls.has(s.url)) { seenUrls.add(s.url); uniqueSources.push(s); }
    }
  }

  // Step 4: Verify if requested
  let verification = { verified: true, confidence: "high" };
  if (args.verify !== false && finalAnswer.length > 100) {
    const vr = await geminiGroundedSearch(finalAnswer.substring(0, 500), "fact_check");
    if (vr && !vr.error) {
      verification = { verified: true, confidence: "medium", details: vr.answer };
    }
  }

  return {
    success: true,
    answer: finalAnswer,
    pipeline: "goap-gemini",
    steps: {
      queries_composed: searchQueries.length,
      searches_executed: searchResults.filter(r => !r?.error).length,
      sources_found: uniqueSources.length,
      verification,
    },
    sources: uniqueSources.slice(0, 10),
    searchQueries,
    duration_ms: Date.now() - startTime,
  };
}

// =============================================================================
// TOOL EXECUTOR
// =============================================================================

// ADR-166 §6 Phase 1d + 2a — server-side tool gate.
// Enforced HERE (not just in the autopilot handler) so /mcp, /mcp/:group,
// autopilot, and any future path share ONE denial gate. Was the missing
// link that made the disclosed unauthenticated-RCE chain reach shell.
const DANGEROUS_TOOLS = Object.freeze(new Set([
  "terminal_execute",
  "ruflo__terminal_execute",
  "devtools__terminal_execute",
]));
function isTerminalTool(name) {
  return DANGEROUS_TOOLS.has(name) || /terminal_execute/i.test(name);
}
const MCP_ENABLE_TERMINAL = process.env.MCP_ENABLE_TERMINAL === "true";

async function executeTool(name, args, groupName) {
  // The same visibility gate covers group endpoints, catch-all calls, and autopilot.
  const visible = groupName === undefined
    ? [...BUILTIN_TOOLS, ...getActiveTools()]
    : getToolsForGroup(groupName);
  if (!visible.some(tool => tool.name === name)) {
    return { error: `Tool "${name}" is not available on this endpoint`, code: "TOOL_NOT_ALLOWED" };
  }
  // Deny dangerous tools unless the operator explicitly opted in.
  // Enforced on every path (not just autopilot) — root cause of ADR-166 V2/V3.
  if (isTerminalTool(name) && !MCP_ENABLE_TERMINAL) {
    return {
      error:
        `Tool "${name}" is disabled by default. Set MCP_ENABLE_TERMINAL=true to allow.`,
      code: "TOOL_DISABLED",
    };
  }
  switch (name) {
    case "search": {
      if (CLOUD_FUNCTIONS.search) {
        return callCloudFunction(CLOUD_FUNCTIONS.search, { query: args.query, limit: args.limit || 5 });
      }
      // Fallback: use Gemini grounded search
      return geminiGroundedSearch(args.query, "search");
    }

    case "web_research": {
      const action = args.action || "search";
      if (action === "goap") {
        // GOAP needs research endpoint — fall back to multi-search via Gemini
        if (CLOUD_FUNCTIONS.research) return executeGoapSearch(args.query, args);
        return executeGoapSearchGemini(args.query, args);
      }
      if (CLOUD_FUNCTIONS.research) {
        const payload = { action };
        if (action === "search") payload.query = args.query;
        else if (action === "research") payload.topic = args.query;
        else if (action === "compare") payload.items = args.items;
        else if (action === "fact_check") payload.claim = args.claim || args.query;
        return callCloudFunction(CLOUD_FUNCTIONS.research, payload, 60000);
      }
      // Fallback: Gemini grounded search
      const mode = action === "fact_check" ? "fact_check" : action === "compare" ? "compare" : action === "research" ? "research" : "search";
      const query = action === "compare" ? (args.items || []).join(" vs ") : (args.claim || args.query);
      return geminiGroundedSearch(query, mode);
    }

    case "guidance":
      return getGuidance(args.topic || "overview", args.tool_name);

    default: {
      // Route to external MCP backend
      const activeTools = getActiveTools();
      const extTool = activeTools.find(t => t.name === name);
      if (extTool) {
        const backend = mcpBackends.get(extTool._backend);
        if (backend) {
          let invocation;
          try {
            invocation = backendInvocation(extTool, args);
          } catch (error) {
            return { error: error.message, code: "INVALID_TOOL_ARGUMENTS" };
          }
          return backend.callTool(invocation.name, invocation.arguments);
        }
        return { error: `Backend ${extTool._backend} not available` };
      }
      return { error: `Unknown tool: ${name}. Call 'guidance' with topic='groups' to see available tools.` };
    }
  }
}

// =============================================================================
// PER-GROUP TOOL HELPERS
// =============================================================================

// Get tools for a specific group only
function getToolsForGroup(groupName) {
  const group = TOOL_GROUPS[groupName];
  if (!group || !group.enabled) return [];
  if (groupName === "core") return BUILTIN_TOOLS;

  const allActive = getActiveTools();
  return allActive.filter(tool => toolMatchesGroup(tool, group));
}

// Group display names for the Chat UI
const GROUP_DISPLAY_NAMES = {
  operations: "Operations & Governance",
  core: "Core Tools",
  intelligence: "Intelligence & Learning",
  agents: "Agents & Orchestration",
  memory: "Memory & Knowledge",
  devtools: "Dev Tools & Analysis",
  security: "Security & Safety",
  browser: "Browser Automation",
  neural: "Neural & DAA",
  "agentic-flow": "Agentic Flow",
  "claude-code": "Claude Code",
  gemini: "Gemini",
  codex: "Codex",
};

// =============================================================================
// MCP SERVER — Multiple endpoints per group
// =============================================================================

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---------- MCP Streamable HTTP session (#2425 djimit) ----------
// Streamable-HTTP clients (Codex/RMCP) send `DELETE /mcp` with an
// `Mcp-Session-Id` header at shutdown. We echo a stable session id back
// on every /mcp* response so those clients can attach it to the DELETE
// and to `notifications/initialized` handshakes.
const MCP_SESSION_ID = randomUUID();
app.use((req, res, next) => {
  if (req.path.startsWith("/mcp")) {
    res.setHeader("Mcp-Session-Id", MCP_SESSION_ID);
  }
  next();
});

// ---------- CORS middleware (ADR-166 §6 Phase 3b) ----------
// MCP_CORS_ORIGIN: comma-separated allowlist (e.g. "https://a.example,https://b.example").
//   unset → "*" for back-compat (loopback default is same-origin anyway)
//   "*"   → wildcard (explicit opt-in — same as legacy behavior)
//   other → echo the request origin ONLY if it appears in the allowlist
const CORS_ALLOWLIST = (process.env.MCP_CORS_ORIGIN || "*")
  .split(",").map(s => s.trim()).filter(Boolean);
const CORS_WILDCARD = CORS_ALLOWLIST.length === 1 && CORS_ALLOWLIST[0] === "*";
app.use((req, res, next) => {
  const origin = req.get("origin") || "";
  if (CORS_WILDCARD) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && CORS_ALLOWLIST.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  // If no match, do NOT set the header — browser will block the request.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Auth middleware ----------
// No-op in local-only mode (MCP_AUTH_TOKEN unset). Enforces 401 when token is set.
const MCP_TOKEN = process.env.MCP_AUTH_TOKEN || "";
function requireAuth(req, res, next) {
  if (req.path === "/health") return next();
  if (!MCP_TOKEN) return next();
  const expected = `Bearer ${MCP_TOKEN}`;
  const got = req.get("authorization") || "";
  const ok = got.length === expected.length &&
    timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}
app.use(requireAuth);

// ---------- Shared MCP handler ----------
function createMcpHandler(groupName) {
  return async (req, res) => {
    const { method, id, params } = req.body;
    try {
      switch (method) {
        case "initialize":
          return res.json({
            jsonrpc: "2.0", id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: `mcp-bridge/${groupName}`, version: "2.0.0" },
            },
          });
        case "tools/list": {
          const tools = getToolsForGroup(groupName);
          return res.json({ jsonrpc: "2.0", id, result: { tools } });
        }
        case "tools/call": {
          const { name, arguments: toolArgs } = params;
          const result = await executeTool(name, toolArgs ?? {}, groupName);
          return res.json({
            jsonrpc: "2.0", id,
            result: {
              isError: Boolean(result?.error || result?.isError),
              content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
            },
          });
        }
        case "notifications/initialized":
          // MCP streamable-HTTP spec: notifications must return 202 Accepted
          // with an empty body (no jsonrpc envelope).
          return res.status(202).end();
        default:
          return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      console.error(`MCP error [${groupName}/${method}]:`, err);
      return res.json({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
    }
  };
}

function createMcpSseHandler(groupName) {
  return (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ type: "endpoint", url: `/mcp/${groupName}` })}\n\n`);
  };
}

// ---------- Register per-group endpoints ----------
for (const groupName of Object.keys(TOOL_GROUPS)) {
  app.post(`/mcp/${groupName}`, createMcpHandler(groupName));
  app.get(`/mcp/${groupName}`, createMcpSseHandler(groupName));
  // #2425 djimit — streamable-HTTP session cleanup
  app.delete(`/mcp/${groupName}`, (_, res) => res.sendStatus(204));
}

// ---------- Catch-all /mcp — serves ALL enabled tools (backwards-compatible) ----------
app.post("/mcp", async (req, res) => {
  const { method, id, params } = req.body;
  try {
    switch (method) {
      case "initialize":
        return res.json({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mcp-bridge", version: "2.0.0" },
          },
        });
      case "tools/list": {
        const activeTools = getActiveTools();
        return res.json({ jsonrpc: "2.0", id, result: { tools: [...BUILTIN_TOOLS, ...activeTools] } });
      }
      case "tools/call": {
        const { name, arguments: toolArgs } = params;
        const result = await executeTool(name, toolArgs ?? {});
        return res.json({
          jsonrpc: "2.0", id,
          result: {
            isError: Boolean(result?.error || result?.isError),
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
          },
        });
      }
      case "notifications/initialized":
        return res.status(202).end();
      default:
        return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    console.error(`MCP error [${method}]:`, err);
    return res.json({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
  }
});

app.get("/mcp", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ type: "endpoint", url: "/mcp" })}\n\n`);
});

// #2425 djimit — streamable-HTTP session cleanup on the catch-all route.
app.delete("/mcp", (_, res) => res.sendStatus(204));

// ---------- GET /mcp-servers — returns MCP_SERVERS JSON for Chat UI config ----------
app.get("/mcp-servers", (_, res) => {
  const servers = [];
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (!group.enabled) continue;
    const tools = getToolsForGroup(name);
    if (tools.length === 0) continue;
    servers.push({
      name: GROUP_DISPLAY_NAMES[name] || name,
      url: `/mcp/${name}`,
      tools: tools.length,
      group: name,
    });
  }
  res.json(servers);
});

// =============================================================================
// CHAT COMPLETIONS PROXY
// =============================================================================

const PROVIDER_ROUTES = {
  openai: { baseURL: "https://api.openai.com/v1/chat/completions", getKey: () => process.env.OPENAI_API_KEY },
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", getKey: () => process.env.GOOGLE_API_KEY },
  openrouter: { baseURL: "https://openrouter.ai/api/v1/chat/completions", getKey: () => process.env.OPENROUTER_API_KEY },
};

function resolveProvider(model) {
  if (typeof model === "string") {
    if (model.startsWith("gemini-")) return "gemini";
    if (model.includes("/")) return "openrouter";
  }
  return "openai";
}

// =============================================================================
// SYSTEM PROMPT — Injected server-side into every chat completion request
// =============================================================================
// This comprehensive prompt teaches the AI how to use all 200+ MCP tools
// across 5 groups. It is injected as the first system message, ensuring
// consistent behavior regardless of what preprompt the Chat UI sends.

function buildSystemPrompt() {
  // Build dynamic group status
  const enabledGroups = Object.entries(TOOL_GROUPS)
    .filter(([, g]) => g.enabled)
    .map(([name]) => name);

  return `You are an intelligent AI assistant with powerful tools organized into ${enabledGroups.length} active groups.

# CRITICAL RULES
1. Use tools proactively — NEVER guess answers, ALWAYS search first
2. For ANY factual question, current event, or research request → call \`web_research\` IMMEDIATELY
3. NEVER say "I don't have access to real-time information" — you DO via web_research
4. NEVER say "I can't search the web" — you CAN via web_research
5. Call tools FIRST, present results conversationally AFTER
6. When multiple tools could help, call them ALL in parallel

# Tool Groups

Tools prefixed with backend name (e.g., \`ruflo__agent_spawn\`). Always use the full prefixed name.

## Group 1: Core Tools (always on)

- **search** — Search your knowledge base (documents, workflows, how-tos).
  Use for: internal knowledge, company docs, past conversations.
  \`{"query": "how to process a claim"}\`

- **web_research** — Search the internet via Google. This is your primary research tool.
  ALWAYS use this for: current events, facts, comparisons, any external knowledge.
  Actions:
  - \`search\` — Quick web search. Default, fast. \`{"action": "search", "query": "latest news on X"}\`
  - \`research\` — Deep report with synthesis. \`{"action": "research", "query": "comprehensive analysis of X"}\`
  - \`compare\` — Side-by-side comparison. \`{"action": "compare", "query": "X", "items": ["A", "B"]}\`
  - \`fact_check\` — Verify a claim. \`{"action": "fact_check", "query": "claim to verify"}\`
  - \`goap\` — Multi-step pipeline: decomposes → parallel searches → synthesizes → verifies. BEST for important questions.
    \`{"action": "goap", "query": "complex question requiring thorough research"}\`

- **guidance** — Get help on tool groups or specific tool usage.
  Topics: \`overview\`, \`groups\`, \`agents\`, \`memory\`, \`intelligence\`, \`devtools\`
  \`{"topic": "overview"}\` or \`{"topic": "tool", "tool_name": "ruflo__agent_spawn"}\`

## Group 2: Intelligence & Learning (ruvector)
Pattern learning, routing, code analysis, and trajectory tracking. ${TOOL_GROUPS.intelligence.enabled ? "ACTIVE" : "DISABLED"}

### Essential Intelligence Tools:
- **ruvector__hooks_route** — Route a task to the optimal agent type. Call this FIRST for complex tasks.
  \`{"task": "describe what needs to be done", "context": ["relevant info"]}\`
  Returns ranked agent recommendations with confidence scores.
- **ruvector__hooks_remember** — Store a key-value pair in persistent memory for cross-session recall.
  \`{"key": "pattern-name", "value": "what to remember", "namespace": "patterns"}\`
- **ruvector__hooks_recall** — Retrieve a previously stored memory by key.
- **ruvector__hooks_suggest_context** — Get contextual suggestions based on current work.
- **ruvector__hooks_swarm_recommend** — Get swarm topology recommendation for a task type.
- **ruvector__hooks_capabilities** — List all intelligence system capabilities.

### Code Analysis:
- **ruvector__hooks_ast_analyze** — Analyze code structure (AST) of a file.
- **ruvector__hooks_ast_complexity** — Get complexity metrics for code.
- **ruvector__hooks_security_scan** — Scan code for security vulnerabilities.
- **ruvector__hooks_diff_analyze** — Analyze a code diff for risk and impact.
- **ruvector__hooks_diff_similar** — Find similar past diffs/changes.

### Trajectory Learning (for multi-step tasks):
- **ruvector__hooks_trajectory_begin** — Start tracking a multi-step task for learning.
- **ruvector__hooks_trajectory_step** — Record a step in the current trajectory.
- **ruvector__hooks_trajectory_end** — End trajectory, triggering pattern extraction.

### Memory & Compression:
- **ruvector__hooks_compress** — Compress/summarize long text for efficient storage.
- **ruvector__hooks_rag_context** — Get RAG context for a query from stored knowledge.
- **ruvector__hooks_learn** — Force the system to learn from provided examples.
- **ruvector__hooks_batch_learn** — Learn from multiple examples at once.
- **ruvector__hooks_stats** — View learning statistics and metrics.
- **ruvector__hooks_doctor** — Run diagnostics on the intelligence system.

## Group 3: Agents & Orchestration (ruflo)
Spawn agents, coordinate swarms, manage tasks and workflows. ${TOOL_GROUPS.agents.enabled ? "ACTIVE" : "DISABLED"}

### Agent Lifecycle:
- **ruflo__agent_spawn** — Create a new specialized agent.
  \`{"type": "coder|researcher|tester|reviewer|architect|security", "name": "optional-name"}\`
  Agent types and when to use them:
  - \`coder\` — Write code, implement features, fix bugs
  - \`researcher\` — Find information, analyze documentation, investigate
  - \`tester\` — Write tests, run test suites, validate behavior
  - \`reviewer\` — Review code quality, security, best practices
  - \`architect\` — Design systems, plan architectures, evaluate trade-offs
  - \`security\` — Audit security, find vulnerabilities, recommend fixes
- **ruflo__agent_status** — Check an agent's current state. \`{"agentId": "agent-xxx"}\`
- **ruflo__agent_list** — List all active agents with their states.
- **ruflo__agent_terminate** — Stop an agent. \`{"agentId": "agent-xxx"}\`
- **ruflo__agent_health** — Health check across all agents.
- **ruflo__agent_pool** — View the agent pool and available capacity.

### Swarm Coordination:
- **ruflo__swarm_init** — Initialize a multi-agent swarm.
  \`{"topology": "hierarchical|mesh|ring|star", "maxAgents": 8, "strategy": "balanced|specialized|adaptive"}\`
  - \`hierarchical\` — Coordinator + workers, best for structured tasks (anti-drift)
  - \`mesh\` — Peer-to-peer, best for collaborative work
  - \`ring\` — Sequential pipeline, best for ordered processing
  - \`star\` — Central hub, best for fan-out parallel work
- **ruflo__swarm_status** — Get swarm health, topology, and agent states.
- **ruflo__swarm_health** — Detailed health metrics for the swarm.
- **ruflo__swarm_shutdown** — Tear down a swarm and all its agents.

### Task Management:
- **ruflo__task_create** — Create a tracked task.
  \`{"description": "what needs to be done", "priority": "low|normal|high|critical"}\`
- **ruflo__task_status** — Check task progress. \`{"taskId": "task-xxx"}\`
- **ruflo__task_list** — List all tasks with their statuses.
- **ruflo__task_complete** — Mark a task as done. \`{"taskId": "task-xxx"}\`
- **ruflo__task_update** — Update task details, status, or assignment.
- **ruflo__task_cancel** — Cancel a task.

### Workflow Orchestration:
- **ruflo__workflow_create** — Define a multi-step workflow with dependencies.
- **ruflo__workflow_execute** — Run a workflow. \`{"workflowId": "wf-xxx"}\`
- **ruflo__workflow_status** — Check workflow progress.
- **ruflo__workflow_template** — Use a pre-built workflow template.
- **ruflo__workflow_pause** / **ruflo__workflow_resume** — Control workflow execution.

### Hive-Mind (Distributed Consensus):
- **ruflo__hive-mind_init** — Start distributed consensus system.
- **ruflo__hive-mind_spawn** — Add an agent to the hive.
- **ruflo__hive-mind_consensus** — Run consensus vote across agents.
- **ruflo__hive-mind_broadcast** — Send message to all hive agents.
- **ruflo__hive-mind_memory** — Access shared hive memory.

### Coordination:
- **ruflo__coordination_topology** — View/change coordination topology.
- **ruflo__coordination_load_balance** — Distribute work across agents.
- **ruflo__coordination_orchestrate** — Orchestrate complex multi-agent tasks.
- **ruflo__coordination_sync** — Synchronize state across agents.

### Session Management:
- **ruflo__session_save** — Save current session state.
- **ruflo__session_restore** — Restore a previous session.
- **ruflo__session_list** — List available sessions.

## Group 4: Memory & Knowledge (ruflo)
Persistent memory, vector search, embeddings, and pattern storage. ${TOOL_GROUPS.memory.enabled ? "ACTIVE" : "DISABLED"}

### Memory Operations:
- **ruflo__memory_store** — Store data in persistent memory.
  \`{"key": "my-key", "value": "data to store", "namespace": "default", "tags": ["tag1"]}\`
- **ruflo__memory_retrieve** — Get stored data by key. \`{"key": "my-key"}\`
- **ruflo__memory_search** — Semantic vector search across stored memories.
  \`{"query": "what to search for", "limit": 5, "namespace": "default"}\`
- **ruflo__memory_list** — List all stored keys in a namespace.
- **ruflo__memory_delete** — Remove a stored memory.
- **ruflo__memory_stats** — View memory usage statistics.

### Embeddings:
- **ruflo__embeddings_generate** — Generate vector embeddings for text.
- **ruflo__embeddings_compare** — Compare semantic similarity of two texts.
- **ruflo__embeddings_search** — Search embeddings database by similarity.
- **ruflo__embeddings_neural** — Generate neural embeddings.
- **ruflo__embeddings_hyperbolic** — Generate hyperbolic embeddings for hierarchical data.

### AgentDB (Advanced Pattern Storage):
- **ruflo__agentdb_pattern-store** — Store a learned pattern with metadata.
  \`{"pattern": "description", "category": "code|debug|architecture", "confidence": 0.9}\`
- **ruflo__agentdb_pattern-search** — Search patterns by similarity.
- **ruflo__agentdb_route** — Route a query to the most relevant stored pattern.
- **ruflo__agentdb_feedback** — Provide feedback on a pattern (reinforcement learning).
- **ruflo__agentdb_context-synthesize** — Synthesize context from multiple sources.
- **ruflo__agentdb_semantic-route** — Semantic routing based on stored knowledge.
- **ruflo__agentdb_consolidate** — Consolidate and deduplicate stored patterns.
- **ruflo__agentdb_batch** — Batch operations on patterns.
- **ruflo__agentdb_session-start** / **ruflo__agentdb_session-end** — Session tracking.
- **ruflo__agentdb_hierarchical-store** / **ruflo__agentdb_hierarchical-recall** — Hierarchical memory.

## Group 5: Dev Tools & Analysis (ruflo)
Performance, system health, GitHub integration, code analysis, terminal. ${TOOL_GROUPS.devtools.enabled ? "ACTIVE" : "DISABLED"}

### System & Performance:
- **ruflo__system_status** — System health overview.
- **ruflo__system_metrics** — Detailed performance metrics.
- **ruflo__system_health** — Health check across all subsystems.
- **ruflo__performance_report** — Generate performance report.
- **ruflo__performance_bottleneck** — Identify performance bottlenecks.
- **ruflo__performance_benchmark** — Run benchmarks.
- **ruflo__performance_optimize** — Get optimization recommendations.
- **ruflo__performance_profile** — Profile specific operations.

### Code Analysis:
- **ruflo__analyze_diff** — Analyze a code diff.
- **ruflo__analyze_diff-risk** — Assess risk level of changes.
- **ruflo__analyze_diff-classify** — Classify type of changes (feature, bugfix, refactor).
- **ruflo__analyze_diff-reviewers** — Suggest code reviewers.
- **ruflo__analyze_file-risk** — Assess risk of a specific file.

### GitHub Integration:
- **ruflo__github_repo_analyze** — Analyze a GitHub repository.
  \`{"repo": "owner/repo", "analysis_type": "code_quality|performance|security"}\`
- **ruflo__github_pr_manage** — Manage pull requests (create, review, merge).
- **ruflo__github_issue_track** — Track and manage issues.
- **ruflo__github_workflow** — Manage GitHub Actions workflows.
- **ruflo__github_metrics** — Repository metrics and insights.

### Terminal Access:
- **ruflo__terminal_create** — Create a terminal session.
- **ruflo__terminal_execute** — Execute a command. \`{"command": "ls -la"}\`
- **ruflo__terminal_list** — List active terminals.
- **ruflo__terminal_history** — View command history.

### Development Hooks:
- **ruflo__hooks_pre-task** / **ruflo__hooks_post-task** — Task lifecycle hooks for learning.
- **ruflo__hooks_pre-edit** / **ruflo__hooks_post-edit** — File edit hooks.
- **ruflo__hooks_session-start** / **ruflo__hooks_session-end** — Session lifecycle.
- **ruflo__hooks_worker-dispatch** — Dispatch background workers.
  Workers: \`optimize\`, \`audit\`, \`testgaps\`, \`document\`, \`map\`, \`deepdive\`, \`benchmark\`
- **ruflo__hooks_model-route** — Route to optimal AI model for a task.
- **ruflo__hooks_explain** — Explain a routing or intelligence decision.

### Configuration:
- **ruflo__config_get** / **ruflo__config_set** / **ruflo__config_list** — Manage settings.

### Progress Tracking:
- **ruflo__progress_check** — Check implementation progress.
- **ruflo__progress_summary** — Summarize overall progress.

# Decision Framework — FOLLOW THIS EXACTLY

1. **ANY factual question** → \`web_research(action='search')\` IMMEDIATELY. Do NOT answer from memory.
2. **"What is X?"** → \`web_research(action='search', query='X')\`
3. **"Compare X vs Y"** → \`web_research(action='compare', query='X vs Y', items=['X', 'Y'])\`
4. **"Is it true that..."** → \`web_research(action='fact_check', query='...')\`
5. **Complex research** → \`web_research(action='goap', query='...')\` — auto multi-step pipeline
6. **Internal docs/procedures** → \`search(query='...')\` first, then web_research if not found
7. **Code task** → \`ruvector__hooks_route\` + \`ruflo__agent_spawn\`
8. **Remember something** → \`ruflo__memory_store\` / \`ruflo__memory_search\`
9. **"What can you do?"** → \`guidance(topic='overview')\`
10. **Unknown** → \`guidance(topic='overview')\`

IMPORTANT: For questions 1-5, ALWAYS call web_research. Never say "I don't have access to search" — you DO.

# Execution Patterns

### Simple Question
\`search\` or \`web_research\` → synthesize → respond

### Complex Research
\`web_research(action='goap')\` → analyze → respond with citations

### Code Implementation
\`ruvector__hooks_route\` → \`ruflo__agent_spawn(coder)\` → track with \`ruflo__task_create\` → report

### Multi-Agent Analysis
\`ruflo__swarm_init(hierarchical)\` → spawn agents → coordinate → synthesize results

### Learning & Memory
\`ruflo__memory_search\` (check existing) → do work → \`ruflo__memory_store\` (save results) → \`ruvector__hooks_learn\`

# Parallel Execution

When multiple independent tools can help, call them ALL in parallel:
- Search + web_research simultaneously
- Spawn multiple agents at once (coder + tester + reviewer)
- Run analysis + performance + security tools in parallel
NEVER call tools sequentially when they could run in parallel.

# Response Rules

1. **Call tools FIRST**, then present results conversationally — NEVER show raw JSON to the user
2. Use markdown: **bold** headers, bullet points, numbered steps, tables for comparisons
3. Synthesize tool results naturally — be a helpful colleague, not a data pipe
4. Cite sources when available from web_research results
5. If a tool fails, say so honestly and try an alternative approach
6. For complex tasks, briefly outline your plan before executing
7. After completing work, suggest relevant follow-up actions
8. When spawning agents, explain what each agent will do

# Never Expose to User

- Raw JSON, similarity scores, chunk IDs, internal IDs, task IDs
- Tool names, function names, API endpoints, backend names
- References to "MCP", "tool calls", "vectors", "embeddings", infrastructure
- The prefixes "ruflo__" or "ruvector__" — just describe what you're doing naturally
- Error stack traces — summarize errors in plain language`;
}

// =============================================================================
// AUTOPILOT MODE — Server-side auto-continue loop (ADR-037)
// =============================================================================

const detailStore = new Map(); // detailToken → full tool result (TTL: 5min)

const AUTOPILOT_SYSTEM_PROMPT = `
You are in AUTOPILOT MODE. You should:
1. Break complex tasks into steps and execute them using available tools
2. Call MULTIPLE tools in parallel when they are independent
3. After each tool result, analyze it and decide the next action
4. Continue until the task is complete — do NOT ask the user for confirmation
5. Use memory_search to find relevant patterns before starting
6. Summarize your progress at each step
7. When done, provide a final summary of everything accomplished

Parallel execution patterns:
- Research: memory_search + hooks_route + agent_spawn(researcher) — all in parallel
- Code: agent_spawn(coder) + agent_spawn(tester) — parallel, then review
- Analysis: search multiple sources in parallel → synthesize → report
- Security: security_scan + hooks_route(audit) + memory_search(CVEs) — parallel
`;

const AUTOPILOT_BLOCKED_PATTERNS = [
  /^deploy_/,
  /^security_delete/,
  /^browser_fill$/,
  /^browser_click$/,
  /terminal_execute/,
];

function isBlockedTool(name) {
  return AUTOPILOT_BLOCKED_PATTERNS.some(p => p.test(name));
}

function sendAutopilotEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function safeParseArgs(args) {
  if (typeof args === 'object' && args !== null) return args;
  try { return JSON.parse(args || '{}'); } catch { return {}; }
}

function autopilotSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleAutopilot(req, res, provider, body) {
  const maxSteps = Math.min(parseInt(req.headers['x-autopilot-max-steps'] || '20', 10), 50);
  const cooldownMs = parseInt(process.env.AUTOPILOT_COOLDOWN || '500', 10);
  const stepTimeoutMs = parseInt(process.env.AUTOPILOT_STEP_TIMEOUT || '30000', 10);

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let messages = [...body.messages];
  let step = 0;
  let aborted = false;
  let totalTasks = 0;
  const startTime = Date.now();

  req.on('close', () => { aborted = true; });

  sendAutopilotEvent(res, { type: 'autopilot_start', maxSteps });

  // Get the tools list for the AI provider (OpenAI function calling format)
  // Limit to BUILTIN_TOOLS + top external tools to avoid overwhelming the model
  // (Gemini struggles with 100+ tool definitions)
  const MAX_AUTOPILOT_TOOLS = 30;
  const externalTools = getActiveTools();
  // Prioritize tools from enabled high-value groups
  const priorityPrefixes = ['ruvector__hooks', 'ruvector__memory', 'ruflo__memory', 'ruflo__agent'];
  const prioritized = externalTools
    .sort((a, b) => {
      const aP = priorityPrefixes.some(p => a.name.startsWith(p)) ? 0 : 1;
      const bP = priorityPrefixes.some(p => b.name.startsWith(p)) ? 0 : 1;
      return aP - bP;
    })
    .slice(0, MAX_AUTOPILOT_TOOLS - BUILTIN_TOOLS.length);
  const allTools = [...BUILTIN_TOOLS, ...prioritized];
  const toolDefs = allTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
  console.log(`[autopilot] ${allTools.length} tools (${BUILTIN_TOOLS.length} builtin + ${prioritized.length} external)`);

  while (step < maxSteps && !aborted) {
    // 1. Call upstream AI provider (non-streaming for tool call parsing)
    const apiKey = provider.getKey();
    let aiResult;
    try {
      const aiResponse = await fetch(provider.baseURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          ...body,
          messages,
          stream: false,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        }),
        signal: AbortSignal.timeout(stepTimeoutMs),
      });
      aiResult = await aiResponse.json();
    } catch (err) {
      sendAutopilotEvent(res, { type: 'autopilot_error', error: `AI call failed: ${err.message}` });
      break;
    }

    const choice = aiResult.choices?.[0];
    if (!choice) {
      sendAutopilotEvent(res, { type: 'autopilot_error', error: 'No response from AI' });
      break;
    }

    // 2. Check for tool calls
    const toolCalls = choice.message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // Final text response — send it
      sendAutopilotEvent(res, { type: 'autopilot_text', content: choice.message?.content || '' });
      break;
    }

    // 3. Execute ALL tool calls in parallel
    step++;
    const groupId = `g${step}`;
    const taskEvents = toolCalls.map((tc, i) => ({
      taskId: `t${totalTasks + i + 1}`,
      tool: tc.function.name,
      args: safeParseArgs(tc.function.arguments),
      status: 'running',
    }));
    totalTasks += taskEvents.length;

    // If the AI also included text content, stream it before tools
    if (choice.message?.content) {
      sendAutopilotEvent(res, { type: 'autopilot_text', content: choice.message.content });
    }

    // Stream group start
    sendAutopilotEvent(res, { type: 'task_group_start', groupId, step, tasks: taskEvents });

    // Append assistant message to conversation
    messages.push(choice.message);

    // Execute tools in parallel
    const groupStart = Date.now();
    const results = await Promise.allSettled(
      toolCalls.map(async (tc, i) => {
        const taskId = taskEvents[i].taskId;
        const toolName = tc.function.name;
        const toolArgs = safeParseArgs(tc.function.arguments);
        const taskStart = Date.now();

        // Check blocklist
        if (isBlockedTool(toolName)) {
          sendAutopilotEvent(res, {
            type: 'task_update', taskId, status: 'blocked',
            summary: `${toolName} requires confirmation`,
            duration: Date.now() - taskStart,
          });
          return { toolCallId: tc.id, blocked: true, toolName };
        }

        try {
          const result = await executeTool(toolName, toolArgs);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

          // Store full detail, generate token for lazy loading
          const detailToken = `dt_${taskId}_${Date.now()}`;
          detailStore.set(detailToken, resultStr);

          // Stream task completion with summary only
          const summary = resultStr.length > 120
            ? resultStr.substring(0, 120).replace(/\n/g, ' ') + '...'
            : resultStr.replace(/\n/g, ' ');

          sendAutopilotEvent(res, {
            type: 'task_update', taskId, status: 'completed',
            summary, duration: Date.now() - taskStart, detailToken,
          });

          return { toolCallId: tc.id, content: resultStr };
        } catch (err) {
          sendAutopilotEvent(res, {
            type: 'task_update', taskId, status: 'failed',
            summary: err.message, duration: Date.now() - taskStart,
          });
          return { toolCallId: tc.id, content: `Error: ${err.message}` };
        }
      })
    );

    // Stream group end
    sendAutopilotEvent(res, { type: 'task_group_end', groupId, step, duration: Date.now() - groupStart });

    // Check if any tools were blocked — pause autopilot
    const blockedResults = results
      .filter(r => r.status === 'fulfilled' && r.value.blocked)
      .map(r => r.value);
    if (blockedResults.length > 0) {
      sendAutopilotEvent(res, {
        type: 'autopilot_paused',
        reason: 'blocked_tools',
        tools: blockedResults.map(b => b.toolName),
      });
      break;
    }

    // Append tool results to messages
    for (const r of results) {
      if (r.status === 'fulfilled' && !r.value.blocked) {
        messages.push({
          role: 'tool',
          tool_call_id: r.value.toolCallId,
          content: r.value.content,
        });
      }
    }

    // Cooldown to prevent runaway
    await autopilotSleep(cooldownMs);
  }

  if (step >= maxSteps && !aborted) {
    sendAutopilotEvent(res, {
      type: 'autopilot_text',
      content: `\n⚠️ Autopilot reached max steps (${maxSteps}). Stopping.\n`,
    });
  }

  sendAutopilotEvent(res, {
    type: 'autopilot_end',
    totalSteps: step,
    totalTasks,
    duration: Date.now() - startTime,
  });

  res.write('data: [DONE]\n\n');
  res.end();

  // Clean up detail store after 5 minutes
  const detailTTL = parseInt(process.env.AUTOPILOT_DETAIL_TTL || '300000', 10);
  setTimeout(() => {
    for (const [key] of detailStore) {
      if (key.startsWith('dt_')) detailStore.delete(key);
    }
  }, detailTTL);
}

// Lazy detail loading endpoint
app.get('/autopilot/detail/:token', (req, res) => {
  const content = detailStore.get(req.params.token);
  if (content) {
    res.json({ content });
  } else {
    res.status(404).json({ error: 'Detail expired or not found' });
  }
});

// =============================================================================
// CHAT COMPLETIONS PROXY
// =============================================================================

app.post("/chat/completions", async (req, res) => {
  const model = req.body?.model;
  const providerName = resolveProvider(model);
  const provider = PROVIDER_ROUTES[providerName];
  const apiKey = provider.getKey();

  if (!apiKey) return res.status(401).json({ error: { message: `No API key for provider: ${providerName}` } });

  // Inject comprehensive system prompt as the first message
  const body = { ...req.body };
  if (body.messages && Array.isArray(body.messages)) {
    let systemPrompt = buildSystemPrompt();
    // Add autopilot instructions if autopilot mode is active
    const isAutopilot = req.headers['x-autopilot'] === 'true';
    if (isAutopilot) {
      systemPrompt = AUTOPILOT_SYSTEM_PROMPT + '\n\n' + systemPrompt;
    }
    // Prepend our system prompt before any existing messages
    const hasSystemMsg = body.messages[0]?.role === "system";
    if (hasSystemMsg) {
      // Merge with existing system message
      body.messages = [
        { role: "system", content: systemPrompt + "\n\n" + body.messages[0].content },
        ...body.messages.slice(1),
      ];
    } else {
      body.messages = [{ role: "system", content: systemPrompt }, ...body.messages];
    }
  }

  // Route to autopilot handler if x-autopilot header is set
  if (req.headers['x-autopilot'] === 'true') {
    return handleAutopilot(req, res, provider, body);
  }

  try {
    const upstream = await fetch(provider.baseURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const errBody = await upstream.text();
      console.error(`Proxy error [${providerName}/${model}]: ${upstream.status} ${errBody.substring(0, 200)}`);
      // Normalize all upstream errors into OpenAI-compatible format so the
      // Chat UI's OpenAI SDK can parse them instead of "400 (no body)".
      let errorMessage = `Upstream ${providerName} error (${upstream.status})`;
      try {
        const parsed = JSON.parse(errBody);
        // Gemini returns [{"error": {"message": "..."}}]
        if (Array.isArray(parsed) && parsed[0]?.error?.message) {
          errorMessage = parsed[0].error.message;
        // OpenAI/OpenRouter return {"error": {"message": "..."}}
        } else if (parsed.error?.message) {
          errorMessage = parsed.error.message;
        }
      } catch {}
      return res.status(upstream.status).json({
        error: { message: errorMessage, type: "upstream_error", code: upstream.status },
      });
    }

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");

    if (req.body?.stream && upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (e) { /* stream closed */ }
      finally { res.end(); }
    } else {
      res.send(await upstream.text());
    }
  } catch (err) {
    console.error(`Proxy error [${providerName}/${model}]:`, err.message);
    res.status(502).json({ error: { message: `Upstream error: ${err.message}` } });
  }
});

// =============================================================================
// MODELS & HEALTH
// =============================================================================

const KNOWN_MODELS = [
  "gemini-2.5-pro", "gemini-2.5-flash",
  "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini",
  "o3-mini", "o1-mini",
];

app.get("/models", (_, res) => {
  res.json({ object: "list", data: KNOWN_MODELS.map(id => ({
    id,
    object: "model",
    owned_by: "system",
    providers: [{ supports_tools: true }],
  })) });
});

app.get("/health", (_, res) => {
  const backends = {};
  for (const [name, client] of mcpBackends) {
    backends[name] = { ready: client.ready, tools: client.tools.length };
  }
  const activeTools = getActiveTools();
  const groups = {};
  for (const [name, g] of Object.entries(TOOL_GROUPS)) {
    groups[name] = { enabled: g.enabled, source: g.source };
  }
  res.json({
    status: "ok", service: "mcp-bridge", version: "2.0.0",
    tools: { builtin: BUILTIN_TOOLS.length, external: activeTools.length, total: BUILTIN_TOOLS.length + activeTools.length },
    groups, backends,
  });
});

// GET /groups — list tool groups and their status
app.get("/groups", (_, res) => {
  const result = {};
  for (const [name, g] of Object.entries(TOOL_GROUPS)) {
    const tools = getToolsForGroup(name);
    result[name] = {
      enabled: g.enabled,
      description: g.description,
      tools: tools.length,
      toolNames: tools.map(t => t.name).slice(0, 10),
    };
  }
  res.json(result);
});

// =============================================================================
// STARTUP
// =============================================================================

async function main() {
  const isPublic = BIND_HOST !== "127.0.0.1" && BIND_HOST !== "localhost";
  if (isPublic && !process.env.MCP_AUTH_TOKEN) {
    console.error(
      "FATAL: refusing to bind a public interface without MCP_AUTH_TOKEN. " +
      "Generate one with: MCP_AUTH_TOKEN=$(openssl rand -base64 32)"
    );
    process.exit(1);
  }
  const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`MCP Bridge v2.0.0 on port ${server.address().port} (${BIND_HOST})`);
    const enabled = Object.entries(TOOL_GROUPS).filter(([, g]) => g.enabled).map(([n]) => n);
    console.log(`Active groups: ${enabled.join(", ")}`);
    // ADR-166 §6 — startup posture banner (helps operators see the security state at boot)
    console.log(
      `[security] bind=${BIND_HOST} auth=${process.env.MCP_AUTH_TOKEN ? "bearer" : "off (local-only)"} ` +
      `terminal=${MCP_ENABLE_TERMINAL ? "ENABLED (⚠ opt-in)" : "disabled"}`,
    );
    if (MCP_ENABLE_TERMINAL) {
      console.warn(
        "[security] WARNING: terminal_execute is enabled. This tool grants shell access " +
        "inside the bridge container to any client the auth layer accepts. Ensure " +
        "MCP_AUTH_TOKEN is set on any non-loopback bind. See ADR-166 §6 Phase 1d.",
      );
    }
  });

  const anyBackendNeeded = BACKEND_DEFS.some(isBackendNeeded);
  if (anyBackendNeeded) {
    console.log("Initializing MCP backends...");
    await initBackends();
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
