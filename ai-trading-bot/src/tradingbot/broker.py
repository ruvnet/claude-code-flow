"""Broker interface.

Three implementations satisfy it: MT5Broker (real terminal), PaperBroker
(simulated fills against live prices) and BacktestBroker (historical replay).
The trading loop cannot tell them apart, which is what makes "test exactly what
you will run" possible.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

import pandas as pd

from .types import AccountState, OrderRequest, OrderResult, Position, SymbolInfo


@runtime_checkable
class Broker(Protocol):
    name: str

    def connect(self) -> bool: ...
    def disconnect(self) -> None: ...
    def is_connected(self) -> bool: ...

    def account(self) -> AccountState: ...
    def symbol_info(self, symbol: str) -> SymbolInfo | None: ...
    def bars(self, symbol: str, timeframe: str, count: int) -> pd.DataFrame: ...
    def tick_price(self, symbol: str, side_for_entry: str) -> float | None: ...

    def positions(self) -> list[Position]: ...
    def place(self, req: OrderRequest) -> OrderResult: ...
    def modify(
        self, ticket: int, stop_loss: float | None, take_profit: float | None
    ) -> OrderResult: ...
    def close(self, ticket: int, reason: str = "") -> OrderResult: ...


class BrokerError(RuntimeError):
    pass
