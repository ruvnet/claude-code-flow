# ruflo-aperture

Plugin wrapper for the [`aperture`](../../aperture/) Rust+WASM workspace. Logic lives in `aperture/`; this exists for IPFS distribution alongside `ruflo-market-data` / `ruflo-neural-trader`.

## Pane → Agent map

| Pane | Agent ID | Backed by |
|---|---|---|
| Quote | `aperture:pane.quote` | `aperture-data` `DataSource::quote()` |
| Chart | `aperture:pane.chart` | OHLCV + `ruflo-market-data` HNSW |
| Watchlist | `aperture:pane.watchlist` | `KeyValueStore` (sled / OPFS) |
| Oracle | `aperture:pane.oracle` | `ruflo-neural-trader` over bus |
| News | `aperture:pane.news` | `DataSource::news()` |
| Macro | `aperture:pane.macro` | `DataSource::macro_indicators()` |
| Yields | `aperture:pane.yields` | `DataSource::yield_curve()` |
| FX | `aperture:pane.fx` | `DataSource::fx_rates()` |
| Options | `aperture:pane.options` | `DataSource::options_chain()` |
| Insider | `aperture:pane.insider` | `DataSource::insider_trades()` |
| Financials | `aperture:pane.financials` | `DataSource::financials()` |
| Crypto | `aperture:pane.crypto` | `DataSource::crypto_quote()` |
| Risk | `aperture:pane.risk` | `DataSource::risk_metrics()` |
| Corpact | `aperture:pane.corpact` | `DataSource::corp_actions()` |
| Inbox | `aperture:pane.inbox` | in-memory mailbox |
| Export | `aperture:pane.export` | host-supplied snapshot formatter |
| Earnings | `aperture:pane.earnings` | `DataSource::earnings_calendar()` |
| Movers | `aperture:pane.movers` | `DataSource::movers()` |
| Screen | `aperture:pane.screen` | `DataSource::screener()` |
| Members | `aperture:pane.members` | `DataSource::index_members()` |
| IVol | `aperture:pane.ivol` | `DataSource::vol_surface()` |
| Tech | `aperture:pane.tech` | `DataSource::technicals()` |
| Corr | `aperture:pane.corr` | `DataSource::correlation_matrix()` |
| Filings | `aperture:pane.filings` | `DataSource::filings()` |
| Order | `aperture:pane.order` | in-memory paper blotter |
| Sentiment | `aperture:pane.sentiment` | `DataSource::sentiment()` |

## Verbs

| Verb | Owner | Reply |
|---|---|---|
| `DESC` | `pane.quote` | `QUOTE.RESULT` |
| `CHART [range]` | `pane.chart` | `CHART.RESULT` |
| `WATCH` / `UNWATCH` / `LIST` | `pane.watchlist` | `WATCH.RESULT` / `UNWATCH.RESULT` / `LIST.RESULT` |
| `ASK "..."` | `pane.oracle` | `ASK.RESULT` |
| `NEWS [symbol]` | `pane.news` | `NEWS.RESULT` |
| `MACRO` | `pane.macro` | `MACRO.RESULT` |
| `YIELDS` | `pane.yields` | `YIELDS.RESULT` |
| `FX [base]` | `pane.fx` | `FX.RESULT` |
| `OPTIONS` | `pane.options` | `OPTIONS.RESULT` |
| `INSIDER` | `pane.insider` | `INSIDER.RESULT` |
| `FINANCIALS` | `pane.financials` | `FINANCIALS.RESULT` |
| `CRYPTO` | `pane.crypto` | `CRYPTO.RESULT` |
| `RISK [symbols]` | `pane.risk` | `RISK.RESULT` |
| `CORPACT` | `pane.corpact` | `CORPACT.RESULT` |
| `INBOX` / `INBOX.POST` / `INBOX.CLEAR` | `pane.inbox` | `INBOX.RESULT` |
| `EXPORT` | `pane.export` | `EXPORT.RESULT` |
| `EARNINGS [window_days]` | `pane.earnings` | `EARNINGS.RESULT` |
| `MOVERS [scope]` | `pane.movers` | `MOVERS.RESULT` |
| `SCREEN [criteria]` | `pane.screen` | `SCREEN.RESULT` |
| `MEMBERS` | `pane.members` | `MEMBERS.RESULT` |
| `IVOL` | `pane.ivol` | `IVOL.RESULT` |
| `TECH [indicator]` | `pane.tech` | `TECH.RESULT` |
| `CORR [symbols]` | `pane.corr` | `CORR.RESULT` |
| `FILINGS` | `pane.filings` | `FILINGS.RESULT` |
| `ORDER` | `pane.order` | `ORDER.RESULT` |
| `BLOTTER` | `pane.order` | `BLOTTER.RESULT` |
| `SENTIMENT` | `pane.sentiment` | `SENTIMENT.RESULT` |
| `FOCUS` | broadcast | — (re-anchor) |
| `QUOTE` / `OHLCV` | `agent.data` | `*.RESULT` |
