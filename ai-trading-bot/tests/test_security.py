"""Security of the research pipeline.

The research pipeline converts text from the internet into rules that run on a
machine logged into a brokerage account. That makes the expression evaluator a
genuine attack surface rather than a theoretical one, so these tests are
adversarial by design.

If any test in this file starts failing, stop using the research pipeline until
it passes again.
"""
from __future__ import annotations

import pytest

from tradingbot.data import features as F
from tradingbot.data.synthetic import make_bars
from tradingbot.research.ingest import from_text
from tradingbot.research.safe_expr import (
    UnsafeExpression,
    evaluate,
    validate,
)
from tradingbot.research.spec import StrategySpec


@pytest.fixture(scope="module")
def frame():
    return F.build(make_bars(400, seed=5))


@pytest.fixture(scope="module")
def columns(frame):
    return set(frame.columns)


# Each of these would be a real compromise if the evaluator used eval().
ATTACKS = [
    "__import__('os').system('calc')",
    "().__class__.__bases__[0].__subclasses__()",
    "open('secrets.txt').read()",
    "exec('import os')",
    "eval('1+1')",
    "compile('x','y','exec')",
    "close.__class__.__mro__",
    "close.to_csv('exfiltrate.csv')",
    "getattr(close, 'values')",
    "globals()",
    "locals()",
    "vars()",
    "[x for x in range(10)]",
    "{k: v for k, v in []}",
    "lambda: 1",
    "close if True else close",
    "'a string'",
    "f'{close}'",
    "close[0]",
    "_private > 1",
    "__builtins__",
    "close.rolling(5).apply(print)",
]


class TestExpressionSandbox:
    @pytest.mark.parametrize("attack", ATTACKS)
    def test_attack_is_blocked(self, attack, columns):
        with pytest.raises((UnsafeExpression, Exception)):
            validate(attack, columns)

    @pytest.mark.parametrize("attack", ATTACKS)
    def test_attack_never_evaluates(self, attack, frame):
        """Belt and braces: even via the public entry point."""
        with pytest.raises(Exception):
            evaluate(attack, frame)

    @pytest.mark.parametrize(
        "expression",
        [
            "rsi < 30",
            "close > ema_trend and adx > 25",
            "crossed_above(ema_fast, ema_slow)",
            "crossed_below(rsi, 70)",
            "high >= highest(high, 20)",
            "low <= lowest(low, 20)",
            "abs(macd_hist) > atr * 0.5",
            "not (adx < 20)",
            "rising(close, 3)",
            "falling(close, 2) and rsi > 50",
            "(close - ema_slow) / atr > 1.5",
            "bb_pos > 0.9 or bb_pos < 0.1",
        ],
    )
    def test_legitimate_expression_works(self, expression, frame):
        result = evaluate(expression, frame)
        assert len(result) == len(frame)
        assert result.dtype == bool

    def test_unknown_identifier_rejected(self, columns):
        with pytest.raises(UnsafeExpression, match="unknown identifier"):
            validate("not_a_real_column > 5", columns)

    def test_length_limit(self, columns):
        with pytest.raises(UnsafeExpression, match="limit"):
            validate("rsi < 30 and " * 200 + "rsi < 30", columns)

    def test_complexity_limit(self, columns):
        with pytest.raises(UnsafeExpression):
            validate(" + ".join(["rsi"] * 300) + " > 1", columns)

    def test_empty_expression_rejected(self, columns):
        with pytest.raises(UnsafeExpression):
            validate("   ", columns)

    def test_result_is_causal(self, frame):
        """Truncating the frame must not change earlier values.

        A rule whose past output depends on future bars would look brilliant in
        a backtest and do nothing in live trading.
        """
        expr = "crossed_above(ema_fast, ema_slow) and adx > 20"
        full = evaluate(expr, frame)
        partial = evaluate(expr, frame.iloc[:300])
        assert (full.iloc[:300].values == partial.values).all()


class TestIngestSafety:
    def test_martingale_is_refused_not_merely_unsupported(self):
        r = from_text(
            "Use martingale and double down after every loss. RSI below 30 to "
            "enter.",
            "danger",
        )
        assert r.spec is None
        assert "refus" in r.note.lower() or "martingale" in r.note.lower()

    def test_no_stop_loss_claim_is_flagged(self):
        r = from_text(
            "Buy when RSI drops below 30. No stop loss needed, the market "
            "always comes back.",
            "risky",
        )
        if r.spec is not None:
            assert r.spec.provenance["red_flags"]
            assert r.confidence < 0.5

    def test_implausible_win_rate_lowers_confidence(self):
        honest = from_text("Buy when RSI drops below 30 in a ranging market.", "a")
        hyped = from_text(
            "Buy when RSI drops below 30. This has a 98% win rate and never "
            "loses.",
            "b",
        )
        assert honest.spec and hyped.spec
        assert hyped.confidence < honest.confidence

    def test_vague_text_produces_nothing(self):
        r = from_text("Trade with the trend and manage risk carefully.", "vague")
        assert r.spec is None

    def test_unrepresentable_concepts_reported_not_guessed(self):
        r = from_text(
            "Wait for a liquidity sweep, then find a fair value gap and an "
            "order block.",
            "smc",
        )
        assert r.spec is None
        assert r.unmatched_hints

    def test_filter_only_side_is_dropped(self):
        """ADX > 25 is a permission slip, not an entry. A leg with no trigger
        would fire on most bars."""
        r = from_text("Only trade when ADX is above 25 in a strong trend.", "f")
        assert r.spec is None

    def test_filters_are_not_mirrored_into_nonsense(self):
        """Mirroring 'ADX > 25' into 'ADX < 25' would silently invert a trend
        filter into a chop filter."""
        r = from_text(
            "Go long when the fast EMA crosses above the slow EMA. Go short "
            "when the fast EMA crosses below the slow EMA. Require ADX above 25.",
            "both",
        )
        assert r.spec is not None
        assert "adx > 25" in r.spec.long_entry
        assert "adx > 25" in r.spec.short_entry
        assert "adx < 25" not in r.spec.short_entry


class TestSpecValidation:
    def test_rejects_unsafe_expression(self):
        spec = StrategySpec(name="evil", long_entry="__import__('os').system('x')")
        assert spec.validate()

    def test_rejects_reward_below_risk(self):
        spec = StrategySpec(
            name="bad_rr", long_entry="rsi < 30",
            stop_atr_mult=3.0, target_atr_mult=1.0,
        )
        problems = spec.validate()
        assert any("target_atr_mult" in p for p in problems)

    def test_rejects_no_entry_condition(self):
        assert StrategySpec(name="empty").validate()

    def test_accepts_a_sound_spec(self):
        spec = StrategySpec(
            name="sound",
            long_entry="crossed_above(rsi, 30) and adx < 20",
            short_entry="crossed_below(rsi, 70) and adx < 20",
            stop_atr_mult=1.5, target_atr_mult=2.5,
        )
        assert spec.validate() == []
        assert spec.build() is not None

    def test_defaults_to_quarantined(self):
        assert StrategySpec(name="x", long_entry="rsi < 30").status == "quarantined"

    def test_contradictory_signal_stands_aside(self, frame):
        """If both legs fire on the same bar, emit nothing rather than guess."""
        spec = StrategySpec(
            name="contradictory",
            long_entry="close > 0", short_entry="close > 0",  # always both
            stop_atr_mult=1.5, target_atr_mult=2.5,
        )
        assert spec.build().evaluate(frame, "EURUSD") is None
