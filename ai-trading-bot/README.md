# AI Trading Bot for MetaTrader 5

A self-improving systematic trading bot. It generates signals from a book of
strategies, learns which of them work in which market conditions, sizes every
position from a fixed risk budget, and can ingest strategies described
elsewhere and put them through a validation gauntlet before they touch money.

**Start here: [Read this first](#read-this-first-about-1000week).**

---

## Read this first: about $1000/week

A dollar target is not a strategy. It only means something next to the balance
that has to produce it:

| Balance | Required weekly return | Verdict |
|---|---|---|
| $5,000 | 20% | Infeasible |
| $25,000 | 4.0% | Infeasible |
| $50,000 | 2.0% | Unlikely |
| $100,000 | 1.0% | Aggressive but possible |
| $200,000 | 0.5% | Comfortable |
| $500,000 | 0.2% | Comfortable |

20% per week compounds to roughly 1,300,000% per year. No fund, trader or
system sustains that. A system that appears to is running a hidden risk that
has not shown up yet.

So the bot **computes this itself and refuses to chase the target**:

```bash
python -m tradingbot goal --equity 5000
```

The critical design property is in `goal/controller.py`: the goal controller
can only scale risk **down**, never up. `scale` is clamped to `<= 1.0`, so
falling behind the target can never talk the bot into betting bigger. That
feedback loop — lose, size up to catch up, lose bigger — is the single most
common way retail accounts die, and here it is structurally impossible rather
than merely discouraged. There is a test that asserts it across thousands of
input combinations (`test_scale_never_exceeds_one`).

If the target is out of reach at your balance, the bot trades its normal size
and reports the shortfall. It will not gamble to close the gap.

**What no software can promise:** that it will make money. This bot brings
discipline, record-keeping, adaptation and a refusal to over-risk. It cannot
manufacture an edge that is not there, and neither can anything else.

---

## What it does

- **Trades MetaTrader 5** — real broker integration, handling the things that
  silently reject orders in production (filling modes, broker stop distances,
  symbol selection, retryable retcodes).
- **Five seed strategies** across trend, breakout and mean-reversion.
- **Learns from every closed trade** by two independent mechanisms:
  - a **contextual bandit** over `(strategy, regime)` that learns which
    strategies work in which market conditions, and suppresses ones that stop
    working;
  - a **meta-model** (gradient boosting) that learns which individual setups
    are worth taking from the feature vector at signal time.
- **Risk-first sizing** — a wider stop buys a smaller position, so the dollar
  loss on a stop-out is the same number regardless of instrument or volatility.
- **Circuit breakers** — daily loss, weekly loss, max drawdown, kill switch.
- **Research pipeline** — ingests strategies described in prose or YAML and
  puts them through backtest → walk-forward → robustness → paper before any
  promotion.
- **Honest backtester** — pessimistic intrabar fills, costs charged both ways,
  and a regression test asserting it *loses* money on a random walk.

---

## Quickstart

```bash
cd ai-trading-bot
pip install -r requirements.txt
```

Check your environment before anything else:

```bash
python -m tradingbot doctor
```

This checks Python, packages, that the MT5 terminal is running and logged in,
that algo trading is enabled, and that your configured symbols exist at your
broker. Fix whatever it flags.

### When doctor says the terminal is unreachable

The Python bridge reports `(-6, 'Terminal: Authorization failed')` for *every*
authorization problem — an expired demo, a wrong server, a bad password and a
terminal with no account at all all produce that same string. So `doctor` reads
the terminal's own log and tells you what the broker actually said:

```
| MT5 terminal reachable  | -- | (-6) Terminal: Authorization failed          |
|   broker said           |    | account 124578369 on ICMarketsSC-Demo:       |
|                         |    | authorization failed (Invalid account)       |
|   likely cause          |    | The broker rejected this login as not        |
|                         |    | existing on that server. Usually an expired  |
|                         |    | demo account, or the right login pointed at  |
|                         |    | the wrong server.                            |
```

Common causes, in rough order:

- **Expired demo.** Most brokers cull demo accounts after ~30 days idle.
  Fix: `File → Open an Account` in MT5 and make a new one.
- **Wrong server.** A login valid on `ICMarketsSC-Demo` is "Invalid account" on
  `ICMarketsGlobal-Demo`. Check the server string exactly.
- **Investor password.** Logs in read-only; the bot cannot place orders.
- **Algo Trading off.** The toolbar button must be green.

### If you run more than one terminal

`mt5.initialize()` attaches to whichever terminal the OS hands it, so with
several installed the bot can silently trade a *different account than you
expect*. Pin it:

```yaml
mt5:
  terminal_path: "C:\\Program Files\\MetaTrader 5 IC Markets Global\\terminal64.exe"
```

`doctor` lists every terminal it can find, with the broker and build each one
is running.

Broker symbol names vary (`EURUSD` vs `EURUSD.a` vs `EURUSD.raw`):

```bash
python -m tradingbot symbols EUR
```

Try it with no broker and no risk at all:

```bash
python -m tradingbot backtest --synthetic
python -m tradingbot walkforward --synthetic
```

Then run it. **Paper mode is the default and requires no credentials:**

```bash
python -m tradingbot run
```

---

## Configuration

Everything tunable is in `config/config.yaml`. **Credentials are not.** They
come from the environment:

```bash
export MT5_LOGIN=12345678
export MT5_PASSWORD='your-password'
export MT5_SERVER='ICMarketsSC-MT5'
```

or from `credentials.yaml`, which is gitignored. Never put them in
`config.yaml`.

---

## The safety model

Risk decisions live in exactly one place — `risk/manager.py` — and it is the
only component that can approve a trade. Strategies decide *direction*; the
risk manager decides *whether and how much*, and it vetoes most signals.

**Hard ceilings** (`config.yaml` → `risk`). Nothing may raise these:

| Limit | Default | Effect |
|---|---|---|
| `max_risk_per_trade_pct` | 0.5% | absolute per-trade ceiling |
| `base_risk_per_trade_pct` | 0.25% | normal size |
| `max_portfolio_risk_pct` | 2% | total open risk |
| `daily_loss_limit_pct` | 3% | stop until tomorrow |
| `weekly_loss_limit_pct` | 6% | stop until Monday |
| `max_drawdown_pct` | 15% | **hard halt, manual reset only** |

Every multiplier in the system (goal scale, model confidence, bandit
confidence, symbol weight) is clamped to `<= 1.0` before it is applied, so the
composition of them can only ever *reduce* size.

The drawdown breaker deliberately does not auto-reset. If the account is down
15%, something about the model of the world is wrong, and the right response is
a human looking at it — not the bot deciding it feels better.

**Kill switch**, effective within one poll cycle:

```bash
python -m tradingbot halt
python -m tradingbot resume
```

Open positions keep their stops when halted; a halt stops *new* trades and
keeps managing existing ones.

**Going live takes two keys**, on purpose:

```yaml
execution:
  mode: live
  allow_live: true
```

Setting `mode: live` alone raises a config error. The CLI then asks for
confirmation interactively.

---

## How the learning works

Every closed trade updates both learners. Reconciliation happens *before* new
decisions each cycle, so a trade that closed badly thirty seconds ago can
influence the next entry.

**Bandit** (`learning/bandit.py`) — Thompson sampling over a Normal posterior
on mean R-multiple, per `(strategy, regime)`:

- reward is **R-multiple, not profit**, so statistics survive changes in
  account size and volatility;
- **exponentially discounted**, so it tracks a changing market rather than
  averaging over regimes that no longer exist — this is the difference between
  learning and merely accumulating;
- uncertainty does the exploring: a strategy with 5 trades has a wide posterior
  and gets sampled optimistically sometimes, one with 300 does not.

**Meta-model** (`learning/meta_model.py`) — gradient boosting on the
signal-time feature vector, predicting P(profitable).

The guard that matters: **if the model does not beat a coin flip on held-out,
time-ordered data (AUC < 0.55), it is refused and the gate stays open.** A
filter that has not demonstrated skill must not be allowed to veto trades — it
would just be an expensive random number generator. Validation is
forward-chaining (train on the past, test on the future), never shuffled;
shuffling price-derived data leaks the future and produces a model that looks
excellent and loses money.

Inspect what it learned:

```bash
python -m tradingbot report
python -m tradingbot retrain
```

`report` includes the **signal funnel** — how many signals were generated
versus taken, and why the rest were rejected. That is what tells you whether
your filters are working or eating all your edge.

---

## The research pipeline

This is the "studies strategies online and from other traders" half. What it
honestly is: a **distiller**. It converts claims into a testable form. It has
no opinion about whether a strategy works — all the filtering is downstream.

Reading ten thousand blog posts does not help if you believe them. It helps
only if you can cheaply reject the 99% that do not survive out-of-sample data
and spread.

Drop `.md`/`.txt` descriptions or `.yaml` specs into `research_sources/`, then:

```bash
python -m tradingbot research --symbol EURUSD --bars 40000
```

**Security.** Extracted rules run on a machine logged into your brokerage
account, so the obvious implementation — `eval()` on the extracted condition —
would be a remote code execution hole with extra steps. Instead,
`research/safe_expr.py` parses to an AST and rejects any node not on an
allowlist: no attribute access, no subscripting, no imports, no comprehensions,
no string literals, and only a handful of registered functions. `test_security.py`
fires 22 attack payloads at it on every run.

**The gauntlet** (`research/gauntlet.py`) — every stage can only reject:

1. **Structural** — safe to express, coherent risk/reward
2. **Backtest** — ≥100 trades, PF ≥ 1.25, Sharpe ≥ 0.8, drawdown ≤ 20%
3. **Walk-forward** — ≥4 rolling windows, ≥60% profitable
4. **Robustness** — survives a 3× spread shock *and* generalises to other
   instruments
5. **Paper** — forward-tested on live prices for 30 days
6. **Promotion** — a human says yes

Stage 4 catches most curve-fits: a real edge is usually a statement about
market structure and shows up in more than one place, while an overfit is a
statement about one price history.

The ingester also **refuses** martingale and grid sizing outright, and lowers
confidence for "98% win rate", "never loses" and "no stop loss needed". When it
cannot represent something (order blocks, fair value gaps, Elliott wave) it
says so rather than guessing — a misextracted strategy that happens to backtest
well is worse than no strategy.

A strategy that clears everything is still only *permitted*, not trusted. It
enters at reduced size under the same bandit that can suppress it again within
a few dozen trades.

---

## Command reference

| Command | Purpose |
|---|---|
| `doctor` | environment and connectivity check — run this first |
| `symbols [pattern]` | list what your broker actually calls things |
| `goal [--equity N]` | is the weekly target realistic? |
| `backtest` | test the strategy book on history |
| `walkforward` | out-of-sample validation — the number that means something |
| `run [--mode paper\|live]` | start trading |
| `status` | account, breakers, goal, model state |
| `report` | performance by strategy, plus the signal funnel |
| `research` | ingest and validate external strategies |
| `retrain` | force a meta-model retrain |
| `halt` / `resume` | kill switch |
| `reset-guards --equity N` | clear a drawdown halt (deliberately manual) |

---

## Testing

```bash
python -m pytest -q
```

256 tests. The ones worth knowing about:

- `test_scale_never_exceeds_one` — the goal can never inflate risk
- `test_never_exceeds_per_trade_ceiling` — swept across equity, ATR, and every
  multiplier combination
- `test_random_walk_is_not_profitable` — **if this ever passes, the backtester
  is cheating**
- `test_indicators_are_causal` — no lookahead: truncating history must not
  change earlier indicator values
- `test_stop_wins_ties_within_a_bar` — pessimistic intrabar fills
- `test_refuses_to_install_a_useless_model` — the AUC floor
- `TestExpressionSandbox` — 22 attack payloads, all blocked

---

## Honest limitations

- **No demonstrated edge.** The five seed strategies are textbook setups. They
  are a *starting point for the learning machinery*, not a proven money-maker.
  Backtest them on your own broker's data before believing anything.
- **Synthetic backtest results mean nothing.** `--synthetic` tests the
  plumbing. The returns it prints are from data with structure I planted; they
  are not evidence of edge, and the CLI says so every time.
- **Fully unattended operation is a goal, not a guarantee.** MT5 must stay
  running and logged in; brokers disconnect, roll servers, and change symbol
  specs. The bot reconnects and has watchdogs, but "deposit money and never
  look again" is not a state any trading system reaches. Check `status` weekly
  at minimum.
- **Paper mode fills its own stops** at poll resolution, so it is slightly
  optimistic versus a real server-side stop during a fast move.
- **Backtest speed** is ~320 bars/sec; 40k bars takes about two minutes.
- **The meta-model needs ~200 closed trades** before it does anything. Expect
  it to be inactive for the first weeks.
- **Costs are modelled, not measured.** Set `commission_per_lot` to your
  broker's actual rate before trusting a backtest.

---

## Recommended path to live

1. `doctor` until everything passes
2. `backtest` and `walkforward` on **your broker's real history**, not synthetic
3. If walk-forward pass rate < 60%, stop — do not trade this configuration
4. Run `paper` mode for at least a month; compare `report` against the backtest
5. Go live at reduced size (drop `base_risk_per_trade_pct` to 0.1%)
6. Raise size only after the live results match paper

Skipping steps 3–4 is how people find out their backtest was fiction, with real
money.
