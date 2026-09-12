"""The trading loop.

One pass over every enabled symbol, forever. The order of operations matters
and is the same every cycle:

    1. guards      -- may we trade at all? (drawdown, daily loss, kill switch)
    2. reconcile   -- what closed since last pass? feed those outcomes to the
                      learners BEFORE deciding anything new
    3. manage      -- trail stops and move to breakeven on open positions
    4. scan        -- strategies propose, bandit filters, meta-model filters,
                      risk manager sizes, executor places
    5. learn       -- retrain the meta-model when enough new trades exist

Reconciliation happens before scanning on purpose: the bot should always act on
the most recent information about its own results, and a trade that closed
badly thirty seconds ago should be able to influence the next entry.

Nothing in this file decides *how much* to risk. That authority sits entirely
with RiskManager, and this loop can only ask.
"""
from __future__ import annotations

import logging
import signal
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import numpy as np

from .broker import BrokerError
from .config import Config
from .data import features as F
from .goal.controller import GoalController
from .learning.bandit import StrategyBandit
from .learning.journal import Journal
from .learning.meta_model import MetaModel
from .risk.guards import RiskGuards
from .risk.manager import RiskManager
from .strategy import registry
from .strategy.base import Strategy
from .types import Position, Regime, Signal

log = logging.getLogger(__name__)


@dataclass
class CycleStats:
    cycles: int = 0
    signals_seen: int = 0
    signals_taken: int = 0
    orders_placed: int = 0
    orders_failed: int = 0
    trades_closed: int = 0
    errors: int = 0
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_cycle_at: datetime | None = None

    @property
    def uptime(self) -> timedelta:
        return datetime.now(timezone.utc) - self.started_at


