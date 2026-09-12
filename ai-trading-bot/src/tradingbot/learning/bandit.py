"""Contextual bandit over (strategy, regime).

The question this answers is "which of my strategies is actually working, in
the market I am in right now?" -- and it has to answer it while still finding
out, which is what makes it a bandit problem rather than a ranking problem.

Design notes:

* **Reward is R-multiple, not profit.** A win of $50 on a $10 risk and a win of
  $50 on a $500 risk are very different events; R normalises them so the
  statistics survive changes in account size and volatility.

* **Thompson sampling** over a Normal posterior on the mean R. Uncertainty does
  the exploring for us: a strategy with 5 trades has a wide posterior and gets
  sampled optimistically sometimes; one with 300 trades does not.

* **Exponential discounting** (``decay``) so the estimate tracks a changing
  market instead of averaging over regimes that no longer exist. This is the
  difference between learning and merely accumulating.

* **Context = regime.** Statistics are kept per (strategy, regime) with a
  pooled per-strategy fallback for regimes not yet seen.
"""
from __future__ import annotations

import json
import logging
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

from ..types import Regime

log = logging.getLogger(__name__)

# Prior belief: no edge, with enough spread that a few good trades can move it.
PRIOR_MEAN = 0.0
PRIOR_VAR = 1.0
PRIOR_WEIGHT = 2.0  # pseudo-trades of prior strength


@dataclass(slots=True)
class ArmStats:
    """Discounted sufficient statistics for one (strategy, regime) arm."""

    n: float = 0.0          # effective (discounted) trade count
    sum_r: float = 0.0
    sum_r2: float = 0.0
    raw_count: int = 0      # undiscounted, for the min-trades gate
    wins: int = 0

    @property
    def mean(self) -> float:
        if self.n <= 0:
            return PRIOR_MEAN
        # Shrink toward the prior when evidence is thin.
        w = self.n / (self.n + PRIOR_WEIGHT)
        return w * (self.sum_r / self.n) + (1 - w) * PRIOR_MEAN

    @property
    def variance(self) -> float:
        if self.n <= 1:
            return PRIOR_VAR
        raw_mean = self.sum_r / self.n
        var = max(self.sum_r2 / self.n - raw_mean**2, 1e-6)
        return var

    @property
    def stderr(self) -> float:
        """Standard error of the mean, floored so it never fully collapses."""
        effective = self.n + PRIOR_WEIGHT
        return math.sqrt(max(self.variance, 1e-6) / effective)

    @property
    def win_rate(self) -> float:
        return (self.wins / self.raw_count) if self.raw_count else 0.0

    def update(self, r: float, decay: float) -> None:
        self.n = self.n * decay + 1.0
        self.sum_r = self.sum_r * decay + r
        self.sum_r2 = self.sum_r2 * decay + r * r
        self.raw_count += 1
        if r > 0:
            self.wins += 1

    def to_dict(self) -> dict:
        return {
            "n": self.n, "sum_r": self.sum_r, "sum_r2": self.sum_r2,
            "raw_count": self.raw_count, "wins": self.wins,
        }


@dataclass(slots=True)
class BanditDecision:
    allow: bool
    score: float            # sampled expected R
    mean: float             # posterior mean expected R
    confidence: float       # 0..1 multiplier handed to the risk manager
    exploring: bool
    reason: str
    trades: int = 0


