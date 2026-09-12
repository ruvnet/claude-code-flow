"""Bar-replay backtester.

Deliberately pessimistic. A backtest that flatters you is worse than no
backtest, so every ambiguity is resolved against the strategy:

* **Intrabar ordering is assumed to be the worst case.** If a bar's range
  covers both the stop and the target, the stop is recorded as hit. Without
  tick data you cannot know the order, and assuming the good one is the single
  most common way people build a profitable-looking system that loses money.
* **Signals act on the next bar's open**, never the close that produced them.
* **Spread and commission are charged on every trade**, entry and exit.
* **Indicators are computed on the full series once**, but every strategy is
  only ever shown ``df.iloc[:i+1]`` -- so it cannot see its own future.

The same RiskManager the live engine uses does the sizing here, so position
sizes are not a separate, more optimistic code path.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd

from ..config import Config
from ..data import features as F
from ..learning.bandit import StrategyBandit
from ..risk.manager import RiskManager
from ..strategy.base import Strategy
from ..types import AccountState, Regime, Side, Signal, SymbolInfo

log = logging.getLogger(__name__)


@dataclass(slots=True)
class BTTrade:
    symbol: str
    strategy: str
    side: Side
    volume: float
    entry_price: float
    entry_time: datetime
    stop_loss: float
    take_profit: float
    initial_stop: float
    regime: Regime
    features: dict[str, float] = field(default_factory=dict)
    exit_price: float = 0.0
    exit_time: datetime | None = None
    profit: float = 0.0
    r_multiple: float = 0.0
    exit_reason: str = ""
    bars_held: int = 0


@dataclass
class BacktestResult:
    symbol: str
    timeframe: str
    start: datetime | None = None
    end: datetime | None = None
    starting_equity: float = 0.0
    ending_equity: float = 0.0
    trades: list[BTTrade] = field(default_factory=list)
    equity_curve: list[tuple[datetime, float]] = field(default_factory=list)
    rejections: dict[str, int] = field(default_factory=dict)

    # ------------------------------------------------------------- statistics

    @property
    def n_trades(self) -> int:
        return len(self.trades)

    @property
    def net_profit(self) -> float:
        return self.ending_equity - self.starting_equity

    @property
    def return_pct(self) -> float:
        return (
            self.net_profit / self.starting_equity if self.starting_equity else 0.0
        )

    @property
    def wins(self) -> list[BTTrade]:
        return [t for t in self.trades if t.profit > 0]

    @property
    def losses(self) -> list[BTTrade]:
        return [t for t in self.trades if t.profit <= 0]

    @property
    def win_rate(self) -> float:
        return len(self.wins) / self.n_trades if self.n_trades else 0.0

    @property
    def profit_factor(self) -> float:
        gross_win = sum(t.profit for t in self.wins)
        gross_loss = -sum(t.profit for t in self.losses)
        if gross_loss <= 0:
            return float("inf") if gross_win > 0 else 0.0
        return gross_win / gross_loss

    @property
    def expectancy_r(self) -> float:
        return (
            float(np.mean([t.r_multiple for t in self.trades]))
            if self.trades else 0.0
        )

    @property
    def max_drawdown(self) -> float:
        if not self.equity_curve:
            return 0.0
        eq = np.array([e for _, e in self.equity_curve], dtype=float)
        peaks = np.maximum.accumulate(eq)
        with np.errstate(divide="ignore", invalid="ignore"):
            dd = np.where(peaks > 0, (peaks - eq) / peaks, 0.0)
        return float(np.max(dd)) if len(dd) else 0.0

    @property
    def sharpe(self) -> float:
        """Annualised Sharpe of the per-trade return stream (rf = 0)."""
        if self.n_trades < 2:
            return 0.0
        rets = np.array([t.profit for t in self.trades], dtype=float)
        base = self.starting_equity or 1.0
        rets = rets / base
        sd = float(np.std(rets, ddof=1))
        if sd <= 0:
            return 0.0
        # Scale by trade frequency rather than assuming daily observations.
        span_days = 1.0
        if self.start and self.end:
            span_days = max((self.end - self.start).total_seconds() / 86400.0, 1.0)
        trades_per_year = self.n_trades / span_days * 365.0
        return float(np.mean(rets) / sd * np.sqrt(max(trades_per_year, 1.0)))

    def summary(self) -> dict:
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "trades": self.n_trades,
            "win_rate": round(self.win_rate, 4),
            "profit_factor": round(self.profit_factor, 3)
            if np.isfinite(self.profit_factor) else None,
            "expectancy_r": round(self.expectancy_r, 4),
            "net_profit": round(self.net_profit, 2),
            "return_pct": round(self.return_pct, 4),
            "max_drawdown": round(self.max_drawdown, 4),
            "sharpe": round(self.sharpe, 3),
            "starting_equity": self.starting_equity,
            "ending_equity": round(self.ending_equity, 2),
            "start": self.start.isoformat() if self.start else None,
            "end": self.end.isoformat() if self.end else None,
        }

    def __str__(self) -> str:  # pragma: no cover
        s = self.summary()
        pf = s["profit_factor"]
        return (
            f"{self.symbol} {self.timeframe}: {s['trades']} trades, "
            f"win {s['win_rate']:.1%}, PF {pf if pf is not None else 'inf'}, "
            f"exp {s['expectancy_r']:+.3f}R, ret {s['return_pct']:+.2%}, "
            f"maxDD {s['max_drawdown']:.2%}, Sharpe {s['sharpe']:.2f}"
        )


def synthetic_symbol_info(name: str, price: float) -> SymbolInfo:
    """Reasonable defaults when no broker is attached (offline research)."""
    jpy = "JPY" in name.upper()
    metal = any(m in name.upper() for m in ("XAU", "XAG", "GOLD"))
    if metal:
        digits, point, tick_value, contract = 2, 0.01, 1.0, 100.0
    elif jpy:
        digits, point, tick_value, contract = 3, 0.001, 0.9, 100_000.0
    else:
        digits, point, tick_value, contract = 5, 0.00001, 1.0, 100_000.0
    return SymbolInfo(
        name=name, digits=digits, point=point, tick_size=point,
        tick_value=tick_value, contract_size=contract,
        volume_min=0.01, volume_max=100.0, volume_step=0.01,
        stops_level_points=10.0, spread_points=12.0, trade_allowed=True,
    )


class BacktestEngine:
    def __init__(
        self,
        cfg: Config,
        strategies: list[Strategy],
        starting_equity: float = 100_000.0,
        spread_points: float | None = None,
        commission_per_lot: float = 7.0,
        slippage_points: float = 2.0,
        use_bandit: bool = True,
        seed: int = 11,
    ) -> None:
        self.cfg = cfg
        self.strategies = strategies
        self.starting_equity = starting_equity
        self.spread_points = spread_points
        self.commission_per_lot = commission_per_lot
        self.slippage_points = slippage_points
        self.risk = RiskManager(cfg.risk)
        self.bandit = (
            StrategyBandit(
                cfg.learning.bandit_decay,
                cfg.learning.bandit_min_trades,
                cfg.learning.bandit_exploration,
                seed=seed,
            )
            if use_bandit
            else None
        )

    # ---------------------------------------------------------------- helpers

    def _costs(self, info: SymbolInfo, volume: float) -> float:
        """Round-turn commission in account currency."""
        return self.commission_per_lot * volume

    def _fill_price(
        self, info: SymbolInfo, side: Side, price: float, spread_pts: float
    ) -> float:
        """Buy at ask, sell at bid, plus adverse slippage."""
        half = spread_pts * info.point / 2.0
        slip = self.slippage_points * info.point
        return price + side.sign * (half + slip)

    def _exit_within_bar(
        self, trade: BTTrade, bar: pd.Series, info: SymbolInfo, spread_pts: float
    ) -> tuple[float, str] | None:
        """Resolve stop/target against a bar, assuming the WORST ordering."""
        high, low = float(bar["high"]), float(bar["low"])
        half = spread_pts * info.point / 2.0

        if trade.side is Side.BUY:
            hit_stop = low - half <= trade.stop_loss
            hit_tp = high - half >= trade.take_profit
            if hit_stop:  # pessimistic: stop wins any tie
                return trade.stop_loss, "stop_loss"
            if hit_tp:
                return trade.take_profit, "take_profit"
        else:
            hit_stop = high + half >= trade.stop_loss
            hit_tp = low + half <= trade.take_profit
            if hit_stop:
                return trade.stop_loss, "stop_loss"
            if hit_tp:
                return trade.take_profit, "take_profit"
        return None

    # ------------------------------------------------------------------- main

    def run(
        self,
        df: pd.DataFrame,
        symbol: str,
        timeframe: str = "M15",
        info: SymbolInfo | None = None,
        warmup: int = 250,
    ) -> BacktestResult:
        if df.empty or len(df) < warmup + 50:
            return BacktestResult(symbol, timeframe, starting_equity=self.starting_equity,
                                  ending_equity=self.starting_equity)

        feat = F.build(df, self.cfg.learning.regime_lookback)
        info = info or synthetic_symbol_info(symbol, float(df["close"].iloc[-1]))

        equity = self.starting_equity
        result = BacktestResult(
            symbol=symbol, timeframe=timeframe,
            start=feat.index[warmup].to_pydatetime(),
            end=feat.index[-1].to_pydatetime(),
            starting_equity=equity,
        )

        open_trades: list[BTTrade] = []
        symbol_cfg = next(
            (s for s in self.cfg.symbols if s.name == symbol), None
        )
        weight = symbol_cfg.weight if symbol_cfg else 1.0

        for i in range(warmup, len(feat) - 1):
            bar = feat.iloc[i]
            next_bar = feat.iloc[i + 1]
            now = feat.index[i].to_pydatetime()
            spread_pts = (
                self.spread_points
                if self.spread_points is not None
                else float(bar.get("spread", info.spread_points) or info.spread_points)
            )
            atr_value = float(bar.get("atr", np.nan))

            # --- 1. manage and resolve open trades on THIS bar ---------------
            still_open: list[BTTrade] = []
            for t in open_trades:
                t.bars_held += 1
                exit_ = self._exit_within_bar(t, bar, info, spread_pts)
                if exit_ is None:
                    # trailing / breakeven, using the same live-engine logic
                    if np.isfinite(atr_value) and atr_value > 0:
                        pos_like = _as_position(t)
                        new_stop, _ = self.risk.manage(
                            pos_like, float(bar["close"]), atr_value
                        )
                        if new_stop is not None:
                            t.stop_loss = new_stop
                    still_open.append(t)
                    continue

                price, reason = exit_
                gross = (price - t.entry_price) * t.side.sign * info.money_per_price_unit(
                    t.volume
                )
                net = gross - self._costs(info, t.volume)
                risk_dist = abs(t.entry_price - t.initial_stop)
                risk_money = risk_dist * info.money_per_price_unit(t.volume)

                t.exit_price, t.exit_time, t.profit = price, now, net
                t.r_multiple = (net / risk_money) if risk_money > 0 else 0.0
                t.exit_reason = reason
                equity += net
                result.trades.append(t)
                if self.bandit:
                    self.bandit.update(t.strategy, t.regime, t.r_multiple)

            open_trades = still_open
            result.equity_curve.append((now, equity))

            if equity <= 0:
                log.warning("%s: account wiped out at %s", symbol, now)
                break

            # --- 2. look for new entries -------------------------------------
            if not np.isfinite(atr_value) or atr_value <= 0:
                continue

            window = feat.iloc[: i + 1]  # closed bars only
            regime = F.classify_regime(window)
            account = AccountState(equity, equity, 0.0, equity, "USD", 500)

            for strat in self.strategies:
                if not strat.enabled:
                    continue
                try:
                    signal = strat.evaluate(window, symbol)
                except Exception:
                    log.exception("strategy %s raised", strat.name)
                    continue
                if signal is None:
                    continue

                conf_scale = signal.confidence
                if self.bandit:
                    decision = self.bandit.evaluate(strat.name, regime)
                    if not decision.allow:
                        result.rejections["bandit"] = (
                            result.rejections.get("bandit", 0) + 1
                        )
                        continue
                    conf_scale *= decision.confidence

                entry = self._fill_price(
                    info, signal.side, float(next_bar["open"]), spread_pts
                )
                sized = self.risk.size(
                    signal, info, entry, atr_value, account,
                    [_as_position(t) for t in open_trades],
                    goal_scale=1.0, symbol_weight=weight,
                    confidence_scale=conf_scale,
                )
                if not sized.approved:
                    key = sized.reason.split(":")[0][:48]
                    result.rejections[key] = result.rejections.get(key, 0) + 1
                    continue

                open_trades.append(
                    BTTrade(
                        symbol=symbol, strategy=strat.name, side=signal.side,
                        volume=sized.volume, entry_price=entry,
                        entry_time=feat.index[i + 1].to_pydatetime(),
                        stop_loss=sized.stop_loss, take_profit=sized.take_profit,
                        initial_stop=sized.stop_loss, regime=regime,
                        features=signal.features,
                    )
                )

        # --- 3. close anything still open at the final price -----------------
        if open_trades:
            last = feat.iloc[-1]
            now = feat.index[-1].to_pydatetime()
            for t in open_trades:
                price = float(last["close"])
                gross = (price - t.entry_price) * t.side.sign * info.money_per_price_unit(
                    t.volume
                )
                net = gross - self._costs(info, t.volume)
                risk_money = abs(t.entry_price - t.initial_stop) * info.money_per_price_unit(
                    t.volume
                )
                t.exit_price, t.exit_time, t.profit = price, now, net
                t.r_multiple = (net / risk_money) if risk_money > 0 else 0.0
                t.exit_reason = "end_of_data"
                equity += net
                result.trades.append(t)
            result.equity_curve.append((now, equity))

        result.ending_equity = equity
        return result


def _as_position(t: BTTrade):
    """Adapt a backtest trade to the Position shape the RiskManager expects."""
    from ..types import Position

    return Position(
        ticket=0, symbol=t.symbol, side=t.side, volume=t.volume,
        entry_price=t.entry_price, stop_loss=t.stop_loss,
        take_profit=t.take_profit, profit=0.0, opened_at=t.entry_time,
        strategy=t.strategy, initial_stop=t.initial_stop,
    )
