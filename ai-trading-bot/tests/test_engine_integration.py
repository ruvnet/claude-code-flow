"""End-to-end test of the live trading loop.

Runs the real TradingEngine against a PaperBroker fed by a scripted price
source. Nothing is mocked inside the engine -- the same code path that will
run against a real MT5 account executes here, which is the only way to know
the wiring actually works.
"""
from __future__ import annotations

import pandas as pd
import pytest

from tradingbot.config import load_config
from tradingbot.data.synthetic import make_bars
from tradingbot.engine import TradingEngine
from tradingbot.execution.paper import PaperBroker
from tradingbot.strategy import registry
from tradingbot.types import Side, SymbolInfo


class ScriptedPriceSource:
    """Replays a fixed history, advancing one bar per `advance()` call."""

    def __init__(self, df: pd.DataFrame, start: int = 400) -> None:
        self.df = df
        self.i = start

    def connect(self) -> bool:
        return True

    def disconnect(self) -> None:
        pass

    def is_connected(self) -> bool:
        return True

    def advance(self, n: int = 1) -> None:
        self.i = min(self.i + n, len(self.df) - 1)

    def bars(self, symbol: str, timeframe: str, count: int) -> pd.DataFrame:
        lo = max(0, self.i - count)
        return self.df.iloc[lo : self.i]

    def tick_price(self, symbol: str, side_for_entry: str) -> float | None:
        close = float(self.df["close"].iloc[self.i])
        half_spread = 0.00007
        return close + (half_spread if side_for_entry == Side.BUY.value else -half_spread)

    def symbol_info(self, symbol: str) -> SymbolInfo:
        return SymbolInfo(
            name=symbol, digits=5, point=1e-5, tick_size=1e-5, tick_value=1.0,
            contract_size=100_000, volume_min=0.01, volume_max=100.0,
            volume_step=0.01, stops_level_points=10.0, spread_points=14.0,
        )

    def spread_points(self, symbol: str) -> float:
        return 14.0


@pytest.fixture
def engine(tmp_path):
    cfg = load_config()
    cfg = cfg.model_copy(
        update={
            "ops": cfg.ops.model_copy(
                update={
                    "db_path": str(tmp_path / "j.db"),
                    "state_path": str(tmp_path / "state.json"),
                    "log_dir": str(tmp_path / "logs"),
                }
            ),
            # One symbol keeps the test fast and deterministic.
            "symbols": [s for s in cfg.symbols if s.name == "EURUSD"],
        }
    )
    source = ScriptedPriceSource(make_bars(3000, regime_switching=True, seed=21))
    broker = PaperBroker(
        source, starting_balance=200_000.0,
        state_path=tmp_path / "paper.json",
    )
    eng = TradingEngine(cfg, broker, registry.build(cfg.strategies))
    eng.source = source
    return eng


class TestEngineLoop:
    def test_starts_cleanly(self, engine):
        engine.start()
        assert engine.broker.is_connected()
        status = engine.status()
        assert status["mode"] == "paper"
        assert status["equity"] == pytest.approx(200_000.0)
        assert status["can_trade"]

    def test_runs_many_cycles_without_error(self, engine):
        """The real proof: drive the loop and confirm it trades and settles."""
        engine.start()
        for _ in range(600):
            engine.run_cycle()
            engine.source.advance()

        assert engine.stats.errors == 0
        assert engine.stats.cycles == 600
        assert engine.stats.signals_seen > 0, "no strategy ever fired"
        assert engine.stats.orders_placed > 0, "nothing was ever executed"
        assert engine.stats.trades_closed > 0, "no trade ever closed"

    def test_learning_loop_actually_closes(self, engine):
        """Closed trades must reach the journal AND the bandit."""
        engine.start()
        for _ in range(600):
            engine.run_cycle()
            engine.source.advance()

        closed = engine.journal.closed_trades()
        assert closed, "journal recorded no closed trades"
        assert engine.bandit.leaderboard(), "bandit learned nothing"

        total_arm_trades = sum(r["trades"] for r in engine.bandit.leaderboard())
        assert total_arm_trades == len(closed)

    def test_respects_risk_cap_end_to_end(self, engine):
        engine.start()
        for _ in range(400):
            engine.run_cycle()
            engine.source.advance()

        cap = engine.cfg.risk.max_risk_per_trade_pct
        info = engine.broker.symbol_info("EURUSD")
        for p in engine.broker.positions():
            assert p.stop_loss is not None, "position opened with no stop"
            risk = abs(p.entry_price - p.stop_loss) * info.money_per_price_unit(
                p.volume
            )
            assert risk / engine.broker.account().equity <= cap * 1.05

    def test_every_position_has_a_stop(self, engine):
        """A naked position is an unbounded loss. Never acceptable."""
        engine.start()
        for _ in range(500):
            engine.run_cycle()
            engine.source.advance()
            for p in engine.broker.positions():
                assert p.stop_loss is not None
                assert p.take_profit is not None

    def test_kill_switch_stops_new_trades(self, engine):
        engine.start()
        for _ in range(200):
            engine.run_cycle()
            engine.source.advance()

        engine.guards.engage_kill_switch("test")
        before = engine.stats.orders_placed
        for _ in range(200):
            engine.run_cycle()
            engine.source.advance()

        assert engine.stats.orders_placed == before
        assert not engine.status()["can_trade"]

    def test_halted_engine_still_manages_open_positions(self, engine):
        """A halt must not mean abandoning trades that are already exposed."""
        engine.start()
        for _ in range(300):
            engine.run_cycle()
            engine.source.advance()

        engine.guards.engage_kill_switch("test")
        for _ in range(100):
            engine.run_cycle()
            engine.source.advance()
        # Positions either closed on their stops/targets or still carry them.
        for p in engine.broker.positions():
            assert p.stop_loss is not None

    def test_survives_a_price_source_outage(self, engine):
        """Brokers disconnect. The loop must not die when quotes stop."""
        engine.start()
        for _ in range(100):
            engine.run_cycle()
            engine.source.advance()

        broken = engine.source.bars

        def no_data(*a, **k):
            return pd.DataFrame()

        engine.source.bars = no_data
        for _ in range(20):
            engine.run_cycle()

        engine.source.bars = broken
        for _ in range(50):
            engine.run_cycle()
            engine.source.advance()

        assert engine.stats.errors == 0

    def test_state_persists_across_restart(self, engine, tmp_path):
        engine.start()
        for _ in range(400):
            engine.run_cycle()
            engine.source.advance()
        closed_before = len(engine.journal.closed_trades())
        engine.stop()

        revived = TradingEngine(
            engine.cfg,
            PaperBroker(
                engine.source, starting_balance=200_000.0,
                state_path=tmp_path / "paper.json",
            ),
            registry.build(engine.cfg.strategies),
        )
        revived.start()
        assert len(revived.journal.closed_trades()) == closed_before
        if closed_before:
            assert revived.bandit.leaderboard(), "learning was lost on restart"
