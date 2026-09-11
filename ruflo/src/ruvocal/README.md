# RuVocal — RuFlo Web UI

> RuFlo's multi-model AI chat with built-in Model Context Protocol (MCP) tool calling. Live at [**flo.ruv.io**](https://flo.ruv.io/).

[![Try the Web UI — flo.ruv.io](https://img.shields.io/badge/✨_Try_it-flo.ruv.io-6366f1?style=for-the-badge&logo=svelte&logoColor=white)](https://flo.ruv.io/)

RuVocal is the SvelteKit web app that lets you chat with Qwen, Claude, Gemini, or OpenAI while [RuFlo](https://github.com/ruvnet/ruflo) invokes the same ~210 MCP tools the CLI uses — agent orchestration, persistent memory, swarm coordination, code review, GitHub ops — all directly from chat. No install, no API key needed to try the hosted demo.

It started as a fork of the [HuggingFace chat-ui](https://github.com/huggingface/chat-ui) v0.20.0 and has been extended with a WASM-MCP integration layer, parallel tool execution, an in-browser tool gallery, and a "RuFlo Capabilities" tour modal. See [ADR-033](../../docs/adr/ADR-033-RUVOCAL-WASM-MCP-INTEGRATION.md) for the architecture.

## Workspace and governed integrations

The source now includes `/workspace`: mission drafting, recent conversations, a searchable MCP tool inventory, and administrator runtime observations. Open it from the sidebar or use **Ctrl/Cmd + K**. Mission text stays in the tab until you submit the editable chat draft. Requested iteration limits are instructions, not runtime authorization or enforced budgets.

Tool inventory comes from discovery. Runtime cards distinguish unconfigured, unreachable, degraded and observed services. The optional operations bridge exposes exact status tools and a MetaHarness wrapper fixed to `operation: "status"`; it cannot run or promote candidates. Autogenous exposes libraries and signed receipts upstream; a verified operator adapter is required for a remote connection. ruOS observations cover rendezvous services, not full desktop readiness.

See [configuration and limits](docs/source/configuration/workspace.md), [gap analysis](docs/reviews/2026-09-05-ui-gap-analysis.md), and ADRs [039](docs/adr/ADR-039-WORKSPACE-CAPABILITY-EVIDENCE.md), [040](docs/adr/ADR-040-GOVERNED-RUNTIME-INTEGRATIONS.md), [041](docs/adr/ADR-041-IMPLEMENTATION-OPTIMIZATION-LOOP.md), [042](docs/adr/ADR-042-BOUNDED-OPERATIONS-TOOLS.md). These source changes do not establish that the published service has been updated.

```bash
npm ci
npm run test:workspace
node --test mcp-bridge/operations-tools.test.js
npm run build
npm run test:workspace:smoke
```

The production build does not contact model providers. The HTTP acceptance test uses a local model list fixture and tests all workspace views, chat, model discovery and administrator denial. It does not run inference or contact production integrations.

## What RuVocal adds on top of upstream chat-ui

| | |
|---|---|
| 🛠️ **~210 MCP tools, prefixed** | Five RuFlo server groups (Core, Intelligence, Agents, Memory, DevTools) plus a 18-tool in-browser WASM gallery |
| ⚡ **Parallel tool calls** | One model turn fires 4–6+ tools at once via `Promise.all`. The UI shows a *Step N — X tools completed* badge per turn |
| 📘 **RuFlo Capabilities modal** | Question-mark icon → multi-section tour: models, tools, architecture, shortcuts |
| 💾 **AgentDB-backed memory** | "Remember my favorite color is indigo" → recalled weeks later via HNSW vector search |
| 🧠 **6 curated frontier models** | Qwen 3.6 Max (default), Claude Sonnet 4.6, Claude Haiku 4.5, Gemini 2.5 Pro, Gemini 2.5 Flash, OpenAI — via OpenRouter |
| 🔌 **Bring-your-own MCP servers** | Add HTTP/SSE/stdio endpoints from the chat input; they join the parallel-execution flow |
| 🦾 **ruvLLM ready** | Native support for [ruvLLM](https://github.com/ruvnet/RuVector/tree/main/examples/ruvLLM) — RuFlo's self-improving local model layer |
| 🏠 **Self-hostable** | Multi-stage Dockerfile (`INCLUDE_DB=true` builds in MongoDB), `cloudbuild.yaml` for Google Cloud Run |

## Quick Start

### Hosted (zero install)

[**flo.ruv.io**](https://flo.ruv.io/) — pick a model, type a question. That's it.

### Local dev

```bash
git clone https://github.com/ruvnet/ruflo
cd ruflo/ruflo/src/ruvocal
cp config/workspace.env.example .env.local  # configure your model provider
npm install
npm run dev               # → http://localhost:5173
```

Minimum `.env.local` to use OpenRouter (matches the hosted setup):

```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=sk-or-v1-...

# Curated RuFlo model list (optional — defaults to /models from the base URL)
TASK_MODEL=qwen/qwen3.6-max-preview
PUBLIC_APP_NAME=RuFlo
PUBLIC_APP_DESCRIPTION="Intelligent workflow automation assistant powered by Claude/Gemini/Qwen and MCP tools."
```

Any OpenAI-compatible endpoint works (vLLM, Ollama, LM Studio, llama.cpp, Together, Groq, self-hosted, …):

| Provider | `OPENAI_BASE_URL` | Key |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | `sk-or-v1-...` |
| Hugging Face router | `https://router.huggingface.co/v1` | `hf_xxx` |
| llama.cpp server | `http://127.0.0.1:8080/v1` | any string |
| Ollama (OAI bridge) | `http://127.0.0.1:11434/v1` | `ollama` |
| Poe | `https://api.poe.com/v1` | `pk_...` |

### Docker (with embedded MongoDB)

```bash
docker build -t ruvocal --build-arg INCLUDE_DB=true .
docker run -p 3000:3000 \
  -e OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
  -e OPENAI_API_KEY=sk-or-v1-... \
  -v ruvocal-data:/data \
  ruvocal
```

### Google Cloud Run (production-style)

`cloudbuild.yaml` does a multi-stage build with `INCLUDE_DB=true`, pushes to Artifact Registry, and deploys to Cloud Run. Hosted demo at `flo.ruv.io` runs from this exact pipeline. See [`cloudbuild.yaml`](./cloudbuild.yaml) and the deploy notes in [ADR-033](../../docs/adr/ADR-033-RUVOCAL-WASM-MCP-INTEGRATION.md).

## Database

Chat history, users, settings, files, and stats live in MongoDB. Three options:

- **Embedded (zero-config)** — omit `MONGODB_URL`; the app uses `MongoMemoryServer` and persists to `./db`. Good for local dev and the `INCLUDE_DB=true` Docker path.
- **MongoDB Atlas (managed)** — free cluster at [mongodb.com](https://www.mongodb.com/pricing), allow-list your IP, set `MONGODB_URL` to the connection string.
- **Local container** — `docker run -d -p 27017:27017 --name mongo-ruvocal mongo:latest` then `MONGODB_URL=mongodb://localhost:27017`.

`MONGODB_DB_NAME` defaults to `chat-ui` (kept for upstream compatibility); change per environment.

## MCP Tools (the RuFlo difference)

RuVocal calls tools exposed by Model Context Protocol servers and feeds results back to the model via OpenAI function calling. Configure trusted servers via env, let users add their own, and the router auto-selects tools-capable models when needed.

```env
MCP_SERVERS=[
  {"name":"RuFlo Core","url":"https://mcp-bridge-...run.app/mcp/core","transport":"sse"},
  {"name":"RuFlo Intelligence","url":"https://mcp-bridge-...run.app/mcp/intelligence","transport":"sse"},
  {"name":"RuFlo Agents","url":"https://mcp-bridge-...run.app/mcp/agents","transport":"sse"},
  {"name":"RuFlo Memory","url":"https://mcp-bridge-...run.app/mcp/memory","transport":"sse"},
  {"name":"RuFlo DevTools","url":"https://mcp-bridge-...run.app/mcp/devtools","transport":"sse"},
  {"name":"π Shared Brain","url":"https://mcp.pi.ruv.io","transport":"streamable-http"}
]
```

In the chat UI: **MCP (n)** pill in the chat input → *Add Server* to drop in any HTTP/SSE/stdio endpoint. Run a local MCP server on `localhost:3000` and it just works.

When a model calls a tool, the message shows a compact card with parameters, a progress bar while running, and the result. Multiple tools in the same turn render as a parallel-execution group.

## LLM Router (Omni)

RuVocal can do server-side smart routing using [katanemo/Arch-Router-1.5B](https://huggingface.co/katanemo/Arch-Router-1.5B) without a separate router service. Selecting "Omni" in the model picker:

1. Calls Arch once (non-streaming) to pick the best route for recent turns
2. Emits `RouterMetadata` so the UI shows route + selected model
3. Streams from the selected model via `OPENAI_BASE_URL`; on errors, tries route fallbacks

Shortcut paths bypass Arch:
- **Multimodal** — `LLM_ROUTER_ENABLE_MULTIMODAL=true` + image attached → uses `LLM_ROUTER_MULTIMODAL_MODEL`
- **Tools/Agentic** — `LLM_ROUTER_ENABLE_TOOLS=true` + ≥1 MCP server enabled → uses `LLM_ROUTER_TOOLS_MODEL`

Configure via `LLM_ROUTER_ROUTES_PATH` (JSON array of route entries with `name`, `description`, `primary_model`, optional `fallback_models`), `LLM_ROUTER_ARCH_BASE_URL`, `LLM_ROUTER_ARCH_MODEL`, `LLM_ROUTER_OTHER_ROUTE`, `LLM_ROUTER_FALLBACK_MODEL`, `LLM_ROUTER_ARCH_TIMEOUT_MS`.

Display: `PUBLIC_LLM_ROUTER_ALIAS_ID` (default `omni`), `PUBLIC_LLM_ROUTER_DISPLAY_NAME` (default `Omni`), `PUBLIC_LLM_ROUTER_LOGO_URL`.

## Theming

```env
PUBLIC_APP_NAME=RuFlo
PUBLIC_APP_ASSETS=chatui
PUBLIC_APP_DESCRIPTION="Intelligent workflow automation assistant powered by Claude/Gemini/Qwen and MCP tools."
PUBLIC_APP_DATA_SHARING=
```

`PUBLIC_APP_ASSETS` picks the logo/favicon directory under `static/$PUBLIC_APP_ASSETS`.

## Build

```bash
npm run build         # production bundle
npm run preview       # preview the build locally
```

## Architecture (one-pager)

- **SvelteKit 2 + Svelte 5 runes** (`$state`, `$derived`, `$effect`)
- **MongoDB** persistence with `MongoMemoryServer` fallback
- **TailwindCSS** with `scrollbar-custom` and Tailwind class sorting
- **OpenAI-compatible** model registry pulled from `${OPENAI_BASE_URL}/models`
- **MCP bridge** in `src/lib/server/mcp/`; each server group exposes its own SSE endpoint
- **WASM tool gallery** via Web Worker (`src/lib/wasm/wasm.worker.ts`), opt-in via `?worker=1`
- **Parallel tool calls** — `Promise.all` in `src/lib/server/tools/toolInvocation.ts`
- **Capabilities modal** — `src/lib/components/RufloHelpModal.svelte`
- **Dynamic follow-ups** — tool-call-aware suggested next prompts in `ChatWindow.svelte`

For deeper internals, see [`CLAUDE.md`](./CLAUDE.md) (Claude Code agent guide) and [ADR-033](../../docs/adr/ADR-033-RUVOCAL-WASM-MCP-INTEGRATION.md).

## Related

- 🏠 **Parent project** — [RuFlo](https://github.com/ruvnet/ruflo)
- 🎯 **Goal Planner UI** — [goal.ruv.io](https://goal.ruv.io/) · [/agents](https://goal.ruv.io/agents)
- 📖 **ADR-033** — RuVocal/WASM-MCP integration architecture
- 📋 **Roadmap** — [issue #1689](https://github.com/ruvnet/ruflo/issues/1689)
- 🍴 **Upstream** — [huggingface/chat-ui](https://github.com/huggingface/chat-ui) (RuVocal is forked from v0.20.0)

## License

MIT — same as the parent [RuFlo](https://github.com/ruvnet/ruflo) project.
