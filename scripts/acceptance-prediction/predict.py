#!/usr/bin/env python3
"""Predict calibrated acceptance probability from a manuscript and frozen review."""

import argparse
import json
import pathlib
import sys


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from acceptance_prediction import AcceptancePredictor, ModelError


def main():
    parser = argparse.ArgumentParser(description="Run OneScience acceptance predictor")
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", required=True, help="JSON with manuscript, target_venue and review (or score + model_trace for a score-contract model)")
    parser.add_argument("--out")
    args = parser.parse_args()
    with pathlib.Path(args.input).open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    predictor = AcceptancePredictor.load(args.model)
    try:
        if predictor.feature_contract == "score":
            result = predictor.predict_from_score(
                payload["manuscript"],
                payload["target_venue"],
                payload.get("score") or {},
                payload.get("model_trace") or {},
            )
        else:
            result = predictor.predict(
                payload["manuscript"], payload["target_venue"], payload["review"]
            )
    except (KeyError, ModelError) as error:
        raise SystemExit(str(error)) from error
    body = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        destination = pathlib.Path(args.out)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(body, encoding="utf-8")
    else:
        print(body, end="")


if __name__ == "__main__":
    main()
