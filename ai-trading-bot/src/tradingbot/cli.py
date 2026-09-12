"""Command-line interface.

    python -m tradingbot doctor          check the environment before anything else
    python -m tradingbot symbols         list what your broker actually calls things
    python -m tradingbot goal            is $1000/week realistic on this balance?
    python -m tradingbot backtest        test the strategy book on history
    python -m tradingbot walkforward     the honest version of a backtest
    python -m tradingbot run             start trading (paper by default)
    python -m tradingbot status          what is it doing right now
    python -m tradingbot report          performance, per strategy and regime
    python -m tradingbot research        ingest and gauntlet external strategies
    python -m tradingbot halt / resume   kill switch
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from .config import ROOT, load_config
from .ops.logging_setup import setup as setup_logging

app = typer.Typer(
    add_completion=False,
    help="AI trading bot for MetaTrader 5 -- learns from every trade.",
    no_args_is_help=True,
)
console = Console()
log = logging.getLogger("tradingbot.cli")

CONFIG_OPT = typer.Option(None, "--config", "-c", help="Path to config.yaml")


def _load(config: str | None):
    cfg = load_config(config)
    setup_logging(cfg.ops.log_level, cfg.path("log_dir"))
    return cfg


def _broker(cfg, force_mt5: bool = False):
    """Build the broker the configured mode implies."""
    from .mt5_client import MT5Broker

    mt5_broker = MT5Broker(cfg.mt5)
    if cfg.execution.mode == "live" or force_mt5:
        return mt5_broker

    from .execution.paper import PaperBroker

    return PaperBroker(
        price_source=mt5_broker,
        starting_balance=100_000.0,
        state_path=cfg.path("state_path").parent / "paper_account.json",
    )


# --------------------------------------------------------------------- doctor


@app.command()
def doctor(config: str = CONFIG_OPT) -> None:
    """Check everything that has to be true before the bot can trade."""
    cfg = _load(config)
    console.print("\n[bold]Environment check[/bold]\n")

    rows: list[tuple[str, bool, str]] = []

    rows.append(("Python >= 3.10", sys.version_info >= (3, 10),
                 sys.version.split()[0]))

    for pkg in ("pandas", "numpy", "sklearn", "yaml", "pydantic"):
        try:
            __import__(pkg)
            rows.append((f"package: {pkg}", True, "installed"))
        except ImportError:
            rows.append((f"package: {pkg}", False, "MISSING -- pip install -r requirements.txt"))

    try:
        import MetaTrader5 as mt5

        rows.append(("package: MetaTrader5", True, mt5.__version__))
    except ImportError:
        rows.append((
            "package: MetaTrader5", False,
            "MISSING -- pip install MetaTrader5 (Windows only)",
        ))
        mt5 = None

    if mt5 is not None:
        ok = mt5.initialize(**({"path": cfg.mt5.terminal_path} if cfg.mt5.terminal_path else {}))
        if ok:
            info = mt5.account_info()
            term = mt5.terminal_info()
            rows.append(("MT5 terminal reachable", True, "connected"))
            if info:
                rows.append((
                    "MT5 account logged in", True,
                    f"#{info.login} {info.server} "
                    f"{info.balance:.2f} {info.currency}",
                ))
            else:
                rows.append(("MT5 account logged in", False,
                             "terminal is running but no account is logged in"))
            if term:
                rows.append((
                    "Algo trading enabled", bool(term.trade_allowed),
                    "on" if term.trade_allowed
                    else "OFF -- click the Algo Trading button in MT5",
                ))
            missing = [
                s.name for s in cfg.enabled_symbols
                if mt5.symbol_info(s.name) is None
            ]
            rows.append((
                "Configured symbols exist", not missing,
                "all found" if not missing
                else f"not found: {', '.join(missing)} (run `symbols` to list)",
            ))
            mt5.shutdown()
        else:
            code, msg = mt5.last_error()
            # (-6, 'Authorization failed') covers an expired demo, a wrong
            # server, a bad password and a terminal with no account at all.
            # The terminal's own log knows which -- surface that instead.
            from .ops.mt5_diagnostics import diagnose_all

            hint = "start MetaTrader 5 and log in"
            try:
                failures = [d for d in diagnose_all() if d.is_failure]
                if failures:
                    d = failures[0]
                    hint = f"{d.summary()}"
                    mt5_detail = d.explanation
                else:
                    mt5_detail = ""
            except Exception:  # diagnostics must never break the check itself
                log.debug("log diagnostics failed", exc_info=True)
                mt5_detail = ""

            rows.append(("MT5 terminal reachable", False, f"({code}) {msg}"))
            # ok=None marks an explanatory row: rendered, but not counted as a
            # separate failure.
            rows.append(("  broker said", None, hint))
            if mt5_detail:
                rows.append(("  likely cause", None, mt5_detail))

    var = cfg.path("state_path").parent
    try:
        var.mkdir(parents=True, exist_ok=True)
        probe = var / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        rows.append(("var/ writable", True, str(var)))
    except Exception as exc:
        rows.append(("var/ writable", False, str(exc)))

    halt = var / "HALT"
    rows.append((
        "Kill switch clear", not halt.exists(),
        "clear" if not halt.exists() else f"HALT file present at {halt}",
    ))

    live_armed = cfg.execution.mode == "live" and cfg.execution.allow_live
    rows.append((
        "Execution mode", True,
        f"{cfg.execution.mode.upper()}"
        + (" -- REAL MONEY" if live_armed else " (no real money at risk)"),
    ))

    table = Table(show_header=True, header_style="bold")
    table.add_column("check", width=26)
    table.add_column("", width=4)
    table.add_column("detail")
    for name, ok, detail in rows:
        if ok is None:
            marker = ""           # explanatory continuation of the row above
        elif ok:
            marker = "[green]OK[/green]"
        else:
            marker = "[red]--[/red]"
        table.add_row(name, marker, detail)
    console.print(table)

    failures = [r for r in rows if r[1] is False]
    if failures:
        console.print(
            f"\n[red]{len(failures)} check(s) failed.[/red] "
            "Fix these before running.\n"
        )
        raise typer.Exit(1)
    console.print("\n[green]All checks passed.[/green]\n")


@app.command()
def symbols(
    pattern: str = typer.Argument("", help="Filter, e.g. EUR"),
    config: str = CONFIG_OPT,
) -> None:
    """List the symbols your broker actually offers (names vary per broker)."""
    cfg = _load(config)
    from .mt5_client import MT5Broker

    broker = MT5Broker(cfg.mt5)
    broker.connect()
    names = broker.list_symbols()
    if pattern:
        names = [n for n in names if pattern.upper() in n.upper()]
    console.print(f"\n{len(names)} symbol(s)"
                  + (f" matching {pattern!r}" if pattern else "") + ":\n")
    for i in range(0, len(names), 6):
        console.print("  " + "".join(f"{n:<16}" for n in names[i:i + 6]))
    broker.disconnect()


# ----------------------------------------------------------------------- goal


@app.command()
def goal(
    equity: float = typer.Option(None, help="Assume this equity instead of asking MT5"),
    config: str = CONFIG_OPT,
) -> None:
    """Is the weekly profit target realistic on the current balance?"""
    cfg = _load(config)
    from .goal.controller import GoalController

    if equity is None:
        try:
            broker = _broker(cfg)
            broker.connect()
            equity = broker.account().equity
            broker.disconnect()
        except Exception as exc:
            console.print(f"[yellow]Could not reach the broker ({exc}).[/yellow]")
            console.print("Pass --equity to run the numbers anyway.\n")
            raise typer.Exit(1)

    console.print()
    console.print(GoalController(cfg.goal).reality_check(equity))
    console.print()


# ------------------------------------------------------------------ backtest


@app.command()
def backtest(
    symbol: str = typer.Option("EURUSD", "--symbol", "-s"),
    timeframe: str = typer.Option("M15", "--timeframe", "-t"),
    bars: int = typer.Option(20_000, help="How many bars of history"),
    equity: float = typer.Option(100_000.0),
    synthetic: bool = typer.Option(False, help="Use generated data (no MT5 needed)"),
    config: str = CONFIG_OPT,
) -> None:
    """Backtest the enabled strategy book."""
    cfg = _load(config)
    from .backtest.engine import BacktestEngine
    from .strategy import registry

    df = _history(cfg, symbol, timeframe, bars, synthetic)
    if df.empty:
        console.print("[red]no data[/red]")
        raise typer.Exit(1)

    strategies = registry.build(cfg.strategies)
    console.print(
        f"\nBacktesting {len(strategies)} strategies on {symbol} {timeframe}, "
        f"{len(df):,} bars ({df.index[0].date()} to {df.index[-1].date()})\n"
    )
    engine = BacktestEngine(cfg, strategies, starting_equity=equity)
    result = engine.run(df, symbol, timeframe)

    _print_backtest(result)
    if engine.bandit:
        rows = engine.bandit.leaderboard()[:10]
        if rows:
            table = Table(title="what the bandit learned", header_style="bold")
            for col in ("strategy", "regime", "trades", "mean R", "win rate"):
                table.add_column(col)
            for r in rows:
                table.add_row(
                    r["strategy"], r["regime"], str(r["trades"]),
                    f"{r['mean_r']:+.3f}", f"{r['win_rate']:.1%}",
                )
            console.print(table)

    if synthetic:
        console.print(
            "\n[yellow]This was synthetic data. It tests the plumbing, not the "
            "strategy. Nothing here is evidence of edge.[/yellow]\n"
        )


@app.command()
def walkforward(
    symbol: str = typer.Option("EURUSD", "--symbol", "-s"),
    timeframe: str = typer.Option("M15", "--timeframe", "-t"),
    bars: int = typer.Option(40_000),
    windows: int = typer.Option(6),
    mode: str = typer.Option("rolling", help="rolling | anchored"),
    synthetic: bool = typer.Option(False),
    config: str = CONFIG_OPT,
) -> None:
    """Walk-forward analysis -- the number that actually means something."""
    cfg = _load(config)
    from .backtest.walkforward import walk_forward
    from .strategy import registry

    df = _history(cfg, symbol, timeframe, bars, synthetic)
    if df.empty:
        console.print("[red]no data[/red]")
        raise typer.Exit(1)

    report = walk_forward(
        cfg, registry.build(cfg.strategies), df, symbol, timeframe,
        n_windows=windows, mode=mode,
    )
    console.print(f"\n{report}\n")
    console.print(report.table())
    console.print()
    if report.pass_rate < 0.6:
        console.print(
            "[yellow]Pass rate below 60%: this configuration does not hold up "
            "out-of-sample. Do not trade it live.[/yellow]\n"
        )


def _history(cfg, symbol: str, timeframe: str, bars: int, synthetic: bool):
    if synthetic:
        from .data.synthetic import make_bars

        console.print("[dim]using synthetic data[/dim]")
        return make_bars(bars, regime_switching=True, seed=17)
    from .mt5_client import MT5Broker

    broker = MT5Broker(cfg.mt5)
    try:
        broker.connect()
        df = broker.bars(symbol, timeframe, bars)
        broker.disconnect()
        return df
    except Exception as exc:
        console.print(f"[yellow]MT5 unavailable ({exc}); use --synthetic.[/yellow]")
        return __import__("pandas").DataFrame()


def _print_backtest(result) -> None:
    s = result.summary()
    table = Table(show_header=False, box=None)
    table.add_column(style="bold", width=20)
    table.add_column()
    pf = s["profit_factor"]
    for label, value in [
        ("trades", f"{s['trades']:,}"),
        ("win rate", f"{s['win_rate']:.1%}"),
        ("profit factor", f"{pf:.2f}" if pf is not None else "inf"),
        ("expectancy", f"{s['expectancy_r']:+.3f} R"),
        ("net profit", f"{s['net_profit']:+,.2f}"),
        ("return", f"{s['return_pct']:+.2%}"),
        ("max drawdown", f"{s['max_drawdown']:.2%}"),
        ("Sharpe", f"{s['sharpe']:.2f}"),
    ]:
        table.add_row(label, value)
    console.print(table)

    if result.rejections:
        console.print("\n[dim]why signals were rejected:[/dim]")
        for reason, n in sorted(
            result.rejections.items(), key=lambda kv: -kv[1]
        )[:6]:
            console.print(f"  [dim]{n:>6}  {reason}[/dim]")


# ---------------------------------------------------------------------- run


@app.command()
def run(
    mode: str = typer.Option(None, help="Override execution mode: paper | live"),
    config: str = CONFIG_OPT,
) -> None:
    """Start the trading loop."""
    cfg = _load(config)
    if mode:
        cfg = cfg.model_copy(
            update={"execution": cfg.execution.model_copy(update={"mode": mode})}
        )

    if cfg.execution.mode == "live":
        if not cfg.execution.allow_live:
            console.print(
                "\n[red]Refusing to trade live.[/red] Set "
                "[bold]execution.allow_live: true[/bold] in config.yaml as well "
                "as mode: live. Two keys, on purpose.\n"
            )
            raise typer.Exit(1)
        console.print("\n[bold red]LIVE MODE -- REAL MONEY[/bold red]")
        typer.confirm("Trade with real money?", abort=True)

    from .engine import TradingEngine

    engine = TradingEngine(cfg, _broker(cfg))
    try:
        engine.run_forever()
    except KeyboardInterrupt:
        console.print("\ninterrupted")


@app.command()
def status(config: str = CONFIG_OPT) -> None:
    """Show current account, guard and goal state."""
    cfg = _load(config)
    from .engine import TradingEngine

    engine = TradingEngine(cfg, _broker(cfg))
    engine.broker.connect()
    data = engine.status()
    engine.broker.disconnect()

    table = Table(show_header=False, box=None)
    table.add_column(style="bold", width=20)
    table.add_column()
    for k, v in data.items():
        if isinstance(v, float):
            v = f"{v:,.4f}" if abs(v) < 1 else f"{v:,.2f}"
        table.add_row(k.replace("_", " "), str(v))
    console.print()
    console.print(table)
    console.print()


@app.command()
def report(
    days: int = typer.Option(30),
    config: str = CONFIG_OPT,
) -> None:
    """Performance report from the trade journal."""
    cfg = _load(config)
    from .learning.journal import Journal

    j = Journal(cfg.path("db_path"))
    overall = j.stats()

    console.print("\n[bold]Overall[/bold]")
    if overall["trades"] == 0:
        console.print("  no closed trades yet\n")
    else:
        pf = overall["profit_factor"]
        console.print(
            f"  {overall['trades']} trades | win {overall['win_rate']:.1%} | "
            f"PF {pf:.2f} | net {overall['net_profit']:+,.2f} | "
            f"avg {overall['avg_r']:+.3f}R\n"
        )

    board = j.strategy_leaderboard()
    if board:
        table = Table(title="by strategy", header_style="bold")
        for col in ("strategy", "trades", "win rate", "PF", "net", "avg R"):
            table.add_column(col)
        for r in board:
            pf = r["profit_factor"]
            table.add_row(
                r["strategy"], str(r["trades"]), f"{r['win_rate']:.1%}",
                f"{pf:.2f}" if pf != float("inf") else "inf",
                f"{r['net_profit']:+,.2f}", f"{r['avg_r']:+.3f}",
            )
        console.print(table)

    funnel = j.signal_funnel(days)
    console.print(
        f"\n[bold]Signal funnel[/bold] (last {days} days): "
        f"{funnel['signals']} signals, {funnel['accepted']} taken "
        f"({funnel['acceptance_rate']:.1%})"
    )
    for reason, n in funnel["top_rejections"]:
        console.print(f"  [dim]{n:>6}  {reason}[/dim]")
    console.print()


# ------------------------------------------------------------------ research


@app.command()
def research(
    ingest_dir: str = typer.Option(None, help="Directory of source documents"),
    run_gauntlet: bool = typer.Option(True, "--gauntlet/--no-gauntlet"),
    symbol: str = typer.Option("EURUSD"),
    bars: int = typer.Option(20_000),
    synthetic: bool = typer.Option(False),
    acknowledge: bool = typer.Option(
        False, "--acknowledge", help="Human ack required to promote to paper"
    ),
    config: str = CONFIG_OPT,
) -> None:
    """Ingest external strategy descriptions and run them through the gauntlet."""
    cfg = _load(config)
    from .research.gauntlet import Gauntlet
    from .research.ingest import ingest_directory

    src = Path(ingest_dir) if ingest_dir else ROOT / cfg.research.sources_dir
    results = ingest_directory(src)
    if not results:
        console.print(
            f"\nNo source documents in [bold]{src}[/bold].\n\n"
            "Drop .md/.txt files describing strategies, or .yaml files with "
            "explicit long_entry/short_entry expressions, then re-run.\n"
        )
        raise typer.Exit(0)

    console.print(f"\nIngested {len(results)} document(s) from {src}\n")
    specs = []
    for r in results:
        if r.spec is None:
            console.print(f"  [yellow]skipped[/yellow]: {r.note}")
            continue
        console.print(
            f"  [green]extracted[/green] {r.spec.name} "
            f"(confidence {r.confidence:.2f}, matched {', '.join(r.matched)})"
        )
        specs.append(r.spec)

    if not specs or not run_gauntlet:
        return

    df = _history(cfg, symbol, "M15", bars, synthetic)
    if df.empty:
        console.print("[red]no price data for validation[/red]")
        raise typer.Exit(1)

    datasets = {symbol: df}
    gauntlet = Gauntlet(cfg)
    out_dir = ROOT / "strategies"
    out_dir.mkdir(exist_ok=True)

    for spec in specs:
        console.print()
        rep = gauntlet.run(spec, datasets)
        console.print(rep.summary())
        ok, msg = gauntlet.promote(spec, rep, acknowledged=acknowledge)
        console.print(f"  promotion: {msg}")
        spec.save(out_dir / f"{spec.name}.yaml")
    console.print(f"\nSpecs written to {out_dir}\n")


# ---------------------------------------------------------------- kill switch


@app.command()
def halt(
    reason: str = typer.Option("manual", help="Why"),
    config: str = CONFIG_OPT,
) -> None:
    """Engage the kill switch. The running bot stops opening trades."""
    cfg = _load(config)
    from .risk.guards import RiskGuards

    path = RiskGuards(cfg.risk, cfg.path("state_path")).engage_kill_switch(reason)
    console.print(f"\n[red]Kill switch engaged[/red] -> {path}")
    console.print("Open positions keep their stops. Run `resume` to clear.\n")


@app.command()
def resume(config: str = CONFIG_OPT) -> None:
    """Release the kill switch."""
    cfg = _load(config)
    from .risk.guards import RiskGuards

    released = RiskGuards(cfg.risk, cfg.path("state_path")).release_kill_switch()
    console.print(
        "\n[green]Kill switch released[/green]\n" if released
        else "\nNo kill switch was set\n"
    )


@app.command("reset-guards")
def reset_guards(
    equity: float = typer.Option(..., help="Re-anchor baselines to this equity"),
    config: str = CONFIG_OPT,
) -> None:
    """Clear a drawdown halt. Deliberately manual -- review first."""
    cfg = _load(config)
    from .risk.guards import RiskGuards

    console.print(
        "\n[yellow]The drawdown breaker exists because a 15% loss means "
        "something is wrong. Confirm you have reviewed the journal.[/yellow]"
    )
    typer.confirm("Reset the circuit breakers?", abort=True)
    RiskGuards(cfg.risk, cfg.path("state_path")).reset(equity)
    console.print("[green]guards reset[/green]\n")


@app.command()
def retrain(config: str = CONFIG_OPT) -> None:
    """Force a meta-model retrain from the journal."""
    cfg = _load(config)
    from .learning.journal import Journal
    from .learning.meta_model import MetaModel

    j = Journal(cfg.path("db_path"))
    trades = j.closed_trades()
    model = MetaModel(
        cfg.learning.meta_model_min_samples, cfg.learning.meta_model_gate_threshold
    )
    rep = model.train(trades)
    console.print(f"\n{rep.summary()}\n")
    if rep.accepted:
        model.save(cfg.path("state_path").parent / "meta_model.pkl")
        if rep.feature_importance:
            console.print("[bold]what it keys on:[/bold]")
            for k, v in rep.feature_importance.items():
                console.print(f"  {k:<18} {v:.3f}")
        console.print()


def main() -> None:
    app()


if __name__ == "__main__":
    main()
