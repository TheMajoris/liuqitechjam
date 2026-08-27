#!/usr/bin/env python3
"""Verify the immutable Starter Kit and print its resolved benchmark contract."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT = ROOT / "configs" / "benchmarks" / "kuairand_pure.yaml"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_contract(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        contract = yaml.safe_load(handle)
    if not isinstance(contract, dict):
        raise ValueError(f"benchmark contract must be a mapping: {path}")
    return contract


def verify(contract_path: Path) -> dict[str, Any]:
    contract = load_contract(contract_path)
    starter = contract.get("starter_kit")
    if not isinstance(starter, dict):
        raise ValueError("contract is missing starter_kit")

    kit_dir = (ROOT / str(starter["directory"])).resolve()
    if ROOT not in kit_dir.parents:
        raise ValueError("starter_kit.directory must resolve inside the repository")

    inventory = []
    for entry in starter.get("protected_files", []):
        relative = Path(entry["path"])
        target = (kit_dir / relative).resolve()
        if kit_dir not in target.parents:
            raise ValueError(f"protected path escapes Starter Kit: {relative}")
        if not target.is_file():
            raise FileNotFoundError(f"protected Starter Kit file is missing: {relative}")
        actual = sha256(target)
        expected = str(entry["sha256"])
        if actual != expected:
            raise ValueError(
                f"protected Starter Kit file changed: {relative} "
                f"(expected {expected}, got {actual})"
            )
        inventory.append({"path": relative.as_posix(), "sha256": actual})

    if not inventory:
        raise ValueError("contract has no protected Starter Kit files")
    return {"protected_files": inventory, "benchmark_contract": contract}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    args = parser.parse_args()
    try:
        report = verify(args.contract.resolve())
    except (KeyError, OSError, TypeError, ValueError) as exc:
        print(f"Starter Kit verification failed: {exc}")
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
