"""Meta-model: a learned filter over the strategies.

The bandit learns *which strategy* to trust. This learns *which individual
setups* are worth taking, from the feature vector captured at signal time --
volatility, trend strength, session, spread, and so on.

The guard that matters most is at the bottom of :meth:`train`: if the model
does not beat a coin flip on held-out, time-ordered data, it is refused and the
gate stays open. A filter that has not demonstrated skill must not be allowed
to veto trades -- it would just be an expensive random number generator.

Validation is a forward-chaining split (train on the past, test on the future),
never a shuffled one. Shuffling price-derived data leaks the future into the
training set and produces a model that looks excellent and loses money.
"""
from __future__ import annotations

import logging
import pickle
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from ..data.features import FEATURE_COLUMNS
from ..types import TradeRecord

log = logging.getLogger(__name__)

try:
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    SKLEARN_AVAILABLE = True
except ImportError:  # pragma: no cover
    SKLEARN_AVAILABLE = False


# Categorical context appended to the numeric feature vector.
EXTRA_COLUMNS = ["side_is_buy", "strategy_id", "regime_id"]


@dataclass
class TrainReport:
    trained: bool
    accepted: bool
    samples: int = 0
    auc: float = 0.5
    baseline_rate: float = 0.0
    message: str = ""
    feature_importance: dict[str, float] = field(default_factory=dict)
    trained_at: datetime | None = None

    def summary(self) -> str:
        if not self.trained:
            return f"meta-model not trained: {self.message}"
        verdict = "ACCEPTED" if self.accepted else "REJECTED"
        return (
            f"meta-model {verdict}: {self.samples} samples, holdout AUC "
            f"{self.auc:.3f}, base win rate {self.baseline_rate:.1%}. "
            f"{self.message}"
        )


