"""Goal controller: turning "$1000 per week" into a risk decision.

A profit target in dollars is not a strategy. It is only meaningful next to the
balance that has to produce it, and the honest way to handle it is to compute
the weekly return it implies and say plainly whether that number is achievable.

    required_weekly_return = weekly_target / equity

    <= 0.5%/wk   COMFORTABLE   a good systematic book does this
    <= 1.0%/wk   AGGRESSIVE    possible, expect real drawdowns
    <= 2.0%/wk   UNLIKELY      survivorship territory
     > 2.0%/wk   INFEASIBLE    no sustainable edge compounds this fast

The single most important property of this module: **the goal can only scale
risk DOWN.** ``scale`` is clamped to at most 1.0, so falling behind target can
never talk the bot into betting bigger. That is the exact feedback loop that
turns a losing week into a blown account, and it is structurally impossible
here rather than merely discouraged.
"""
from __future__ import annotations

import enum
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from ..config import GoalConfig

log = logging.getLogger(__name__)


class Feasibility(str, enum.Enum):
    COMFORTABLE = "comfortable"
    AGGRESSIVE = "aggressive"
    UNLIKELY = "unlikely"
    INFEASIBLE = "infeasible"

    @property
    def is_realistic(self) -> bool:
        return self in (Feasibility.COMFORTABLE, Feasibility.AGGRESSIVE)


@dataclass(frozen=True, slots=True)
class GoalAssessment:
    equity: float
    weekly_target: float
    required_weekly_return: float
    feasibility: Feasibility
    week_pnl: float
    progress: float                 # 0..1+ toward this week's target
    scale: float                    # risk multiplier, always <= 1.0
    target_hit: bool
    should_trade: bool
    equity_for_comfortable: float
    equity_for_aggressive: float
    note: str

    def summary(self) -> str:
        return (
            f"goal ${self.weekly_target:,.0f}/wk on ${self.equity:,.2f} equity "
            f"= {self.required_weekly_return:.2%}/wk [{self.feasibility.value}] | "
            f"week P&L ${self.week_pnl:,.2f} ({self.progress:.0%}) | "
            f"risk scale {self.scale:.2f}"
        )


def week_start(now: datetime | None = None) -> datetime:
    """Monday 00:00 UTC of the current trading week."""
    now = now or datetime.now(timezone.utc)
    monday = now - timedelta(days=now.weekday())
    return monday.replace(hour=0, minute=0, second=0, microsecond=0)


class GoalController:
    def __init__(self, cfg: GoalConfig) -> None:
        self.cfg = cfg
        self._warned_infeasible = False

    # ------------------------------------------------------------------ maths

    def classify(self, equity: float) -> tuple[float, Feasibility]:
        if equity <= 0:
            return float("inf"), Feasibility.INFEASIBLE
        required = self.cfg.weekly_profit_target / equity
        if required <= self.cfg.comfortable_weekly_return:
            return required, Feasibility.COMFORTABLE
        if required <= self.cfg.aggressive_weekly_return:
            return required, Feasibility.AGGRESSIVE
        if required <= self.cfg.infeasible_weekly_return:
            return required, Feasibility.UNLIKELY
        return required, Feasibility.INFEASIBLE

    def equity_needed(self, weekly_return: float) -> float:
        if weekly_return <= 0:
            return float("inf")
        return self.cfg.weekly_profit_target / weekly_return

    # ------------------------------------------------------------------ logic

    def assess(self, equity: float, week_pnl: float) -> GoalAssessment:
        required, feasibility = self.classify(equity)
        target = self.cfg.weekly_profit_target
        progress = (week_pnl / target) if target > 0 else 0.0
        target_hit = week_pnl >= target > 0

        scale = 1.0
        should_trade = True
        notes: list[str] = []

        if feasibility is Feasibility.INFEASIBLE:
            # Trade at the normal safe size and be explicit that the target is
            # out of reach. Do NOT size up to chase it.
            scale = 1.0
            notes.append(
                f"${target:,.0f}/wk needs {required:.1%} per week on "
                f"${equity:,.2f}. That is not a sustainable rate of return. "
                f"Trading at normal risk; the target will not be met at this "
                f"balance. Fund to ~${self.equity_needed(self.cfg.aggressive_weekly_return):,.0f} "
                f"to make it aggressive-but-possible, or "
                f"~${self.equity_needed(self.cfg.comfortable_weekly_return):,.0f} "
                f"to make it comfortable."
            )
            if not self._warned_infeasible:
                log.warning(notes[-1])
                self._warned_infeasible = True

        elif feasibility is Feasibility.UNLIKELY:
            notes.append(
                f"target needs {required:.2%}/wk -- achievable only in a good "
                f"stretch, not reliably."
            )

        if target_hit:
            if self.cfg.stop_after_target:
                should_trade = False
                notes.append("weekly target reached; standing down until Monday.")
            elif self.cfg.taper_after_target:
                scale = min(scale, self.cfg.taper_factor)
                notes.append(
                    f"weekly target reached; risk tapered to "
                    f"{self.cfg.taper_factor:.0%} to protect the week."
                )

        # Invariant: the goal may lower risk, never raise it.
        scale = max(0.0, min(scale, 1.0))

        return GoalAssessment(
            equity=equity,
            weekly_target=target,
            required_weekly_return=required,
            feasibility=feasibility,
            week_pnl=week_pnl,
            progress=progress,
            scale=scale,
            target_hit=target_hit,
            should_trade=should_trade,
            equity_for_comfortable=self.equity_needed(
                self.cfg.comfortable_weekly_return
            ),
            equity_for_aggressive=self.equity_needed(
                self.cfg.aggressive_weekly_return
            ),
            note=" ".join(notes),
        )

    def reality_check(self, equity: float) -> str:
        """Human-readable feasibility report, used by the CLI and at startup."""
        required, feasibility = self.classify(equity)
        target = self.cfg.weekly_profit_target
        lines = [
            f"Weekly target      : ${target:,.2f}",
            f"Current equity     : ${equity:,.2f}",
            f"Required return    : {required:.2%} per week "
            f"({(1 + required) ** 52 - 1:,.0%} per year compounded)",
            f"Assessment         : {feasibility.value.upper()}",
            "",
            f"Comfortable at     : ${self.equity_needed(self.cfg.comfortable_weekly_return):,.0f} "
            f"equity ({self.cfg.comfortable_weekly_return:.1%}/wk)",
            f"Aggressive at      : ${self.equity_needed(self.cfg.aggressive_weekly_return):,.0f} "
            f"equity ({self.cfg.aggressive_weekly_return:.1%}/wk)",
        ]
        if not feasibility.is_realistic:
            lines += [
                "",
                "The bot will not increase risk to chase this target. It trades",
                "its normal size and reports the shortfall. Sizing up to reach a",
                "dollar figure the account cannot support is how accounts die.",
            ]
        return "\n".join(lines)
