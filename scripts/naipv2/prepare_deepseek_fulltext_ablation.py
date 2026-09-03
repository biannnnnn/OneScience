#!/usr/bin/env python3
"""Prepare leakage-controlled ProReview cases for DeepSeek input ablation."""

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


def clean(value: object) -> str:
    return " ".join(str(value or "").split())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-csv", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    source = Path(args.test_csv).resolve()
    output = Path(args.output).resolve()
    frame = pd.read_csv(source)
    required = {
        "source_paper_id", "title", "abstract_only", "research_question_contributions",
        "experimental_setup_datasets", "key_findings_conclusion", "RTS", "accept",
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise SystemExit(f"Missing columns: {missing}")
    frame = frame.sample(frac=1, random_state=args.seed).reset_index(drop=True)
    rows = []
    for batch_position, row in frame.iterrows():
        evidence = {
            "paper_id": clean(row["source_paper_id"]),
            "title": clean(row["title"]),
            "abstract": clean(row["abstract_only"]),
            "research_question_contributions": clean(row["research_question_contributions"]),
            "experimental_setup_datasets": clean(row["experimental_setup_datasets"]),
            "key_findings_conclusion": clean(row["key_findings_conclusion"]),
            "rts": float(row["RTS"]),
            "accept": int(row["accept"]),
            "fixed_order": int(batch_position),
        }
        if any(not evidence[key] for key in (
            "paper_id", "title", "abstract", "research_question_contributions",
            "experimental_setup_datasets", "key_findings_conclusion",
        )):
            raise SystemExit(f"Incomplete evidence at source row {row.name}")
        rows.append(evidence)
    if len({row["paper_id"] for row in rows}) != len(rows):
        raise SystemExit("Duplicate paper_id values")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    manifest = {
        "schema_version": "1.0.0",
        "dataset": "ProReview full-text evidence DeepSeek ablation",
        "rows": len(rows),
        "seed": args.seed,
        "variants": ["title_abstract", "fulltext_evidence"],
        "ground_truth": ["confidence-weighted reviewer rating", "decision when known"],
        "excluded_from_model_input": [
            "authors", "affiliations", "venue", "citations", "references",
            "reviews", "meta_review", "decision", "RTS",
        ],
        "source_sha256": sha256_file(source),
        "cases_sha256": sha256_file(output),
    }
    output.with_suffix(".manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
