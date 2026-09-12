"""Core domain types shared by every layer.

Kept deliberately free of MetaTrader imports so backtest and paper engines can
use them on any machine.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


class Side(str, enum.Enum):
    BUY = "buy"
    SELL = "sell"

    @property
    def sign(self) -> int:
        return 1 if self is Side.BUY else -1

    @property
    def opposite(self) -> "Side":
        return Side.SELL if self is Side.BUY else Side.BUY


class Regime(str, enum.Enum):
    TREND_UP = "trend_up"
    TREND_DOWN = "trend_down"
    RANGE = "range"
    HIGH_VOL = "high_vol"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class Signal:
    """A strategy's opinion. Deliberately not an order -- risk sizing, the
    meta-model gate and the portfolio checks all sit between this and the
    broker."""

    strategy: str
    symbol: str
    side: Side
    confidence: float                  # 0..1, the strategy's own conviction
    stop_atr_mult: float | None = None
    target_atr_mult: float | None = None
    reason: str = ""
    features: dict[str, float] = field(default_factory=dict)
    at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError(f"confidence out of range: {self.confidence}")


@dataclass(frozen=True, slots=True)
class SymbolInfo:
    name: str
    digits: int
    point: float
    tick_size: float
    tick_value: float                  # account currency per tick per 1.0 lot
    contract_size: float
    volume_min: float
    volume_max: float
    volume_step: float
    stops_level_points: float          # broker's minimum SL/TP distance
    spread_points: float
    trade_allowed: bool = True

    def normalize_volume(self, volume: float) -> float:
        """Snap a lot size to the broker's step/min/max grid."""
        if self.volume_step <= 0:
            return round(max(self.volume_min, min(volume, self.volume_max)), 2)
        steps = round(volume / self.volume_step)
        v = steps * self.volume_step
        v = max(self.volume_min, min(v, self.volume_max))
        # Kill binary float dust like 0.30000000000000004.
        decimals = max(0, len(str(self.volume_step).split(".")[-1].rstrip("0")))
        return round(v, decimals if "." in str(self.volume_step) else 2)

    def money_per_price_unit(self, volume: float) -> float:
        """Account-currency P&L for a 1.0 move in price, at ``volume`` lots."""
        if self.tick_size <= 0:
            return 0.0
        return (self.tick_value / self.tick_size) * volume


@dataclass(frozen=True, slots=True)
class AccountState:
    balance: float
    equity: float
    margin: float
    margin_free: float
    currency: str
    leverage: int = 0

    @property
    def margin_level_pct(self) -> float:
        return (self.equity / self.margin * 100.0) if self.margin > 0 else float("inf")

    @property
    def free_margin_pct(self) -> float:
        return (self.margin_free / self.equity) if self.equity > 0 else 0.0


@dataclass(slots=True)
class Position:
    ticket: int
    symbol: str
    side: Side
    volume: float
    entry_price: float
    stop_loss: float | None
    take_profit: float | None
    profit: float
    opened_at: datetime
    strategy: str = ""
    comment: str = ""
    initial_stop: float | None = None

    def risk_price_distance(self) -> float:
        ref = self.initial_stop if self.initial_stop is not None else self.stop_loss
        if ref is None:
            return 0.0
        return abs(self.entry_price - ref)

    def r_multiple(self, current_price: float) -> float:
        """How many initial-risk units this position is currently up or down."""
        dist = self.risk_price_distance()
        if dist <= 0:
            return 0.0
        return ((current_price - self.entry_price) * self.side.sign) / dist


@dataclass(frozen=True, slots=True)
class OrderRequest:
    symbol: str
    side: Side
    volume: float
    stop_loss: float
    take_profit: float
    strategy: str
    comment: str = ""
    risk_amount: float = 0.0
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class OrderResult:
    ok: bool
    ticket: int | None = None
    price: float | None = None
    volume: float | None = None
    retcode: int | None = None
    message: str = ""


@dataclass(frozen=True, slots=True)
class TradeRecord:
    """A closed trade, as written to the journal and fed back into learning."""

    ticket: int
    symbol: str
    strategy: str
    side: Side
    volume: float
    entry_price: float
    exit_price: float
    stop_loss: float | None
    take_profit: float | None
    profit: float
    opened_at: datetime
    closed_at: datetime
    r_multiple: float
    regime: Regime = Regime.UNKNOWN
    features: dict[str, float] = field(default_factory=dict)
    exit_reason: str = ""

    @property
    def won(self) -> bool:
        return self.profit > 0

    @property
    def duration_minutes(self) -> float:
        return (self.closed_at - self.opened_at).total_seconds() / 60.0
