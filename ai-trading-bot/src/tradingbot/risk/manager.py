"""Risk manager: position sizing and the veto.

Every signal passes through here and most of them die here. That is working as
intended -- the strategies decide *direction*, this module decides *whether and
how much*, and it is the only component allowed to say yes.

Sizing is risk-first, never lot-first:

    risk_money      = equity * risk_pct * goal_scale
    stop_distance   = atr * stop_atr_mult              (in price)
    money_per_unit  = tick_value / tick_size           (per 1.0 lot)
    volume          = risk_money / (stop_distance * money_per_unit)

so a wider stop buys a smaller position and the dollar loss on a stop-out is
the same number regardless of instrument or volatility.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from ..config import RiskConfig
from ..types import AccountState, OrderRequest, Position, Side, Signal, SymbolInfo

log = logging.getLogger(__name__)


# R-multiple is a ratio of two float subtractions of similar magnitudes, so a
# position sitting exactly at the breakeven trigger computes as 0.999999...
# rather than 1.0. Without this tolerance the stop is never moved and a trade
# that reached its trigger can still give back a full loss. Stops and targets
# are both derived from the same ATR, so landing exactly on the threshold is
# routine rather than a corner case.
R_EPSILON = 1e-6


@dataclass(frozen=True, slots=True)
class RiskDecision:
    approved: bool
    reason: str
    volume: float = 0.0
    stop_loss: float = 0.0
    take_profit: float = 0.0
    risk_amount: float = 0.0
    risk_pct: float = 0.0

    @classmethod
    def veto(cls, reason: str) -> "RiskDecision":
        return cls(False, reason)


class RiskManager:
    def __init__(self, cfg: RiskConfig) -> None:
        self.cfg = cfg

    # ------------------------------------------------------------ portfolio

    def open_risk(self, positions: list[Position], equity: float) -> float:
        """Total equity fraction currently at risk across open positions.

        Positions whose stop is already at or beyond breakeven contribute zero.
        """
        if equity <= 0:
            return 0.0
        total = 0.0
        for p in positions:
            if p.stop_loss is None:
                # Unprotected. Treat as a full-size risk so it blocks new entries.
                total += self.cfg.max_risk_per_trade_pct
                continue
            adverse = (p.entry_price - p.stop_loss) * p.side.sign
            if adverse <= 0:
                continue  # stop is at or past breakeven: nothing left to lose
            total += (adverse * p.volume) / equity if equity else 0.0
        return total

    def _portfolio_checks(
        self,
        signal: Signal,
        positions: list[Position],
        account: AccountState,
    ) -> str | None:
        cfg = self.cfg
        if len(positions) >= cfg.max_positions:
            return f"at max positions ({cfg.max_positions})"

        same_symbol = [p for p in positions if p.symbol == signal.symbol]
        if len(same_symbol) >= cfg.max_positions_per_symbol:
            return (
                f"already holding {len(same_symbol)} position(s) in "
                f"{signal.symbol}"
            )
        if any(p.side is not signal.side for p in same_symbol):
            return f"opposite position already open in {signal.symbol}"

        if account.free_margin_pct < cfg.min_free_margin_pct:
            return (
                f"free margin {account.free_margin_pct:.1%} below floor "
                f"{cfg.min_free_margin_pct:.0%}"
            )
        return None

    # --------------------------------------------------------------- sizing

    def size(
        self,
        signal: Signal,
        info: SymbolInfo,
        entry_price: float,
        atr_value: float,
        account: AccountState,
        positions: list[Position],
        goal_scale: float = 1.0,
        symbol_weight: float = 1.0,
        confidence_scale: float = 1.0,
    ) -> RiskDecision:
        cfg = self.cfg

        if atr_value <= 0:
            return RiskDecision.veto("ATR unavailable or zero")
        if entry_price <= 0:
            return RiskDecision.veto("no valid entry price")
        if account.equity <= 0:
            return RiskDecision.veto("non-positive equity")

        blocked = self._portfolio_checks(signal, positions, account)
        if blocked:
            return RiskDecision.veto(blocked)

        # --- risk budget -----------------------------------------------------
        # Clamp every multiplier to <= 1.0 first. Nothing may inflate base risk
        # above the configured ceiling.
        goal_scale = max(0.0, min(goal_scale, 1.0))
        confidence_scale = max(0.0, min(confidence_scale, 1.0))
        symbol_weight = max(0.0, min(symbol_weight, 1.0))

        risk_pct = (
            cfg.base_risk_per_trade_pct * goal_scale * confidence_scale * symbol_weight
        )
        risk_pct = min(risk_pct, cfg.max_risk_per_trade_pct)
        if risk_pct <= 0:
            return RiskDecision.veto("risk budget scaled to zero")

        # --- portfolio headroom ---------------------------------------------
        current = self.open_risk(positions, account.equity)
        headroom = cfg.max_portfolio_risk_pct - current
        if headroom <= 0:
            return RiskDecision.veto(
                f"portfolio risk {current:.2%} at cap "
                f"{cfg.max_portfolio_risk_pct:.2%}"
            )
        risk_pct = min(risk_pct, headroom)

        risk_money = account.equity * risk_pct

        # --- stop / target ---------------------------------------------------
        stop_mult = max(
            signal.stop_atr_mult or cfg.default_stop_atr_mult, cfg.min_stop_atr_mult
        )
        target_mult = signal.target_atr_mult or cfg.default_target_atr_mult
        if target_mult <= stop_mult:
            target_mult = stop_mult * 1.5  # never accept a sub-1R reward

        stop_distance = atr_value * stop_mult
        broker_min = max(info.stops_level_points, 1.0) * info.point
        if stop_distance < broker_min:
            stop_distance = broker_min

        sign = signal.side.sign
        stop_loss = entry_price - sign * stop_distance
        take_profit = entry_price + sign * atr_value * target_mult
        if stop_loss <= 0:
            return RiskDecision.veto("computed stop is non-positive")

        # --- volume ----------------------------------------------------------
        money_per_unit = info.money_per_price_unit(1.0)
        if money_per_unit <= 0:
            return RiskDecision.veto(
                f"cannot value {info.name}: tick_value={info.tick_value} "
                f"tick_size={info.tick_size}"
            )

        raw_volume = risk_money / (stop_distance * money_per_unit)
        volume = info.normalize_volume(raw_volume)
        volume = min(volume, cfg.max_lot, info.volume_max)

        if volume < info.volume_min:
            return RiskDecision.veto(
                f"risk budget ${risk_money:,.2f} implies {raw_volume:.4f} lots, "
                f"below the {info.volume_min} minimum for {info.name}. One "
                f"minimum-size trade would risk more than the configured cap."
            )

        # Recompute the true risk of the volume we can actually trade, since
        # normalising to the lot grid changes it.
        actual_risk = stop_distance * money_per_unit * volume
        actual_pct = actual_risk / account.equity
        if actual_pct > cfg.max_risk_per_trade_pct * 1.001:
            return RiskDecision.veto(
                f"minimum lot risks {actual_pct:.2%}, above the "
                f"{cfg.max_risk_per_trade_pct:.2%} per-trade ceiling"
            )
        if current + actual_pct > cfg.max_portfolio_risk_pct * 1.001:
            return RiskDecision.veto(
                f"would push portfolio risk to {current + actual_pct:.2%}, "
                f"above the {cfg.max_portfolio_risk_pct:.2%} cap"
            )

        return RiskDecision(
            approved=True,
            reason=(
                f"{volume:g} lots risking ${actual_risk:,.2f} "
                f"({actual_pct:.2%}) with a {stop_mult:.1f}xATR stop"
            ),
            volume=volume,
            stop_loss=round(stop_loss, info.digits),
            take_profit=round(take_profit, info.digits),
            risk_amount=actual_risk,
            risk_pct=actual_pct,
        )

    def to_order(self, signal: Signal, decision: RiskDecision) -> OrderRequest:
        return OrderRequest(
            symbol=signal.symbol,
            side=signal.side,
            volume=decision.volume,
            stop_loss=decision.stop_loss,
            take_profit=decision.take_profit,
            strategy=signal.strategy,
            comment=f"{signal.strategy}|{signal.side.value}",
            risk_amount=decision.risk_amount,
            meta={"reason": signal.reason, "confidence": signal.confidence},
        )

    # ------------------------------------------------------- trade management

    def manage(
        self, position: Position, current_price: float, atr_value: float
    ) -> tuple[float | None, str]:
        """Return an updated stop for an open position, or (None, reason).

        Two rules, applied in order:
          1. at +1R, pull the stop to breakeven -- the trade can no longer lose
          2. beyond that, trail at ``trailing_atr_mult`` x ATR behind price
        Stops only ever move in the favourable direction.
        """
        cfg = self.cfg
        if position.stop_loss is None or atr_value <= 0:
            return None, "no stop or no ATR"

        r = position.r_multiple(current_price)
        sign = position.side.sign
        new_stop: float | None = None
        reason = ""

        if r >= cfg.breakeven_at_r - R_EPSILON:
            trail = current_price - sign * atr_value * cfg.trailing_atr_mult
            breakeven = position.entry_price
            candidate = max(trail, breakeven) if sign > 0 else min(trail, breakeven)
            improves = (
                candidate > position.stop_loss
                if sign > 0
                else candidate < position.stop_loss
            )
            if improves:
                new_stop = candidate
                reason = (
                    f"at {r:.2f}R: "
                    + ("breakeven" if candidate == breakeven else "trailing")
                )

        if new_stop is None:
            return None, f"no adjustment (at {r:.2f}R)"
        return new_stop, reason
