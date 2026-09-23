"""Checks for the DeepSWE drift early-detection experiment.

The offline test validates the metric/fitting code with synthetic trajectories.
The live test is opt-in (DEEPSWE_RUN=1): it runs a real DeepSWE task with
deepseek-v4.1-flash through the OpenCode inference API while the drift pipeline
scores every turn, then fits the heuristic parameters from the logs.

    DEEPSWE_RUN=1 pytest tests/test_js_drift_early_detection.py -v
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "deepswe" / "run.ts"
ANALYZER = ROOT / "scripts" / "deepswe" / "analyze.ts"
SELFTEST = ROOT / "scripts" / "deepswe" / "selftest.ts"
ANALYSIS = ROOT / "experiments" / "deepswe" / "analysis"


def bun(*args: str, timeout: int = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bun", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ},
    )


def test_metrics_selftest_offline() -> None:
    result = bun(str(SELFTEST), timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "all metric checks passed" in result.stdout


@pytest.mark.skipif(os.environ.get("DEEPSWE_RUN") != "1", reason="set DEEPSWE_RUN=1 for the live DeepSWE run")
def test_js_drift_early_detection_deepswe() -> None:
    run = bun(
        str(RUNNER),
        "run",
        "--tasks",
        "mashumaro-flattened-dataclass-fields",
        "--arms",
        "control,distractor",
        "--rollouts",
        "1",
        "--max-turns",
        "6",
        "--inject-at",
        "2",
        "--deadline-min",
        "8",
        timeout=2400,
    )
    assert run.returncode == 0, run.stdout + run.stderr

    analyze = bun(str(ANALYZER), timeout=300)
    assert analyze.returncode == 0, analyze.stdout + analyze.stderr

    params = json.loads((ANALYSIS / "params.json").read_text())
    assert params["runs"] >= 2
    assert params["best"]["stats"]["positives"] >= 1
    assert params["best"]["stats"]["detected"] >= 1, "injected drift never crossed the fitted threshold"
    assert (ANALYSIS / "report.md").exists()
