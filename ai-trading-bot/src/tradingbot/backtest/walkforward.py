"""Walk-forward analysis.

A single backtest over one history tells you almost nothing: with enough
strategies and enough parameters, something always looks good on any fixed
window. Walk-forward asks the harder question -- does the result hold up on
data the configuration has never touched, repeatedly, as the window rolls
forward?

Anchored (expanding) and rolling windows are both supported. Rolling is the
stricter test, because it also forces the strategy to survive without the
oldest, most flattering data.

The output that matters is ``pass_rate``: the fraction of out-of-sample windows
that were profitable. One brilliant window and four bad ones is a strategy that
got lucky once, and the pass rate says so where the aggregate return would not.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..config import Config
from ..strategy.base import Strategy
from .engine import BacktestEngine, BacktestResult

log = logging.getLogger(__name__)


@dataclass
class WindowResult:
    index: int
    train_start: pd.Timestamp
    train_end: pd.Timestamp
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    result: BacktestResult

    @property
    def passed(self) -> bool:
        return self.result.net_profit > 0 and self.result.n_trades > 0


@dataclass
class WalkForwardReport:
    symbol: str
    windows: list[WindowResult] = field(default_factory=list)
    mode: str = "rolling"
    requested_windows: int = 0

    @property
    def n_windows(self) -> int:
        return len(self.windows)

    @property
    def data_limited(self) -> bool:
        """True when fewer windows ran than were asked for.

        Lets a caller distinguish "this strategy failed validation" from "there
        was not enough history to validate it" -- very different verdicts that
        look identical if you only count passing windows.
        """
        return bool(self.requested_windows) and self.n_windows < self.requested_windows

    @property
    def pass_rate(self) -> float:
        if not self.windows:
            return 0.0
        return sum(1 for w in self.windows if w.passed) / len(self.windows)

    @property
    def total_trades(self) -> int:
        return sum(w.result.n_trades for w in self.windows)

    @property
    def aggregate_return(self) -> float:
        """Compounded return across the out-of-sample windows."""
        total = 1.0
        for w in self.windows:
            total *= 1.0 + w.result.return_pct
        return total - 1.0

    @property
    def mean_expectancy_r(self) -> float:
        rs = [t.r_multiple for w in self.windows for t in w.result.trades]
        return float(np.mean(rs)) if rs else 0.0

    @property
    def worst_drawdown(self) -> float:
        return max((w.result.max_drawdown for w in self.windows), default=0.0)

    @property
    def consistency(self) -> float:
        """1 - (stdev / |mean|) of window returns. Punishes lumpy results."""
        rets = [w.result.return_pct for w in self.windows]
        if len(rets) < 2:
            return 0.0
        mean, sd = float(np.mean(rets)), float(np.std(rets, ddof=1))
        if abs(mean) < 1e-9:
            return 0.0
        return float(max(0.0, 1.0 - sd / abs(mean)))

    def summary(self) -> dict:
        return {
            "symbol": self.symbol,
            "mode": self.mode,
            "windows": self.n_windows,
            "pass_rate": round(self.pass_rate, 3),
            "total_trades": self.total_trades,
            "aggregate_return": round(self.aggregate_return, 4),
            "mean_expectancy_r": round(self.mean_expectancy_r, 4),
            "worst_drawdown": round(self.worst_drawdown, 4),
            "consistency": round(self.consistency, 3),
        }

    def __str__(self) -> str:  # pragma: no cover
        s = self.summary()
        return (
            f"walk-forward {self.symbol} [{self.mode}]: {s['windows']} windows, "
            f"pass rate {s['pass_rate']:.0%}, {s['total_trades']} trades, "
            f"agg return {s['aggregate_return']:+.2%}, "
            f"exp {s['mean_expectancy_r']:+.3f}R, worst DD {s['worst_drawdown']:.2%}"
        )

    def table(self) -> str:  # pragma: no cover
        lines = [
            f"{'win':>3} {'test period':<26} {'trades':>6} {'ret':>8} "
            f"{'PF':>6} {'expR':>7}  ok"
        ]
        for w in self.windows:
            r = w.result
            pf = r.profit_factor
            # str() first: date.__format__ treats a spec like "<12" as a
            # strftime pattern and emits it literally.
            period = f"{w.test_start.date()}..{w.test_end.date()}"
            lines.append(
                f"{w.index:>3} {period:<26} "
                f"{r.n_trades:>6} {r.return_pct:>+7.2%} "
                f"{(f'{pf:.2f}' if np.isfinite(pf) else 'inf'):>6} "
                f"{r.expectancy_r:>+7.3f}  {'Y' if w.passed else 'n'}"
            )
        return "\n".join(lines)


def walk_forward(
    cfg: Config,
    strategies: list[Strategy],
    df: pd.DataFrame,
    symbol: str,
    timeframe: str = "M15",
    n_windows: int = 6,
    train_frac: float = 0.6,
    mode: str = "rolling",
    starting_equity: float = 100_000.0,
    warmup: int = 250,
) -> WalkForwardReport:
    """Split ``df`` into ``n_windows`` train/test folds and test each one.

    The strategies here are rule-based, so "training" means letting the bandit
    accumulate statistics on the training slice; the reported result is the
    *test* slice only, with the bandit state carried forward exactly as it
    would be live.
    """
    report = WalkForwardReport(symbol=symbol, mode=mode)
    n = len(df)

    # Reserve enough history before the FIRST test window for a real training
    # slice. Laying folds out from bar 0 instead silently drops the first
    # window (its training slice is too short), so a caller asking for 6
    # windows gets 5 and reads that as a failure rather than as a data limit.
    min_train = warmup + 150
    reserve = warmup + min_train if mode == "rolling" else warmup + min_train

    min_test = 100
    if n < reserve + min_test * 2:
        log.warning(
            "%s: %d bars is not enough for walk-forward (need >= %d)",
            symbol, n, reserve + min_test * 2,
        )
        return report

    testable = n - reserve
    fold = testable // n_windows
    if fold < min_test:
        n_windows = max(2, testable // min_test)
        fold = testable // n_windows
        log.info(
            "%s: reduced to %d walk-forward windows (%d bars available)",
            symbol, n_windows, n,
        )
    report.requested_windows = n_windows

    train_len = int(fold * train_frac / (1 - train_frac)) if train_frac < 1 else fold
    train_len = max(train_len, min_train)

    for k in range(n_windows):
        test_start_i = reserve + k * fold
        test_end_i = min(test_start_i + fold, n)
        if test_end_i - test_start_i < min_test:
            break

        if mode == "anchored":
            train_start_i = 0
        else:
            train_start_i = max(0, test_start_i - train_len - warmup)

        train_slice = df.iloc[train_start_i:test_start_i]
        test_slice = df.iloc[max(0, test_start_i - warmup) : test_end_i]

        if len(train_slice) < min_train or len(test_slice) < warmup + min_test:
            log.debug("window %d skipped: insufficient slice length", k)
            continue

        engine = BacktestEngine(
            cfg, strategies, starting_equity=starting_equity, use_bandit=True,
            seed=100 + k,
        )
        # Warm the bandit on the training slice; discard its P&L.
        engine.run(train_slice, symbol, timeframe, warmup=warmup)
        # Then measure only out-of-sample.
        test_result = engine.run(test_slice, symbol, timeframe, warmup=warmup)

        report.windows.append(
            WindowResult(
                index=k,
                train_start=train_slice.index[0],
                train_end=train_slice.index[-1],
                test_start=test_slice.index[warmup]
                if len(test_slice) > warmup
                else test_slice.index[0],
                test_end=test_slice.index[-1],
                result=test_result,
            )
        )

    return report
