#!/usr/bin/env python3
"""Remove outcome-bearing venue metadata from prepared acceptance cases."""

import argparse
import collections
import json
import pathlib


OUTCOME_TOKENS = ("reject", "withdraw", "poster", "spotlight", "oral")


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def sanitize_case(case):
    source = case.get("source") or {}
    source_venue = str(source.get("venue_id") or "").lower()
    if "withdraw" in source_venue:
        return None
    year = int(source.get("year"))
    clean = dict(case)
    clean["decision_case_schema_version"] = "1.1.0"
    clean["target_venue"] = {
        "id": "ICLR.cc/{}/Conference".format(year),
        "name": "ICLR {}".format(year),
    }
    return clean


def main():
    parser = argparse.ArgumentParser(
        description="Normalize inference-time venue fields and exclude withdrawals"
    )
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--manifest")
    args = parser.parse_args()

    source_rows = read_jsonl(args.cases)
    clean_rows = []
    excluded = collections.Counter()
    for case in source_rows:
        clean = sanitize_case(case)
        if clean is None:
            excluded["withdrawn_submission"] += 1
            continue
        venue_text = "{} {}".format(
            clean["target_venue"]["id"], clean["target_venue"]["name"]
        ).lower()
        matched = [token for token in OUTCOME_TOKENS if token in venue_text]
        if matched:
            raise SystemExit(
                "清洗后的 target_venue 仍包含结果词：{}（case_id={}）".format(
                    matched, clean.get("case_id")
                )
            )
        clean_rows.append(clean)

    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        for case in clean_rows:
            handle.write(json.dumps(case, ensure_ascii=False) + "\n")

    distribution = collections.Counter(
        (case["split"], int(case["decision_label"])) for case in clean_rows
    )
    manifest = {
        "schema_version": "1.0.0",
        "source_cases": str(pathlib.Path(args.cases)),
        "output_cases": str(destination),
        "input_count": len(source_rows),
        "output_count": len(clean_rows),
        "excluded": dict(excluded),
        "target_venue_policy": "ICLR.cc/{year}/Conference; no outcome-specific status",
        "distribution": {
            split: {
                "reject": distribution[(split, 0)],
                "accept": distribution[(split, 1)],
            }
            for split in ("train", "validation", "test")
        },
    }
    manifest_path = (
        pathlib.Path(args.manifest)
        if args.manifest
        else destination.with_suffix(".manifest.json")
    )
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
