#!/usr/bin/env python3
"""Prepare a deterministic, balanced NAIDv2 subset for DeepSeek/NAIPv2 A/B evaluation."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path


EXPECTED_TEST_SHA256 = "bbbd4ccc1a84761579e6faf54c3248bba0c3456696c0a9897889390aaef2095e"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def evenly_spaced(rows: list[dict], count: int) -> list[dict]:
    ordered = sorted(rows, key=lambda row: (row["rts"], row["paper_id"]))
    if count == 1:
        return [ordered[len(ordered) // 2]]
    indexes = [round(index * (len(ordered) - 1) / (count - 1)) for index in range(count)]
    return [ordered[index] for index in indexes]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-csv", required=True)
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--size", type=int, default=32)
    args = parser.parse_args()

    if args.size < 8 or args.size % 2:
        raise SystemExit("--size must be an even number >= 8")
    test_csv = Path(args.test_csv).resolve()
    predictions_csv = Path(args.predictions).resolve()
    output_dir = Path(args.output_dir).resolve()
    if sha256_file(test_csv) != EXPECTED_TEST_SHA256:
        raise SystemExit("NAIDv2 test CSV checksum mismatch")

    with test_csv.open("r", encoding="utf-8", newline="") as handle:
        papers = list(csv.DictReader(handle))
    with predictions_csv.open("r", encoding="utf-8", newline="") as handle:
        prediction_by_id = {row["id"]: row for row in csv.DictReader(handle)}

    usable = []
    for paper in papers:
        prediction = prediction_by_id.get(paper["id"])
        if not prediction or not paper.get("title", "").strip() or not paper.get("abstract", "").strip():
            continue
        usable.append({
            "paper_id": paper["id"],
            "title": paper["title"].strip(),
            "abstract": paper["abstract"].strip(),
            "rts": float(paper["RTS"]),
            "accept": int(float(paper["accept"])),
            "pub_year": int(float(paper["pub_year"])),
            "cluster_cat": paper["cluster_cat"],
            "naipv2_score": float(prediction["pred"]),
        })

    per_label = args.size // 2
    rejected = evenly_spaced([row for row in usable if row["accept"] == 0], per_label)
    accepted = evenly_spaced([row for row in usable if row["accept"] == 1], per_label)
    selected = []
    for reject, accept in zip(rejected, accepted):
        selected.extend([reject, accept])

    output_dir.mkdir(parents=True, exist_ok=True)
    cases_path = output_dir / "cases.jsonl"
    with cases_path.open("w", encoding="utf-8") as handle:
        for row in selected:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    manifest = {
        "schema_version": "1.0.0",
        "source": "NAIDv2 fixed public test set",
        "test_csv_sha256": EXPECTED_TEST_SHA256,
        "official_predictions_sha256": sha256_file(predictions_csv),
        "usable_rows": len(usable),
        "selected_rows": len(selected),
        "accepted": sum(row["accept"] for row in selected),
        "rejected": len(selected) - sum(row["accept"] for row in selected),
        "selection": "evenly spaced across RTS separately within accept/reject; interleaved; deterministic",
        "cases_sha256": sha256_file(cases_path),
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
