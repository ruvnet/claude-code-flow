"""Risk invariants.

These are the tests that matter most. A bug in a strategy costs you a bad
trade; a bug here costs you the account. Every test in this file asserts a
property that must hold for *all* inputs, not just typical ones.
"""
from __future__ import annotations

import pytest

from tradingbot.config import load_config
from tradingbot.goal.controller import Feasibility, GoalController
from tradingbot.risk.guards import Breaker, RiskGuards
from tradingbot.risk.manager import RiskManager
from tradingbot.types import AccountState, Position, Side, Signal, SymbolInfo


@pytest.fixture
def cfg():
    return load_config()


@pytest.fixture
def eurusd():
    return SymbolInfo(
        name="EURUSD", digits=5, point=1e-5, tick_size=1e-5, tick_value=1.0,
        contract_size=100_000, volume_min=0.01, volume_max=100.0,
        volume_step=0.01, stops_level_points=10.0, spread_points=12.0,
    )


def account(equity: float) -> AccountState:
    return AccountState(equity, equity, 0.0, equity, "USD", 500)


def signal(side=Side.BUY, confidence=0.7, **kw) -> Signal:
    return Signal("test_strategy", "EURUSD", side, confidence, **kw)


# ------------------------------------------------------------------- sizing


class TestPositionSizing:
    def test_dollar_risk_is_invariant_to_volatility(self, cfg, eurusd):
        """The whole point of risk-first sizing: a wider stop buys a smaller
        position so the loss on a stop-out is the same number either way."""
        rm = RiskManager(cfg.risk)
        risks = []
        for atr in (0.0003, 0.0008, 0.0015, 0.0030):
            d = rm.size(signal(), eurusd, 1.10, atr, account(100_000), [])
            assert d.approved, d.reason
            risks.append(d.risk_amount)
        assert max(risks) - min(risks) < max(risks) * 0.05

    @pytest.mark.parametrize("equity", [10_000, 50_000, 250_000, 1_000_000])
    @pytest.mark.parametrize("atr", [0.0002, 0.0009, 0.004])
    @pytest.mark.parametrize("goal_scale", [0.0, 0.4, 1.0])
    @pytest.mark.parametrize("conf", [0.1, 0.5, 1.0])
    def test_never_exceeds_per_trade_ceiling(
        self, cfg, eurusd, equity, atr, goal_scale, conf
    ):
        """No combination of inputs may breach the per-trade risk cap."""
        rm = RiskManager(cfg.risk)
        d = rm.size(
            signal(), eurusd, 1.10, atr, account(equity), [],
            goal_scale=goal_scale, confidence_scale=conf,
        )
        if d.approved:
            assert d.risk_pct <= cfg.risk.max_risk_per_trade_pct * 1.001

    def test_rejects_when_min_lot_would_breach_cap(self, cfg, eurusd):
        """A tiny account must be refused, not silently over-risked."""
        rm = RiskManager(cfg.risk)
        d = rm.size(signal(), eurusd, 1.10, 0.02, account(200), [])
        assert not d.approved
        assert "minimum" in d.reason.lower() or "ceiling" in d.reason.lower()

    def test_target_always_beats_stop(self, cfg, eurusd):
        """Reward must exceed risk, even if a strategy asks otherwise."""
        rm = RiskManager(cfg.risk)
        d = rm.size(
            signal(stop_atr_mult=3.0, target_atr_mult=1.0),  # inverted on purpose
            eurusd, 1.10, 0.001, account(100_000), [],
        )
        assert d.approved
        assert abs(d.take_profit - 1.10) > abs(1.10 - d.stop_loss)

    def test_stop_on_correct_side(self, cfg, eurusd):
        rm = RiskManager(cfg.risk)
        long_d = rm.size(signal(Side.BUY), eurusd, 1.10, 0.001, account(100_000), [])
        short_d = rm.size(signal(Side.SELL), eurusd, 1.10, 0.001, account(100_000), [])
        assert long_d.stop_loss < 1.10 < long_d.take_profit
        assert short_d.take_profit < 1.10 < short_d.stop_loss

    def test_zero_and_negative_inputs_rejected(self, cfg, eurusd):
        rm = RiskManager(cfg.risk)
        assert not rm.size(signal(), eurusd, 1.10, 0.0, account(100_000), []).approved
        assert not rm.size(signal(), eurusd, 0.0, 0.001, account(100_000), []).approved
        assert not rm.size(signal(), eurusd, 1.10, 0.001, account(0), []).approved


