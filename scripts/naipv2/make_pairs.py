#!/usr/bin/env python3
"""Sample same-year pairwise training examples from RTS labels.

Each example is a (a, b) pair with label = I[RTS_a > RTS_b]. Pairs with an RTS gap
below the margin are dropped (NAIPv2 Tab. 14b: margin 0.05 is best). For v0 we group
by year only; domain clustering is a later refinement (NAIPv2 Tab. 3).
"""

import argparse
import json
import pathlib
import random


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def paper_text(row):
    return "Title: {}\n\nAbstract: {}".format(row["title"], row["abstract"])


def main():
    parser = argparse.ArgumentParser(description="Sample pairwise training examples")
    parser.add_argument("--rts", required=True, help="output of extract_rts.py")
    parser.add_argument("--out", required=True)
    parser.add_argument("--num-pairs", type=int, default=10000)
    parser.add_argument("--margin", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--year", type=int, default=2025, help="train on this year only")
    args = parser.parse_args()

    random.seed(args.seed)
    rows = [r for r in read_jsonl(args.rts) if r["year"] == args.year and r.get("rts") is not None]
    if len(rows) < 2:
        raise SystemExit("year={} 只有 {} 篇，无法组对。".format(args.year, len(rows)))

    texts = [paper_text(r) for r in rows]
    rts = [float(r["rts"]) for r in rows]

    pairs = []
    attempts = 0
    while len(pairs) < args.num_pairs and attempts < args.num_pairs * 200:
        attempts += 1
        a, b = random.sample(range(len(rows)), 2)
        gap = abs(rts[a] - rts[b])
        if gap < args.margin:
            continue
        label = 1 if rts[a] > rts[b] else 0
        pairs.append(
            {
                "a_text": texts[a],
                "b_text": texts[b],
                "label": label,
                "rts_a": rts[a],
                "rts_b": rts[b],
            }
        )

    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        for pair in pairs:
            handle.write(json.dumps(pair, ensure_ascii=False) + "\n")

    pos = sum(1 for p in pairs if p["label"] == 1)
    print(
        json.dumps(
            {
                "papers": len(rows),
                "pairs": len(pairs),
                "positive_ratio": round(pos / len(pairs), 4) if pairs else None,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
