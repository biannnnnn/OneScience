#!/usr/bin/env python3
"""Compare small NAIPv2 rankers with the frozen 8B public-test baseline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


DEFAULT_MARGINS = {"auc": 0.02, "spearman": 0.03, "ndcg_at_20": 0.03}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--run", action="append", required=True, help="label=metrics.json")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    baseline_path = Path(args.baseline).resolve()
    baseline = read_json(baseline_path)
    rows = []
    for item in args.run:
        label, separator, raw_path = item.partition("=")
        if not separator or not label or not raw_path:
            raise SystemExit("--run 必须使用 label=metrics.json")
        path = Path(raw_path).resolve()
        metrics = read_json(path)
        comparisons = {}
        for metric, margin in DEFAULT_MARGINS.items():
            value = float(metrics[metric])
            reference = float(baseline[metric])
            comparisons[metric] = {
                "value": value,
                "baseline": reference,
                "delta": value - reference,
                "margin": margin,
                "within_margin": value >= reference - margin,
            }
        rows.append({
            "label": label,
            "metrics_path": str(path),
            "metrics": {key: metrics[key] for key in DEFAULT_MARGINS},
            "comparison": comparisons,
            "close_on_all_frozen_margins": all(value["within_margin"] for value in comparisons.values()),
        })

    payload = {
        "schema_version": "1.0.0",
        "baseline_metrics_path": str(baseline_path),
        "margins": DEFAULT_MARGINS,
        "interpretation": "A close result is a screening criterion, not a statistical equivalence claim.",
        "runs": rows,
    }
    output = Path(args.out).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