# ---------------------------------------------------------------- portfolio


class TestPortfolioLimits:
    def _position(self, symbol="EURUSD", side=Side.BUY, entry=1.10, stop=1.095):
        from datetime import datetime, timezone

        return Position(
            ticket=1, symbol=symbol, side=side, volume=0.5, entry_price=entry,
            stop_loss=stop, take_profit=1.11, profit=0.0,
            opened_at=datetime.now(timezone.utc), initial_stop=stop,
        )

    def test_blocks_second_position_in_same_symbol(self, cfg, eurusd):
        rm = RiskManager(cfg.risk)
        d = rm.size(signal(), eurusd, 1.10, 0.001, account(100_000),
                    [self._position()])
        assert not d.approved
        assert "EURUSD" in d.reason

    def test_blocks_at_max_positions(self, cfg, eurusd):
        rm = RiskManager(cfg.risk)
        others = [
            self._position(symbol=f"PAIR{i}") for i in range(cfg.risk.max_positions)
        ]
        d = rm.size(signal(), eurusd, 1.10, 0.001, account(100_000), others)
        assert not d.approved
        assert "max positions" in d.reason

    def test_breakeven_stop_contributes_no_risk(self, cfg):
        """A position whose stop is at entry cannot lose, so it must not
        consume portfolio risk budget."""
        rm = RiskManager(cfg.risk)
        at_risk = rm.open_risk([self._position(stop=1.095)], 100_000)
        breakeven = rm.open_risk([self._position(stop=1.10)], 100_000)
        assert at_risk > 0
        assert breakeven == 0.0

    def test_unprotected_position_counts_as_full_risk(self, cfg):
        rm = RiskManager(cfg.risk)
        p = self._position()
        p.stop_loss = None
        assert rm.open_risk([p], 100_000) == cfg.risk.max_risk_per_trade_pct


# --------------------------------------------------------- trade management


class TestTradeManagement:
    def _position(self, side=Side.BUY, entry=1.10, stop=1.095):
        from datetime import datetime, timezone

        return Position(
            ticket=1, symbol="EURUSD", side=side, volume=0.5, entry_price=entry,
            stop_loss=stop, take_profit=1.115, profit=0.0,
            opened_at=datetime.now(timezone.utc), initial_stop=stop,
        )

    def test_no_move_before_one_r(self, cfg):
        rm = RiskManager(cfg.risk)
        new_stop, _ = rm.manage(self._position(), 1.1020, 0.001)  # ~0.4R
        assert new_stop is None

    def test_moves_to_at_least_breakeven_at_one_r(self, cfg):
        rm = RiskManager(cfg.risk)
        p = self._position()
        new_stop, reason = rm.manage(p, 1.1050, 0.001)  # 1R
        assert new_stop is not None
        assert new_stop >= p.entry_price
        assert reason

    def test_stop_never_moves_backwards(self, cfg):
        """Trailing must be monotonic or a winner can turn into a loser."""
        rm = RiskManager(cfg.risk)
        p = self._position()
        p.stop_loss = 1.104  # already trailed up
        new_stop, _ = rm.manage(p, 1.1055, 0.001)
        assert new_stop is None or new_stop >= p.stop_loss

    def test_short_side_trails_downward(self, cfg):
        rm = RiskManager(cfg.risk)
        p = self._position(side=Side.SELL, entry=1.10, stop=1.105)
        new_stop, _ = rm.manage(p, 1.0950, 0.001)  # 1R in profit
        assert new_stop is not None
        assert new_stop <= p.entry_price


# --------------------------------------------------------------------- goal


