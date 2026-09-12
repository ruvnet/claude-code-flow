"""Strategy contract.

Convention that the whole system depends on: a strategy is handed a DataFrame
of **closed bars only**, and evaluates the last row. The live engine drops the
still-forming bar before calling. Backtest does the same. Break that and the
backtest starts trading on information that did not exist yet.
"""
from __future__ import annotations

import abc
import logging
from typing import Any

import pandas as pd

from ..types import Regime, Side, Signal

log = logging.getLogger(__name__)


class Strategy(abc.ABC):
    """Base class for every signal generator.

    Subclasses implement :meth:`evaluate`. They must not place orders, size
    positions, or look at account state -- those decisions belong to the risk
    manager, which can veto any signal.
    """

    name: str = "unnamed"
    # Regimes this strategy claims to work in. The bandit still measures the
    # truth; this is only a prior that avoids obviously wasted trades.
    preferred_regimes: tuple[Regime, ...] = ()
    min_bars: int = 250

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        self.params = dict(self.defaults())
        if params:
            self.params.update({k: v for k, v in params.items() if k != "enabled"})
        self.enabled = bool((params or {}).get("enabled", True))

    @staticmethod
    def defaults() -> dict[str, Any]:
        return {}

    @abc.abstractmethod
    def evaluate(self, df: pd.DataFrame, symbol: str) -> Signal | None:
        """Return a Signal for the last (closed) bar, or None to stand aside."""

    # ------------------------------------------------------------------ utils

    def ready(self, df: pd.DataFrame) -> bool:
        return not df.empty and len(df) >= self.min_bars

    # Recomputing an indicator over the full history on every bar makes a
    # backtest O(n^2) -- at 40k bars that is the difference between seconds and
    # an hour. Two escapes, in order of preference:
    #
    #   column()  reuse the value features.build() already computed
    #   tail()    compute over a bounded recent window instead of everything
    #
    # tail() is an approximation for recursive indicators (EMA, ATR, RSI): a
    # different seed point shifts early values, but the influence of the seed
    # decays as (1-alpha)^k, so at 8x the span the residual error is ~1e-4 of
    # one bar's deviation -- far below tick size. Non-recursive indicators
    # (rolling max/min/mean) are exact given a window of at least their period.

    TAIL_MULTIPLE = 8

    @staticmethod
    def column(df: pd.DataFrame, name: str) -> pd.Series | None:
        """Reuse a precomputed feature column, if features.build() made one."""
        if name in df.columns:
            col = df[name]
            if col.notna().iloc[-1]:
                return col
        return None

    def tail(self, df: pd.DataFrame, period: int) -> pd.DataFrame:
        """A bounded recent slice sufficient to evaluate ``period``."""
        need = max(int(period) * self.TAIL_MULTIPLE, self.min_bars)
        return df if len(df) <= need else df.iloc[-need:]

    def suits_regime(self, regime: Regime) -> bool:
        return not self.preferred_regimes or regime in self.preferred_regimes

    def _signal(
        self,
        symbol: str,
        side: Side,
        confidence: float,
        df: pd.DataFrame,
        reason: str,
        stop_atr_mult: float | None = None,
        target_atr_mult: float | None = None,
    ) -> Signal:
        from ..data import features as F

        return Signal(
            strategy=self.name,
            symbol=symbol,
            side=side,
            confidence=max(0.0, min(1.0, confidence)),
            stop_atr_mult=stop_atr_mult,
            target_atr_mult=target_atr_mult,
            reason=reason,
            features=F.snapshot(df),
            at=df.index[-1].to_pydatetime(),
        )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<{type(self).__name__} {self.name} {self.params}>"