class StrategyBandit:
    def __init__(
        self,
        decay: float = 0.995,
        min_trades: int = 20,
        exploration: float = 0.15,
        seed: int | None = None,
    ) -> None:
        self.decay = decay
        self.min_trades = min_trades
        self.exploration = exploration
        self._rng = random.Random(seed)
        self._arms: dict[tuple[str, str], ArmStats] = {}
        self._pooled: dict[str, ArmStats] = {}

    # -------------------------------------------------------------- accessors

    def arm(self, strategy: str, regime: Regime) -> ArmStats:
        return self._arms.setdefault((strategy, regime.value), ArmStats())

    def pooled(self, strategy: str) -> ArmStats:
        return self._pooled.setdefault(strategy, ArmStats())

    # --------------------------------------------------------------- learning

    def update(self, strategy: str, regime: Regime, r_multiple: float) -> None:
        """Fold one closed trade into the statistics.

        Called for every trade the bot closes -- this is the "improves from
        every trade" loop, and it is deliberately the only way statistics move.
        """
        r = max(-5.0, min(5.0, float(r_multiple)))  # clip fat tails
        self.arm(strategy, regime).update(r, self.decay)
        self.pooled(strategy).update(r, self.decay)
        log.debug(
            "bandit update %s/%s r=%.2f -> mean=%.3f n=%.1f",
            strategy, regime.value, r, self.arm(strategy, regime).mean,
            self.arm(strategy, regime).n,
        )

    # -------------------------------------------------------------- selection

    def evaluate(self, strategy: str, regime: Regime) -> BanditDecision:
        """Thompson-sample this arm and decide whether to let the signal through."""
        arm = self.arm(strategy, regime)
        pool = self.pooled(strategy)

        # Blend the regime-specific arm with the pooled one while the former is
        # thin, so a brand-new regime does not throw away everything we know.
        if arm.raw_count < self.min_trades and pool.raw_count > arm.raw_count:
            weight = arm.raw_count / max(self.min_trades, 1)
            mean = weight * arm.mean + (1 - weight) * pool.mean
            stderr = max(arm.stderr, pool.stderr)
            trades = arm.raw_count
        else:
            mean, stderr, trades = arm.mean, arm.stderr, arm.raw_count

        sample = self._rng.gauss(mean, stderr)

        # Warm-up: not enough evidence to judge. Allow, but at reduced size.
        if trades < self.min_trades:
            return BanditDecision(
                allow=True,
                score=sample,
                mean=mean,
                confidence=0.5,
                exploring=True,
                reason=f"warm-up ({trades}/{self.min_trades} trades)",
                trades=trades,
            )

        if sample > 0:
            # Map the posterior mean onto a sizing multiplier. A strategy
            # averaging +0.5R gets full size; a marginal one gets less.
            confidence = float(min(1.0, 0.4 + 1.2 * max(mean, 0.0)))
            return BanditDecision(
                True, sample, mean, confidence, False,
                f"sampled +{sample:.2f}R (mean {mean:+.2f}R over {trades})",
                trades,
            )

        # Losing arm -- but explore occasionally so it can prove it recovered.
        if self._rng.random() < self.exploration:
            return BanditDecision(
                True, sample, mean, 0.35, True,
                f"exploring a weak arm (mean {mean:+.2f}R)", trades,
            )

        return BanditDecision(
            False, sample, mean, 0.0, False,
            f"suppressed: mean {mean:+.2f}R over {trades} trades", trades,
        )

    def leaderboard(self) -> list[dict]:
        rows = []
        for (strategy, regime), a in self._arms.items():
            if a.raw_count == 0:
                continue
            rows.append({
                "strategy": strategy, "regime": regime, "trades": a.raw_count,
                "mean_r": a.mean, "win_rate": a.win_rate,
                "effective_n": a.n, "stderr": a.stderr,
            })
        return sorted(rows, key=lambda d: d["mean_r"], reverse=True)

    # ------------------------------------------------------------ persistence

    def save(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "decay": self.decay,
            "min_trades": self.min_trades,
            "exploration": self.exploration,
            "arms": {f"{s}|{r}": a.to_dict() for (s, r), a in self._arms.items()},
            "pooled": {s: a.to_dict() for s, a in self._pooled.items()},
        }
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(p)

    def load(self, path: str | Path) -> bool:
        p = Path(path)
        if not p.exists():
            return False
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            log.exception("could not read bandit state at %s", p)
            return False
        for key, stats in (d.get("arms") or {}).items():
            strategy, _, regime = key.partition("|")
            self._arms[(strategy, regime)] = ArmStats(**stats)
        for strategy, stats in (d.get("pooled") or {}).items():
            self._pooled[strategy] = ArmStats(**stats)
        log.info("bandit state restored: %d arms", len(self._arms))
        return True

    def rebuild_from_journal(self, journal) -> int:
        """Replay every closed trade to reconstruct statistics from scratch.

        Used after a state file is lost, and by the backtest so learning starts
        from the same place live trading would.
        """
        self._arms.clear()
        self._pooled.clear()
        trades = journal.closed_trades()
        for t in trades:
            self.update(t.strategy, t.regime, t.r_multiple)
        log.info("bandit rebuilt from %d journal trades", len(trades))
        return len(trades)
