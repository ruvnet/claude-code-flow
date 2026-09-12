"""Indicator and feature engineering.

Pure pandas/numpy so it runs identically in backtest, paper and live. No TA-Lib
build step.

Every function here is causal: the value at bar *i* uses only bars <= *i*. That
property is what keeps the backtest honest, so any change to this module should
preserve it.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..types import Regime


# --------------------------------------------------------------------- basics


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False, min_periods=period).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period, min_periods=period).mean()


def true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["close"].shift(1)
    return pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Wilder's ATR (an EMA with alpha = 1/period)."""
    return true_range(df).ewm(alpha=1.0 / period, adjust=False,
                              min_periods=period).mean()


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - (100.0 / (1.0 + rs))
    # avg_loss == 0 means an unbroken run of gains: RSI is 100 by definition.
    return out.where(avg_loss != 0.0, 100.0).where(avg_gain != 0.0, out.fillna(50.0))


def macd(
    series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[pd.Series, pd.Series, pd.Series]:
    line = ema(series, fast) - ema(series, slow)
    sig = line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return line, sig, line - sig


def bollinger(
    series: pd.Series, period: int = 20, std: float = 2.0
) -> tuple[pd.Series, pd.Series, pd.Series]:
    mid = sma(series, period)
    dev = series.rolling(period, min_periods=period).std(ddof=0)
    return mid + std * dev, mid, mid - std * dev


def donchian(
    df: pd.DataFrame, period: int = 20
) -> tuple[pd.Series, pd.Series]:
    """Upper/lower channel EXCLUDING the current bar.

    The shift is essential: comparing a bar's high to a channel that already
    contains that high makes a breakout unfalsifiable and inflates backtests.
    """
    upper = df["high"].rolling(period, min_periods=period).max().shift(1)
    lower = df["low"].rolling(period, min_periods=period).min().shift(1)
    return upper, lower


def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average Directional Index: trend strength, direction-agnostic."""
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)

    tr = true_range(df)
    atr_ = tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    plus_di = 100.0 * (
        pd.Series(plus_dm, index=df.index)
        .ewm(alpha=1.0 / period, adjust=False, min_periods=period)
        .mean()
        / atr_.replace(0.0, np.nan)
    )
    minus_di = 100.0 * (
        pd.Series(minus_dm, index=df.index)
        .ewm(alpha=1.0 / period, adjust=False, min_periods=period)
        .mean()
        / atr_.replace(0.0, np.nan)
    )
    dx = 100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0.0, np.nan)
    return dx.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


def realized_vol(series: pd.Series, period: int = 20) -> pd.Series:
    return series.pct_change().rolling(period, min_periods=period).std(ddof=0)


def zscore(series: pd.Series, period: int = 50) -> pd.Series:
    m = series.rolling(period, min_periods=period).mean()
    s = series.rolling(period, min_periods=period).std(ddof=0)
    return (series - m) / s.replace(0.0, np.nan)


def slope(series: pd.Series, period: int = 20) -> pd.Series:
    """Least-squares slope per bar over a rolling window."""
    x = np.arange(period, dtype=float)
    x_centered = x - x.mean()
    denom = (x_centered**2).sum()

    def _fit(window: np.ndarray) -> float:
        return float((x_centered * (window - window.mean())).sum() / denom)

    return series.rolling(period, min_periods=period).apply(_fit, raw=True)


# ------------------------------------------------------------------- assembly

FEATURE_COLUMNS = [
    "atr", "atr_pct", "rsi", "adx", "macd_hist", "bb_pos", "ema_spread",
    "trend_slope_atr", "vol_z", "ret_1", "ret_5", "ret_20", "range_pct",
    "body_pct", "hour", "dow", "spread_atr",
]


def build(df: pd.DataFrame, lookback: int = 200) -> pd.DataFrame:
    """Attach every indicator the strategies and the meta-model consume."""
    if df.empty or len(df) < 60:
        return df.copy()

    out = df.copy()
    close = out["close"]

    out["atr"] = atr(out, 14)
    out["atr_pct"] = out["atr"] / close.replace(0.0, np.nan)
    out["rsi"] = rsi(close, 14)
    out["adx"] = adx(out, 14)

    macd_line, macd_sig, macd_hist = macd(close)
    out["macd"] = macd_line
    out["macd_signal"] = macd_sig
    out["macd_hist"] = macd_hist

    bb_u, bb_m, bb_l = bollinger(close, 20, 2.0)
    out["bb_upper"], out["bb_mid"], out["bb_lower"] = bb_u, bb_m, bb_l
    width = (bb_u - bb_l).replace(0.0, np.nan)
    out["bb_pos"] = ((close - bb_l) / width).clip(-1.0, 2.0)

    out["ema_fast"] = ema(close, 12)
    out["ema_slow"] = ema(close, 34)
    out["ema_trend"] = ema(close, 200)
    out["ema_spread"] = (out["ema_fast"] - out["ema_slow"]) / out["atr"].replace(
        0.0, np.nan
    )

    out["trend_slope"] = slope(out["ema_trend"], 20)
    out["trend_slope_atr"] = out["trend_slope"] / out["atr"].replace(0.0, np.nan)

    out["vol_z"] = zscore(out["atr"], min(lookback, 100))
    out["ret_1"] = close.pct_change(1)
    out["ret_5"] = close.pct_change(5)
    out["ret_20"] = close.pct_change(20)

    out["range_pct"] = (out["high"] - out["low"]) / close.replace(0.0, np.nan)
    out["body_pct"] = (out["close"] - out["open"]).abs() / (
        out["high"] - out["low"]
    ).replace(0.0, np.nan)

    idx = out.index
    out["hour"] = idx.hour.astype(float)
    out["dow"] = idx.dayofweek.astype(float)

    if "spread" in out.columns:
        out["spread_atr"] = out["spread"] / (
            out["atr"] / out.get("point", 1e-5)
        ).replace(0.0, np.nan)
        out["spread_atr"] = out["spread_atr"].fillna(0.0)
    else:
        out["spread_atr"] = 0.0

    return out


def classify_regime(df: pd.DataFrame, i: int | None = None) -> Regime:
    """Bucket the market at bar ``i`` into a regime.

    The bandit keeps separate statistics per regime, so a strategy that only
    works in a range does not get credit for a trending week.
    """
    if df.empty:
        return Regime.UNKNOWN
    row = df.iloc[i if i is not None else -1]

    adx_v = row.get("adx", np.nan)
    slope_v = row.get("trend_slope_atr", np.nan)
    vol_z_v = row.get("vol_z", np.nan)

    if pd.isna(adx_v) or pd.isna(slope_v):
        return Regime.UNKNOWN
    if not pd.isna(vol_z_v) and vol_z_v > 2.0:
        return Regime.HIGH_VOL
    if adx_v >= 25.0:
        return Regime.TREND_UP if slope_v > 0 else Regime.TREND_DOWN
    return Regime.RANGE


def snapshot(df: pd.DataFrame, i: int | None = None) -> dict[str, float]:
    """Extract the feature vector at one bar, as plain floats for the journal."""
    if df.empty:
        return {}
    row = df.iloc[i if i is not None else -1]
    out: dict[str, float] = {}
    for col in FEATURE_COLUMNS:
        if col in row.index:
            v = row[col]
            out[col] = float(v) if pd.notna(v) else 0.0
    return out
