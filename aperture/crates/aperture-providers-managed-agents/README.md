# aperture-providers-managed-agents

Web-research `DataSource` backed by [Anthropic Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview).
Parallels the sibling [`aperture-providers-claude`](../aperture-providers-claude/)
crate (which shells out to the `claude` CLI) but talks directly to the
Managed Agents REST + SSE endpoints at `api.anthropic.com`. Same prompt
set, same 9-method coverage, same fallback contract.

## How it works

For each web-research call the researcher:

1. **Bootstraps once per process** — creates a research Agent and a
   sandbox Environment via `POST /v1/agents` and `POST /v1/environments`,
   caches both IDs.
2. **Spins up a Session** — `POST /v1/sessions` with the cached agent
   and environment.
3. **POSTs the user event** — `POST /v1/sessions/<id>/events` with a
   schema-pinned `user.message` (prompts reused from
   `aperture-providers-claude::prompts`).
4. **Polls the events endpoint** — `GET /v1/sessions/<id>/events` every
   ~1.5 s until a terminal `session.status_idle` appears past the turn's
   starting event count.
5. **Collects the agent's output** — concatenates the `text` blocks of
   every `agent.message` event in that turn.
6. **Parses the response as JSON** — tolerates code-fenced or
   prose-wrapped JSON via the same `parse_loose_json` helper as the
   CLI backend.
7. **Caches the result** with a 1-hour TTL keyed by `(method, args)`.

> **Why polling, not SSE?** The Managed Agents docs describe a
> `GET /v1/sessions/<id>/stream` SSE endpoint, but it returns
> `not_found_error` in the environments we've tested (the streaming
> surface appears gated during the beta). `GET /v1/sessions/<id>/events`
> reliably returns the full event history, so the crate polls that.
> An SSE-stream parser (`sse::SseParser`) and `api::stream_argv` are
> retained for when the streaming endpoint goes GA.

All HTTP calls use `curl` via `tokio::process::Command` so the workspace
stays free of a heavy `reqwest` / `hyper` / TLS dep tree.

## Auth

`Config::from_env()` reads these environment variables:

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic's canonical name (matches all SDKs) |
| `ANTHROPIC_KEY` | Accepted as a friendly alias |
| `ANTHROPIC_BASE_URL` | Overrides the API host; defaults to `https://api.anthropic.com` |

The key must be a Claude API key (`sk-ant-...`). When neither key var is
set, `Config::from_env()` returns `ConfigError::MissingApiKey` and the
host should either bail or wire the researcher only on opt-in.

The crate never logs the key.

## Headers sent on every request

```
x-api-key: $ANTHROPIC_API_KEY
anthropic-version: 2023-06-01
anthropic-beta: managed-agents-2026-04-01
content-type: application/json   (for POSTs)
```

`anthropic-beta` is required per the Managed Agents docs while the API
is in beta.

## Methods

Identical surface to `aperture-providers-claude`:

| Method | Backed by Managed Agents |
|---|---|
| `news(symbol)` | ✅ |
| `macro_indicators()` | ✅ |
| `yield_curve()` | ✅ |
| `fx_rates(base)` | ✅ |
| `earnings_calendar(window)` | ✅ |
| `index_members(symbol)` | ✅ |
| `corp_actions(symbol)` | ✅ |
| `filings(symbol)` | ✅ |
| `sentiment(symbol)` | ✅ |
| Everything else | passes through to the wrapped fallback |

## Use

Add to `aperture-tui` as a feature-gated dep:

```toml
# aperture/crates/aperture-tui/Cargo.toml
[features]
provider-managed-agents = ["dep:aperture-providers-managed-agents"]

[dependencies]
aperture-providers-managed-agents = { path = "../aperture-providers-managed-agents", optional = true }
```

Then:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."     # or ANTHROPIC_KEY
cargo run -p aperture-tui --features provider-managed-agents \
          -- --provider=managed-agents
> AAPL NEWS GO
```

First call per (method, args) incurs the full bootstrap + session
round-trip (typically 5–30 s); subsequent calls hit the cache for 1
hour by default.

## Tests

```bash
cargo test -p aperture-providers-managed-agents
```

- Unit tests cover `curl` argv assembly (URL, header order, body), SSE
  parsing (single message, split chunks, CRLF, malformed JSON,
  unknown event types, terminal `session.status_idle`).
- Integration tests in `tests/fallback.rs` point the curl binary at a
  guaranteed-missing path and assert every web-research method still
  yields the wrapped provider's output rather than bubbling the spawn
  error.
- No test actually invokes the API — that requires a real API key and
  network. Manually:

  ```bash
  ANTHROPIC_API_KEY=sk-ant-...   \
  cargo run -p aperture-tui --features provider-managed-agents \
            -- --provider=managed-agents
  ```

## Defaults

| Knob | Default |
|---|---|
| `base_url` | `https://api.anthropic.com` |
| `anthropic_version` | `2023-06-01` |
| `beta_header` | `managed-agents-2026-04-01` |
| `model` | `claude-haiku-4-5-20251001` |
| `curl_binary` | `curl` (resolved on PATH) |
| `timeout` | 90 s per call |
| `cache_ttl` | 1 h |

Override via `Config { ... }` and `ManagedAgentsResearcher::new(fallback, config)`.

## See also

- ADR-104 — Aperture pane-as-agent swarm
- ADR-105 — v0.2 architecture backlog (this crate is the SDK-direct
  variant of item #3, complementing the CLI-shell variant)
- Anthropic docs: <https://platform.claude.com/docs/en/managed-agents/overview>