class TestGoalController:
    def test_feasibility_bands(self, cfg):
        gc = GoalController(cfg.goal)
        assert gc.classify(500_000)[1] is Feasibility.COMFORTABLE
        assert gc.classify(120_000)[1] is Feasibility.AGGRESSIVE
        assert gc.classify(60_000)[1] is Feasibility.UNLIKELY
        assert gc.classify(5_000)[1] is Feasibility.INFEASIBLE

    @pytest.mark.parametrize("equity", [100, 1_000, 10_000, 100_000, 10_000_000])
    @pytest.mark.parametrize("week_pnl", [-50_000, -1_000, 0, 500, 50_000])
    def test_scale_never_exceeds_one(self, cfg, equity, week_pnl):
        """THE invariant: being behind target must never increase risk.

        This is the feedback loop that turns a bad week into a blown account,
        and it has to be impossible rather than merely discouraged.
        """
        gc = GoalController(cfg.goal)
        assert 0.0 <= gc.assess(equity, week_pnl).scale <= 1.0

    def test_infeasible_target_does_not_scale_up(self, cfg):
        gc = GoalController(cfg.goal)
        a = gc.assess(2_000, 0.0)   # needs 50%/week
        assert a.feasibility is Feasibility.INFEASIBLE
        assert a.scale <= 1.0
        assert "not a sustainable" in a.note

    def test_tapers_after_hitting_target(self, cfg):
        gc = GoalController(cfg.goal)
        a = gc.assess(300_000, cfg.goal.weekly_profit_target + 1)
        assert a.target_hit
        assert a.scale <= cfg.goal.taper_factor

    def test_zero_equity_is_infeasible_not_a_crash(self, cfg):
        gc = GoalController(cfg.goal)
        assert gc.classify(0)[1] is Feasibility.INFEASIBLE


# ------------------------------------------------------------------- guards


class TestGuards:
    def test_daily_loss_trips_and_clears_next_day(self, cfg, tmp_path):
        g = RiskGuards(cfg.risk, tmp_path / "state.json")
        g.reset(100_000)
        assert g.check(100_000).can_trade

        loss = 100_000 * (cfg.risk.daily_loss_limit_pct + 0.005)
        v = g.check(100_000 - loss)
        assert not v.can_trade
        assert v.breaker is Breaker.DAILY_LOSS

        from datetime import datetime, timedelta, timezone

        tomorrow = datetime.now(timezone.utc) + timedelta(days=1)
        assert g.check(100_000 - loss, now=tomorrow).can_trade

    def test_drawdown_halt_does_not_auto_clear(self, cfg, tmp_path):
        """A 15% drawdown means the model of the world is wrong. Only a human
        should decide that it is safe to continue."""
        g = RiskGuards(cfg.risk, tmp_path / "state.json")
        g.reset(100_000)
        crashed = 100_000 * (1 - cfg.risk.max_drawdown_pct - 0.01)
        assert not g.check(crashed).can_trade

        from datetime import datetime, timedelta, timezone

        much_later = datetime.now(timezone.utc) + timedelta(days=30)
        v = g.check(crashed, now=much_later)
        assert not v.can_trade
        assert v.breaker is Breaker.MAX_DRAWDOWN

        g.reset(crashed)
        assert g.check(crashed).can_trade

    def test_kill_switch_beats_everything(self, cfg, tmp_path):
        g = RiskGuards(cfg.risk, tmp_path / "state.json")
        g.reset(100_000)
        g.engage_kill_switch("test")
        v = g.check(100_000)
        assert not v.can_trade
        assert v.breaker is Breaker.KILL_SWITCH
        g.release_kill_switch()
        assert g.check(100_000).can_trade

    def test_state_survives_restart(self, cfg, tmp_path):
        """A crash loop must not be a way to reset the daily loss limit."""
        path = tmp_path / "state.json"
        g1 = RiskGuards(cfg.risk, path)
        g1.reset(100_000)
        g1.check(100_000 * (1 - cfg.risk.daily_loss_limit_pct - 0.01))

        g2 = RiskGuards(cfg.risk, path)
        assert g2.state.halted
        assert not g2.check(90_000).can_trade


class TestConfigInvariants:
    def test_rejects_base_risk_above_ceiling(self):
        from tradingbot.config import Config

        with pytest.raises(ValueError, match="max_risk_per_trade_pct"):
            Config.model_validate(
                {"risk": {"base_risk_per_trade_pct": 0.05,
                          "max_risk_per_trade_pct": 0.01}}
            )

    def test_rejects_live_without_second_key(self):
        from tradingbot.config import Config

        with pytest.raises(ValueError, match="allow_live"):
            Config.model_validate(
                {"execution": {"mode": "live", "allow_live": False}}
            )

    def test_rejects_target_below_stop(self):
        from tradingbot.config import Config

        with pytest.raises(ValueError, match="target_atr_mult"):
            Config.model_validate(
                {"risk": {"default_stop_atr_mult": 3.0,
                          "default_target_atr_mult": 2.0}}
            )
