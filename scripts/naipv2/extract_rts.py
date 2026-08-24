#!/usr/bin/env python3
"""Extract RTS (Review Tendency Signal) labels from the ProReviewer parquet.

For each submission we collapse the per-review initial_rating + confidence into a
single scalar quality label (RTS), following NAIPv2 (arXiv:2509.25179, App. F):

    score normalization:   s = (rating - min_rating) / (max_rating - min_rating)
    confidence:            c = alpha + (1 - alpha) * (conf - min_conf) / (max_conf - min_conf)
    sigma(c)  = 0.2 * (1 - c) + 0.05
    RTS       = sum(s_i / sigma_i^2) / sum(1 / sigma_i^2)     # precision-weighted mean

Alongside RTS we keep title + abstract (model input) and the raw decision (evaluation).
"""

import argparse
import json
import pathlib
import re

import pyarrow.parquet as parquet


ALPHA = 0.2  # confidence normalization lower bound (best in NAIPv2 Tab. 7b)


def sigma(confidence):
    return 0.2 * (1.0 - confidence) + 0.05


def extract_abstract(markdown, max_chars=1024):
    text = str(markdown or "")
    match = re.search(
        r"(?m)^#{1,4}\s*Abstract\b[^\n]*\n(.*?)(?=^#{1,4}\s|\Z)",
        text,
        flags=re.S,
    )
    body = match.group(1) if match else text
    return re.sub(r"\s+", " ", body).strip()[:max_chars]


def decision_label(decision):
    value = str(decision or "").lower()
    if "accept" in value:
        return 1
    if value and ("reject" in value or "withdraw" in value or "decline" in value):
        return 0
    return None


def load_cases(parquet_path, year):
    """Yield (paper_id, ratings, confidences, decision, title, abstract) per paper."""
    table = parquet.read_table(parquet_path)
    for row in table.to_pylist():
        reviews = row.get("reviews") or []
        ratings, confidences = [], []
        for review in reviews:
            rating = review.get("initial_rating")
            confidence = review.get("confidence")
            if rating is not None:
                ratings.append(int(rating))
                confidences.append(int(confidence) if confidence is not None else 0)
        if not ratings:
            continue
        decision = (row.get("decision") or {}).get("decision")
        yield {
            "paper_id": row.get("paper_id"),
            "year": year,
            "title": (row.get("title") or "").strip(),
            "abstract": extract_abstract((row.get("markdown") or {}).get("content")),
            "ratings": ratings,
            "confidences": confidences,
            "decision": decision,
        }


def compute_rts(ratings, confidences, rating_min, rating_max, confidence_min, confidence_max):
    numerator, denominator = 0.0, 0.0
    rating_span = rating_max - rating_min or 1.0
    confidence_span = confidence_max - confidence_min or 1.0
    for rating, confidence in zip(ratings, confidences):
        s = (rating - rating_min) / rating_span
        c = ALPHA + (1.0 - ALPHA) * (confidence - confidence_min) / confidence_span
        weight = 1.0 / (sigma(c) ** 2)
        numerator += s * weight
        denominator += weight
    return numerator / denominator


def main():
    parser = argparse.ArgumentParser(description="Extract RTS labels from ProReviewer parquet")
    parser.add_argument("--train-parquet", required=True)
    parser.add_argument("--test-parquet", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--min-reviews", type=int, default=1)
    args = parser.parse_args()

    cases = list(load_cases(args.train_parquet, 2025)) + list(load_cases(args.test_parquet, 2026))
    cases = [case for case in cases if len(case["ratings"]) >= args.min_reviews]

    all_ratings = [r for case in cases for r in case["ratings"]]
    all_confidences = [c for case in cases for c in case["confidences"]]
    rating_min, rating_max = min(all_ratings), max(all_ratings)
    confidence_min, confidence_max = min(all_confidences), max(all_confidences)

    rows = []
    for case in cases:
        rts = compute_rts(
            case["ratings"],
            case["confidences"],
            rating_min,
            rating_max,
            confidence_min,
            confidence_max,
        )
        rows.append(
            {
                "paper_id": case["paper_id"],
                "year": case["year"],
                "split": "train" if case["year"] == 2025 else "test",
                "title": case["title"],
                "abstract": case["abstract"],
                "rts": round(rts, 6),
                "n_reviews": len(case["ratings"]),
                "rating_avg": round(sum(case["ratings"]) / len(case["ratings"]), 3),
                "decision": case["decision"],
                "decision_label": decision_label(case["decision"]),
            }
        )

    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    summary = {
        "total": len(rows),
        "rating_range": [rating_min, rating_max],
        "confidence_range": [confidence_min, confidence_max],
        "by_year": {year: sum(1 for r in rows if r["year"] == year) for year in (2025, 2026)},
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
