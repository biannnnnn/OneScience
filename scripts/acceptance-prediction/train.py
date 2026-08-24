#!/usr/bin/env python3
"""Train and evaluate the calibrated acceptance prediction layer."""

import argparse
import json
import pathlib
import sys


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from acceptance_prediction import ModelError, train_model


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def join_cases_reviews(cases, predictions):
    reviews = {
        item["case_id"]: item.get("review")
        for item in predictions
        if item.get("status") == "ok" and item.get("review")
    }
    joined = []
    for case in cases:
        review = reviews.get(case["case_id"])
        if review:
            joined.append({**case, "review": review})
    return joined


def join_cases_scores(cases, predictions):
    scores = {
        item["case_id"]: item.get("score")
        for item in predictions
        if item.get("status") == "ok" and item.get("score")
    }
    traces = {
        item["case_id"]: item.get("model_trace")
        for item in predictions
        if item.get("status") == "ok" and item.get("score")
    }
    joined = []
    for case in cases:
        score = scores.get(case["case_id"])
        if score is not None:
            joined.append({**case, "score": score, "model_trace": traces.get(case["case_id"])})
    return joined


def main():
    parser = argparse.ArgumentParser(description="Train calibrated OneScience acceptance predictor")
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--report")
    parser.add_argument("--feature-mode", choices=("review", "score"), default="review")
    parser.add_argument("--reviews", help="frozen-review features JSONL (review mode)")
    parser.add_argument("--scores", help="venue-score features JSONL (score mode)")
    parser.add_argument("--epochs", type=int, default=1600)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--l2", type=float, default=0.02)
    parser.add_argument("--min-train-samples", type=int, default=100)
    parser.add_argument("--min-validation-samples", type=int, default=100)
    parser.add_argument("--min-test-samples", type=int, default=100)
    args = parser.parse_args()
    cases = read_jsonl(args.cases)
    if args.feature_mode == "score":
        if not args.scores:
            parser.error("--feature-mode score 需要 --scores")
        predictions = read_jsonl(args.scores)
        rows = join_cases_scores(cases, predictions)
    else:
        if not args.reviews:
            parser.error("--feature-mode review 需要 --reviews")
        predictions = read_jsonl(args.reviews)
        rows = join_cases_reviews(cases, predictions)
    required_counts = {
        "train": args.min_train_samples,
        "validation": args.min_validation_samples,
        "test": args.min_test_samples,
    }
    for split, minimum in required_counts.items():
        selected = [row for row in rows if row.get("split") == split]
        if len(selected) < minimum:
            raise SystemExit(
                "可用 {} 样本只有 {}，低于要求的 {}。".format(split, len(selected), minimum)
            )
        if len({int(row["decision_label"]) for row in selected}) < 2:
            raise SystemExit("{} 样本必须同时包含 accept 和 reject。".format(split))
    try:
        model = train_model(
            rows,
            learning_rate=args.learning_rate,
            epochs=args.epochs,
            l2=args.l2,
            feature_mode=args.feature_mode,
        )
    except ModelError as error:
        raise SystemExit(str(error)) from error
    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        json.dump(model, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    report_path = pathlib.Path(args.report) if args.report else destination.with_suffix(".report.json")
    report = {
        "model_id": model["model_id"],
        "sample_counts": model["sample_counts"],
        "metrics": model["metrics"],
        "historical_rate_baseline_metrics": model["historical_rate_baseline_metrics"],
        "reviewer_signature": model["reviewer_signature"],
        "warning": "模型未通过时间外校准门槛前，不得在产品中宣称真实录用概率。",
    }
    with report_path.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
