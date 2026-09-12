"""Strategy registry.

Holds both the hand-written strategies and any spec-driven strategy the
research pipeline has promoted. Everything the engine trades comes from here,
so this is the one place to look to answer "what is actually running".
"""
from __future__ import annotations

import logging
from typing import Any, Iterable

from .base import Strategy
from .builtin.classic import ALL_STRATEGIES

log = logging.getLogger(__name__)

_REGISTRY: dict[str, type[Strategy]] = {cls.name: cls for cls in ALL_STRATEGIES}


def register(cls: type[Strategy]) -> type[Strategy]:
    if cls.name in _REGISTRY and _REGISTRY[cls.name] is not cls:
        log.warning("overwriting registered strategy %s", cls.name)
    _REGISTRY[cls.name] = cls
    return cls


def available() -> list[str]:
    return sorted(_REGISTRY)


def get(name: str) -> type[Strategy] | None:
    return _REGISTRY.get(name)


def build(config: dict[str, dict[str, Any]]) -> list[Strategy]:
    """Instantiate every enabled strategy named in the config."""
    out: list[Strategy] = []
    for name, params in (config or {}).items():
        cls = _REGISTRY.get(name)
        if cls is None:
            log.warning("unknown strategy in config, skipping: %s", name)
            continue
        if params is not None and params.get("enabled") is False:
            continue
        try:
            out.append(cls(params or {}))
        except Exception:
            log.exception("failed to construct strategy %s", name)
    if not out:
        log.warning("no strategies enabled -- the bot will never signal")
    return out


def build_all(exclude: Iterable[str] = ()) -> list[Strategy]:
    """Every registered strategy at defaults. Used by research sweeps."""
    skip = set(exclude)
    return [cls({}) for name, cls in sorted(_REGISTRY.items()) if name not in skip]