class MetaModel:
    """Predicts P(trade is profitable) from the signal-time feature vector."""

    MIN_ACCEPTABLE_AUC = 0.55  # must beat a coin flip by a real margin

    def __init__(
        self,
        min_samples: int = 200,
        gate_threshold: float = 0.5,
        model_kind: str = "gbm",
    ) -> None:
        self.min_samples = min_samples
        self.gate_threshold = gate_threshold
        self.model_kind = model_kind
        self.pipeline: Any | None = None
        self.report = TrainReport(False, False, message="never trained")
        self._strategy_ids: dict[str, int] = {}
        self._regime_ids: dict[str, int] = {}

    # ---------------------------------------------------------------- feature

    def _encode_id(self, table: dict[str, int], key: str) -> int:
        return table.setdefault(key, len(table))

    def _vector(
        self, features: dict[str, float], side_is_buy: bool, strategy: str, regime: str
    ) -> list[float]:
        row = [float(features.get(c, 0.0) or 0.0) for c in FEATURE_COLUMNS]
        row.append(1.0 if side_is_buy else 0.0)
        row.append(float(self._encode_id(self._strategy_ids, strategy)))
        row.append(float(self._encode_id(self._regime_ids, regime)))
        return row

    def _matrix(self, trades: list[TradeRecord]) -> tuple[np.ndarray, np.ndarray]:
        X, y = [], []
        for t in trades:
            if not t.features:
                continue
            X.append(
                self._vector(
                    t.features, t.side.value == "buy", t.strategy, t.regime.value
                )
            )
            y.append(1 if t.profit > 0 else 0)
        if not X:
            return np.empty((0, len(FEATURE_COLUMNS) + 3)), np.empty(0)
        arr = np.asarray(X, dtype=float)
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
        return arr, np.asarray(y, dtype=int)

    def _build(self) -> Any:
        if self.model_kind == "logistic":
            return Pipeline([
                ("scale", StandardScaler()),
                ("clf", LogisticRegression(max_iter=1000, C=0.5,
                                           class_weight="balanced")),
            ])
        return Pipeline([
            ("scale", StandardScaler()),
            ("clf", GradientBoostingClassifier(
                n_estimators=120, max_depth=3, learning_rate=0.05,
                subsample=0.85, random_state=7,
            )),
        ])

    # --------------------------------------------------------------- training

    def train(self, trades: list[TradeRecord]) -> TrainReport:
        if not SKLEARN_AVAILABLE:
            self.report = TrainReport(False, False, message="scikit-learn not installed")
            return self.report

        X, y = self._matrix(trades)
        n = len(y)
        if n < self.min_samples:
            self.report = TrainReport(
                False, False, samples=n,
                message=f"need {self.min_samples} closed trades, have {n}",
            )
            return self.report

        if len(np.unique(y)) < 2:
            self.report = TrainReport(
                False, False, samples=n,
                message="all outcomes identical; nothing to learn yet",
            )
            return self.report

        # Forward-chaining split: train on the past, validate on the future.
        # `trades` arrives in ascending close order from the journal.
        split = int(n * 0.75)
        if split < 50 or (n - split) < 25:
            split = max(50, n - max(25, n // 4))
        X_tr, y_tr, X_te, y_te = X[:split], y[:split], X[split:], y[split:]

        if len(np.unique(y_tr)) < 2 or len(np.unique(y_te)) < 2:
            self.report = TrainReport(
                False, False, samples=n,
                message="a split has only one class; need more varied outcomes",
            )
            return self.report

        pipeline = self._build()
        try:
            pipeline.fit(X_tr, y_tr)
            proba = pipeline.predict_proba(X_te)[:, 1]
            auc = float(roc_auc_score(y_te, proba))
        except Exception as exc:
            log.exception("meta-model training failed")
            self.report = TrainReport(False, False, samples=n,
                                      message=f"training error: {exc}")
            return self.report

        baseline = float(np.mean(y))
        importance = self._importance(pipeline)

        if auc < self.MIN_ACCEPTABLE_AUC:
            # Keep whatever model was previously accepted; do not install this one.
            self.report = TrainReport(
                True, False, samples=n, auc=auc, baseline_rate=baseline,
                message=(
                    f"holdout AUC {auc:.3f} is below the {self.MIN_ACCEPTABLE_AUC} "
                    f"floor -- no demonstrated skill, so the gate stays open "
                    f"rather than filtering trades at random."
                ),
                feature_importance=importance,
                trained_at=datetime.now(timezone.utc),
            )
            log.warning(self.report.summary())
            return self.report

        # Refit on everything now that the design has proven itself.
        try:
            final = self._build()
            final.fit(X, y)
            self.pipeline = final
        except Exception as exc:  # pragma: no cover
            log.exception("final refit failed")
            self.report = TrainReport(True, False, samples=n, auc=auc,
                                      message=f"refit error: {exc}")
            return self.report

        self.report = TrainReport(
            True, True, samples=n, auc=auc, baseline_rate=baseline,
            message=f"gate active at P(win) >= {self.gate_threshold:.2f}",
            feature_importance=importance,
            trained_at=datetime.now(timezone.utc),
        )
        log.info(self.report.summary())
        return self.report

    def _importance(self, pipeline: Any) -> dict[str, float]:
        names = FEATURE_COLUMNS + EXTRA_COLUMNS
        clf = pipeline.named_steps.get("clf")
        vals = getattr(clf, "feature_importances_", None)
        if vals is None:
            coef = getattr(clf, "coef_", None)
            if coef is None:
                return {}
            vals = np.abs(coef[0])
        total = float(np.sum(vals)) or 1.0
        pairs = sorted(
            ((n, float(v) / total) for n, v in zip(names, vals)),
            key=lambda kv: kv[1], reverse=True,
        )
        return dict(pairs[:10])

    # -------------------------------------------------------------- inference

    @property
    def active(self) -> bool:
        return self.pipeline is not None and self.report.accepted

    def predict(
        self, features: dict[str, float], side_is_buy: bool, strategy: str, regime: str
    ) -> float:
        """P(profitable). Returns 0.5 (neutral) when no accepted model exists."""
        if not self.active:
            return 0.5
        try:
            x = np.asarray(
                [self._vector(features, side_is_buy, strategy, regime)], dtype=float
            )
            x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
            return float(self.pipeline.predict_proba(x)[0, 1])
        except Exception:
            log.exception("meta-model inference failed; passing the signal through")
            return 0.5

    def gate(
        self, features: dict[str, float], side_is_buy: bool, strategy: str, regime: str
    ) -> tuple[bool, float, str]:
        """(allow, probability, reason)."""
        if not self.active:
            return True, 0.5, "meta-model inactive"
        p = self.predict(features, side_is_buy, strategy, regime)
        if p >= self.gate_threshold:
            return True, p, f"P(win)={p:.2f}"
        return False, p, f"P(win)={p:.2f} below gate {self.gate_threshold:.2f}"

    def size_multiplier(self, probability: float) -> float:
        """Map P(win) onto a sizing multiplier in [0.5, 1.0].

        Capped at 1.0: the model may shrink a position, never inflate one.
        """
        if not self.active:
            return 1.0
        span = max(1.0 - self.gate_threshold, 1e-6)
        scaled = (probability - self.gate_threshold) / span
        return float(min(1.0, max(0.5, 0.5 + 0.5 * scaled)))

    # ------------------------------------------------------------ persistence
    #
    # Trust boundary: these two methods use pickle, which executes arbitrary
    # code on load. That is acceptable here and only here, because the file is
    # written by this process into the bot's own var/ directory and is never
    # fetched from a network, a broker, or the research pipeline. A fitted
    # sklearn Pipeline has no practical JSON representation, so pickle is the
    # realistic option.
    #
    # The rule that keeps this safe: NEVER point load() at a model file you did
    # not train locally. If you ever want to share a trained model between
    # machines, ship the journal database and retrain at the far end instead --
    # `retrain` reproduces the model from trades, which are plain data.

    def save(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("wb") as fh:
            pickle.dump(
                {
                    "pipeline": self.pipeline,
                    "report": self.report,
                    "strategy_ids": self._strategy_ids,
                    "regime_ids": self._regime_ids,
                    "gate_threshold": self.gate_threshold,
                },
                fh,
            )

    def load(self, path: str | Path) -> bool:
        p = Path(path)
        if not p.exists():
            return False
        try:
            with p.open("rb") as fh:
                d = pickle.load(fh)
            self.pipeline = d.get("pipeline")
            self.report = d.get("report", self.report)
            self._strategy_ids = d.get("strategy_ids", {})
            self._regime_ids = d.get("regime_ids", {})
            log.info("meta-model restored: %s", self.report.summary())
            return True
        except Exception:
            log.exception("could not load meta-model from %s", p)
            return False
