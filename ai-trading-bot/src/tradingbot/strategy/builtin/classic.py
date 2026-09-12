"""The seed strategy book.

These are deliberately plain, well-understood setups. The point is not that any
one of them is a money machine -- it is that they are diverse enough for the
bandit to have something to choose between, and simple enough that when one
starts losing you can tell why.

Each strategy reports a confidence, which the meta-model later learns to
recalibrate against realised outcomes.

Performance note: every strategy takes its indicators from the precomputed
feature columns where possible, and otherwise from a bounded tail slice (see
Strategy.column / Strategy.tail). Recomputing over full history on every bar
turns a backtest into an O(n^2) crawl.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from ...data import features as F
from ...types import Regime, Side, Signal
from ..base import Strategy


def _f(row: pd.Series, key: str, default: float = np.nan) -> float:
    v = row.get(key, default)
    return float(v) if pd.notna(v) else float("nan")


def _ema(strat: Strategy, df: pd.DataFrame, period: int,
         cached_as: str | None, cached_period: int | None) -> pd.Series:
    """Precomputed column when the period matches, bounded tail otherwise."""
    if cached_as is not None and period == cached_period:
        col = strat.column(df, cached_as)
        if col is not None:
            return col
    return F.ema(strat.tail(df, period)["close"], period)


class EmaCross(Strategy):
    """Fast/slow EMA cross, taken only in the direction of the long trend."""

    name = "ema_cross"
    preferred_regimes = (Regime.TREND_UP, Regime.TREND_DOWN)

    @staticmethod
    def defaults() -> dict[str, Any]:
        return {"fast": 12, "slow": 34, "trend_filter": 200, "min_slope_atr": 0.05}

    def evaluate(self, df: pd.DataFrame, symbol: str) -> Signal | None:
        if not self.ready(df):
            return None
        p = self.params
        fast = _ema(self, df, p["fast"], "ema_fast", 12)
        slow = _ema(self, df, p["slow"], "ema_slow", 34)
        trend = _ema(self, df, p["trend_filter"], "ema_trend", 200)

        if len(fast) < 2 or pd.isna(trend.iloc[-1]) or pd.isna(slow.iloc[-1]):
            return None

        row = df.iloc[-1]
        atr_v = _f(row, "atr")
        if not np.isfinite(atr_v) or atr_v <= 0:
            return None

        slope_atr = _f(row, "trend_slope_atr", 0.0)
        crossed_up = fast.iloc[-2] <= slow.iloc[-2] and fast.iloc[-1] > slow.iloc[-1]
        crossed_dn = fast.iloc[-2] >= slow.iloc[-2] and fast.iloc[-1] < slow.iloc[-1]
        price = float(row["close"])

        # Separation normalised by ATR: a cross that barely separates is noise.
        sep = abs(float(fast.iloc[-1] - slow.iloc[-1])) / atr_v
        conf = float(np.clip(0.35 + 0.4 * sep + 0.1 * abs(slope_atr), 0.0, 0.95))

        if crossed_up and price > trend.iloc[-1] and slope_atr > p["min_slope_atr"]:
            return self._signal(
                symbol, Side.BUY, conf, df,
                f"EMA{p['fast']}>EMA{p['slow']} above EMA{p['trend_filter']}, "
                f"sep={sep:.2f}ATR",
            )
        if crossed_dn and price < trend.iloc[-1] and slope_atr < -p["min_slope_atr"]:
            return self._signal(
                symbol, Side.SELL, conf, df,
                f"EMA{p['fast']}<EMA{p['slow']} below EMA{p['trend_filter']}, "
                f"sep={sep:.2f}ATR",
            )
        return None


class RsiMeanReversion(Strategy):
    """Fade an RSI extreme, but only in a range and only on the cross back out."""

    name = "rsi_meanrev"
    preferred_regimes = (Regime.RANGE,)

    @staticmethod
    def defaults() -> dict[str, Any]:
        return {
            "period": 14, "oversold": 28, "overbought": 72,
            "trend_filter": 200, "require_range_regime": True,
        }

    def evaluate(self, df: pd.DataFrame, symbol: str) -> Signal | None:
        if not self.ready(df):
            return None
        p = self.params
        if p["require_range_regime"] and F.classify_regime(df) is not Regime.RANGE:
            return None

        r = self.column(df, "rsi") if p["period"] == 14 else None
        if r is None:
            r = F.rsi(self.tail(df, p["period"])["close"], p["period"])
        if len(r) < 2 or pd.isna(r.iloc[-1]) or pd.isna(r.iloc[-2]):
            return None

        prev, now = float(r.iloc[-2]), float(r.iloc[-1])
        row = df.iloc[-1]
        atr_v = _f(row, "atr")
        if not np.isfinite(atr_v) or atr_v <= 0:
            return None

        # Require the cross back OUT of the extreme, not merely being in it --
        # "oversold" can stay oversold for a very long time.
        if prev <= p["oversold"] < now:
            depth = (p["oversold"] - min(prev, p["oversold"])) / max(p["oversold"], 1)
            conf = float(np.clip(0.4 + depth, 0.0, 0.9))
            return self._signal(
                symbol, Side.BUY, conf, df,
                f"RSI crossed up out of {p['oversold']} ({prev:.1f}->{now:.1f})",
                stop_atr_mult=1.5, target_atr_mult=2.2,
            )
        if prev >= p["overbought"] > now:
            depth = (max(prev, p["overbought"]) - p["overbought"]) / max(
                100 - p["overbought"], 1
            )
            conf = float(np.clip(0.4 + depth, 0.0, 0.9))
            return self._signal(
                symbol, Side.SELL, conf, df,
                f"RSI crossed down out of {p['overbought']} ({prev:.1f}->{now:.1f})",
                stop_atr_mult=1.5, target_atr_mult=2.2,
            )
        return None


class DonchianBreakout(Strategy):
    """Classic channel breakout. Wants volatility, dies in a chop."""

    name = "donchian_breakout"
    preferred_regimes = (Regime.TREND_UP, Regime.TREND_DOWN, Regime.HIGH_VOL)

    @staticmethod
    def defaults() -> dict[str, Any]:
        return {"channel": 40, "exit_channel": 20, "min_atr_pct": 0.0004}

    def evaluate(self, df: pd.DataFrame, symbol: str) -> Signal | None:
        if not self.ready(df):
            return None
        p = self.params
        # Rolling max/min are exact on a bounded window (>= the period).
        upper, lower = F.donchian(self.tail(df, p["channel"]), p["channel"])
        if pd.isna(upper.iloc[-1]) or pd.isna(lower.iloc[-1]):
            return None

        row = df.iloc[-1]
        atr_v, atr_pct = _f(row, "atr"), _f(row, "atr_pct", 0.0)
        if not np.isfinite(atr_v) or atr_v <= 0 or atr_pct < p["min_atr_pct"]:
            return None

        close = float(row["close"])
        adx_v = _f(row, "adx", 0.0)
        conf = float(np.clip(0.35 + adx_v / 100.0, 0.0, 0.9))

        if close > float(upper.iloc[-1]):
            return self._signal(
                symbol, Side.BUY, conf, df,
                f"close broke {p['channel']}-bar high {upper.iloc[-1]:.5f}",
                stop_atr_mult=2.0, target_atr_mult=3.5,
            )
        if close < float(lower.iloc[-1]):
            return self._signal(
                symbol, Side.SELL, conf, df,
                f"close broke {p['channel']}-bar low {lower.iloc[-1]:.5f}",
                stop_atr_mult=2.0, target_atr_mult=3.5,
            )
        return None


class MacdTrend(Strategy):
    """MACD histogram flipping sign, filtered by the long EMA."""

    name = "macd_trend"
    preferred_regimes = (Regime.TREND_UP, Regime.TREND_DOWN)

    @staticmethod
    def defaults() -> dict[str, Any]:
        return {"fast": 12, "slow": 26, "signal": 9, "trend_filter": 200}

    def evaluate(self, df: pd.DataFrame, symbol: str) -> Signal | None:
        if not self.ready(df):
            return None
        p = self.params
        default_macd = (p["fast"], p["slow"], p["signal"]) == (12, 26, 9)
        hist = self.column(df, "macd_hist") if default_macd else None
        if hist is None:
            _, _, hist = F.macd(
                self.tail(df, p["slow"] + p["signal"])["close"],
                p["fast"], p["slow"], p["signal"],
            )
        trend = _ema(self, df, p["trend_filter"], "ema_trend", 200)

        if len(hist) < 2 or pd.isna(hist.iloc[-1]) or pd.isna(trend.iloc[-1]):
            return None

        row = df.iloc[-1]
        atr_v = _f(row, "atr")
        if not np.isfinite(atr_v) or atr_v <= 0:
            return None

        prev, now = float(hist.iloc[-2]), float(hist.iloc[-1])
        price = float(row["close"])
        strength = min(abs(now) / atr_v, 1.0)
        conf = float(np.clip(0.35 + 0.5 * strength, 0.0, 0.9))

        if prev <= 0 < now and price > float(trend.iloc[-1]):
            return self._signal(
                symbol, Side.BUY, conf, df, "MACD histogram turned positive in uptrend"
            )
        if prev >= 0 > now and price < float(trend.iloc[-1]):
            return self._signal(
                symbol, Side.SELL, conf, df,
                "MACD histogram turned negative in downtrend",
            )
        return None


class BollingerFade(Strategy):
    """Fade a close outside the band, back toward the mean. Range regimes only."""

    name = "bollinger_fade"
    preferred_regimes = (Regime.RANGE,)

    @staticmethod
    def defaults() -> dict[str, Any]:
        return {"period": 20, "std": 2.2, "require_range_regime": True}

    def evaluate(self, df: pd.DataFrame, symbol: str) -> Signal | None:
        if not self.ready(df):
            return None
        p = self.params
        if p["require_range_regime"] and F.classify_regime(df) is not Regime.RANGE:
            return None

        # Rolling mean/std are exact on a bounded window.
        upper, mid, lower = F.bollinger(
            self.tail(df, p["period"])["close"], p["period"], p["std"]
        )
        if pd.isna(upper.iloc[-1]) or pd.isna(mid.iloc[-1]):
            return None

        row = df.iloc[-1]
        atr_v = _f(row, "atr")
        if not np.isfinite(atr_v) or atr_v <= 0:
            return None

        close = float(row["close"])
        band_w = float(upper.iloc[-1] - lower.iloc[-1])
        if band_w <= 0:
            return None

        if close < float(lower.iloc[-1]):
            excursion = (float(lower.iloc[-1]) - close) / band_w
            conf = float(np.clip(0.4 + 2.0 * excursion, 0.0, 0.9))
            return self._signal(
                symbol, Side.BUY, conf, df,
                f"close {excursion:.1%} of a band-width below the lower band",
                stop_atr_mult=1.6, target_atr_mult=2.4,
            )
        if close > float(upper.iloc[-1]):
            excursion = (close - float(upper.iloc[-1])) / band_w
            conf = float(np.clip(0.4 + 2.0 * excursion, 0.0, 0.9))
            return self._signal(
                symbol, Side.SELL, conf, df,
                f"close {excursion:.1%} of a band-width above the upper band",
                stop_atr_mult=1.6, target_atr_mult=2.4,
            )
        return None


ALL_STRATEGIES: tuple[type[Strategy], ...] = (
    EmaCross,
    RsiMeanReversion,
    DonchianBreakout,
    MacdTrend,
    BollingerFade,
)
