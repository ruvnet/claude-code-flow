"""Learning and backtest integrity.

The backtest tests are the important ones. A backtester that lies is worse than
having none, because it converts "I do not know" into false confidence, and the
usual way it lies is by leaking future information into past decisions.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from tradingbot.backtest.engine import BacktestEngine
from tradingbot.config import load_config
from tradingbot.data import features as F
from tradingbot.data.synthetic import make_bars
from tradingbot.learning.bandit import StrategyBandit
from tradingbot.learning.journal import Journal
from tradingbot.learning.meta_model import MetaModel
from tradingbot.strategy import registry
from tradingbot.types import Regime, Side, Signal, TradeRecord


@pytest.fixture(scope="module")
def cfg():
    return load_config()


# ------------------------------------------------------------------ features


class TestFeatures:
    def test_indicators_are_causal(self):
        """A value at bar i must not change when later bars arrive.

        This is the single property that separates a real backtest from a
        fantasy one.
        """
        df = make_bars(800, seed=3)
        full = F.build(df)
        partial = F.build(df.iloc[:500])
        for col in ("atr", "rsi", "adx", "macd_hist", "ema_trend", "bb_mid"):
            a = full[col].iloc[:500].to_numpy()
            b = partial[col].to_numpy()
            mask = ~(np.isnan(a) | np.isnan(b))
            assert np.allclose(a[mask], b[mask], rtol=1e-9), f"{col} is not causal"

    def test_donchian_excludes_current_bar(self):
        """Including the current bar makes a breakout unfalsifiable."""
        df = make_bars(200, seed=4)
        upper, lower = F.donchian(df, 20)
        assert np.isnan(upper.iloc[19])
        assert upper.iloc[20] == pytest.approx(df["high"].iloc[0:20].max())
        assert lower.iloc[20] == pytest.approx(df["low"].iloc[0:20].min())

    def test_snapshot_has_no_nan(self):
        snap = F.snapshot(F.build(make_bars(500, seed=9)))
        assert snap
        assert not any(np.isnan(v) for v in snap.values())

    def test_regime_classification_is_stable(self):
        df = F.build(make_bars(600, seed=11))
        assert F.classify_regime(df) in set(Regime)


# ------------------------------------------------------------------- bandit


class TestBandit:
    def test_learns_to_suppress_a_losing_strategy(self):
        import random

        rng = random.Random(42)
        b = StrategyBandit(decay=0.995, min_trades=20, exploration=0.15, seed=1)
        truth = {"good": 0.30, "bad": -0.30}
        allowed = {k: 0 for k in truth}

        for _ in range(500):
            for name, edge in truth.items():
                d = b.evaluate(name, Regime.TREND_UP)
                if d.allow:
                    allowed[name] += 1
                    b.update(name, Regime.TREND_UP, rng.gauss(edge, 1.0))

        assert allowed["good"] > allowed["bad"] * 2
        assert b.arm("good", Regime.TREND_UP).mean > b.arm("bad", Regime.TREND_UP).mean

    def test_explores_during_warmup(self):
        b = StrategyBandit(min_trades=20, seed=1)
        d = b.evaluate("brand_new", Regime.RANGE)
        assert d.allow and d.exploring
        assert d.confidence < 1.0  # reduced size while unproven

    def test_keeps_regimes_separate(self):
        b = StrategyBandit(min_trades=5, seed=1)
        for _ in range(40):
            b.update("s", Regime.TREND_UP, 1.0)
            b.update("s", Regime.RANGE, -1.0)
        assert b.arm("s", Regime.TREND_UP).mean > 0
        assert b.arm("s", Regime.RANGE).mean < 0

    def test_decay_favours_recent_evidence(self):
        b = StrategyBandit(decay=0.9, min_trades=5, seed=1)
        for _ in range(50):
            b.update("s", Regime.RANGE, -1.0)
        for _ in range(50):
            b.update("s", Regime.RANGE, 1.0)
        assert b.arm("s", Regime.RANGE).mean > 0  # recent wins dominate

    def test_persistence_roundtrip(self, tmp_path):
        b = StrategyBandit(seed=1)
        for _ in range(30):
            b.update("s", Regime.TREND_UP, 0.5)
        path = tmp_path / "bandit.json"
        b.save(path)

        restored = StrategyBandit(seed=2)
        assert restored.load(path)
        assert restored.arm("s", Regime.TREND_UP).mean == pytest.approx(
            b.arm("s", Regime.TREND_UP).mean
        )

    def test_clips_extreme_rewards(self):
        """One catastrophic outlier must not permanently poison an arm."""
        b = StrategyBandit(min_trades=1, seed=1)
        b.update("s", Regime.RANGE, -1000.0)
        assert b.arm("s", Regime.RANGE).mean > -10.0


# --------------------------------------------------------------- meta-model


def _trades(n: int, learnable: bool, seed: int = 3) -> list[TradeRecord]:
    rng = np.random.default_rng(seed)
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    for i in range(n):
        feats = {c: float(rng.normal()) for c in F.FEATURE_COLUMNS}
        if learnable:
            score = 0.9 * feats["adx"] + 0.7 * feats["ema_spread"]
            win = (score + rng.normal(0, 0.6)) > 0
        else:
            win = rng.random() < 0.5
        out.append(
            TradeRecord(
                ticket=i, symbol="EURUSD", strategy="s", side=Side.BUY,
                volume=0.1, entry_price=1.1, exit_price=1.1, stop_loss=1.09,
                take_profit=1.12, profit=50.0 if win else -50.0,
                opened_at=base + timedelta(hours=i),
                closed_at=base + timedelta(hours=i, minutes=30),
                r_multiple=1.5 if win else -1.0, regime=Regime.TREND_UP,
                features=feats,
            )
        )
    return out


class TestMetaModel:
    def test_refuses_to_install_a_useless_model(self):
        """A filter that has not demonstrated skill must not veto trades.

        Otherwise it is an expensive random number generator sitting between
        the strategies and the market.
        """
        m = MetaModel(min_samples=200)
        report = m.train(_trades(600, learnable=False))
        assert not report.accepted
        assert not m.active
        allow, _, _ = m.gate({}, True, "s", "trend_up")
        assert allow  # gate stays open

    def test_accepts_a_model_with_real_skill(self):
        m = MetaModel(min_samples=200)
        report = m.train(_trades(900, learnable=True))
        assert report.accepted
        assert m.active
        assert report.auc > 0.55

    def test_needs_minimum_samples(self):
        m = MetaModel(min_samples=200)
        assert not m.train(_trades(50, learnable=True)).trained

    def test_size_multiplier_never_exceeds_one(self):
        """The model may shrink a position, never inflate one."""
        m = MetaModel(min_samples=200)
        m.train(_trades(900, learnable=True))
        for p in np.linspace(0, 1, 21):
            assert m.size_multiplier(float(p)) <= 1.0

    def test_handles_single_class_outcomes(self):
        trades = _trades(300, learnable=False)
        for t in trades:
            object.__setattr__(t, "profit", 10.0)  # all winners
        assert not MetaModel(min_samples=200).train(trades).accepted


# ------------------------------------------------------------------ journal


class TestJournal:
    def test_trade_roundtrip(self, tmp_path):
        j = Journal(tmp_path / "j.db")
        sig = Signal("s", "EURUSD", Side.BUY, 0.7, features={"atr": 0.001})
        j.open_trade(1, sig, 0.1, 1.10, 1.095, 1.115, Regime.TREND_UP)
        assert j.open_tickets() == {1}

        j.close_trade(1, 1.115, 150.0, 1.5, "take_profit")
        assert j.open_tickets() == set()

        closed = j.closed_trades()
        assert len(closed) == 1
        assert closed[0].profit == 150.0
        assert closed[0].r_multiple == 1.5
        assert closed[0].features["atr"] == 0.001

    def test_stats(self, tmp_path):
        j = Journal(tmp_path / "j.db")
        sig = Signal("s", "EURUSD", Side.BUY, 0.7)
        for i, profit in enumerate([100.0, -50.0, 200.0, -50.0], start=1):
            j.open_trade(i, sig, 0.1, 1.10, 1.095, 1.115, Regime.RANGE)
            j.close_trade(i, 1.11, profit, profit / 50.0)
        s = j.stats()
        assert s["trades"] == 4
        assert s["wins"] == 2
        assert s["profit_factor"] == pytest.approx(3.0)

    def test_records_rejected_signals(self, tmp_path):
        """Knowing what was declined separates 'filters working' from
        'filters eating the edge'."""
        j = Journal(tmp_path / "j.db")
        sig = Signal("s", "EURUSD", Side.BUY, 0.7)
        j.record_signal(sig, Regime.RANGE, False, "risk: too small")
        j.record_signal(sig, Regime.RANGE, True)
        funnel = j.signal_funnel(days=7)
        assert funnel["signals"] == 2
        assert funnel["accepted"] == 1


# ----------------------------------------------------------------- backtest


class TestBacktestIntegrity:
    @pytest.mark.parametrize("seed", [1, 2, 3])
    def test_random_walk_is_not_profitable(self, cfg, seed):
        """A random walk has no edge. After spread and commission any strategy
        must lose on it. If this ever passes, the backtester is cheating."""
        df = make_bars(6000, seed=seed)
        engine = BacktestEngine(
            cfg, registry.build(cfg.strategies), starting_equity=100_000,
            use_bandit=False,
        )
        result = engine.run(df, "EURUSD", "M15")
        assert result.n_trades > 20
        assert result.net_profit < 0

    def test_costs_are_actually_charged(self, cfg):
        df = make_bars(4000, regime_switching=True, seed=8)
        strategies = registry.build(cfg.strategies)
        free = BacktestEngine(
            cfg, strategies, starting_equity=100_000, spread_points=0.0,
            commission_per_lot=0.0, slippage_points=0.0, use_bandit=False,
        ).run(df, "EURUSD", "M15")
        costly = BacktestEngine(
            cfg, strategies, starting_equity=100_000, spread_points=40.0,
            commission_per_lot=15.0, slippage_points=6.0, use_bandit=False,
        ).run(df, "EURUSD", "M15")
        assert costly.net_profit < free.net_profit

    def test_stop_wins_ties_within_a_bar(self, cfg):
        """When a bar covers both stop and target, the pessimistic assumption
        is that the stop filled. Anything else inflates results."""
        import pandas as pd

        from tradingbot.backtest.engine import BTTrade, synthetic_symbol_info

        engine = BacktestEngine(cfg, [], use_bandit=False)
        info = synthetic_symbol_info("EURUSD", 1.1)
        trade = BTTrade(
            symbol="EURUSD", strategy="s", side=Side.BUY, volume=0.1,
            entry_price=1.1000, entry_time=datetime.now(timezone.utc),
            stop_loss=1.0950, take_profit=1.1050, initial_stop=1.0950,
            regime=Regime.RANGE,
        )
        bar = pd.Series({"high": 1.1100, "low": 1.0900, "close": 1.10})
        price, reason = engine._exit_within_bar(trade, bar, info, 0.0)
        assert reason == "stop_loss"

    def test_equity_curve_and_trades_agree(self, cfg):
        df = make_bars(5000, regime_switching=True, seed=12)
        result = BacktestEngine(
            cfg, registry.build(cfg.strategies), starting_equity=100_000,
            use_bandit=False,
        ).run(df, "EURUSD", "M15")
        total = sum(t.profit for t in result.trades)
        assert result.ending_equity == pytest.approx(
            result.starting_equity + total, rel=1e-6
        )

    def test_no_position_exceeds_risk_cap(self, cfg):
        """End-to-end: sizing discipline must hold across a whole backtest."""
        df = make_bars(6000, regime_switching=True, seed=15)
        result = BacktestEngine(
            cfg, registry.build(cfg.strategies), starting_equity=100_000,
            use_bandit=False,
        ).run(df, "EURUSD", "M15")
        from tradingbot.backtest.engine import synthetic_symbol_info

        info = synthetic_symbol_info("EURUSD", 1.1)
        for t in result.trades:
            risk = abs(t.entry_price - t.initial_stop) * info.money_per_price_unit(
                t.volume
            )
            assert risk / 100_000 <= cfg.risk.max_risk_per_trade_pct * 1.05
