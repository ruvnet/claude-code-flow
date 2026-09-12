"""Parsing MetaTrader 5 terminal logs.

The value of this module is turning `(-6, 'Authorization failed')` into
something a person can act on, so the tests are about distinguishing the
failure modes that error code flattens together.

Fixtures are written as UTF-16-LE with a BOM, matching what MT5 actually
produces.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from tradingbot.ops import mt5_diagnostics as D


def write_log(directory: Path, name: str, lines: list[str]) -> Path:
    """Create a log file in MT5's real on-disk format."""
    logs = directory / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    path = logs / name
    path.write_bytes("\n".join(lines).encode("utf-16"))
    return path


def instance_with(tmp_path: Path, lines: list[str], hash_name: str = "A" * 32):
    d = tmp_path / hash_name
    write_log(d, "20260906.log", lines)
    return d


BANNER = "CP\t0\t15:19:36.837\tTerminal\tMetaTrader 5 IC Markets Global x64 build 6182 started for Raw Trading Ltd"


class TestLogDecoding:
    def test_reads_utf16_with_bom(self, tmp_path):
        instance_with(tmp_path, [BANNER])
        instances = D.find_instances(tmp_path)
        assert len(instances) == 1
        assert "IC Markets Global" in instances[0].name

    def test_ignores_non_instance_directories(self, tmp_path):
        instance_with(tmp_path, [BANNER])
        for skip in ("Common", "Community", "Help"):
            write_log(tmp_path / skip, "20260906.log", [BANNER])
        assert len(D.find_instances(tmp_path)) == 1

    def test_ignores_non_dated_logs(self, tmp_path):
        d = tmp_path / ("B" * 32)
        write_log(d, "metaeditor.log", ["0\t11:22:28\tCompiler\tcompiled x.mq5"])
        instances = D.find_instances(tmp_path)
        assert instances[0].last_log is None

    def test_missing_root_is_not_an_error(self, tmp_path):
        assert D.find_instances(tmp_path / "nope") == []

    def test_corrupt_log_does_not_raise(self, tmp_path):
        d = tmp_path / ("C" * 32)
        logs = d / "logs"
        logs.mkdir(parents=True)
        (logs / "20260906.log").write_bytes(b"\xff\xfe\x00\x01\x02\x03random")
        assert D.diagnose(D.find_instances(tmp_path)[0]) is not None


class TestAuthDiagnosis:
    def _diagnose(self, tmp_path, lines):
        instance_with(tmp_path, [BANNER, *lines])
        return D.diagnose(D.find_instances(tmp_path)[0])

    def test_invalid_account(self, tmp_path):
        """The real-world case: an expired demo."""
        r = self._diagnose(tmp_path, [
            "DO\t2\t15:20:34.898\tNetwork\t'124578369': authorization on "
            "ICMarketsSC-Demo failed (Invalid account)"
        ])
        assert r.kind == "invalid_account"
        assert r.login == "124578369"
        assert r.server == "ICMarketsSC-Demo"
        assert r.is_failure
        assert "expired demo" in r.explanation

    def test_invalid_password_mentions_investor_passwords(self, tmp_path):
        """An investor password logs in read-only and cannot trade -- a
        confusing failure worth calling out by name."""
        r = self._diagnose(tmp_path, [
            "DO\t2\t15:20:34.898\tNetwork\t'999': authorization on Broker-Live "
            "failed (Invalid password)"
        ])
        assert r.kind == "invalid_password"
        assert "investor" in r.explanation.lower()

    def test_no_connection(self, tmp_path):
        r = self._diagnose(tmp_path, [
            "DI\t2\t15:19:50.867\tNetwork\t'124578369': no connection to "
            "ICMarketsSC-Demo"
        ])
        assert r.kind == "no_connection"
        assert r.server == "ICMarketsSC-Demo"

    def test_successful_authorization(self, tmp_path):
        r = self._diagnose(tmp_path, [
            "AB\t0\t15:20:00.000\tNetwork\t'555666': authorized on "
            "ICMarketsSC-Demo"
        ])
        assert r.kind == "authorized"
        assert not r.is_failure
        assert r.login == "555666"

    def test_most_recent_outcome_wins(self, tmp_path):
        """A failure followed by a success must report the success."""
        r = self._diagnose(tmp_path, [
            "DO\t2\t15:20:34.898\tNetwork\t'111': authorization on S failed "
            "(Invalid account)",
            "AB\t0\t15:21:00.000\tNetwork\t'222': authorized on S",
        ])
        assert r.kind == "authorized"
        assert r.login == "222"

    def test_no_login_attempt_is_unknown_not_failure(self, tmp_path):
        r = self._diagnose(tmp_path, [])
        assert r.kind == "unknown"
        assert not r.is_failure

    def test_detects_algo_trading_state(self, tmp_path):
        on = self._diagnose(tmp_path, [
            "CR\t0\t15:19:49.953\tExperts\tautomated trading is enabled"
        ])
        assert on.algo_trading_enabled is True

    def test_login_prefix_not_duplicated_in_summary(self, tmp_path):
        r = self._diagnose(tmp_path, [
            "DO\t2\t15:20:34.898\tNetwork\t'124578369': authorization on S "
            "failed (Invalid account)"
        ])
        # The account number should appear once, not twice.
        assert r.summary().count("124578369") == 1


class TestExplainConnectionFailure:
    def test_reports_every_instance(self, tmp_path):
        instance_with(tmp_path, [
            BANNER,
            "DO\t2\t15:20:34\tNetwork\t'111': authorization on S1 failed "
            "(Invalid account)",
        ], hash_name="A" * 32)
        instance_with(tmp_path, [
            "RH\t0\t15:20:48\tTerminal\tMetaTrader 5 x64 build 4524 started "
            "for MetaQuotes Ltd.",
            "QJ\t2\t15:19:12\tNetwork\t'222': authorization on S2 failed "
            "(Invalid account)",
        ], hash_name="B" * 32)

        text = D.explain_connection_failure(tmp_path)
        assert "111" in text and "222" in text
        assert "S1" in text and "S2" in text

    def test_handles_no_terminals(self, tmp_path):
        text = D.explain_connection_failure(tmp_path / "missing")
        assert "No MetaTrader 5 data directories" in text
