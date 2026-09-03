#!/usr/bin/env python3
"""Create one auditable summary table for the three full-text Ranker runs."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="append", required=True, help="label=metrics.json")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    rows = []
    for item in args.run:
        label, separator, raw_path = item.partition("=")
        if not separator:
            raise SystemExit("--run 必须使用 label=metrics.json")
        path = Path(raw_path).resolve()
        metrics = json.loads(path.read_text(encoding="utf-8"))
        row = {
            "model": label,
            "auc": metrics["auc"],
            "spearman": metrics["spearman"],
            "ndcg_at_20": metrics["ndcg_at_20"],
            "pairwise_accuracy": metrics["pairwise_accuracy"],
            "rows": metrics["rows"],
            "inference_seconds": metrics["elapsed_seconds"],
            "median_input_tokens": metrics["input_tokens"]["median"],
            "truncated_rows": metrics["input_tokens"]["truncated_rows"],
            "api_tokens": metrics["api_tokens"],
            "metrics_path": str(path),
        }
        rows.append(row)
    output = Path(args.out).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": "1.0.0",
        "protocol": "same held-out ProReview full-text evidence test set",
        "interpretation": (
            "Metrics quantify agreement with held-out reviewer outcomes; they do not "
            "establish objective paper quality or acceptance probability."
        ),
        "runs": rows,
    }
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with output.with_suffix(".csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
