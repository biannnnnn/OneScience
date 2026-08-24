#!/usr/bin/env python3
"""Score held-out papers with a trained pairwise scorer and report AUC / Spearman.

Pointwise inference: each paper's title+abstract is scored once (NAIPv2 Eq. 8).
The primary metric is AUC of the predicted score against the accept/reject decision;
we also report Spearman against the ground-truth RTS quality signal.
"""

import argparse
import json
import pathlib

import torch
from peft import PeftModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer, BitsAndBytesConfig


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def paper_text(row):
    return "Title: {}\n\nAbstract: {}".format(row["title"], row["abstract"])


def roc_auc(y_true, y_score):
    """Rank-based ROC AUC (Mann-Whitney U) with tie averaging."""
    n_pos = sum(1 for y in y_true if y == 1)
    n_neg = len(y_true) - n_pos
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    pairs = sorted(zip(y_score, y_true), key=lambda item: item[0])
    rank_sum = 0.0
    i = 0
    n = len(pairs)
    while i < n:
        j = i
        while j < n and pairs[j][0] == pairs[i][0]:
            j += 1
        avg_rank = (i + j - 1) / 2.0 + 1.0  # 1-indexed average rank
        for k in range(i, j):
            if pairs[k][1] == 1:
                rank_sum += avg_rank
        i = j
    u = rank_sum - n_pos * (n_pos + 1) / 2.0
    return u / (n_pos * n_neg)


def spearman(x, y):
    def ranks(values):
        order = sorted(range(len(values)), key=lambda i: values[i])
        out = [0.0] * len(values)
        i = 0
        while i < len(values):
            j = i
            while j < len(values) and values[order[j]] == values[order[i]]:
                j += 1
            avg = (i + j - 1) / 2.0
            for k in range(i, j):
                out[order[k]] = avg
            i = j
        return out

    rx, ry = ranks(x), ranks(y)
    n = len(x)
    mx = sum(rx) / n
    my = sum(ry) / n
    cov = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    sx = (sum((rx[i] - mx) ** 2 for i in range(n))) ** 0.5
    sy = (sum((ry[i] - my) ** 2 for i in range(n))) ** 0.5
    return cov / (sx * sy) if sx * sy > 0 else 0.0


def main():
    parser = argparse.ArgumentParser(description="Evaluate NAIPv2-style pairwise scorer")
    parser.add_argument("--model", default="models/Qwen3-8B")
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--rts", required=True)
    parser.add_argument("--year", type=int, default=2026, help="held-out year to score")
    parser.add_argument("--cutoff", type=int, default=512)
    args = parser.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.adapter, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    base = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=1,
        quantization_config=bnb,
        torch_dtype=torch.bfloat16,
        device_map={"": 0},
        trust_remote_code=True,
    )
    model = PeftModel.from_pretrained(base, args.adapter)
    model.eval()

    rows = [r for r in read_jsonl(args.rts) if r["year"] == args.year]
    scores = []
    for row in rows:
        enc = tokenizer(
            paper_text(row),
            truncation=True,
            max_length=args.cutoff,
            padding="max_length",
            return_tensors="pt",
        )
        with torch.no_grad():
            logit = model(
                input_ids=enc["input_ids"].to("cuda"),
                attention_mask=enc["attention_mask"].to("cuda"),
            ).logits.squeeze(-1)
        scores.append(float(logit.item()))

    labeled = [(row, score) for row, score in zip(rows, scores) if row["decision_label"] is not None]
    y_true = [row["decision_label"] for row, _ in labeled]
    y_score = [score for _, score in labeled]
    rts_all = [row["rts"] for row, score in zip(rows, scores)]

    result = {
        "year": args.year,
        "scored": len(rows),
        "labeled": len(labeled),
        "auc_vs_decision": round(roc_auc(y_true, y_score), 4) if labeled else None,
        "spearman_vs_rts": round(spearman([s for _, s in zip(rows, scores)], rts_all), 4),
    }
    if labeled:
        # accuracy at threshold 0 (logit midpoint)
        acc = sum(1 for y, s in zip(y_true, y_score) if (s >= 0) == bool(y)) / len(y_true)
        result["acc_at_zero"] = round(acc, 4)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
