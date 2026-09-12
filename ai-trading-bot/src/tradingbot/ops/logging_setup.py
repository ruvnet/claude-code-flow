"""Logging configuration.

Two sinks: a readable console stream and a rotating file that keeps the full
history. The file matters -- when something goes wrong at 3am on a Tuesday the
console scrollback is long gone, and "why did it take that trade" is only
answerable from the log plus the journal.
"""
from __future__ import annotations

import logging
import logging.handlers
import sys
from pathlib import Path

FORMAT = "%(asctime)s %(levelname)-7s %(name)-28s %(message)s"
DATEFMT = "%Y-%m-%d %H:%M:%S"


class _ColourFormatter(logging.Formatter):
    COLOURS = {
        "DEBUG": "\033[38;5;245m",
        "INFO": "\033[38;5;39m",
        "WARNING": "\033[38;5;214m",
        "ERROR": "\033[38;5;203m",
        "CRITICAL": "\033[48;5;203m\033[38;5;231m",
    }
    RESET = "\033[0m"

    def __init__(self, use_colour: bool) -> None:
        super().__init__(FORMAT, DATEFMT)
        self.use_colour = use_colour

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)
        if not self.use_colour:
            return text
        colour = self.COLOURS.get(record.levelname, "")
        return f"{colour}{text}{self.RESET}" if colour else text


def setup(
    level: str = "INFO",
    log_dir: str | Path = "var/logs",
    filename: str = "tradingbot.log",
    quiet_console: bool = False,
) -> None:
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    for h in list(root.handlers):
        root.removeHandler(h)

    numeric = getattr(logging, str(level).upper(), logging.INFO)

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.WARNING if quiet_console else numeric)
    console.setFormatter(_ColourFormatter(sys.stdout.isatty()))
    root.addHandler(console)

    d = Path(log_dir)
    d.mkdir(parents=True, exist_ok=True)
    file_handler = logging.handlers.RotatingFileHandler(
        d / filename, maxBytes=10 * 1024 * 1024, backupCount=10, encoding="utf-8"
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter(FORMAT, DATEFMT))
    root.addHandler(file_handler)

    # A separate errors-only file so incident review starts from a short file.
    error_handler = logging.handlers.RotatingFileHandler(
        d / "errors.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(logging.Formatter(FORMAT, DATEFMT))
    root.addHandler(error_handler)

    for noisy in ("urllib3", "matplotlib", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
