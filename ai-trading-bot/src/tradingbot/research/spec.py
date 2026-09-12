"""Declarative strategy specs.

A ``StrategySpec`` is the machine-readable form of "here is a trading strategy"
-- the thing an article, a forum post, or a video description gets distilled
*into* before the bot will consider it. Specs are plain data (YAML/JSON), so
they can be diffed, reviewed, version-controlled and rejected.

The important property: a spec is inert. Turning one into a live strategy
requires (a) passing safe_expr validation, and (b) clearing the full research
gauntlet. Writing a spec file does not put anything near your money.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from ..data import features as F
from ..strategy.base import Strategy
from ..types import Regime, Side, Signal
from .safe_expr import UnsafeExpression, evaluate, validate

log = logging.getLogger(__name__)


@dataclass
class StrategySpec:
    """A strategy described as data."""

    name: str
    long_entry: str = ""
    short_entry: str = ""
    description: str = ""
    source: str = ""              # where this came from -- provenance matters
    author: str = ""
    stop_atr_mult: float = 1.8
    target_atr_mult: float = 2.7
    confidence: float = 0.5
    preferred_regimes: list[str] = field(default_factory=list)
    min_bars: int = 250
    tags: list[str] = field(default_factory=list)
    status: str = "quarantined"   # quarantined -> validated -> paper -> live
    notes: str = ""
    provenance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "source": self.source,
            "author": self.author,
            "long_entry": self.long_entry,
            "short_entry": self.short_entry,
            "stop_atr_mult": self.stop_atr_mult,
            "target_atr_mult": self.target_atr_mult,
            "confidence": self.confidence,
            "preferred_regimes": self.preferred_regimes,
            "min_bars": self.min_bars,
            "tags": self.tags,
            "status": self.status,
            "notes": self.notes,
            "provenance": self.provenance,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "StrategySpec":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in d.items() if k in known})

    @classmethod
    def load(cls, path: str | Path) -> "StrategySpec":
        p = Path(path)
        raw = p.read_text(encoding="utf-8")
        data = json.loads(raw) if p.suffix == ".json" else yaml.safe_load(raw)
        return cls.from_dict(data or {})

    def save(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        if p.suffix == ".json":
            p.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        else:
            p.write_text(
                yaml.safe_dump(self.to_dict(), sort_keys=False), encoding="utf-8"
            )

    # ------------------------------------------------------------- validation

    def validate(self, columns: set[str] | None = None) -> list[str]:
        """Return a list of problems. Empty means structurally sound.

        Note this checks that the spec is *safe and well-formed*, not that it
        is *profitable*. Only the gauntlet can speak to that.
        """
        problems: list[str] = []
        cols = columns or set(F.FEATURE_COLUMNS) | {
            "open", "high", "low", "close", "volume", "spread",
            "ema_fast", "ema_slow", "ema_trend", "bb_upper", "bb_mid",
            "bb_lower", "macd", "macd_signal", "atr", "rsi", "adx",
        }

        if not self.name or not self.name.replace("_", "").isalnum():
            problems.append("name must be alphanumeric/underscore")
        if not self.long_entry and not self.short_entry:
            problems.append("at least one of long_entry/short_entry is required")

        for label, expr in (("long_entry", self.long_entry),
                            ("short_entry", self.short_entry)):
            if not expr:
                continue
            try:
                validate(expr, cols)
            except UnsafeExpression as exc:
                problems.append(f"{label}: {exc}")

        if self.stop_atr_mult <= 0:
            problems.append("stop_atr_mult must be positive")
        if self.target_atr_mult <= self.stop_atr_mult:
            problems.append(
                "target_atr_mult must exceed stop_atr_mult: a sub-1R reward "
                "needs a win rate above 50% just to break even"
            )
        if not 0.0 <= self.confidence <= 1.0:
            problems.append("confidence must be in [0, 1]")
        for r in self.preferred_regimes:
            if r not in {x.value for x in Regime}:
                problems.append(f"unknown regime: {r}")
        return problems

    def build(self) -> "SpecStrategy":
        problems = self.validate()
        if problems:
            raise ValueError(f"invalid spec {self.name}: {'; '.join(problems)}")
        return SpecStrategy(self)


class SpecStrategy(Strategy):
    """Runs a StrategySpec. Behaves exactly like a hand-written strategy."""

    def __init__(self, spec: StrategySpec) -> None:
        self.spec = spec
        self.name = spec.name
        self.min_bars = spec.min_bars
        self.preferred_regimes = tuple(
            Regime(r) for r in spec.preferred_regimes if r in {x.value for x in Regime}
        )
        super().__init__({})
        self._cache_key: int | None = None
        self._long: pd.Series | None = None
        self._short: pd.Series | None = None

    def _signals_for(self, df: pd.DataFrame) -> tuple[pd.Series | None, pd.Series | None]:
        # Vectorised evaluation is cached per frame identity so a bar-by-bar
        # backtest does not re-evaluate the whole history on every bar.
        key = (id(df), len(df))
        if self._cache_key == hash(key):
            return self._long, self._short
        long_s = short_s = None
        try:
            if self.spec.long_entry:
                long_s = evaluate(self.spec.long_entry, df)
            if self.spec.short_entry:
                short_s = evaluate(self.spec.short_entry, df)
        except Exception:
            log.exception("spec %s failed to evaluate; disabling", self.name)
            self.enabled = False
            return None, None
        self._cache_key = hash(key)
        self._long, self._short = long_s, short_s
        return long_s, short_s

    def evaluate(self, df: pd.DataFrame, symbol: str) -> Signal | None:
        if not self.enabled or not self.ready(df):
            return None
        long_s, short_s = self._signals_for(df)
        if long_s is None and short_s is None:
            return None

        i = len(df) - 1
        go_long = bool(long_s.iloc[i]) if long_s is not None else False
        go_short = bool(short_s.iloc[i]) if short_s is not None else False

        if go_long and go_short:
            return None  # contradictory: stand aside rather than guess
        if not go_long and not go_short:
            return None

        side = Side.BUY if go_long else Side.SELL
        return self._signal(
            symbol, side, self.spec.confidence, df,
            f"[spec:{self.name}] "
            f"{self.spec.long_entry if go_long else self.spec.short_entry}",
            stop_atr_mult=self.spec.stop_atr_mult,
            target_atr_mult=self.spec.target_atr_mult,
        )


def load_specs(directory: str | Path, status: str | None = None) -> list[StrategySpec]:
    """Load every spec in a directory, optionally filtered by status."""
    d = Path(directory)
    if not d.exists():
        return []
    out: list[StrategySpec] = []
    for p in sorted([*d.glob("*.yaml"), *d.glob("*.yml"), *d.glob("*.json")]):
        try:
            spec = StrategySpec.load(p)
            if status is None or spec.status == status:
                out.append(spec)
        except Exception:
            log.exception("could not load spec %s", p)
    return out
