from __future__ import annotations

import json
import statistics
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from evaluate import evaluate


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "configs" / "benchmarks" / "kuairand_pure.yaml"


def test_verifier_reports_frozen_contract() -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "verify_starter_kit.py")],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert len(report["protected_files"]) == 5
    assert report["benchmark_contract"]["evaluation"]["primary"]["formula"] == (
        "mean(GAUC, nDCG@5)"
    )


def test_verifier_rejects_a_hash_mismatch(tmp_path: Path) -> None:
    with CONTRACT.open(encoding="utf-8") as handle:
        contract = yaml.safe_load(handle)
    contract["starter_kit"]["protected_files"][0]["sha256"] = "0" * 64
    tampered_contract = tmp_path / "contract.yaml"
    with tampered_contract.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(contract, handle)

    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "verify_starter_kit.py"),
            "--contract",
            str(tampered_contract),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "protected Starter Kit file changed" in result.stdout


def test_actual_evaluator_matches_frozen_aggregation_rules() -> None:
    # u1 has one positive and one negative; u2 is all-negative and contributes
    # zero to nDCG while being excluded from GAUC.
    result = evaluate(
        user_ids=["u1", "u1", "u2", "u2"],
        labels=[1, 0, 0, 0],
        scores=[1.0, 0.0, 1.0, 0.0],
    )
    assert result == {
        "GAUC": 1.0,
        "nDCG@5": 0.5,
        "primary": 0.75,
        "users": 2,
        "rows": 4,
    }


@pytest.mark.integration
def test_official_fm_baseline_reproduces_published_scores() -> None:
    with CONTRACT.open(encoding="utf-8") as handle:
        contract = yaml.safe_load(handle)
    data_dir = ROOT / contract["data"]["directory"]
    required = (
        "video_features_basic_pure.csv",
        "log_standard_4_08_to_4_21_pure.csv",
        "log_standard_4_22_to_5_08_pure.csv",
    )
    if not all((data_dir / name).is_file() for name in required):
        pytest.skip(f"official dataset is not installed at {data_dir}")

    runs: list[dict[str, dict[str, float]]] = []
    for seed in contract["baseline"]["seeds"]:
        result = subprocess.run(
            [
                sys.executable,
                "baseline.py",
                "--data_dir",
                str(data_dir),
                "--model",
                contract["baseline"]["model"],
                "--seed",
                str(seed),
            ],
            cwd=ROOT / contract["starter_kit"]["directory"],
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )
        observed: dict[str, dict[str, float]] = {}
        for line in result.stdout.splitlines():
            fields = line.split()
            if len(fields) == 9 and fields[0] in {"valid", "test"}:
                observed[fields[0]] = {
                    "GAUC": float(fields[2]),
                    "nDCG@5": float(fields[5]),
                    "primary": float(fields[8]),
                }
        assert observed.keys() == {"valid", "test"}, result.stdout
        runs.append(observed)

    tolerance = contract["baseline"]["verification_absolute_tolerance"]
    for split, expected_metrics in contract["baseline"]["references"].items():
        for metric, expected in expected_metrics.items():
            mean = statistics.fmean(run[split][metric] for run in runs)
            assert mean == pytest.approx(expected, abs=tolerance)
