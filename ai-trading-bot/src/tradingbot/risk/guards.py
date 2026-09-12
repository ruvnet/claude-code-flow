"""Circuit breakers.

The risk manager sizes individual trades. This module answers the prior
question: should the bot be trading at all right now?

Breakers escalate and each has its own reset:

    DAILY_LOSS      -3% on the day    -> resets next UTC day
    WEEKLY_LOSS     -6% on the week   -> resets Monday
    MAX_DRAWDOWN   -15% peak-to-trough-> HARD HALT, manual reset only
    KILL_SWITCH     var/HALT present  -> manual, immediate

The drawdown breaker never auto-resets on purpose. If the account is down 15%
something is wrong with the model of the world, and the correct response is a
human looking at it, not the bot deciding it feels better.
"""
from __future__ import annotations

import enum
import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

from ..config import RiskConfig
from ..goal.controller import week_start

log = logging.getLogger(__name__)

HALT_FILENAME = "HALT"


class Breaker(str, enum.Enum):
    NONE = "none"
    DAILY_LOSS = "daily_loss"
    WEEKLY_LOSS = "weekly_loss"
    MAX_DRAWDOWN = "max_drawdown"
    KILL_SWITCH = "kill_switch"
    NO_CONNECTION = "no_connection"


@dataclass(slots=True)
class GuardState:
    peak_equity: float = 0.0
    day_start_equity: float = 0.0
    week_start_equity: float = 0.0
    current_day: str = ""
    current_week: str = ""
    halted: bool = False
    halt_reason: str = ""
    halted_at: str = ""
    consecutive_losses: int = 0

    def to_dict(self) -> dict:
        return {
            "peak_equity": self.peak_equity,
            "day_start_equity": self.day_start_equity,
            "week_start_equity": self.week_start_equity,
            "current_day": self.current_day,
            "current_week": self.current_week,
            "halted": self.halted,
            "halt_reason": self.halt_reason,
            "halted_at": self.halted_at,
            "consecutive_losses": self.consecutive_losses,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "GuardState":
        return cls(**{k: v for k, v in d.items() if k in cls.__slots__})


@dataclass(frozen=True, slots=True)
class GuardVerdict:
    can_trade: bool
    breaker: Breaker
    message: str
    detail: dict = field(default_factory=dict)


class RiskGuards:
    """Persistent circuit breakers. State survives restarts on purpose -- a
    crash-loop must not be a way to reset the daily loss limit."""

    def __init__(self, cfg: RiskConfig, state_path: Path) -> None:
        self.cfg = cfg
        self.state_path = Path(state_path)
        self.halt_file = self.state_path.parent / HALT_FILENAME
        self.state = self._load()

    # ------------------------------------------------------------ persistence

    def _load(self) -> GuardState:
        if self.state_path.exists():
            try:
                return GuardState.from_dict(
                    json.loads(self.state_path.read_text(encoding="utf-8"))
                )
            except Exception:
                log.exception("could not read guard state; starting fresh")
        return GuardState()

    def save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state.to_dict(), indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    # ----------------------------------------------------------------- period

    def _roll_periods(self, equity: float, now: datetime) -> None:
        today = now.date().isoformat()
        this_week = week_start(now).date().isoformat()

        if self.state.current_day != today:
            self.state.current_day = today
            self.state.day_start_equity = equity
            # A new day clears only the daily breaker.
            if self.state.halted and self.state.halt_reason == Breaker.DAILY_LOSS.value:
                log.info("new trading day: clearing the daily-loss halt")
                self.state.halted = False
                self.state.halt_reason = ""

        if self.state.current_week != this_week:
            self.state.current_week = this_week
            self.state.week_start_equity = equity
            if self.state.halted and self.state.halt_reason == Breaker.WEEKLY_LOSS.value:
                log.info("new trading week: clearing the weekly-loss halt")
                self.state.halted = False
                self.state.halt_reason = ""

        if equity > self.state.peak_equity:
            self.state.peak_equity = equity
        if self.state.day_start_equity <= 0:
            self.state.day_start_equity = equity
        if self.state.week_start_equity <= 0:
            self.state.week_start_equity = equity

    # ------------------------------------------------------------------ query

    def day_pnl(self, equity: float) -> float:
        return equity - self.state.day_start_equity

    def week_pnl(self, equity: float) -> float:
        return equity - self.state.week_start_equity

    def drawdown(self, equity: float) -> float:
        if self.state.peak_equity <= 0:
            return 0.0
        return (self.state.peak_equity - equity) / self.state.peak_equity

    def check(self, equity: float, now: datetime | None = None) -> GuardVerdict:
        now = now or datetime.now(timezone.utc)
        self._roll_periods(equity, now)

        detail = {
            "equity": equity,
            "peak_equity": self.state.peak_equity,
            "day_pnl": self.day_pnl(equity),
            "week_pnl": self.week_pnl(equity),
            "drawdown": self.drawdown(equity),
        }

        # 1. Manual kill switch beats everything.
        if self.halt_file.exists():
            return GuardVerdict(
                False, Breaker.KILL_SWITCH,
                f"kill switch present at {self.halt_file}: delete it to resume",
                detail,
            )

        # 2. A hard drawdown halt persists until a human clears it.
        if self.state.halted and self.state.halt_reason == Breaker.MAX_DRAWDOWN.value:
            return GuardVerdict(
                False, Breaker.MAX_DRAWDOWN,
                f"halted on max drawdown at {self.state.halted_at}. "
                f"Run `reset-guards` after reviewing what happened.",
                detail,
            )

        dd = self.drawdown(equity)
        if dd >= self.cfg.max_drawdown_pct:
            self._halt(Breaker.MAX_DRAWDOWN, now)
            return GuardVerdict(
                False, Breaker.MAX_DRAWDOWN,
                f"drawdown {dd:.2%} hit the {self.cfg.max_drawdown_pct:.0%} "
                f"limit. HARD HALT -- manual reset required.",
                detail,
            )

        # 3. Period losses: soft halts that expire on their own.
        if self.state.week_start_equity > 0:
            week_loss = -self.week_pnl(equity) / self.state.week_start_equity
            if week_loss >= self.cfg.weekly_loss_limit_pct:
                self._halt(Breaker.WEEKLY_LOSS, now)
                return GuardVerdict(
                    False, Breaker.WEEKLY_LOSS,
                    f"down {week_loss:.2%} on the week (limit "
                    f"{self.cfg.weekly_loss_limit_pct:.0%}); stopping until Monday",
                    detail,
                )

        if self.state.day_start_equity > 0:
            day_loss = -self.day_pnl(equity) / self.state.day_start_equity
            if day_loss >= self.cfg.daily_loss_limit_pct:
                self._halt(Breaker.DAILY_LOSS, now)
                return GuardVerdict(
                    False, Breaker.DAILY_LOSS,
                    f"down {day_loss:.2%} today (limit "
                    f"{self.cfg.daily_loss_limit_pct:.0%}); stopping until tomorrow",
                    detail,
                )

        if self.state.halted:
            return GuardVerdict(
                False, Breaker(self.state.halt_reason or "none"),
                f"halted: {self.state.halt_reason}", detail,
            )

        return GuardVerdict(True, Breaker.NONE, "clear", detail)

    # ----------------------------------------------------------------- mutate

    def _halt(self, breaker: Breaker, now: datetime) -> None:
        if not self.state.halted:
            log.error("CIRCUIT BREAKER TRIPPED: %s", breaker.value)
        self.state.halted = True
        self.state.halt_reason = breaker.value
        self.state.halted_at = now.isoformat()
        self.save()

    def record_trade_result(self, won: bool) -> None:
        self.state.consecutive_losses = 0 if won else self.state.consecutive_losses + 1
        self.save()

    def engage_kill_switch(self, reason: str = "manual") -> Path:
        self.halt_file.parent.mkdir(parents=True, exist_ok=True)
        self.halt_file.write_text(
            f"{datetime.now(timezone.utc).isoformat()} {reason}\n", encoding="utf-8"
        )
        log.error("KILL SWITCH ENGAGED: %s", reason)
        return self.halt_file

    def release_kill_switch(self) -> bool:
        if self.halt_file.exists():
            self.halt_file.unlink()
            log.warning("kill switch released")
            return True
        return False

    def reset(self, equity: float) -> None:
        """Clear halts and re-baseline. Deliberately manual."""
        now = datetime.now(timezone.utc)
        self.state.halted = False
        self.state.halt_reason = ""
        self.state.halted_at = ""
        self.state.consecutive_losses = 0
        self.state.peak_equity = equity
        self.state.day_start_equity = equity
        self.state.week_start_equity = equity
        self.state.current_day = now.date().isoformat()
        self.state.current_week = week_start(now).date().isoformat()
        self.save()
        log.warning("guards reset; baselines re-anchored to %.2f", equity)