class TradingEngine:
    def __init__(self, cfg: Config, broker, strategies: list[Strategy] | None = None):
        self.cfg = cfg
        self.broker = broker
        self.strategies = strategies or registry.build(cfg.strategies)

        self.journal = Journal(cfg.path("db_path"))
        self.risk = RiskManager(cfg.risk)
        self.guards = RiskGuards(cfg.risk, cfg.path("state_path"))
        self.goal = GoalController(cfg.goal)

        var_dir = cfg.path("state_path").parent
        self.bandit_path = var_dir / "bandit.json"
        self.model_path = var_dir / "meta_model.pkl"

        self.bandit = StrategyBandit(
            cfg.learning.bandit_decay,
            cfg.learning.bandit_min_trades,
            cfg.learning.bandit_exploration,
        )
        self.meta = MetaModel(
            cfg.learning.meta_model_min_samples,
            cfg.learning.meta_model_gate_threshold,
        )

        self.stats = CycleStats()
        self._running = False
        self._trades_since_retrain = 0
        self._known_tickets: set[int] = set()
        self._position_meta: dict[int, dict] = {}

    # ------------------------------------------------------------------ setup

    def start(self) -> None:
        log.info("=" * 68)
        log.info("Trading engine starting in %s mode", self.cfg.execution.mode.upper())
        log.info("=" * 68)

        if not self.broker.connect():
            raise BrokerError("broker connection failed")

        # Restore learning state, rebuilding from the journal if files are gone.
        if not self.bandit.load(self.bandit_path):
            n = self.bandit.rebuild_from_journal(self.journal)
            log.info("bandit cold start; rebuilt from %d journal trades", n)
        if self.cfg.learning.meta_model_enabled:
            if not self.meta.load(self.model_path):
                self._retrain(force=True)

        account = self.broker.account()
        log.info(
            "account: balance %.2f %s | equity %.2f",
            account.balance, account.currency, account.equity,
        )

        if self.guards.state.peak_equity <= 0:
            self.guards.reset(account.equity)

        log.info("\n%s", self.goal.reality_check(account.equity))

        verdict = self.guards.check(account.equity)
        if not verdict.can_trade:
            log.warning("starting HALTED: %s", verdict.message)

        self._known_tickets = {p.ticket for p in self.broker.positions()}
        self._running = True
        self.journal.event("engine_start", f"mode={self.cfg.execution.mode}")

    def stop(self) -> None:
        self._running = False
        log.info("shutting down")
        if self.cfg.execution.close_on_shutdown:
            for p in self.broker.positions():
                log.info("closing %s on shutdown", p.ticket)
                self.broker.close(p.ticket, "shutdown")
        self.bandit.save(self.bandit_path)
        if self.meta.active:
            self.meta.save(self.model_path)
        self.guards.save()
        self.journal.event(
            "engine_stop",
            f"cycles={self.stats.cycles} orders={self.stats.orders_placed}",
        )
        self.broker.disconnect()

    def install_signal_handlers(self) -> None:
        def handler(signum, _frame):
            log.warning("signal %s received; stopping after this cycle", signum)
            self._running = False

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):  # not in main thread
                pass

    # ------------------------------------------------------------------- loop

    def run_forever(self) -> None:
        self.start()
        self.install_signal_handlers()
        try:
            while self._running:
                started = time.monotonic()
                try:
                    self.run_cycle()
                except BrokerError:
                    self.stats.errors += 1
                    log.exception("broker error; retrying next cycle")
                    time.sleep(5)
                except Exception:
                    self.stats.errors += 1
                    log.exception("unexpected error in cycle")
                    self.journal.event("cycle_error", "see logs", level="ERROR")
                    time.sleep(5)

                elapsed = time.monotonic() - started
                time.sleep(max(0.0, self.cfg.execution.poll_seconds - elapsed))
        finally:
            self.stop()

    def run_cycle(self) -> None:
        self.stats.cycles += 1
        self.stats.last_cycle_at = datetime.now(timezone.utc)

        # Paper mode has to fill its own stops and targets.
        if hasattr(self.broker, "check_exits"):
            self.broker.check_exits()

        account = self.broker.account()
        positions = self.broker.positions()
        self.journal.record_equity(account.equity, account.balance, len(positions))

        # --- 1. guards -------------------------------------------------------
        verdict = self.guards.check(account.equity)

        # --- 2. reconcile closed trades and learn from them -------------------
        self._reconcile(positions, account.equity)

        if not verdict.can_trade:
            if self.stats.cycles % 20 == 1:
                log.warning("not trading: %s", verdict.message)
            # Keep managing open positions even while halted -- a halt must not
            # mean abandoning trades that are already exposed.
            self._manage_positions(positions)
            return

        # --- 3. goal ---------------------------------------------------------
        week_pnl = self.guards.week_pnl(account.equity)
        assessment = self.goal.assess(account.equity, week_pnl)
        if self.stats.cycles % 40 == 1:
            log.info(assessment.summary())
        if not assessment.should_trade:
            self._manage_positions(positions)
            return

        # --- 4. manage then scan ---------------------------------------------
        self._manage_positions(positions)
        for sym_cfg in self.cfg.enabled_symbols:
            try:
                self._scan_symbol(sym_cfg, account, assessment.scale)
            except Exception:
                self.stats.errors += 1
                log.exception("error scanning %s", sym_cfg.name)

        # --- 5. periodic retrain ---------------------------------------------
        if (
            self.cfg.learning.meta_model_enabled
            and self._trades_since_retrain >= self.cfg.learning.meta_model_retrain_every
        ):
            self._retrain()

    # -------------------------------------------------------------- reconcile

    def _reconcile(self, positions: list[Position], equity: float) -> None:
        """Detect positions that closed since the last cycle and learn."""
        live = {p.ticket for p in positions}
        closed = self._known_tickets - live
        self._known_tickets = live

        for ticket in closed:
            meta = self._position_meta.pop(ticket, {})
            profit = meta.get("last_profit", 0.0)
            risk = meta.get("risk_amount", 0.0)
            strategy = meta.get("strategy", "unknown")
            regime = Regime(meta.get("regime", "unknown"))
            r_multiple = (profit / risk) if risk > 0 else 0.0

            self.journal.close_trade(
                ticket, meta.get("last_price", 0.0), profit, r_multiple,
                meta.get("exit_reason", "closed"),
            )
            if self.cfg.learning.enabled:
                self.bandit.update(strategy, regime, r_multiple)
            self.guards.record_trade_result(profit > 0)

            self.stats.trades_closed += 1
            self._trades_since_retrain += 1
            log.info(
                "trade closed: ticket=%s strategy=%s P&L=%+.2f (%.2fR)",
                ticket, strategy, profit, r_multiple,
            )

        if closed:
            self.bandit.save(self.bandit_path)

        # Refresh cached P&L so the next reconcile has an accurate final figure.
        for p in positions:
            m = self._position_meta.setdefault(p.ticket, {})
            m["last_profit"] = p.profit
            m.setdefault("strategy", p.strategy or "unknown")
            if p.stop_loss is not None and "risk_amount" not in m:
                info = self.broker.symbol_info(p.symbol)
                if info:
                    m["risk_amount"] = (
                        abs(p.entry_price - p.stop_loss)
                        * info.money_per_price_unit(p.volume)
                    )

    # ----------------------------------------------------------------- manage

    def _manage_positions(self, positions: list[Position]) -> None:
        for p in positions:
            try:
                df = self.broker.bars(p.symbol, self._timeframe_for(p.symbol), 120)
                if df.empty:
                    continue
                feat = F.build(df)
                atr_value = float(feat["atr"].iloc[-1])
                price = self.broker.tick_price(p.symbol, p.side.opposite.value)
                if price is None or not np.isfinite(atr_value):
                    continue

                meta = self._position_meta.setdefault(p.ticket, {})
                if p.initial_stop is None:
                    p.initial_stop = meta.get("initial_stop", p.stop_loss)

                new_stop, reason = self.risk.manage(p, price, atr_value)
                if new_stop is not None:
                    result = self.broker.modify(p.ticket, new_stop, p.take_profit)
                    if result.ok:
                        log.info(
                            "stop moved on %s (%s): %.5f -> %.5f [%s]",
                            p.ticket, p.symbol, p.stop_loss or 0.0, new_stop, reason,
                        )
                    else:
                        log.warning("could not move stop on %s: %s",
                                    p.ticket, result.message)
                meta["last_price"] = price
            except Exception:
                log.exception("error managing position %s", p.ticket)

    def _timeframe_for(self, symbol: str) -> str:
        for s in self.cfg.symbols:
            if s.name == symbol:
                return s.timeframe
        return "M15"

    # ------------------------------------------------------------------- scan

    def _scan_symbol(self, sym_cfg, account, goal_scale: float) -> None:
        symbol = sym_cfg.name
        info = self.broker.symbol_info(symbol)
        if info is None or not info.trade_allowed:
            return

        # Spread filter: a wide spread quietly destroys short-horizon edges.
        spread = getattr(self.broker, "spread_points", lambda _s: None)(symbol)
        if spread is not None and spread > sym_cfg.max_spread_points:
            log.debug("%s: spread %.1f over limit %.1f", symbol, spread,
                      sym_cfg.max_spread_points)
            return

        df = self.broker.bars(symbol, sym_cfg.timeframe, self.cfg.execution.bars_lookback)
        if df.empty or len(df) < 260:
            return

        # Drop the still-forming bar: strategies see closed bars only.
        df = df.iloc[:-1]
        feat = F.build(df, self.cfg.learning.regime_lookback)
        if feat.empty:
            return

        atr_value = float(feat["atr"].iloc[-1])
        if not np.isfinite(atr_value) or atr_value <= 0:
            return

        regime = F.classify_regime(feat)
        positions = self.broker.positions()

        for strat in self.strategies:
            if not strat.enabled:
                continue
            try:
                signal = strat.evaluate(feat, symbol)
            except Exception:
                log.exception("strategy %s raised on %s", strat.name, symbol)
                continue
            if signal is None:
                continue

            self.stats.signals_seen += 1
            self._consider(signal, feat, regime, info, account, positions,
                           goal_scale, sym_cfg.weight, atr_value)

    def _consider(
        self, signal: Signal, feat, regime: Regime, info, account,
        positions: list[Position], goal_scale: float, weight: float,
        atr_value: float,
    ) -> None:
        """Run one signal through every gate. Most signals die here."""
        confidence_scale = signal.confidence
        bandit_score = None

        # --- gate 1: bandit ---------------------------------------------------
        if self.cfg.learning.enabled:
            decision = self.bandit.evaluate(signal.strategy, regime)
            bandit_score = decision.score
            if not decision.allow:
                self.journal.record_signal(
                    signal, regime, False, f"bandit: {decision.reason}",
                    bandit_score=bandit_score,
                )
                return
            confidence_scale *= decision.confidence

        # --- gate 2: meta-model ----------------------------------------------
        meta_score = None
        if self.cfg.learning.meta_model_enabled and self.meta.active:
            allow, prob, reason = self.meta.gate(
                signal.features, signal.side.value == "buy",
                signal.strategy, regime.value,
            )
            meta_score = prob
            if not allow:
                self.journal.record_signal(
                    signal, regime, False, f"meta: {reason}",
                    meta_score=prob, bandit_score=bandit_score,
                )
                return
            confidence_scale *= self.meta.size_multiplier(prob)

        # --- gate 3: risk -----------------------------------------------------
        entry = self.broker.tick_price(signal.symbol, signal.side.value)
        if entry is None:
            self.journal.record_signal(signal, regime, False, "no price")
            return

        sized = self.risk.size(
            signal, info, entry, atr_value, account, positions,
            goal_scale=goal_scale, symbol_weight=weight,
            confidence_scale=confidence_scale,
        )
        if not sized.approved:
            self.journal.record_signal(
                signal, regime, False, f"risk: {sized.reason}",
                meta_score=meta_score, bandit_score=bandit_score,
            )
            return

        # --- execute ----------------------------------------------------------
        self.stats.signals_taken += 1
        order = self.risk.to_order(signal, sized)
        result = self.broker.place(order)

        self.journal.record_signal(
            signal, regime, result.ok,
            "" if result.ok else f"order: {result.message}",
            meta_score=meta_score, bandit_score=bandit_score,
        )

        if not result.ok:
            self.stats.orders_failed += 1
            log.error("order failed for %s: %s", signal.symbol, result.message)
            return

        self.stats.orders_placed += 1
        ticket = result.ticket or 0
        self._known_tickets.add(ticket)
        self._position_meta[ticket] = {
            "strategy": signal.strategy,
            "regime": regime.value,
            "risk_amount": sized.risk_amount,
            "initial_stop": sized.stop_loss,
            "last_profit": 0.0,
            "last_price": result.price or entry,
        }
        self.journal.open_trade(
            ticket, signal, sized.volume, result.price or entry,
            sized.stop_loss, sized.take_profit, regime,
            mode=self.cfg.execution.mode,
        )
        log.info(
            "ENTERED %s %s: %s | %s",
            signal.side.value.upper(), signal.symbol, sized.reason, signal.reason,
        )

    # ------------------------------------------------------------------ learn

    def _retrain(self, force: bool = False) -> None:
        trades = self.journal.closed_trades()
        if not trades and not force:
            return
        report = self.meta.train(trades)
        self._trades_since_retrain = 0
        if report.accepted:
            self.meta.save(self.model_path)
        self.journal.event("meta_retrain", report.summary(),
                           level="INFO" if report.accepted else "WARNING")
        log.info(report.summary())

    # ------------------------------------------------------------------ status

    def status(self) -> dict:
        account = self.broker.account()
        positions = self.broker.positions()
        verdict = self.guards.check(account.equity)
        assessment = self.goal.assess(
            account.equity, self.guards.week_pnl(account.equity)
        )
        return {
            "mode": self.cfg.execution.mode,
            "connected": self.broker.is_connected(),
            "balance": account.balance,
            "equity": account.equity,
            "currency": account.currency,
            "open_positions": len(positions),
            "open_risk_pct": self.risk.open_risk(positions, account.equity),
            "can_trade": verdict.can_trade,
            "breaker": verdict.breaker.value,
            "breaker_message": verdict.message,
            "day_pnl": self.guards.day_pnl(account.equity),
            "week_pnl": self.guards.week_pnl(account.equity),
            "drawdown": self.guards.drawdown(account.equity),
            "goal": assessment.summary(),
            "goal_feasibility": assessment.feasibility.value,
            "meta_model": self.meta.report.summary(),
            "cycles": self.stats.cycles,
            "signals_seen": self.stats.signals_seen,
            "orders_placed": self.stats.orders_placed,
            "trades_closed": self.stats.trades_closed,
            "errors": self.stats.errors,
        }
