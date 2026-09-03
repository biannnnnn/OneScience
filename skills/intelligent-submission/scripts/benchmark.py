#!/usr/bin/env python3
"""Calculate a manuscript's descriptive position within one journal batch."""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any


def score(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number")
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= 100:
        raise ValueError(f"{label} must be between 0 and 100")
    return number


def percentile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * ratio
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 1)
    interpolated = ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
    return round(interpolated, 1)


def calculate(payload: dict[str, Any]) -> dict[str, Any]:
    manuscript = score(payload.get("manuscript_score"), "manuscript_score")
    raw_references = payload.get("reference_scores")
    if not isinstance(raw_references, list):
        raise ValueError("reference_scores must be an array")
    references = [score(value, f"reference_scores[{index}]") for index, value in enumerate(raw_references)]
    median = percentile(references, 0.5)
    delta = None if median is None else round(manuscript - median, 1)
    if delta is None:
        verdict = "insufficient_reference_data"
    elif delta >= 5:
        verdict = "above_recent_baseline"
    elif delta >= -5:
        verdict = "near_recent_baseline"
    else:
        verdict = "below_recent_baseline"
    confidence = "none" if not references else "very_low" if len(references) == 1 else "low" if len(references) == 2 else "descriptive"
    return {
        "manuscript_score": round(manuscript, 1),
        "reference_count": len(references),
        "reference_p25": percentile(references, 0.25) if len(references) >= 2 else None,
        "reference_median": median,
        "reference_p75": percentile(references, 0.75) if len(references) >= 2 else None,
        "delta_from_median": delta,
        "benchmark_verdict": verdict,
        "confidence": confidence,
        "is_acceptance_probability": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", help="JSON file; reads stdin when omitted")
    args = parser.parse_args()
    try:
        if args.input:
            with open(args.input, encoding="utf-8") as handle:
                payload = json.load(handle)
        else:
            payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("input must be a JSON object")
        json.dump(calculate(payload), sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"benchmark.py: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
