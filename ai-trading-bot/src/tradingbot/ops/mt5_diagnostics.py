"""Reading MetaTrader 5's own logs to explain why a connection failed.

The Python bridge reports `(-6, 'Terminal: Authorization failed')` for every
authorization problem, which is close to useless when you are trying to fix it:
an expired demo, a wrong server, a typo'd login and a genuinely-not-logged-in
terminal all produce that identical string.

The terminal itself knows more. It writes the broker's actual rejection to its
log ("Invalid account", "Invalid password", "no connection to <server>"), and
this module surfaces that so `doctor` can tell you what is really wrong.

MT5 log format: UTF-16-LE, tab-separated, one record per line, named
``YYYYMMDD.log`` under ``<data dir>/logs``. Field layout varies slightly by
build, so parsing is intentionally loose -- the message is always the last
tab-separated field.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

TERMINAL_ROOT = Path.home() / "AppData" / "Roaming" / "MetaQuotes" / "Terminal"

# Non-instance directories that sit alongside the terminal hashes.
SKIP_DIRS = {"Common", "Community", "Help"}

LOG_NAME = re.compile(r"^\d{8}\.log$")

# Broker-side outcomes worth reporting, most specific first. Each maps to a
# plain-English cause and whether the operator can fix it without new
# credentials.
AUTH_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (
        re.compile(r"authorization on (.+?) failed \(Invalid account\)", re.I),
        "invalid_account",
        "The broker rejected this login as not existing on that server. "
        "Usually an expired demo account, or the right login pointed at the "
        "wrong server.",
    ),
    (
        re.compile(r"authorization on (.+?) failed \(Invalid password\)", re.I),
        "invalid_password",
        "The account exists but the password was rejected. Note MT5 has "
        "separate master and investor passwords -- an investor password logs "
        "in read-only and cannot trade.",
    ),
    (
        re.compile(r"authorization on (.+?) failed \(Account disabled\)", re.I),
        "account_disabled",
        "The broker has disabled this account.",
    ),
    (
        re.compile(r"authorization on (.+?) failed(?: \((.+?)\))?", re.I),
        "auth_failed",
        "The broker refused the login.",
    ),
    (
        re.compile(r"no connection to (.+)", re.I),
        "no_connection",
        "Could not reach that trade server at all. Check the server name is "
        "exactly right and that nothing is blocking the connection.",
    ),
]

SUCCESS_PATTERN = re.compile(
    r"'(\d+)': (?:previous successful authorization|authorized on) (.+)", re.I
)
LOGIN_PATTERN = re.compile(r"'(\d+)'")


@dataclass
class TerminalInstance:
    data_dir: Path
    name: str = ""
    executable: str = ""
    last_log: Path | None = None

    @property
    def hash(self) -> str:
        return self.data_dir.name


@dataclass
class AuthDiagnosis:
    instance: TerminalInstance
    kind: str = "unknown"
    login: str = ""
    server: str = ""
    detail: str = ""
    explanation: str = ""
    at: datetime | None = None
    algo_trading_enabled: bool | None = None

    @property
    def is_failure(self) -> bool:
        return self.kind not in ("authorized", "unknown")

    def summary(self) -> str:
        if self.kind == "authorized":
            return f"logged in as {self.login} on {self.server}"
        if self.kind == "unknown":
            return "no login attempt found in the terminal log"
        who = f"account {self.login}" if self.login else "the configured account"
        where = f" on {self.server}" if self.server else ""
        return f"{who}{where}: {self.detail}"


def _decode(path: Path) -> list[str]:
    """MT5 writes UTF-16-LE with a BOM; fall back gracefully."""
    try:
        raw = path.read_bytes()
    except OSError:
        return []
    for encoding in ("utf-16", "utf-16-le", "utf-8", "latin-1"):
        try:
            return [ln for ln in raw.decode(encoding).splitlines() if ln.strip()]
        except (UnicodeDecodeError, UnicodeError):
            continue
    return []


def _message(line: str) -> str:
    """The human-readable part is always the final tab-separated field."""
    parts = [p for p in line.split("\t") if p.strip()]
    return parts[-1].strip() if parts else line.strip()


def _timestamp(line: str) -> datetime | None:
    m = re.search(r"(\d{4}\.\d{2}\.\d{2} )?(\d{2}:\d{2}:\d{2})", line)
    if not m:
        return None
    try:
        if m.group(1):
            return datetime.strptime(m.group(0), "%Y.%m.%d %H:%M:%S")
        return datetime.strptime(m.group(2), "%H:%M:%S")
    except ValueError:
        return None


def find_instances(root: Path | None = None) -> list[TerminalInstance]:
    """Every MT5 data directory on this machine, newest log first."""
    root = root or TERMINAL_ROOT
    if not root.exists():
        return []

    out: list[TerminalInstance] = []
    for d in root.iterdir():
        if not d.is_dir() or d.name in SKIP_DIRS:
            continue
        logs = d / "logs"
        if not logs.is_dir():
            continue
        candidates = sorted(
            (p for p in logs.glob("*.log") if LOG_NAME.match(p.name)),
            key=lambda p: p.name,
        )
        inst = TerminalInstance(data_dir=d, last_log=candidates[-1] if candidates else None)

        # The startup banner names the build and the broker.
        if inst.last_log:
            for line in _decode(inst.last_log):
                msg = _message(line)
                if "started for" in msg:
                    inst.name = msg
                    break
        out.append(inst)

    out.sort(
        key=lambda i: i.last_log.stat().st_mtime if i.last_log else 0, reverse=True
    )
    return out


def diagnose(instance: TerminalInstance) -> AuthDiagnosis:
    """Extract the most recent authorization outcome from a terminal's log."""
    result = AuthDiagnosis(instance=instance)
    if not instance.last_log:
        return result

    lines = _decode(instance.last_log)
    if not lines:
        return result

    # Walk backwards: the most recent outcome is the one that matters.
    for line in reversed(lines):
        msg = _message(line)

        if result.algo_trading_enabled is None:
            if "automated trading is enabled" in msg.lower():
                result.algo_trading_enabled = True
            elif "automated trading is disabled" in msg.lower():
                result.algo_trading_enabled = False

        success = SUCCESS_PATTERN.search(msg)
        if success and result.kind == "unknown":
            result.kind = "authorized"
            result.login, result.server = success.group(1), success.group(2).strip()
            result.at = _timestamp(line)
            continue

        if result.kind != "unknown":
            continue

        for pattern, kind, explanation in AUTH_PATTERNS:
            m = pattern.search(msg)
            if not m:
                continue
            login = LOGIN_PATTERN.search(msg)
            result.kind = kind
            result.login = login.group(1) if login else ""
            result.server = (m.group(1) or "").strip()
            # Drop the leading "'<login>': " so the summary does not repeat the
            # account number it already prints.
            result.detail = re.sub(r"^'\d+':\s*", "", msg)
            result.explanation = explanation
            result.at = _timestamp(line)
            break

    return result


def diagnose_all(root: Path | None = None) -> list[AuthDiagnosis]:
    return [diagnose(i) for i in find_instances(root)]


def explain_connection_failure(root: Path | None = None) -> str:
    """A human-readable account of why no terminal is usable right now.

    Called by `doctor` when mt5.initialize() fails, to replace an unhelpful
    error code with the broker's actual words.
    """
    diagnoses = diagnose_all(root)
    if not diagnoses:
        return (
            "No MetaTrader 5 data directories found. Is MT5 installed for this "
            "Windows user?"
        )

    lines: list[str] = []
    for d in diagnoses:
        label = d.instance.name or d.instance.hash[:12]
        lines.append(f"  {label}")
        lines.append(f"    {d.summary()}")
        if d.explanation:
            lines.append(f"    -> {d.explanation}")
        if d.algo_trading_enabled is False:
            lines.append("    -> Algo Trading is OFF in this terminal.")
    return "\n".join(lines)
