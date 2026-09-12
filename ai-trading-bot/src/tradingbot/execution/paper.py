"""Paper broker: real prices, simulated money.

Satisfies the same Broker protocol as MT5Broker, so the trading loop running
against this is byte-for-byte the same code path that will run against a live
account. That is the whole point -- a paper mode that takes a different route
through the code tests the paper mode, not the bot.

Fills are pessimistic in the same way the backtester is: you cross the spread
on entry and on exit, you pay commission both ways, and when a bar could have
hit either the stop or the target, the stop is recorded.

It reads live quotes from a real broker connection when one is available, so
this is genuinely forward-testing rather than replay.
"""
from __future__ import annotations

import itertools
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from ..types import (
    AccountState,
    OrderRequest,
    OrderResult,
    Position,
    Side,
    SymbolInfo,
)

log = logging.getLogger(__name__)


class PaperBroker:
    """Simulated account driven by a real price source."""

    name = "paper"

    def __init__(
        self,
        price_source,
        starting_balance: float = 100_000.0,
        currency: str = "USD",
        commission_per_lot: float = 7.0,
        slippage_points: float = 2.0,
        state_path: str | Path | None = None,
    ) -> None:
        self.source = price_source          # any object exposing bars/tick_price
        self.starting_balance = starting_balance
        self.balance = starting_balance
        self.currency = currency
        self.commission_per_lot = commission_per_lot
        self.slippage_points = slippage_points
        self.state_path = Path(state_path) if state_path else None

        self._positions: dict[int, Position] = {}
        self._tickets = itertools.count(900_000_001)
        self._connected = False
        self._closed_pnl: list[dict] = []
        if self.state_path:
            self._load()

    # ------------------------------------------------------------ connection

    def connect(self) -> bool:
        if hasattr(self.source, "connect"):
            try:
                self.source.connect()
            except Exception:
                log.warning(
                    "paper broker: price source unavailable; quotes will be "
                    "missing until it reconnects", exc_info=True
                )
        self._connected = True
        log.info(
            "paper broker ready: balance %.2f %s (simulated)",
            self.balance, self.currency,
        )
        return True

    def disconnect(self) -> None:
        self._save()
        if hasattr(self.source, "disconnect"):
            self.source.disconnect()
        self._connected = False

    def is_connected(self) -> bool:
        return self._connected

    # --------------------------------------------------------------- market

    def symbol_info(self, symbol: str) -> SymbolInfo | None:
        if hasattr(self.source, "symbol_info"):
            info = self.source.symbol_info(symbol)
            if info is not None:
                return info
        from ..backtest.engine import synthetic_symbol_info

        return synthetic_symbol_info(symbol, 1.0)

    def bars(self, symbol: str, timeframe: str, count: int) -> pd.DataFrame:
        return self.source.bars(symbol, timeframe, count)

    def tick_price(self, symbol: str, side_for_entry: str) -> float | None:
        if hasattr(self.source, "tick_price"):
            p = self.source.tick_price(symbol, side_for_entry)
            if p is not None:
                return p
        df = self.source.bars(symbol, "M1", 1)
        return float(df["close"].iloc[-1]) if not df.empty else None

    def _mid(self, symbol: str) -> float | None:
        bid = self.tick_price(symbol, Side.SELL.value)
        ask = self.tick_price(symbol, Side.BUY.value)
        if bid is None or ask is None:
            return bid if bid is not None else ask
        return (bid + ask) / 2.0

    # -------------------------------------------------------------- account

    def account(self) -> AccountState:
        equity = self.balance + self.floating_pnl()
        margin = sum(
            p.volume * 1000.0 for p in self._positions.values()
        )  # rough 1:100-ish notional proxy
        return AccountState(
            balance=self.balance,
            equity=equity,
            margin=margin,
            margin_free=max(equity - margin, 0.0),
            currency=self.currency,
            leverage=500,
        )

    def floating_pnl(self) -> float:
        total = 0.0
        for p in self._positions.values():
            price = self._mid(p.symbol)
            if price is None:
                continue
            info = self.symbol_info(p.symbol)
            if info is None:
                continue
            total += (
                (price - p.entry_price)
                * p.side.sign
                * info.money_per_price_unit(p.volume)
            )
        return total

    def positions(self) -> list[Position]:
        for p in self._positions.values():
            price = self._mid(p.symbol)
            info = self.symbol_info(p.symbol)
            if price is not None and info is not None:
                p.profit = (
                    (price - p.entry_price)
                    * p.side.sign
                    * info.money_per_price_unit(p.volume)
                )
        return list(self._positions.values())

    # --------------------------------------------------------------- orders

    def place(self, req: OrderRequest) -> OrderResult:
        info = self.symbol_info(req.symbol)
        if info is None:
            return OrderResult(False, message=f"unknown symbol {req.symbol}")

        raw = self.tick_price(req.symbol, req.side.value)
        if raw is None:
            return OrderResult(False, message="no price available")

        volume = info.normalize_volume(req.volume)
        if volume < info.volume_min:
            return OrderResult(
                False, message=f"volume {req.volume:.4f} below minimum"
            )

        # Adverse slippage on top of the quoted side.
        fill = raw + req.side.sign * self.slippage_points * info.point
        ticket = next(self._tickets)

        self.balance -= self.commission_per_lot * volume  # entry commission

        self._positions[ticket] = Position(
            ticket=ticket,
            symbol=req.symbol,
            side=req.side,
            volume=volume,
            entry_price=fill,
            stop_loss=req.stop_loss,
            take_profit=req.take_profit,
            profit=0.0,
            opened_at=datetime.now(timezone.utc),
            strategy=req.strategy,
            comment=req.comment,
            initial_stop=req.stop_loss,
        )
        log.info(
            "[PAPER] %s %s %.2f lots @ %.5f sl=%.5f tp=%.5f ticket=%d",
            req.side.value.upper(), req.symbol, volume, fill,
            req.stop_loss, req.take_profit, ticket,
        )
        self._save()
        return OrderResult(True, ticket=ticket, price=fill, volume=volume,
                           message="paper fill")

    def modify(
        self, ticket: int, stop_loss: float | None, take_profit: float | None
    ) -> OrderResult:
        p = self._positions.get(ticket)
        if p is None:
            return OrderResult(False, message=f"position {ticket} not found")
        if stop_loss is not None:
            p.stop_loss = stop_loss
        if take_profit is not None:
            p.take_profit = take_profit
        self._save()
        return OrderResult(True, ticket=ticket, message="paper modify")

    def close(self, ticket: int, reason: str = "") -> OrderResult:
        p = self._positions.get(ticket)
        if p is None:
            return OrderResult(False, message=f"position {ticket} not found")

        info = self.symbol_info(p.symbol)
        exit_price = self.tick_price(p.symbol, p.side.opposite.value)
        if exit_price is None or info is None:
            return OrderResult(False, message="no price available to close")

        exit_price -= p.side.sign * self.slippage_points * info.point
        gross = (
            (exit_price - p.entry_price)
            * p.side.sign
            * info.money_per_price_unit(p.volume)
        )
        commission = self.commission_per_lot * p.volume
        net = gross - commission
        self.balance += net

        self._closed_pnl.append({
            "ticket": ticket, "symbol": p.symbol, "strategy": p.strategy,
            "profit": net, "reason": reason,
            "closed_at": datetime.now(timezone.utc).isoformat(),
        })
        del self._positions[ticket]
        log.info(
            "[PAPER] CLOSED %d %s @ %.5f net %+.2f (%s)",
            ticket, p.symbol, exit_price, net, reason,
        )
        self._save()
        return OrderResult(True, ticket=ticket, price=exit_price, message=reason)

    # -------------------------------------------------------- stop/target fill

    def check_exits(self) -> list[tuple[int, float, str]]:
        """Fill stops and targets against current quotes.

        A live account has the broker doing this server-side; in paper mode the
        bot has to do it itself. Ties go to the stop, matching the backtester.
        """
        filled: list[tuple[int, float, str]] = []
        for ticket, p in list(self._positions.items()):
            price = self.tick_price(p.symbol, p.side.opposite.value)
            if price is None:
                continue

            hit_stop = (
                p.stop_loss is not None
                and (price <= p.stop_loss if p.side is Side.BUY
                     else price >= p.stop_loss)
            )
            hit_tp = (
                p.take_profit is not None
                and (price >= p.take_profit if p.side is Side.BUY
                     else price <= p.take_profit)
            )

            if hit_stop:
                result = self.close(ticket, "stop_loss")
                if result.ok:
                    filled.append((ticket, result.price or price, "stop_loss"))
            elif hit_tp:
                result = self.close(ticket, "take_profit")
                if result.ok:
                    filled.append((ticket, result.price or price, "take_profit"))
        return filled

    # ---------------------------------------------------------- persistence

    def _save(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "balance": self.balance,
            "starting_balance": self.starting_balance,
            "positions": [
                {
                    "ticket": p.ticket, "symbol": p.symbol, "side": p.side.value,
                    "volume": p.volume, "entry_price": p.entry_price,
                    "stop_loss": p.stop_loss, "take_profit": p.take_profit,
                    "opened_at": p.opened_at.isoformat(), "strategy": p.strategy,
                    "comment": p.comment, "initial_stop": p.initial_stop,
                }
                for p in self._positions.values()
            ],
            "closed": self._closed_pnl[-500:],
        }
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    def _load(self) -> None:
        if not self.state_path or not self.state_path.exists():
            return
        try:
            d = json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            log.exception("could not restore paper state")
            return
        self.balance = d.get("balance", self.starting_balance)
        self.starting_balance = d.get("starting_balance", self.starting_balance)
        self._closed_pnl = d.get("closed", [])
        highest = 900_000_001
        for row in d.get("positions", []):
            p = Position(
                ticket=row["ticket"], symbol=row["symbol"],
                side=Side(row["side"]), volume=row["volume"],
                entry_price=row["entry_price"], stop_loss=row.get("stop_loss"),
                take_profit=row.get("take_profit"), profit=0.0,
                opened_at=datetime.fromisoformat(row["opened_at"]),
                strategy=row.get("strategy", ""), comment=row.get("comment", ""),
                initial_stop=row.get("initial_stop"),
            )
            self._positions[p.ticket] = p
            highest = max(highest, p.ticket)
        self._tickets = itertools.count(highest + 1)
        log.info(
            "paper state restored: balance %.2f, %d open position(s)",
            self.balance, len(self._positions),
        )
