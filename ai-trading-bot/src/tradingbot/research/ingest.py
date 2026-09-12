"""Turning written strategy descriptions into candidate specs.

This is the "studies strategies online and from other traders" half of the
system. What it honestly is: a *distiller*. It reads prose describing a
strategy and emits a StrategySpec, which is then inert until the gauntlet
passes it.

What it honestly is not: a way to find profitable strategies. The extraction
step has no opinion about whether a strategy works -- it only converts claims
into a testable form. The filtering is entirely downstream, in gauntlet.py, and
that is the correct division of labour. Reading ten thousand blog posts does
not help you if you believe them; it helps you only if you can cheaply reject
the 99% that do not survive contact with out-of-sample data and spread.

Three input paths:

* ``from_text``     -- prose in, spec out, using the phrase patterns below
* ``from_document`` -- a structured YAML/JSON description (highest fidelity)
* ``fetcher``       -- a pluggable callable for pulling remote documents, left
                       unimplemented on purpose so the default install makes no
                       network calls and respects whatever terms the source
                       publishes under

The pattern table below is deliberately conservative. An unrecognised
description produces *no* spec rather than a guessed one, because a
misextracted strategy that happens to backtest well is worse than no strategy.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import yaml

from .spec import StrategySpec

log = logging.getLogger(__name__)

Fetcher = Callable[[str], str]


@dataclass
class SourceDocument:
    identifier: str
    text: str
    title: str = ""
    author: str = ""
    url: str = ""
    kind: str = "article"    # article | forum | video_transcript | manual


@dataclass
class ExtractionResult:
    spec: StrategySpec | None
    confidence: float
    matched: list[str]
    unmatched_hints: list[str]
    note: str = ""


# --------------------------------------------------------------------- rules
# (regex, expression template, side, label)
#
# ``side`` is one of:
#   long    directional trigger, long only
#   short   directional trigger, short only
#   both    directional trigger; the short leg is the MIRRORED condition
#   filter  non-directional context (trend strength, volatility). Applied
#           verbatim to BOTH legs and never mirrored -- mirroring "ADX > 25"
#           into "ADX < 25" would turn a trend filter into a chop filter and
#           silently invert the strategy's meaning.
#
# A leg made only of filters is discarded: "ADX > 25" is not an entry, it is a
# permission slip, and treating it as a trigger would fire on every other bar.

INDICATOR_ALIASES = {
    "rsi": "rsi",
    "relative strength": "rsi",
    "adx": "adx",
    "macd": "macd_hist",
    "atr": "atr",
    "price": "close",
    "close": "close",
}

PATTERNS: list[tuple[str, str, str, str]] = [
    # --- RSI -------------------------------------------------------------
    (r"rsi\s*(?:is\s*)?(?:drops?\s*)?below\s*(\d{1,3})", "rsi < {0}", "long", "rsi"),
    (r"rsi\s*(?:is\s*)?(?:rises?\s*)?above\s*(\d{1,3})", "rsi > {0}", "short", "rsi"),
    (r"rsi\s*(?:is\s*)?oversold", "rsi < 30", "long", "rsi"),
    (r"rsi\s*(?:is\s*)?overbought", "rsi > 70", "short", "rsi"),
    (r"rsi\s*crosses?\s*(?:back\s*)?above\s*(\d{1,3})",
     "crossed_above(rsi, {0})", "long", "rsi"),
    (r"rsi\s*crosses?\s*(?:back\s*)?below\s*(\d{1,3})",
     "crossed_below(rsi, {0})", "short", "rsi"),
    # --- moving averages --------------------------------------------------
    (r"(?:fast\s*)?(?:ema|moving average)\s*crosses?\s*above\s*(?:the\s*)?"
     r"(?:slow\s*)?(?:ema|moving average)",
     "crossed_above(ema_fast, ema_slow)", "long", "ema"),
    (r"(?:fast\s*)?(?:ema|moving average)\s*crosses?\s*below\s*(?:the\s*)?"
     r"(?:slow\s*)?(?:ema|moving average)",
     "crossed_below(ema_fast, ema_slow)", "short", "ema"),
    (r"golden\s*cross", "crossed_above(ema_fast, ema_slow)", "long", "ema"),
    (r"death\s*cross", "crossed_below(ema_fast, ema_slow)", "short", "ema"),
    (r"(?:price|close)\s*(?:is\s*)?above\s*(?:the\s*)?(?:200|long[- ]term)\s*"
     r"(?:ema|ma|moving average)", "close > ema_trend", "long", "trend"),
    (r"(?:price|close)\s*(?:is\s*)?below\s*(?:the\s*)?(?:200|long[- ]term)\s*"
     r"(?:ema|ma|moving average)", "close < ema_trend", "short", "trend"),
    # --- bollinger --------------------------------------------------------
    (r"(?:price|close)\s*(?:closes?\s*)?(?:below|under)\s*(?:the\s*)?lower\s*"
     r"(?:bollinger\s*)?band", "close < bb_lower", "long", "bollinger"),
    (r"(?:price|close)\s*(?:closes?\s*)?above\s*(?:the\s*)?upper\s*"
     r"(?:bollinger\s*)?band", "close > bb_upper", "short", "bollinger"),
    # --- breakout ---------------------------------------------------------
    (r"breaks?\s*(?:out\s*)?above\s*(?:the\s*)?(\d{1,3})[- ](?:bar|period|day)\s*high",
     "high >= highest(high, {0})", "long", "breakout"),
    (r"breaks?\s*(?:out\s*)?below\s*(?:the\s*)?(\d{1,3})[- ](?:bar|period|day)\s*low",
     "low <= lowest(low, {0})", "short", "breakout"),
    (r"(\d{1,3})[- ](?:bar|period|day)\s*(?:donchian\s*)?breakout",
     "high >= highest(high, {0})", "both", "breakout"),
    # --- macd -------------------------------------------------------------
    (r"macd\s*(?:histogram\s*)?(?:turns?|crosses?)\s*(?:above\s*zero|positive)",
     "crossed_above(macd_hist, 0)", "long", "macd"),
    (r"macd\s*(?:histogram\s*)?(?:turns?|crosses?)\s*(?:below\s*zero|negative)",
     "crossed_below(macd_hist, 0)", "short", "macd"),
    (r"macd\s*crosses?\s*above\s*(?:the\s*)?signal",
     "crossed_above(macd, macd_signal)", "long", "macd"),
    (r"macd\s*crosses?\s*below\s*(?:the\s*)?signal",
     "crossed_below(macd, macd_signal)", "short", "macd"),
    # --- trend strength (context, not triggers) ---------------------------
    (r"adx\s*(?:is\s*)?above\s*(\d{1,3})", "adx > {0}", "filter", "adx"),
    (r"strong\s*trend", "adx > 25", "filter", "adx"),
    (r"(?:ranging|sideways|choppy)\s*market", "adx < 20", "filter", "adx"),
]

# Labels that are context filters rather than entry triggers.
FILTER_LABELS = {"adx", "trend"}

# Phrases that signal a strategy we cannot express. Recording them is the point:
# an honest extractor reports what it could not represent.
UNSUPPORTED_HINTS = [
    (r"order\s*block", "order blocks (needs market-structure detection)"),
    (r"fair\s*value\s*gap|fvg", "fair value gaps"),
    (r"liquidity\s*(?:sweep|grab|pool)", "liquidity sweeps"),
    (r"elliott\s*wave", "Elliott wave counts"),
    (r"harmonic|gartley|butterfly\s*pattern", "harmonic patterns"),
    (r"supply\s*(?:and|&)\s*demand\s*zone", "supply/demand zones"),
    (r"head\s*and\s*shoulders|double\s*top|double\s*bottom", "chart patterns"),
    (r"fibonacci|fib\s*retrace", "Fibonacci levels"),
    (r"news|nfp|fomc|economic\s*calendar", "news/event filters"),
    (r"sentiment|cot\s*report", "sentiment or COT data"),
    (r"volume\s*profile|vwap", "volume profile / VWAP"),
    (r"martingale|grid\s*(?:system|strategy)|averaging\s*down",
     "martingale or grid sizing -- REFUSED, not merely unsupported"),
]

# Claims that should lower confidence rather than raise it.
RED_FLAGS = [
    (r"\b(?:100|99|98|95)\s*%\s*(?:win|accuracy|accurate)", "implausible win rate"),
    (r"never\s*loses?|no\s*losses?|guaranteed", "guarantee language"),
    (r"holy\s*grail|secret|banks?\s*don'?t\s*want", "marketing language"),
    (r"martingale|double\s*(?:down|your\s*lot)", "martingale sizing"),
    (r"no\s*stop\s*loss|without\s*(?:a\s*)?stop", "trades without a stop"),
]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower())


def extract_red_flags(text: str) -> list[str]:
    """Claims that make a source less credible, not more."""
    t = _norm(text)
    return [label for pattern, label in RED_FLAGS if re.search(pattern, t)]


def extract_unsupported(text: str) -> list[str]:
    t = _norm(text)
    return [label for pattern, label in UNSUPPORTED_HINTS if re.search(pattern, t)]


def from_text(
    text: str,
    name: str,
    source: str = "",
    author: str = "",
) -> ExtractionResult:
    """Distil prose into a StrategySpec, or refuse.

    Returns a spec only when at least one entry condition was recognised.
    """
    t = _norm(text)
    longs: list[str] = []
    shorts: list[str] = []
    matched: list[str] = []
    # Track whether each leg has at least one genuine directional trigger.
    long_trigger = short_trigger = False

    for pattern, template, side, label in PATTERNS:
        m = re.search(pattern, t)
        if not m:
            continue
        try:
            expr = template.format(*m.groups())
        except (IndexError, KeyError):
            continue
        matched.append(label)
        is_trigger = label not in FILTER_LABELS

        if side == "filter":
            # Context applies to both legs, unmirrored.
            longs.append(expr)
            shorts.append(expr)
            continue
        if side in ("long", "both"):
            longs.append(expr)
            long_trigger = long_trigger or is_trigger
        if side == "short":
            shorts.append(expr)
            short_trigger = short_trigger or is_trigger
        elif side == "both":
            shorts.append(_mirror(expr))
            short_trigger = short_trigger or is_trigger

    # Discard a leg that is all context and no trigger -- it would fire
    # constantly rather than select a setup.
    dropped: list[str] = []
    if longs and not long_trigger:
        dropped.append("long")
        longs = []
    if shorts and not short_trigger:
        dropped.append("short")
        shorts = []

    unsupported = extract_unsupported(text)
    red_flags = extract_red_flags(text)

    if not longs and not shorts:
        note = "no recognisable entry condition -- refusing to guess. "
        if dropped:
            note += (
                f"Found only context filters for the {'/'.join(dropped)} side "
                f"with no entry trigger. "
            )
        if unsupported:
            note += f"Mentions: {', '.join(unsupported)}."
        return ExtractionResult(None, 0.0, matched, unsupported, note)

    refused = [u for u in unsupported if "REFUSED" in u]
    if refused:
        return ExtractionResult(
            None, 0.0, matched, unsupported,
            f"refused: describes {refused[0]}. Position sizing that increases "
            f"after losses is excluded by design, not by omission.",
        )

    # Confidence: more matched concepts is better, red flags and unrepresentable
    # concepts are worse.
    confidence = min(0.65, 0.25 + 0.12 * len(set(matched)))
    confidence -= 0.10 * len(unsupported)
    confidence -= 0.20 * len(red_flags)
    confidence = max(0.05, confidence)

    spec = StrategySpec(
        name=re.sub(r"[^a-z0-9_]", "_", name.lower())[:40].strip("_") or "unnamed",
        long_entry=" and ".join(dict.fromkeys(longs)),
        short_entry=" and ".join(dict.fromkeys(shorts)),
        description=text.strip()[:500],
        source=source,
        author=author,
        confidence=round(confidence, 2),
        status="quarantined",
        tags=sorted(set(matched)),
        provenance={
            "extracted_by": "rule_based_v1",
            "matched_concepts": sorted(set(matched)),
            "unrepresentable": unsupported,
            "red_flags": red_flags,
            "dropped_legs": dropped,
        },
        notes=(
            (f"Could not represent: {', '.join(unsupported)}. " if unsupported else "")
            + (f"Credibility warnings: {', '.join(red_flags)}. " if red_flags else "")
            + (
                f"Dropped the {'/'.join(dropped)} leg (context filters but no "
                f"entry trigger); this strategy is one-directional as extracted. "
                if dropped else ""
            )
            + "Quarantined pending the gauntlet."
        ),
    )
    return ExtractionResult(
        spec, confidence, sorted(set(matched)), unsupported,
        "extracted; unverified and untested",
    )


def _mirror(expr: str) -> str:
    """Flip a long condition into its short counterpart."""
    swaps = [
        ("crossed_above", "__CA__"), ("crossed_below", "crossed_above"),
        ("__CA__", "crossed_below"),
        ("highest(high", "__HH__"), ("lowest(low", "highest(high"),
        ("__HH__", "lowest(low"),
        (">=", "__GE__"), ("<=", ">="), ("__GE__", "<="),
        (">", "__GT__"), ("<", ">"), ("__GT__", "<"),
        ("bb_upper", "__BU__"), ("bb_lower", "bb_upper"), ("__BU__", "bb_lower"),
        ("rising(", "__RI__"), ("falling(", "rising("), ("__RI__", "falling("),
    ]
    out = expr
    for a, b in swaps:
        out = out.replace(a, b)
    return out


def from_document(path: str | Path) -> ExtractionResult:
    """Load a structured strategy description (highest fidelity path)."""
    p = Path(path)
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}

    # Already a full spec?
    if "long_entry" in raw or "short_entry" in raw:
        spec = StrategySpec.from_dict(raw)
        spec.status = spec.status or "quarantined"
        problems = spec.validate()
        if problems:
            return ExtractionResult(None, 0.0, [], [], f"invalid spec: {problems}")
        return ExtractionResult(spec, 0.8, spec.tags, [], "loaded structured spec")

    # Otherwise treat it as prose.
    text = raw.get("text") or raw.get("description") or ""
    if not text:
        return ExtractionResult(None, 0.0, [], [], "no text or rules found")
    return from_text(
        text,
        name=raw.get("name", p.stem),
        source=raw.get("url", str(p)),
        author=raw.get("author", ""),
    )


def ingest_directory(directory: str | Path) -> list[ExtractionResult]:
    d = Path(directory)
    if not d.exists():
        log.info("no research sources directory at %s", d)
        return []
    results = []
    for p in sorted([*d.glob("*.yaml"), *d.glob("*.yml"), *d.glob("*.txt"),
                     *d.glob("*.md")]):
        try:
            if p.suffix in (".txt", ".md"):
                results.append(
                    from_text(p.read_text(encoding="utf-8"), name=p.stem,
                              source=str(p))
                )
            else:
                results.append(from_document(p))
        except Exception:
            log.exception("could not ingest %s", p)
    return results


def fetch_documents(urls: Iterable[str], fetcher: Fetcher | None = None) -> list[SourceDocument]:
    """Pull remote documents through a caller-supplied fetcher.

    There is intentionally no default implementation. Fetching third-party
    content is a decision about that site's terms of service and about what
    code you are willing to let near a machine with broker credentials on it,
    and that decision belongs to the operator rather than to a default. Wire in
    ``requests``/``httpx``, an API client, or an LLM extractor here.
    """
    if fetcher is None:
        raise NotImplementedError(
            "No fetcher configured. Pass a callable that takes a URL and "
            "returns text, e.g. fetch_documents(urls, fetcher=my_fetcher). "
            "Check the source's terms of service before scraping it."
        )
    docs = []
    for url in urls:
        try:
            docs.append(SourceDocument(identifier=url, text=fetcher(url), url=url))
        except Exception:
            log.exception("could not fetch %s", url)
    return docs
