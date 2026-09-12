"""Trade journal.

Every signal considered, every order placed, every trade closed. This is the
bot's memory and the substrate the bandit and meta-model learn from, so it is
written synchronously and is the one component allowed to be slow.

Rejected signals are recorded too. Knowing what the bot *declined* to do is
what lets you tell "the filters are working" apart from "the filters are eating
all the edge".
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from ..types import Regime, Side, Signal, TradeRecord

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket          INTEGER UNIQUE,
    symbol          TEXT    NOT NULL,
    strategy        TEXT    NOT NULL,
    side            TEXT    NOT NULL,
    volume          REAL    NOT NULL,
    entry_price     REAL    NOT NULL,
    exit_price      REAL,
    stop_loss       REAL,
    take_profit     REAL,
    profit          REAL,
    r_multiple      REAL,
    regime          TEXT,
    opened_at       TEXT    NOT NULL,
    closed_at       TEXT,
    exit_reason     TEXT,
    features        TEXT,
    mode            TEXT    DEFAULT 'paper'
);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
CREATE INDEX IF NOT EXISTS idx_trades_closed   ON trades(closed_at);
CREATE INDEX IF NOT EXISTS idx_trades_regime   ON trades(strategy, regime);

CREATE TABLE IF NOT EXISTS signals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    strategy   TEXT NOT NULL,
    side       TEXT NOT NULL,
    confidence REAL,
    regime     TEXT,
    accepted   INTEGER NOT NULL,
    reject_reason TEXT,
    meta_score REAL,
    bandit_score REAL,
    features   TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);

CREATE TABLE IF NOT EXISTS equity_curve (
    ts      TEXT PRIMARY KEY,
    equity  REAL NOT NULL,
    balance REAL NOT NULL,
    open_positions INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts    TEXT NOT NULL,
    level TEXT NOT NULL,
    kind  TEXT NOT NULL,
    message TEXT,
    data  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
"""


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _parse(s: str | None) -> datetime | None:
    if not s:
        return None
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class Journal:
    def __init__(self, db_path: str | Path) -> None:
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.path, timeout=30.0)
            conn.row_factory = sqlite3.Row
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    # ---------------------------------------------------------------- writing

    def record_signal(
        self,
        signal: Signal,
        regime: Regime,
        accepted: bool,
        reject_reason: str = "",
        meta_score: float | None = None,
        bandit_score: float | None = None,
    ) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO signals (ts,symbol,strategy,side,confidence,regime,"
                "accepted,reject_reason,meta_score,bandit_score,features) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    _iso(signal.at), signal.symbol, signal.strategy,
                    signal.side.value, signal.confidence, regime.value,
                    int(accepted), reject_reason, meta_score, bandit_score,
                    json.dumps(signal.features),
                ),
            )

    def open_trade(
        self,
        ticket: int,
        signal: Signal,
        volume: float,
        entry_price: float,
        stop_loss: float,
        take_profit: float,
        regime: Regime,
        mode: str = "paper",
    ) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO trades (ticket,symbol,strategy,side,volume,"
                "entry_price,stop_loss,take_profit,regime,opened_at,features,mode) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    ticket, signal.symbol, signal.strategy, signal.side.value,
                    volume, entry_price, stop_loss, take_profit, regime.value,
                    _iso(datetime.now(timezone.utc)), json.dumps(signal.features),
                    mode,
                ),
            )

    def close_trade(
        self,
        ticket: int,
        exit_price: float,
        profit: float,
        r_multiple: float,
        exit_reason: str = "",
        closed_at: datetime | None = None,
    ) -> None:
        with self._conn() as c:
            c.execute(
                "UPDATE trades SET exit_price=?, profit=?, r_multiple=?, "
                "exit_reason=?, closed_at=? WHERE ticket=?",
                (
                    exit_price, profit, r_multiple, exit_reason,
                    _iso(closed_at or datetime.now(timezone.utc)), ticket,
                ),
            )

    def record_equity(self, equity: float, balance: float, open_positions: int) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO equity_curve (ts,equity,balance,"
                "open_positions) VALUES (?,?,?,?)",
                (_iso(datetime.now(timezone.utc)), equity, balance, open_positions),
            )

    def event(
        self, kind: str, message: str, level: str = "INFO", data: dict | None = None
    ) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO events (ts,level,kind,message,data) VALUES (?,?,?,?,?)",
                (
                    _iso(datetime.now(timezone.utc)), level, kind, message,
                    json.dumps(data or {}),
                ),
            )

    # ---------------------------------------------------------------- reading

    def open_tickets(self) -> set[int]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT ticket FROM trades WHERE closed_at IS NULL"
            ).fetchall()
        return {r["ticket"] for r in rows}

    def closed_trades(
        self, strategy: str | None = None, limit: int | None = None,
        since: datetime | None = None,
    ) -> list[TradeRecord]:
        q = "SELECT * FROM trades WHERE closed_at IS NOT NULL"
        params: list[Any] = []
        if strategy:
            q += " AND strategy=?"
            params.append(strategy)
        if since:
            q += " AND closed_at >= ?"
            params.append(_iso(since))
        q += " ORDER BY closed_at ASC"
        if limit:
            q += f" LIMIT {int(limit)}"

        with self._conn() as c:
            rows = c.execute(q, params).fetchall()

        out: list[TradeRecord] = []
        for r in rows:
            try:
                out.append(
                    TradeRecord(
                        ticket=r["ticket"], symbol=r["symbol"],
                        strategy=r["strategy"], side=Side(r["side"]),
                        volume=r["volume"], entry_price=r["entry_price"],
                        exit_price=r["exit_price"] or 0.0,
                        stop_loss=r["stop_loss"], take_profit=r["take_profit"],
                        profit=r["profit"] or 0.0,
                        opened_at=_parse(r["opened_at"]),
                        closed_at=_parse(r["closed_at"]),
                        r_multiple=r["r_multiple"] or 0.0,
                        regime=Regime(r["regime"] or "unknown"),
                        features=json.loads(r["features"] or "{}"),
                        exit_reason=r["exit_reason"] or "",
                    )
                )
            except Exception:
                log.exception("skipping malformed trade row ticket=%s", r["ticket"])
        return out

    def stats(self, strategy: str | None = None, regime: Regime | None = None) -> dict:
        q = (
            "SELECT COUNT(*) n, "
            "SUM(CASE WHEN profit>0 THEN 1 ELSE 0 END) wins, "
            "SUM(profit) net, "
            "SUM(CASE WHEN profit>0 THEN profit ELSE 0 END) gross_win, "
            "SUM(CASE WHEN profit<0 THEN -profit ELSE 0 END) gross_loss, "
            "AVG(r_multiple) avg_r "
            "FROM trades WHERE closed_at IS NOT NULL"
        )
        params: list[Any] = []
        if strategy:
            q += " AND strategy=?"
            params.append(strategy)
        if regime:
            q += " AND regime=?"
            params.append(regime.value)

        with self._conn() as c:
            r = c.execute(q, params).fetchone()

        n = r["n"] or 0
        wins = r["wins"] or 0
        gw, gl = r["gross_win"] or 0.0, r["gross_loss"] or 0.0
        return {
            "trades": n,
            "wins": wins,
            "losses": n - wins,
            "win_rate": (wins / n) if n else 0.0,
            "net_profit": r["net"] or 0.0,
            "gross_win": gw,
            "gross_loss": gl,
            "profit_factor": (gw / gl) if gl > 0 else (float("inf") if gw > 0 else 0.0),
            "avg_r": r["avg_r"] or 0.0,
        }

    def strategy_leaderboard(self) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT strategy FROM trades WHERE closed_at IS NOT NULL "
                "GROUP BY strategy"
            ).fetchall()
        out = [{"strategy": r["strategy"], **self.stats(r["strategy"])} for r in rows]
        return sorted(out, key=lambda d: d["net_profit"], reverse=True)

    def signal_funnel(self, days: int = 7) -> dict:
        since = _iso(datetime.now(timezone.utc) - timedelta(days=days))
        with self._conn() as c:
            total = c.execute(
                "SELECT COUNT(*) n FROM signals WHERE ts >= ?", (since,)
            ).fetchone()["n"]
            accepted = c.execute(
                "SELECT COUNT(*) n FROM signals WHERE ts >= ? AND accepted=1", (since,)
            ).fetchone()["n"]
            reasons = c.execute(
                "SELECT reject_reason, COUNT(*) n FROM signals "
                "WHERE ts >= ? AND accepted=0 AND reject_reason != '' "
                "GROUP BY reject_reason ORDER BY n DESC LIMIT 12",
                (since,),
            ).fetchall()
        return {
            "days": days,
            "signals": total,
            "accepted": accepted,
            "acceptance_rate": (accepted / total) if total else 0.0,
            "top_rejections": [(r["reject_reason"], r["n"]) for r in reasons],
        }

    def equity_series(self, limit: int = 5000) -> list[tuple[datetime, float]]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT ts, equity FROM equity_curve ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [(_parse(r["ts"]), r["equity"]) for r in reversed(rows)]
