# aperture-providers-claude

Web-research `DataSource` for [Aperture](../../README.md) backed by
headless [`claude -p`](https://claude.com/code) invocations. Wraps any
`DataSource` (typically `MemoryDataSource`) and intercepts the nine
methods that benefit from live web data; everything else passes through
to the wrapped source.

## How it works

For each web-research call the researcher shells out to:

```bash
claude -p \
    --output-format json \
    --dangerously-skip-permissions \
    --max-budget-usd 0.05 \
    --allowedTools "WebFetch,WebSearch" \
    --model haiku \
    "<schema-pinned prompt>"
```

The prompt for each method (in `src/prompts.rs`) tells the model to
output ONLY a JSON document matching a precise schema. The crate
parses the `--output-format json` envelope, extracts the model's text
response, and tolerates code-fence-wrapped or prose-wrapped JSON via
balanced-bracket extraction (`exec::parse_loose_json`). On any failure
(spawn error, timeout, malformed JSON, validation failure) the call
falls back to the wrapped provider.

## Methods covered

| Method | Why it works for `claude -p` |
|---|---|
| `news(symbol)` | Web search → 5 latest headlines per symbol or global |
| `macro_indicators()` | Public site → CPI / unemployment / GDP / Fed funds / ISM |
| `yield_curve()` | Treasury.gov → daily yields at 8 standard tenors |
| `fx_rates(base)` | Public quote → 6 major crosses against `base` |
| `earnings_calendar(window)` | Public calendar → upcoming releases |
| `index_members(symbol)` | Index publisher → top 10 components by weight |
| `corp_actions(symbol)` | Public filings → splits / dividends / earnings dates |
| `filings(symbol)` | SEC EDGAR → 5 most recent filings |
| `sentiment(symbol)` | News + social search → bullish / neutral / bearish score |

Methods that need real-time price data (`quote`, `ohlcv`,
`options_chain`, `vol_surface`, `technicals`, `correlation_matrix`,
`risk_metrics`, `crypto_quote`, `insider_trades`, `movers`,
`screener`) **always delegate to the fallback** — `claude -p` can't
produce them reliably.

## Cache

Results are memoised in-process with a 1-hour TTL keyed by
`(method, args)`. The TTL matches data freshness for these endpoints
and keeps the per-pane budget bounded; a chart pane that re-asks for
yields every 30 seconds incurs one `claude -p` call per hour, not
1 800.

## Use

Add to `aperture-tui` as a feature-gated dep:

```toml
# aperture/crates/aperture-tui/Cargo.toml
[features]
provider-claude = ["dep:aperture-providers-claude"]

[dependencies]
aperture-providers-claude = { path = "../aperture-providers-claude", optional = true }
```

Then run:

```bash
cd aperture
cargo run -p aperture-tui --features provider-claude -- --provider=claude
```

The first invocation per (method, args) round-trips through `claude -p`
(typically 5–15 s). Subsequent invocations hit the cache.

## API keys

The `claude` CLI handles its own auth via `ANTHROPIC_API_KEY` (or its
sign-in flow). Aperture never sees the key. The crate has no API-key
plumbing of its own.

## Tests

```bash
cargo test -p aperture-providers-claude
```

- Unit tests cover prompt assembly (golden strings), JSON envelope
  parsing, the loose-JSON tolerance path, and TTL cache eviction.
- Integration tests in `tests/fallback.rs` point the binary at a
  guaranteed-missing path and assert that every method still yields
  the wrapped provider's output rather than bubbling the spawn error.
- No test actually invokes `claude` — that would require the binary,
  network, and a budget. To exercise the live path manually:

  ```bash
  cargo run -p aperture-tui --features provider-claude -- --provider=claude
  > AAPL NEWS GO
  ```

## Defaults

| Knob | Default |
|---|---|
| `binary` | `"claude"` (resolved on PATH) |
| `allowed_tools` | `["WebFetch", "WebSearch"]` |
| `max_budget_usd` | `0.05` per call |
| `timeout` | 60 s |
| `model` | `"haiku"` (cheapest model that handles structured-JSON web summaries reliably) |
| `cache_ttl` | 1 h |

Override via `Config` and `ClaudeResearcher::with_config`.
