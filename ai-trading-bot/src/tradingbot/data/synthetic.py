"""Synthetic price series.

For tests and for offline work when the terminal is not running. Useful for
checking plumbing; useless for judging whether a strategy makes money.

A random walk has no edge by construction, so a strategy that "wins" on this
data is telling you about a bug in your backtester, not about a strategy. That
is exactly what makes it a good regression test.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def make_bars(
    n: int = 5000,
    start_price: float = 1.1000,
    volatility: float = 0.0006,
    drift: float = 0.0,
    regime_switching: bool = False,
    freq: str = "15min",
    start: str = "2026-01-01",
    seed: int = 42,
    spread_points: tuple[int, int] = (6, 18),
) -> pd.DataFrame:
    """Generate an OHLCV frame shaped like MT5 output.

    ``regime_switching`` alternates trending and mean-reverting stretches so
    regime detection and the bandit have something to actually discriminate.
    """
    rng = np.random.default_rng(seed)
    idx = pd.date_range(start, periods=n, freq=freq, tz="UTC")

    if regime_switching:
        returns = np.zeros(n)
        i = 0
        trend = True
        while i < n:
            span = int(rng.integers(200, 700))
            span = min(span, n - i)
            if trend:
                mu = rng.choice([-1.0, 1.0]) * volatility * rng.uniform(0.05, 0.18)
                returns[i : i + span] = rng.normal(mu, volatility, span)
            else:
                # Ornstein-Uhlenbeck-ish pull back toward the local mean.
                seg = np.zeros(span)
                level = 0.0
                for k in range(span):
                    level = 0.86 * level + rng.normal(0, volatility)
                    seg[k] = -0.14 * level + rng.normal(0, volatility * 0.55)
                returns[i : i + span] = seg
            i += span
            trend = not trend
    else:
        returns = rng.normal(drift / max(n, 1), volatility, n)

    close = start_price * np.exp(np.cumsum(returns))

    # Build plausible OHLC around each close.
    wick = np.abs(rng.normal(0, volatility * 0.75, n)) * close
    high = close + wick
    low = close - np.abs(rng.normal(0, volatility * 0.75, n)) * close
    open_ = np.empty(n)
    open_[0] = start_price
    open_[1:] = close[:-1]

    high = np.maximum.reduce([high, open_, close])
    low = np.minimum.reduce([low, open_, close])

    return pd.DataFrame(
        {
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": rng.integers(40, 900, n).astype(float),
            "spread": rng.integers(spread_points[0], spread_points[1], n).astype(float),
        },
        index=idx,
    )
