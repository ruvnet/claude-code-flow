"""Configuration model.

Everything tunable lives in ``config/config.yaml``. Credentials never do -- they
come from the environment (``MT5_LOGIN`` / ``MT5_PASSWORD`` / ``MT5_SERVER``) or
from a gitignored ``credentials.yaml``.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, model_validator

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "config" / "config.yaml"


class MT5Config(BaseModel):
    login: int | None = None
    password: str | None = None
    server: str | None = None
    terminal_path: str | None = None
    timeout_ms: int = 60_000
    # Magic number tags every order this bot places so it never touches a
    # position opened by hand or by another EA.
    magic: int = 770_101
    deviation_points: int = 20

    def resolved(self) -> "MT5Config":
        """Overlay credentials from the environment."""
        env_login = os.getenv("MT5_LOGIN")
        return self.model_copy(
            update={
                "login": int(env_login) if env_login else self.login,
                "password": os.getenv("MT5_PASSWORD") or self.password,
                "server": os.getenv("MT5_SERVER") or self.server,
                "terminal_path": os.getenv("MT5_TERMINAL_PATH") or self.terminal_path,
            }
        )


class SymbolConfig(BaseModel):
    name: str
    timeframe: str = "M15"
    enabled: bool = True
    # Per-symbol risk multiplier, applied on top of the global risk budget.
    weight: float = 1.0
    sessions: list[str] = Field(default_factory=lambda: ["london", "newyork"])
    max_spread_points: float = 30.0


class RiskConfig(BaseModel):
    """Hard limits. The goal controller may scale risk DOWN from these numbers.
    Nothing in the system is permitted to scale it UP past them."""

    max_risk_per_trade_pct: float = 0.005      # 0.5% of equity, absolute ceiling
    base_risk_per_trade_pct: float = 0.0025    # 0.25% starting point
    max_portfolio_risk_pct: float = 0.02       # sum of open risk
    max_positions: int = 5
    max_positions_per_symbol: int = 1
    max_correlated_positions: int = 3
    correlation_threshold: float = 0.7

    daily_loss_limit_pct: float = 0.03         # halt for the day
    weekly_loss_limit_pct: float = 0.06        # halt for the week
    max_drawdown_pct: float = 0.15             # halt entirely, needs manual reset

    min_stop_atr_mult: float = 1.0
    default_stop_atr_mult: float = 1.8
    default_target_atr_mult: float = 2.7       # >1R by construction
    trailing_atr_mult: float = 2.0
    breakeven_at_r: float = 1.0

    min_free_margin_pct: float = 0.35          # refuse new trades below this
    max_lot: float = 5.0
    max_slippage_points: float = 25.0


class GoalConfig(BaseModel):
    weekly_profit_target: float = 1000.0
    currency: str = "USD"
    # Sustainable weekly return bands used to classify how realistic the target
    # is for the current balance. These are deliberately conservative.
    comfortable_weekly_return: float = 0.005   # 0.5%/wk  ~ 29%/yr
    aggressive_weekly_return: float = 0.010    # 1.0%/wk  ~ 68%/yr
    infeasible_weekly_return: float = 0.020    # 2.0%/wk  -- not sustainable
    # Once the weekly target is hit, taper risk instead of pressing.
    taper_after_target: bool = True
    taper_factor: float = 0.4
    stop_after_target: bool = False


class LearningConfig(BaseModel):
    enabled: bool = True
    bandit_decay: float = 0.995           # discount on old outcomes
    bandit_min_trades: int = 20           # before a strategy is trusted
    bandit_exploration: float = 0.15      # floor probability of exploring
    meta_model_enabled: bool = True
    meta_model_min_samples: int = 200
    meta_model_retrain_every: int = 25    # trades
    meta_model_gate_threshold: float = 0.5
    regime_lookback: int = 200


class ResearchConfig(BaseModel):
    enabled: bool = True
    sources_dir: str = "research_sources"
    # A discovered strategy must clear every one of these to be promoted.
    min_backtest_trades: int = 100
    min_profit_factor: float = 1.25
    min_sharpe: float = 0.8
    max_backtest_drawdown_pct: float = 0.20
    min_walkforward_windows: int = 4
    min_walkforward_pass_rate: float = 0.6
    paper_trade_days: int = 30
    min_paper_trades: int = 30
    auto_promote: bool = False            # human ack by default


class ExecutionConfig(BaseModel):
    mode: Literal["backtest", "paper", "live"] = "paper"
    poll_seconds: int = 15
    bars_lookback: int = 1500
    allow_live: bool = False              # second lock on top of mode=live
    close_on_shutdown: bool = False


class OpsConfig(BaseModel):
    log_level: str = "INFO"
    log_dir: str = "var/logs"
    db_path: str = "var/journal.db"
    state_path: str = "var/state.json"
    heartbeat_seconds: int = 60
    alert_webhook: str | None = None


class Config(BaseModel):
    mt5: MT5Config = Field(default_factory=MT5Config)
    symbols: list[SymbolConfig] = Field(default_factory=list)
    risk: RiskConfig = Field(default_factory=RiskConfig)
    goal: GoalConfig = Field(default_factory=GoalConfig)
    learning: LearningConfig = Field(default_factory=LearningConfig)
    research: ResearchConfig = Field(default_factory=ResearchConfig)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    ops: OpsConfig = Field(default_factory=OpsConfig)
    strategies: dict[str, dict[str, Any]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check_invariants(self) -> "Config":
        r = self.risk
        if r.base_risk_per_trade_pct > r.max_risk_per_trade_pct:
            raise ValueError(
                "base_risk_per_trade_pct must not exceed max_risk_per_trade_pct"
            )
        if r.daily_loss_limit_pct >= r.weekly_loss_limit_pct:
            raise ValueError("daily_loss_limit_pct must be below weekly_loss_limit_pct")
        if r.weekly_loss_limit_pct >= r.max_drawdown_pct:
            raise ValueError("weekly_loss_limit_pct must be below max_drawdown_pct")
        if r.default_target_atr_mult <= r.default_stop_atr_mult:
            raise ValueError(
                "default_target_atr_mult must exceed default_stop_atr_mult "
                "(otherwise expectancy needs >50% win rate to break even)"
            )
        if self.execution.mode == "live" and not self.execution.allow_live:
            raise ValueError(
                "execution.mode=live requires execution.allow_live=true. "
                "This is an intentional two-key lock on real-money trading."
            )
        return self

    @property
    def enabled_symbols(self) -> list[SymbolConfig]:
        return [s for s in self.symbols if s.enabled]

    def path(self, attr: str) -> Path:
        """Resolve a configured relative path against the project root."""
        value = getattr(self.ops, attr)
        p = Path(value)
        return p if p.is_absolute() else ROOT / p


def load_config(path: str | Path | None = None) -> Config:
    cfg_path = Path(path) if path else DEFAULT_CONFIG
    if not cfg_path.exists():
        raise FileNotFoundError(f"config not found: {cfg_path}")
    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}

    creds_path = cfg_path.parent.parent / "credentials.yaml"
    if creds_path.exists():
        creds = yaml.safe_load(creds_path.read_text(encoding="utf-8")) or {}
        raw.setdefault("mt5", {}).update(creds.get("mt5", {}))

    cfg = Config.model_validate(raw)
    return cfg.model_copy(update={"mt5": cfg.mt5.resolved()})
