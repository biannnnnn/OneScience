#!/usr/bin/env python3
"""Build a reproducible, label-balanced subset of acceptance cases."""

import argparse
import hashlib
import json
import pathlib


SPLITS = ("train", "validation", "test")


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def successful_case_ids(path):
    if not path:
        return set()
    source = pathlib.Path(path)
    if not source.exists():
        return set()
    return {
        row.get("case_id")
        for row in read_jsonl(source)
        if row.get("status") == "ok" and row.get("review")
    }


def stable_key(seed, case):
    value = "{}|{}|{}|{}".format(
        seed,
        case.get("split"),
        int(case.get("decision_label")),
        case.get("case_id"),
    )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def label_targets(total):
    # Assign the extra item in an odd-sized split to accept (label 1).
    return {0: total // 2, 1: total - total // 2}


def choose_cases(cases, successful, targets, seed, require_success):
    selected = []
    stats = {}
    for split in SPLITS:
        split_selected = []
        quotas = label_targets(targets[split])
        label_stats = {}
        for label in (0, 1):
            pool = [
                case
                for case in cases
                if case.get("split") == split
                and int(case.get("decision_label")) == label
                and (not require_success or case.get("case_id") in successful)
            ]
            # Reuse completed work first; hash order makes each group reproducible.
            pool.sort(
                key=lambda case: (
                    0 if case.get("case_id") in successful else 1,
                    stable_key(seed, case),
                )
            )
            quota = quotas[label]
            if len(pool) < quota:
                raise SystemExit(
                    "{} label={} 只有 {} 条可选，少于目标 {} 条。".format(
                        split, label, len(pool), quota
                    )
                )
            chosen = pool[:quota]
            split_selected.extend(chosen)
            label_stats[str(label)] = {
                "selected": len(chosen),
                "already_successful": sum(
                    case.get("case_id") in successful for case in chosen
                ),
                "pending": sum(case.get("case_id") not in successful for case in chosen),
            }
        split_selected.sort(key=lambda case: stable_key(seed, case))
        selected.extend(split_selected)
        stats[split] = {
            "target": targets[split],
            "selected": len(split_selected),
            "already_successful": sum(
                case.get("case_id") in successful for case in split_selected
            ),
            "pending": sum(
                case.get("case_id") not in successful for case in split_selected
            ),
            "labels": label_stats,
        }
    return selected, stats


def main():
    parser = argparse.ArgumentParser(
        description="Create a deterministic stratified acceptance subset"
    )
    parser.add_argument("--cases", required=True)
    parser.add_argument("--reviews")
    parser.add_argument("--out", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--train", type=int, required=True)
    parser.add_argument("--validation", type=int, required=True)
    parser.add_argument("--test", type=int, required=True)
    parser.add_argument("--seed", default="onescience-acceptance-stratified-v0.1")
    parser.add_argument(
        "--require-success",
        action="store_true",
        help="Only select cases that already have a successful frozen-reviewer result",
    )
    args = parser.parse_args()

    targets = {
        "train": args.train,
        "validation": args.validation,
        "test": args.test,
    }
    if any(value < 2 for value in targets.values()):
        parser.error("每个 split 的目标数必须至少为 2")

    cases = read_jsonl(args.cases)
    case_ids = [case.get("case_id") for case in cases]
    if len(case_ids) != len(set(case_ids)):
        raise SystemExit("源 cases 中存在重复 case_id。")
    successful = successful_case_ids(args.reviews)
    selected, stats = choose_cases(
        cases, successful, targets, args.seed, args.require_success
    )

    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        for case in selected:
            handle.write(json.dumps(case, ensure_ascii=False) + "\n")

    manifest_path = (
        pathlib.Path(args.manifest)
        if args.manifest
        else destination.with_suffix(".manifest.json")
    )
    manifest = {
        "schema_version": "1.0.0",
        "source_cases": str(pathlib.Path(args.cases)),
        "source_reviews": str(pathlib.Path(args.reviews)) if args.reviews else None,
        "output_cases": str(destination),
        "seed": args.seed,
        "require_success": args.require_success,
        "selected_total": len(selected),
        "splits": stats,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
