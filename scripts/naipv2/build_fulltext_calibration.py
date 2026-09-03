#!/usr/bin/env python3
"""Build an empirical score calibration from the training run's internal validation split."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--train-csv", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    predictions = Path(args.predictions).resolve()
    train_csv = Path(args.train_csv).resolve()
    adapter = Path(args.adapter).resolve()
    output = Path(args.output).resolve()
    frame = pd.read_csv(predictions)
    if "pred" not in frame or len(frame) < 2:
        raise SystemExit("Validation predictions must contain at least two pred values")
    scores = sorted(float(value) for value in frame["pred"].dropna())
    if len(scores) < 2:
        raise SystemExit("Validation predictions contain too few finite scores")
    payload = {
        "schema_version": "1.0.0",
        "source": "seed-42 internal 10% validation split of ProReview training data",
        "rows": len(scores),
        "prompt_version": "naipv2-fulltext-evidence-pointwise-1.0.0",
        "input_schema": "fulltext_evidence_v1",
        "max_length": 1024,
        "train_csv_sha256": sha256_file(train_csv),
        "validation_predictions_sha256": sha256_file(predictions),
        "adapter": str(adapter),
        "scores": scores,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in payload.items() if key != "scores"}, indent=2))


if __name__ == "__main__":
    main()
