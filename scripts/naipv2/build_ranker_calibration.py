#!/usr/bin/env python3
"""Build a leakage-safe empirical CDF from the fixed NAIPv2 validation split."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from ranker_service.model import TransformersRanker


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--train-csv", required=True)
    parser.add_argument("--validation-ids", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-length", type=int, default=512)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = Path(args.output).resolve()
    if output.exists():
        raise SystemExit("Refusing to overwrite existing calibration: {}".format(output))
    train_csv = Path(args.train_csv).resolve()
    validation_ids_path = Path(args.validation_ids).resolve()
    validation_ids = [line.strip() for line in validation_ids_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    validation_set = set(validation_ids)
    frame = pd.read_csv(train_csv, dtype={"id": str})
    frame = frame[frame["id"].isin(validation_set)].copy()
    if len(frame) != len(validation_set):
        missing = len(validation_set) - len(frame)
        raise SystemExit("Validation IDs missing from training CSV: {}".format(missing))
    by_id = frame.set_index("id")
    frame = by_id.loc[validation_ids].reset_index()
    papers = [
        {
            "paper_id": str(row.id),
            "title": "" if pd.isna(row.title) else str(row.title),
            "abstract": "" if pd.isna(row.abstract) else str(row.abstract),
        }
        for row in frame.itertuples(index=False)
    ]
    ranker = TransformersRanker({
        "model": {
            "base_model_path": args.base_model,
            "adapter_path": args.adapter,
            "calibration_path": None,
            "max_length": args.max_length,
            "batch_size": args.batch_size,
            "device": "cuda:0",
            "adapter_version": "retrained-paper-faithful-seed42",
        }
    })
    scores = ranker.score_raw(papers)
    payload = {
        "schema_version": "1.0.0",
        "source": "NAIDv2 fixed seed-42 validation split",
        "rows": len(scores),
        "prompt_version": ranker.info()["prompt_version"],
        "max_length": args.max_length,
        "train_csv_sha256": sha256_file(train_csv),
        "validation_ids_sha256": sha256_file(validation_ids_path),
        "adapter": str(Path(args.adapter).resolve()),
        "scores": sorted(round(float(value), 8) for value in scores),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "rows": len(scores),
        "min": min(scores),
        "max": max(scores),
        "sha256": sha256_file(output),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
