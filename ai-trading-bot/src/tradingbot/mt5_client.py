"""MetaTrader 5 broker adapter.

Every quirk this module works around is one that silently rejects orders in
production: unsupported filling modes, broker minimum stop distances, symbols
that are not selected in Market Watch, and ``order_send`` returning ``None``
instead of a result object.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

import pandas as pd

from .broker import BrokerError
from .config import MT5Config
from .types import AccountState, OrderRequest, OrderResult, Position, Side, SymbolInfo

log = logging.getLogger(__name__)

try:  # pragma: no cover - platform dependent
    import MetaTrader5 as mt5

    MT5_AVAILABLE = True
except ImportError:  # pragma: no cover
    mt5 = None  # type: ignore[assignment]
    MT5_AVAILABLE = False


TIMEFRAMES: dict[str, str] = {
    "M1": "TIMEFRAME_M1",
    "M5": "TIMEFRAME_M5",
    "M15": "TIMEFRAME_M15",
    "M30": "TIMEFRAME_M30",
    "H1": "TIMEFRAME_H1",
    "H4": "TIMEFRAME_H4",
    "D1": "TIMEFRAME_D1",
    "W1": "TIMEFRAME_W1",
}

# Retcodes worth retrying: transient market/dealer conditions, not our bug.
RETRYABLE = {10004, 10006, 10008, 10021, 10024, 10018}


def timeframe_const(name: str) -> int:
    if not MT5_AVAILABLE:
        raise BrokerError("MetaTrader5 package is not installed")
    key = TIMEFRAMES.get(name.upper())
    if key is None:
        raise BrokerError(f"unsupported timeframe: {name}")
    return getattr(mt5, key)


def timeframe_minutes(name: str) -> int:
    n = name.upper()
    unit, num = n[0], int(n[1:])
    return {"M": 1, "H": 60, "D": 1440, "W": 10080}[unit] * num


class MT5Broker:
    """Thread-safe wrapper around the MetaTrader5 terminal API.

    The MT5 python binding is a process-wide singleton and is not re-entrant,
    so every call is serialised behind one lock.
    """

    name = "mt5"

    def __init__(self, cfg: MT5Config) -> None:
        self.cfg = cfg
        self._lock = threading.RLock()
        self._connected = False
        self._symbol_cache: dict[str, SymbolInfo] = {}
        self._selected: set[str] = set()
        self._filling_cache: dict[str, int] = {}

    # ---------------------------------------------------------------- connect

    def connect(self) -> bool:
        if not MT5_AVAILABLE:
            raise BrokerError(
                "MetaTrader5 package not installed. Run: pip install MetaTrader5 "
                "(Windows only)."
            )
        with self._lock:
            if self._connected and mt5.terminal_info() is not None:
                return True

            kwargs: dict = {"timeout": self.cfg.timeout_ms}
            if self.cfg.terminal_path:
                kwargs["path"] = self.cfg.terminal_path
            if self.cfg.login and self.cfg.password and self.cfg.server:
                kwargs.update(
                    login=int(self.cfg.login),
                    password=self.cfg.password,
                    server=self.cfg.server,
                )

            if not mt5.initialize(**kwargs):
                code, msg = mt5.last_error()
                raise BrokerError(
                    f"mt5.initialize failed ({code}): {msg}. Is the MetaTrader 5 "
                    "terminal running and logged in, with algo trading enabled?"
                )

            info = mt5.account_info()
            if info is None:
                mt5.shutdown()
                raise BrokerError("connected to terminal but no account is logged in")

            term = mt5.terminal_info()
            if term is not None and not term.trade_allowed:
                log.warning(
                    "Algo trading is DISABLED in the terminal. Orders will be "
                    "rejected until the Algo Trading button is enabled."
                )

            self._connected = True
            log.info(
                "MT5 connected: account=%s server=%s balance=%.2f %s leverage=1:%s",
                info.login,
                info.server,
                info.balance,
                info.currency,
                info.leverage,
            )
            return True

    def disconnect(self) -> None:
        with self._lock:
            if self._connected and MT5_AVAILABLE:
                mt5.shutdown()
            self._connected = False

    def is_connected(self) -> bool:
        with self._lock:
            if not self._connected or not MT5_AVAILABLE:
                return False
            return mt5.terminal_info() is not None

    def ensure_connected(self) -> None:
        if not self.is_connected():
            log.warning("MT5 connection lost, reconnecting")
            self._connected = False
            self._symbol_cache.clear()
            self._selected.clear()
            self.connect()

    # ----------------------------------------------------------------- market

    def account(self) -> AccountState:
        with self._lock:
            self.ensure_connected()
            a = mt5.account_info()
            if a is None:
                raise BrokerError("account_info() returned None")
            return AccountState(
                balance=a.balance,
                equity=a.equity,
                margin=a.margin,
                margin_free=a.margin_free,
                currency=a.currency,
                leverage=a.leverage,
            )

    def _select(self, symbol: str) -> bool:
        if symbol in self._selected:
            return True
        if not mt5.symbol_select(symbol, True):
            log.error("symbol_select(%s) failed: %s", symbol, mt5.last_error())
            return False
        self._selected.add(symbol)
        return True

    def symbol_info(self, symbol: str, refresh: bool = False) -> SymbolInfo | None:
        with self._lock:
            self.ensure_connected()
            if not refresh and symbol in self._symbol_cache:
                return self._symbol_cache[symbol]

            if not self._select(symbol):
                return None
            s = mt5.symbol_info(symbol)
            if s is None:
                log.error("symbol_info(%s) returned None", symbol)
                return None

            tick_size = s.trade_tick_size or s.point
            tick_value = s.trade_tick_value
            if tick_value <= 0:  # some brokers only populate the profit variant
                tick_value = getattr(s, "trade_tick_value_profit", 0.0) or 0.0

            info = SymbolInfo(
                name=s.name,
                digits=s.digits,
                point=s.point,
                tick_size=tick_size,
                tick_value=tick_value,
                contract_size=s.trade_contract_size,
                volume_min=s.volume_min,
                volume_max=s.volume_max,
                volume_step=s.volume_step,
                stops_level_points=float(s.trade_stops_level),
                spread_points=float(s.spread),
                trade_allowed=s.trade_mode != mt5.SYMBOL_TRADE_MODE_DISABLED,
            )
            self._symbol_cache[symbol] = info
            return info

    def list_symbols(self, pattern: str = "") -> list[str]:
        with self._lock:
            self.ensure_connected()
            syms = mt5.symbols_get(pattern) if pattern else mt5.symbols_get()
            return sorted(s.name for s in (syms or ()))

    def bars(self, symbol: str, timeframe: str, count: int) -> pd.DataFrame:
        with self._lock:
            self.ensure_connected()
            if not self._select(symbol):
                return pd.DataFrame()
            rates = mt5.copy_rates_from_pos(
                symbol, timeframe_const(timeframe), 0, int(count)
            )
        if rates is None or len(rates) == 0:
            log.warning("no bars for %s %s: %s", symbol, timeframe, mt5.last_error())
            return pd.DataFrame()

        df = pd.DataFrame(rates)
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
        df = df.rename(columns={"tick_volume": "volume"})
        keep = ["time", "open", "high", "low", "close", "volume", "spread"]
        df = df[[c for c in keep if c in df.columns]]
        return df.set_index("time").sort_index()

    def tick_price(self, symbol: str, side_for_entry: str) -> float | None:
        """Ask when buying, bid when selling: the price we would actually pay."""
        with self._lock:
            self.ensure_connected()
            if not self._select(symbol):
                return None
            t = mt5.symbol_info_tick(symbol)
        if t is None:
            return None
        return float(t.ask if side_for_entry == Side.BUY.value else t.bid)

    def spread_points(self, symbol: str) -> float | None:
        with self._lock:
            self.ensure_connected()
            if not self._select(symbol):
                return None
            t = mt5.symbol_info_tick(symbol)
            s = self.symbol_info(symbol)
        if t is None or s is None or s.point <= 0:
            return None
        return (t.ask - t.bid) / s.point

    # -------------------------------------------------------------- positions

    def positions(self) -> list[Position]:
        with self._lock:
            self.ensure_connected()
            raw = mt5.positions_get()
        out: list[Position] = []
        for p in raw or ():
            if p.magic != self.cfg.magic:
                continue  # not ours, never touch it
            strategy, _, _ = (p.comment or "").partition("|")
            out.append(
                Position(
                    ticket=p.ticket,
                    symbol=p.symbol,
                    side=Side.BUY if p.type == mt5.POSITION_TYPE_BUY else Side.SELL,
                    volume=p.volume,
                    entry_price=p.price_open,
                    stop_loss=p.sl or None,
                    take_profit=p.tp or None,
                    profit=p.profit,
                    opened_at=datetime.fromtimestamp(p.time, tz=timezone.utc),
                    strategy=strategy.strip(),
                    comment=p.comment or "",
                )
            )
        return out

    # ----------------------------------------------------------------- orders

    def _filling_mode(self, symbol: str) -> int:
        """Pick a filling mode the broker actually supports for this symbol.

        Getting this wrong is the most common cause of retcode 10030
        (unsupported filling mode) rejections.
        """
        if symbol in self._filling_cache:
            return self._filling_cache[symbol]
        s = mt5.symbol_info(symbol)
        mode = mt5.ORDER_FILLING_IOC
        if s is not None:
            flags = s.filling_mode
            if flags & mt5.SYMBOL_FILLING_FOK:
                mode = mt5.ORDER_FILLING_FOK
            elif flags & mt5.SYMBOL_FILLING_IOC:
                mode = mt5.ORDER_FILLING_IOC
            else:
                mode = mt5.ORDER_FILLING_RETURN
        self._filling_cache[symbol] = mode
        return mode

    def _clamp_stops(
        self, info: SymbolInfo, side: Side, price: float, sl: float, tp: float
    ) -> tuple[float, float]:
        """Push SL/TP out to the minimum distance the broker will accept."""
        min_dist = max(info.stops_level_points, 1.0) * info.point
        if side is Side.BUY:
            sl = min(sl, price - min_dist)
            tp = max(tp, price + min_dist)
        else:
            sl = max(sl, price + min_dist)
            tp = min(tp, price - min_dist)
        return round(sl, info.digits), round(tp, info.digits)

    def place(self, req: OrderRequest, retries: int = 3) -> OrderResult:
        with self._lock:
            self.ensure_connected()
            info = self.symbol_info(req.symbol)
            if info is None:
                return OrderResult(False, message=f"unknown symbol {req.symbol}")
            if not info.trade_allowed:
                return OrderResult(False, message=f"trading disabled for {req.symbol}")

            volume = info.normalize_volume(req.volume)
            if volume < info.volume_min:
                return OrderResult(
                    False,
                    message=(
                        f"computed volume {req.volume:.4f} is below the broker "
                        f"minimum {info.volume_min}. The risk budget is too small "
                        f"for this symbol: tighten the stop or fund the account."
                    ),
                )

            order_type = (
                mt5.ORDER_TYPE_BUY if req.side is Side.BUY else mt5.ORDER_TYPE_SELL
            )
            last_msg = ""
            for attempt in range(1, retries + 1):
                tick = mt5.symbol_info_tick(req.symbol)
                if tick is None:
                    return OrderResult(False, message="no tick data")
                price = tick.ask if req.side is Side.BUY else tick.bid
                sl, tp = self._clamp_stops(
                    info, req.side, price, req.stop_loss, req.take_profit
                )

                request = {
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": req.symbol,
                    "volume": volume,
                    "type": order_type,
                    "price": price,
                    "sl": sl,
                    "tp": tp,
                    "deviation": self.cfg.deviation_points,
                    "magic": self.cfg.magic,
                    "comment": (req.comment or req.strategy)[:31],
                    "type_time": mt5.ORDER_TIME_GTC,
                    "type_filling": self._filling_mode(req.symbol),
                }

                result = mt5.order_send(request)
                if result is None:
                    code, msg = mt5.last_error()
                    last_msg = f"order_send returned None ({code}): {msg}"
                    log.error("%s [attempt %d]", last_msg, attempt)
                    time.sleep(0.4 * attempt)
                    continue

                if result.retcode == mt5.TRADE_RETCODE_DONE:
                    log.info(
                        "FILLED %s %s %.2f lots @ %.5f sl=%.5f tp=%.5f ticket=%s",
                        req.side.value.upper(),
                        req.symbol,
                        result.volume,
                        result.price,
                        sl,
                        tp,
                        result.order,
                    )
                    return OrderResult(
                        True,
                        ticket=result.order,
                        price=result.price,
                        volume=result.volume,
                        retcode=result.retcode,
                        message=result.comment or "ok",
                    )

                last_msg = f"retcode={result.retcode} {result.comment}"
                if result.retcode in RETRYABLE and attempt < retries:
                    log.warning(
                        "retryable rejection: %s [attempt %d]", last_msg, attempt
                    )
                    time.sleep(0.4 * attempt)
                    continue
                log.error("order rejected: %s", last_msg)
                return OrderResult(False, retcode=result.retcode, message=last_msg)

            return OrderResult(False, message=f"exhausted retries: {last_msg}")

    def modify(
        self, ticket: int, stop_loss: float | None, take_profit: float | None
    ) -> OrderResult:
        with self._lock:
            self.ensure_connected()
            pos = next(
                (p for p in mt5.positions_get() or () if p.ticket == ticket), None
            )
            if pos is None:
                return OrderResult(False, message=f"position {ticket} not found")
            if pos.magic != self.cfg.magic:
                return OrderResult(
                    False, message="refusing to modify a foreign position"
                )

            info = self.symbol_info(pos.symbol)
            digits = info.digits if info else 5
            request = {
                "action": mt5.TRADE_ACTION_SLTP,
                "position": ticket,
                "symbol": pos.symbol,
                "sl": round(stop_loss, digits) if stop_loss else 0.0,
                "tp": round(take_profit, digits) if take_profit else 0.0,
                "magic": self.cfg.magic,
            }
            result = mt5.order_send(request)
            if result is None:
                return OrderResult(False, message=f"modify failed: {mt5.last_error()}")
            ok = result.retcode == mt5.TRADE_RETCODE_DONE
            return OrderResult(
                ok,
                ticket=ticket,
                retcode=result.retcode,
                message=result.comment or ("ok" if ok else "failed"),
            )

    def close(self, ticket: int, reason: str = "") -> OrderResult:
        with self._lock:
            self.ensure_connected()
            pos = next(
                (p for p in mt5.positions_get() or () if p.ticket == ticket), None
            )
            if pos is None:
                return OrderResult(False, message=f"position {ticket} not found")
            if pos.magic != self.cfg.magic:
                return OrderResult(False, message="refusing to close a foreign position")

            tick = mt5.symbol_info_tick(pos.symbol)
            if tick is None:
                return OrderResult(False, message="no tick data")
            is_buy = pos.type == mt5.POSITION_TYPE_BUY
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": pos.symbol,
                "volume": pos.volume,
                "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
                "position": ticket,
                "price": tick.bid if is_buy else tick.ask,
                "deviation": self.cfg.deviation_points,
                "magic": self.cfg.magic,
                "comment": (reason or "close")[:31],
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": self._filling_mode(pos.symbol),
            }
            result = mt5.order_send(request)
            if result is None:
                return OrderResult(False, message=f"close failed: {mt5.last_error()}")
            ok = result.retcode == mt5.TRADE_RETCODE_DONE
            if ok:
                log.info("CLOSED ticket=%s %s reason=%s", ticket, pos.symbol, reason)
            return OrderResult(
                ok,
                ticket=ticket,
                price=result.price,
                retcode=result.retcode,
                message=result.comment or ("ok" if ok else "failed"),
            )

    def closed_deals(self, since: datetime, until: datetime | None = None) -> list[dict]:
        """History deals tagged with our magic: source of truth for the journal."""
        with self._lock:
            self.ensure_connected()
            until = until or datetime.now(timezone.utc)
            deals = mt5.history_deals_get(since, until)
        out = []
        for d in deals or ():
            if d.magic != self.cfg.magic:
                continue
            out.append(
                {
                    "ticket": d.ticket,
                    "position_id": d.position_id,
                    "symbol": d.symbol,
                    "type": d.type,
                    "entry": d.entry,
                    "volume": d.volume,
                    "price": d.price,
                    "profit": d.profit,
                    "commission": getattr(d, "commission", 0.0),
                    "swap": getattr(d, "swap", 0.0),
                    "comment": d.comment or "",
                    "time": datetime.fromtimestamp(d.time, tz=timezone.utc),
                }
            )
        return out
