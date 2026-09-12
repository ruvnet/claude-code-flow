"""The gauntlet: what a strategy must survive before it touches money.

Most published trading strategies do not work. Some never worked and were
curve-fitted into existence; some worked once and were arbitraged away; some
work but not after spread and commission. The base rate is bad enough that the
correct default for any strategy found on the internet is *no*.

So promotion is a ratchet, and every stage can only reject:

    1. STRUCTURAL     safe to express, coherent risk/reward
    2. BACKTEST       enough trades, profit factor, Sharpe, drawdown
    3. WALK-FORWARD   holds up out-of-sample across rolling windows
    4. ROBUSTNESS     works on more than one instrument, survives cost shocks
    5. PAPER          proven forward in real time on live prices
    6. PROMOTION      a human says yes (unless auto_promote is on)

Stage 4 is the one that catches most curve-fits: a real edge is usually a
statement about market structure and shows up in more than one place, while an
overfit is a statement about one particular price history.

A strategy that clears everything is still only *permitted*, not trusted -- it
enters live trading at reduced size under the same bandit that can suppress it
again within a few dozen trades.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

import pandas as pd

from ..config import Config
from ..backtest.engine import BacktestEngine, BacktestResult
from ..backtest.walkforward import walk_forward
from .spec import SpecStrategy, StrategySpec

log = logging.getLogger(__name__)


class Stage(str, Enum):
    STRUCTURAL = "structural"
    BACKTEST = "backtest"
    WALK_FORWARD = "walk_forward"
    ROBUSTNESS = "robustness"
    PAPER = "paper"
    PROMOTION = "promotion"


@dataclass
class StageResult:
    stage: Stage
    passed: bool
    reason: str
    metrics: dict = field(default_factory=dict)


@dataclass
class GauntletReport:
    spec_name: str
    source: str = ""
    stages: list[StageResult] = field(default_factory=list)
    verdict: str = "rejected"
    evaluated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def passed(self) -> bool:
        return bool(self.stages) and all(s.passed for s in self.stages)

    @property
    def failed_at(self) -> Stage | None:
        for s in self.stages:
            if not s.passed:
                return s.stage
        return None

    def add(self, stage: Stage, passed: bool, reason: str, **metrics) -> bool:
        self.stages.append(StageResult(stage, passed, reason, metrics))
        if not passed:
            log.info("gauntlet: %s FAILED at %s -- %s", self.spec_name,
                     stage.value, reason)
        return passed

    def summary(self) -> str:
        lines = [f"Gauntlet report: {self.spec_name}"]
        if self.source:
            lines.append(f"  source: {self.source}")
        for s in self.stages:
            lines.append(
                f"  [{'PASS' if s.passed else 'FAIL'}] {s.stage.value:<13} {s.reason}"
            )
        lines.append(f"  VERDICT: {self.verdict.upper()}")
        return "\n".join(lines)


class Gauntlet:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.rcfg = cfg.research

    def run(
        self,
        spec: StrategySpec,
        datasets: dict[str, pd.DataFrame],
        starting_equity: float = 100_000.0,
    ) -> GauntletReport:
        """Put a spec through every stage. Stops at the first failure."""
        report = GauntletReport(spec_name=spec.name, source=spec.source)

        # ---- 1. structural ------------------------------------------------
        problems = spec.validate()
        if not report.add(
            Stage.STRUCTURAL,
            not problems,
            "; ".join(problems) if problems else "spec is safe and coherent",
            problems=problems,
        ):
            report.verdict = "rejected"
            return report

        try:
            strategy = spec.build()
        except Exception as exc:
            report.add(Stage.STRUCTURAL, False, f"could not build: {exc}")
            report.verdict = "rejected"
            return report

        if not datasets:
            report.add(Stage.BACKTEST, False, "no price data supplied")
            report.verdict = "rejected"
            return report

        primary_symbol = next(iter(datasets))
        primary_df = datasets[primary_symbol]

        # ---- 2. backtest ---------------------------------------------------
        result = self._backtest(strategy, primary_df, primary_symbol, starting_equity)
        ok, reason = self._judge_backtest(result)
        if not report.add(
            Stage.BACKTEST, ok, reason, **result.summary()
        ):
            report.verdict = "rejected"
            return report

        # ---- 3. walk-forward ----------------------------------------------
        wf = walk_forward(
            self.cfg, [spec.build()], primary_df, primary_symbol,
            n_windows=max(self.rcfg.min_walkforward_windows, 4),
            starting_equity=starting_equity,
        )
        enough_windows = wf.n_windows >= self.rcfg.min_walkforward_windows
        good_pass_rate = wf.pass_rate >= self.rcfg.min_walkforward_pass_rate
        wf_ok = enough_windows and good_pass_rate

        if not enough_windows:
            # Not a verdict on the strategy -- a verdict on the data supplied.
            wf_reason = (
                f"only {wf.n_windows} usable window(s) from {len(primary_df):,} "
                f"bars; {self.rcfg.min_walkforward_windows} are required. This "
                f"is INSUFFICIENT DATA, not a failed strategy -- supply more "
                f"history and re-run before drawing any conclusion."
            )
        else:
            wf_reason = (
                f"{wf.n_windows} windows, {wf.pass_rate:.0%} profitable "
                f"(need >= {self.rcfg.min_walkforward_pass_rate:.0%})"
            )

        if not report.add(
            Stage.WALK_FORWARD, wf_ok, wf_reason,
            data_limited=not enough_windows, **wf.summary()
        ):
            report.verdict = "insufficient_data" if not enough_windows else "rejected"
            return report

        # ---- 4. robustness -------------------------------------------------
        ok, reason, metrics = self._robustness(
            spec, datasets, primary_symbol, starting_equity
        )
        if not report.add(Stage.ROBUSTNESS, ok, reason, **metrics):
            report.verdict = "rejected"
            return report

        # ---- 5. paper ------------------------------------------------------
        # Cannot be simulated -- it requires real elapsed time on live prices.
        report.add(
            Stage.PAPER,
            False,
            f"awaiting {self.rcfg.paper_trade_days} days / "
            f"{self.rcfg.min_paper_trades} trades of forward paper testing",
            required_days=self.rcfg.paper_trade_days,
            required_trades=self.rcfg.min_paper_trades,
        )
        report.verdict = "paper_pending"
        return report

    # ------------------------------------------------------------------ parts

    def _backtest(
        self, strategy: SpecStrategy, df: pd.DataFrame, symbol: str, equity: float
    ) -> BacktestResult:
        engine = BacktestEngine(
            self.cfg, [strategy], starting_equity=equity, use_bandit=False
        )
        return engine.run(df, symbol, "M15")

    def _judge_backtest(self, r: BacktestResult) -> tuple[bool, str]:
        c = self.rcfg
        if r.n_trades < c.min_backtest_trades:
            return False, (
                f"only {r.n_trades} trades, need {c.min_backtest_trades} for the "
                f"statistics to mean anything"
            )
        if r.profit_factor < c.min_profit_factor:
            return False, (
                f"profit factor {r.profit_factor:.2f} below {c.min_profit_factor}"
            )
        if r.sharpe < c.min_sharpe:
            return False, f"Sharpe {r.sharpe:.2f} below {c.min_sharpe}"
        if r.max_drawdown > c.max_backtest_drawdown_pct:
            return False, (
                f"max drawdown {r.max_drawdown:.1%} exceeds "
                f"{c.max_backtest_drawdown_pct:.0%}"
            )
        if r.expectancy_r <= 0:
            return False, f"expectancy {r.expectancy_r:+.3f}R is not positive"
        return True, (
            f"{r.n_trades} trades, PF {r.profit_factor:.2f}, "
            f"Sharpe {r.sharpe:.2f}, exp {r.expectancy_r:+.3f}R, "
            f"maxDD {r.max_drawdown:.1%}"
        )

    def _robustness(
        self,
        spec: StrategySpec,
        datasets: dict[str, pd.DataFrame],
        primary: str,
        equity: float,
    ) -> tuple[bool, str, dict]:
        """Cross-instrument generalisation plus a cost-shock stress test."""
        others = {k: v for k, v in datasets.items() if k != primary}
        metrics: dict = {}

        # (a) cost shock: triple the spread and double commission. A real edge
        #     shrinks; a marginal one inverts.
        stressed = BacktestEngine(
            self.cfg, [spec.build()], starting_equity=equity,
            spread_points=36.0, commission_per_lot=14.0, slippage_points=5.0,
            use_bandit=False,
        ).run(datasets[primary], primary, "M15")
        metrics["stress_profit_factor"] = round(stressed.profit_factor, 3) if (
            stressed.profit_factor != float("inf")
        ) else None
        metrics["stress_return"] = round(stressed.return_pct, 4)

        if stressed.net_profit <= 0:
            return False, (
                f"does not survive realistic costs: under 3x spread the return "
                f"is {stressed.return_pct:+.2%}. The edge was paying the broker."
            ), metrics

        # (b) other instruments
        if not others:
            return True, (
                f"survives a 3x cost shock ({stressed.return_pct:+.2%}); "
                f"no second instrument supplied, so cross-market generalisation "
                f"is UNTESTED"
            ), metrics

        wins = 0
        per_symbol: dict[str, float] = {}
        for sym, df in others.items():
            r = BacktestEngine(
                self.cfg, [spec.build()], starting_equity=equity, use_bandit=False
            ).run(df, sym, "M15")
            per_symbol[sym] = round(r.return_pct, 4)
            if r.net_profit > 0 and r.n_trades >= 20:
                wins += 1
        metrics["per_symbol_return"] = per_symbol

        need = max(1, len(others) // 2)
        if wins < need:
            return False, (
                f"profitable on only {wins}/{len(others)} other instruments "
                f"(need {need}). Looks fitted to {primary} rather than to a "
                f"real market behaviour."
            ), metrics

        return True, (
            f"survives 3x costs ({stressed.return_pct:+.2%}) and is profitable "
            f"on {wins}/{len(others)} other instruments"
        ), metrics

    # ------------------------------------------------------------- promotion

    def promote(
        self, spec: StrategySpec, report: GauntletReport, acknowledged: bool = False
    ) -> tuple[bool, str]:
        """Advance a spec's status. Requires an explicit human ack by default."""
        if not report.stages:
            return False, "no gauntlet report"

        blocking = [s for s in report.stages if not s.passed and s.stage is not Stage.PAPER]
        if blocking:
            return False, f"still failing at {blocking[0].stage.value}"

        if not (acknowledged or self.rcfg.auto_promote):
            return False, (
                "cleared the automated stages but promotion needs a human ack "
                "(pass --acknowledge, or set research.auto_promote: true)"
            )

        spec.status = "paper"
        spec.notes = (
            f"cleared automated gauntlet {report.evaluated_at.date()}; "
            f"now forward-testing on paper"
        )
        return True, f"{spec.name} promoted to paper trading"
