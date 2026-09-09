---
name: aperture
description: Open Aperture market workspace. Form `/aperture [SYMBOL VERB [ARG...] [GO]]`.
---

Examples:
- `/aperture` — empty workspace
- `/aperture AAPL DESC GO` — Quote pane on AAPL
- `/aperture BTC CRYPTO` — crypto quote
- `/aperture ASK "what moved NVDA today"` — Oracle pane
- `/aperture AAPL OPTIONS GO` — Options pane on AAPL
- `/aperture MACRO GO` — econ indicators
- `/aperture YIELDS GO` — treasury yield curve
- `/aperture AAPL FINANCIALS GO` — income/balance/cashflow
- `/aperture EARNINGS GO` — earnings calendar (default 7-day window)
- `/aperture MOVERS losers GO` — top losers
- `/aperture SPX MEMBERS GO` — index composition
- `/aperture AAPL TECH RSI GO` — RSI on AAPL
- `/aperture CORR AAPL MSFT TSLA GO` — correlation matrix
- `/aperture AAPL IVOL GO` — implied-vol surface
- `/aperture AAPL FILINGS GO` — recent SEC filings
- `/aperture AAPL SENTIMENT GO` — sentiment score
- `/aperture AAPL ORDER BUY 10 GO` — paper-trade order

Native: `cargo run -p aperture-tui`. Browser: `pnpm --filter ruvocal dev` → `/aperture`.
