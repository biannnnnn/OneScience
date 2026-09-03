#!/usr/bin/env python3
"""Evaluate a NAIPv2-compatible adapter on the held-out full-text evidence set."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import peft
import scipy
import sklearn
import torch
import transformers
from peft import PeftModel
from scipy.stats import spearmanr
from sklearn.metrics import ndcg_score, roc_auc_score
from torch.utils.data import DataLoader, Dataset
from tqdm.auto import tqdm
from transformers import AutoModelForSequenceClassification, AutoTokenizer, BitsAndBytesConfig


PROMPT_TEMPLATE = (
    "Given a certain paper, Title: {title}\n"
    "Abstract: {evidence}\n"
    "Evaluate the quality of this paper:"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--test-csv", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-key", required=True)
    parser.add_argument("--text-column", default="abstract")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--max-length", type=int, default=1024)
    parser.add_argument("--pair-sample", type=int, default=10000)
    parser.add_argument("--bootstrap-samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class EvidenceDataset(Dataset):
    def __init__(self, frame: pd.DataFrame, tokenizer, text_column: str, max_length: int):
        self.frame = frame.reset_index(drop=True)
        self.tokenizer = tokenizer
        self.text_column = text_column
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.frame)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        row = self.frame.iloc[index]
        prompt = PROMPT_TEMPLATE.format(title=str(row["title"]), evidence=str(row[self.text_column]))
        encoded = self.tokenizer(
            prompt,
            max_length=self.max_length,
            padding="max_length",
            truncation=True,
            return_tensors="pt",
        )
        return {
            "index": torch.tensor(index, dtype=torch.long),
            "input_ids": encoded["input_ids"].squeeze(0).to(torch.long),
            "attention_mask": encoded["attention_mask"].squeeze(0).to(torch.long),
        }


def safe_minmax(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    span = float(values.max() - values.min())
    return np.zeros_like(values) if span == 0 else (values - values.min()) / span


def point_metrics(frame: pd.DataFrame, scores: np.ndarray) -> dict[str, float]:
    labels = frame["RTS"].to_numpy(dtype=float)
    known = frame["accept"].isin([0, 1]).to_numpy()
    accepts = frame.loc[known, "accept"].to_numpy(dtype=int)
    auc = float(roc_auc_score(accepts, scores[known])) if len(np.unique(accepts)) == 2 else float("nan")
    correlation = float(spearmanr(labels, scores).statistic)
    return {
        "auc": auc,
        "spearman": 0.0 if np.isnan(correlation) else correlation,
        "ndcg_at_20": float(ndcg_score([safe_minmax(labels)], [safe_minmax(scores)], k=20)),
    }


def sampled_pairwise_accuracy(
    frame: pd.DataFrame, scores: np.ndarray, limit: int, seed: int
) -> tuple[float, int]:
    candidates: list[tuple[int, int]] = []
    for _, group in frame.groupby(["pub_year", "cluster_cat"], dropna=False):
        indexes = group.index.to_numpy(dtype=int)
        labels = frame.loc[indexes, "RTS"].to_numpy(dtype=float)
        left, right = np.triu_indices(len(indexes), k=1)
        for i, j in zip(left, right):
            if labels[i] != labels[j]:
                candidates.append((int(indexes[i]), int(indexes[j])))
    if not candidates:
        return float("nan"), 0
    rng = np.random.default_rng(seed)
    if len(candidates) > limit:
        selected = rng.choice(len(candidates), size=limit, replace=False)
        candidates = [candidates[index] for index in selected]
    correct = [
        (scores[i] - scores[j]) * (float(frame.at[i, "RTS"]) - float(frame.at[j, "RTS"])) > 0
        for i, j in candidates
    ]
    ties = [scores[i] == scores[j] for i, j in candidates]
    value = np.mean([0.5 if tie else float(ok) for ok, tie in zip(correct, ties)])
    return float(value), len(candidates)


def bootstrap_intervals(
    frame: pd.DataFrame, scores: np.ndarray, samples: int, seed: int
) -> dict[str, list[float]]:
    rng = np.random.default_rng(seed)
    values: dict[str, list[float]] = {"auc": [], "spearman": [], "ndcg_at_20": []}
    for _ in range(samples):
        indexes = rng.integers(0, len(frame), size=len(frame))
        sample = frame.iloc[indexes].reset_index(drop=True)
        try:
            metrics = point_metrics(sample, scores[indexes])
        except ValueError:
            continue
        for key, value in metrics.items():
            if np.isfinite(value):
                values[key].append(value)
    return {
        key: [float(np.quantile(items, 0.025)), float(np.quantile(items, 0.975))]
        for key, items in values.items()
        if items
    }


def gpu_metadata() -> str | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "-i", "0", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
            check=True, capture_output=True, text=True,
        )
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None


def main() -> None:
    args = parse_args()
    base_model = Path(args.base_model).resolve()
    adapter = Path(args.adapter).resolve()
    test_csv = Path(args.test_csv).resolve()
    output_dir = Path(args.output_dir).resolve()
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required")
    if not base_model.is_dir():
        raise SystemExit(f"Missing base model: {base_model}")
    if not (adapter / "adapter_config.json").is_file():
        raise SystemExit(f"Incomplete adapter: {adapter}")
    frame = pd.read_csv(test_csv)
    required = {"id", "title", args.text_column, "RTS", "accept", "pub_year", "cluster_cat"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise SystemExit(f"Test CSV is missing columns: {missing}")
    if frame[["title", args.text_column, "RTS"]].isna().any().any():
        raise SystemExit("Test CSV contains missing model input or target values")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    tokenizer = AutoTokenizer.from_pretrained(adapter, local_files_only=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    token_lengths = [
        len(tokenizer(PROMPT_TEMPLATE.format(title=row.title, evidence=getattr(row, args.text_column))).input_ids)
        for row in frame.itertuples(index=False)
    ]

    started = time.time()
    try:
        torch.cuda.reset_peak_memory_stats(0)
    except RuntimeError:
        pass
    base = AutoModelForSequenceClassification.from_pretrained(
        base_model,
        num_labels=1,
        device_map={"": 0},
        torch_dtype=torch.float16,
        quantization_config=BitsAndBytesConfig(load_in_8bit=True),
        local_files_only=True,
    )
    base.config.pad_token_id = tokenizer.pad_token_id
    model = PeftModel.from_pretrained(base, adapter, is_trainable=False)
    model.eval()
    loader = DataLoader(
        EvidenceDataset(frame, tokenizer, args.text_column, args.max_length),
        batch_size=args.batch_size, shuffle=False, num_workers=0, pin_memory=True,
    )
    predictions: list[tuple[int, float]] = []
    with torch.inference_mode():
        for batch in tqdm(loader, desc=f"evaluate {args.model_key}", unit="batch"):
            logits = model(
                input_ids=batch["input_ids"].to("cuda:0", non_blocking=True),
                attention_mask=batch["attention_mask"].to("cuda:0", non_blocking=True),
            ).logits.view(-1)
            predictions.extend(
                (int(index), float(score))
                for index, score in zip(batch["index"].numpy(), logits.float().cpu().numpy())
            )
    predictions.sort(key=lambda item: item[0])
    if len(predictions) != len(frame):
        raise RuntimeError(f"Expected {len(frame)} predictions, got {len(predictions)}")
    scores = np.asarray([score for _, score in predictions], dtype=float)
    metrics = point_metrics(frame, scores)
    pair_accuracy, pair_count = sampled_pairwise_accuracy(frame, scores, args.pair_sample, args.seed)
    metrics.update({
        "pairwise_accuracy": pair_accuracy,
        "pairwise_pairs": pair_count,
        "confidence_intervals_95pct": bootstrap_intervals(frame, scores, args.bootstrap_samples, args.seed),
        "rows": int(len(frame)),
        "elapsed_seconds": round(time.time() - started, 3),
        "input_tokens": {
            "median": int(np.median(token_lengths)),
            "p95": int(np.quantile(token_lengths, 0.95)),
            "max": int(max(token_lengths)),
            "truncated_rows": int(sum(length > args.max_length for length in token_lengths)),
        },
        "api_tokens": 0,
    })
    output_dir.mkdir(parents=True, exist_ok=True)
    output = frame[["id", "source_paper_id", "pub_year", "cluster_cat", "RTS", "accept"]].copy()
    output["pred"] = scores
    output.to_csv(output_dir / "predictions.csv", index=False)
    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    environment = {
        "model_key": args.model_key,
        "base_model": str(base_model),
        "adapter": str(adapter),
        "test_csv": str(test_csv),
        "test_csv_sha256": sha256_file(test_csv),
        "text_column": args.text_column,
        "prompt_template": PROMPT_TEMPLATE,
        "max_length": args.max_length,
        "batch_size": args.batch_size,
        "seed": args.seed,
        "gpu": gpu_metadata(),
        "peak_gpu_memory_bytes": int(torch.cuda.max_memory_allocated(0)),
        "python": sys.version,
        "platform": platform.platform(),
        "packages": {
            "torch": torch.__version__, "transformers": transformers.__version__,
            "peft": peft.__version__, "scipy": scipy.__version__,
            "scikit_learn": sklearn.__version__, "pandas": pd.__version__,
        },
    }
    (output_dir / "environment.json").write_text(json.dumps(environment, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
