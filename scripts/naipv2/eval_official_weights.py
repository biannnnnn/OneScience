#!/usr/bin/env python3
"""Evaluate the published NAIPv2 weights on the public NAIDv2 test CSV.

This intentionally follows the public NAIP v2 pointwise evaluation semantics while
using ``AutoModelForSequenceClassification``.  The published Hugging Face snapshot
is a complete model, not a PEFT adapter, so the repository's AutoPeft loader cannot
load it directly.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import platform
import re
import subprocess
import sys
import time
from pathlib import Path

import accelerate
import bitsandbytes
import numpy as np
import pandas as pd
import peft
import scipy
import sklearn
import torch
import transformers
from scipy.stats import spearmanr
from sklearn.metrics import (
    accuracy_score,
    ndcg_score,
    precision_recall_fscore_support,
    roc_auc_score,
)
from torch.utils.data import DataLoader, Dataset
from tqdm.auto import tqdm
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    BitsAndBytesConfig,
)


OFFICIAL_MODEL_ID = "ssocean/NAIPv2"
OFFICIAL_MODEL_REVISION = "174b3728a2517012b26b51764252c1688fab7ba0"
OFFICIAL_CODE_REVISION = "272a480713cb7412d889a061421559a16bf4e398"
OFFICIAL_TEST_SHA256 = "bbbd4ccc1a84761579e6faf54c3248bba0c3456696c0a9897889390aaef2095e"
PUBLIC_TEST_ROWS = 1028
PROMPT_TEMPLATE = (
    "Given a certain paper, Title: {title}\n"
    "Abstract: {abstract}\n"
    "Evaluate the quality of this paper:"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate the fixed NAIPv2 public weights and test set."
    )
    parser.add_argument("--model", required=True, help="Local NAIPv2 snapshot path")
    parser.add_argument("--test-csv", required=True, help="NAIDv2-test.csv path")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--precision",
        choices=("8bit", "fp16"),
        default="8bit",
        help="The public test script uses 8-bit loading.",
    )
    parser.add_argument(
        "--allow-asset-mismatch",
        action="store_true",
        help="Permit a test CSV whose checksum or row count differs from the fixed asset.",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_text(value: object) -> str:
    if pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


class OfficialPointwiseDataset(Dataset):
    def __init__(self, frame: pd.DataFrame, tokenizer, max_length: int):
        self.frame = frame.reset_index(drop=True)
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.frame)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        row = self.frame.iloc[index]
        prompt = PROMPT_TEMPLATE.format(
            title=normalize_text(row["title"]),
            abstract=normalize_text(row["abstract"]),
        )
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
    value_range = values.max() - values.min()
    if not np.isfinite(value_range) or value_range < 1e-8:
        return np.zeros_like(values)
    return (values - values.min()) / (value_range + 1e-8)


def threshold_metrics(scores: np.ndarray, labels: np.ndarray) -> dict[str, dict[str, float]]:
    """Match the public evaluator's exhaustive score-threshold sweep."""
    candidates = np.concatenate(([math.inf], np.unique(scores)[::-1]))
    best: dict[str, dict[str, float] | None] = {"best_f1": None, "best_accuracy": None}
    for threshold in candidates:
        predicted = (scores >= threshold).astype(int)
        precision, recall, f1, _ = precision_recall_fscore_support(
            labels, predicted, average="binary", zero_division=0
        )
        row = {
            "threshold": float(threshold),
            "precision": float(precision),
            "recall": float(recall),
            "f1": float(f1),
            "accuracy": float(accuracy_score(labels, predicted)),
        }
        if best["best_f1"] is None or row["f1"] > best["best_f1"]["f1"]:
            best["best_f1"] = row
        if (
            best["best_accuracy"] is None
            or row["accuracy"] > best["best_accuracy"]["accuracy"]
        ):
            best["best_accuracy"] = row
    return best  # type: ignore[return-value]


def gpu_metadata() -> str | None:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "-i",
                "0",
                "--query-gpu=name,driver_version,memory.total",
                "--format=csv,noheader",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None


def main() -> None:
    args = parse_args()
    model_path = Path(args.model).resolve()
    test_path = Path(args.test_csv).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not torch.cuda.is_available():
        raise SystemExit("CUDA GPU is required for the official 8B evaluation.")
    if not model_path.is_dir():
        raise SystemExit(f"Model snapshot does not exist: {model_path}")
    if not test_path.is_file():
        raise SystemExit(f"Test CSV does not exist: {test_path}")

    test_sha256 = sha256_file(test_path)
    frame = pd.read_csv(test_path)
    required = {"id", "title", "abstract", "RTS", "accept"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise SystemExit(f"Test CSV is missing columns: {missing}")
    if not args.allow_asset_mismatch:
        if test_sha256 != OFFICIAL_TEST_SHA256:
            raise SystemExit(
                f"Test checksum mismatch: expected {OFFICIAL_TEST_SHA256}, got {test_sha256}"
            )
        if len(frame) != PUBLIC_TEST_ROWS:
            raise SystemExit(
                f"Public test row-count mismatch: expected {PUBLIC_TEST_ROWS}, got {len(frame)}"
            )

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
    if tokenizer.pad_token is None and tokenizer.eos_token is not None:
        tokenizer.pad_token = tokenizer.eos_token

    load_kwargs: dict[str, object] = {
        "device_map": {"": 0},
        "dtype": torch.float16,
        "local_files_only": True,
    }
    if args.precision == "8bit":
        load_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_8bit=True)

    started_at = time.time()
    model = AutoModelForSequenceClassification.from_pretrained(model_path, **load_kwargs)
    model.config.pad_token_id = tokenizer.pad_token_id
    model.eval()

    dataset = OfficialPointwiseDataset(frame, tokenizer, args.max_length)
    loader = DataLoader(
        dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=args.num_workers,
        pin_memory=True,
    )

    predicted_rows: list[tuple[int, float]] = []
    with torch.inference_mode():
        for batch in tqdm(loader, desc="NAIPv2 official eval", unit="batch"):
            inputs = {
                "input_ids": batch["input_ids"].to("cuda:0", non_blocking=True),
                "attention_mask": batch["attention_mask"].to("cuda:0", non_blocking=True),
            }
            logits = model(**inputs).logits.view(-1).float().cpu().numpy()
            indices = batch["index"].numpy()
            predicted_rows.extend((int(index), float(score)) for index, score in zip(indices, logits))

    predicted_rows.sort(key=lambda item: item[0])
    if len(predicted_rows) != len(frame):
        raise RuntimeError(f"Expected {len(frame)} predictions, got {len(predicted_rows)}")
    scores = np.asarray([score for _, score in predicted_rows], dtype=float)
    rts = frame["RTS"].to_numpy(dtype=float)
    accepts = frame["accept"].to_numpy(dtype=int)

    spearman_value = spearmanr(rts, scores).statistic
    metrics = {
        "auc": float(roc_auc_score(accepts, scores)),
        "spearman": 0.0 if np.isnan(spearman_value) else float(spearman_value),
        "ndcg_at_20": float(
            ndcg_score([safe_minmax(rts)], [safe_minmax(scores)], k=20)
        ),
        "thresholds_on_test_for_official_parity_only": threshold_metrics(scores, accepts),
        "rows": int(len(frame)),
        "accepted": int(accepts.sum()),
        "rejected": int((accepts == 0).sum()),
        "elapsed_seconds": round(time.time() - started_at, 3),
    }

    predictions = frame[["id", "pub_year", "cluster_cat", "RTS", "accept"]].copy()
    predictions["pred"] = scores
    predictions["abs_error"] = np.abs(rts - scores)
    predictions.to_csv(output_dir / "predictions.csv", index=False)

    environment = {
        "model_id": OFFICIAL_MODEL_ID,
        "model_revision": OFFICIAL_MODEL_REVISION,
        "code_revision": OFFICIAL_CODE_REVISION,
        "model_path": str(model_path),
        "test_csv": str(test_path),
        "test_sha256": test_sha256,
        "public_test_rows": int(len(frame)),
        "paper_declared_test_rows": 1029,
        "prompt_template": PROMPT_TEMPLATE,
        "max_length": args.max_length,
        "batch_size": args.batch_size,
        "precision": args.precision,
        "seed": args.seed,
        "python": sys.version,
        "platform": platform.platform(),
        "gpu": gpu_metadata(),
        "packages": {
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "accelerate": accelerate.__version__,
            "peft": peft.__version__,
            "bitsandbytes": bitsandbytes.__version__,
            "pandas": pd.__version__,
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "scikit_learn": sklearn.__version__,
        },
        "loader_compatibility_note": (
            "Published snapshot is a full LlamaForSequenceClassification model; "
            "AutoModelForSequenceClassification replaces the public script's PEFT-only loader."
        ),
    }

    with (output_dir / "metrics.json").open("w", encoding="utf-8") as handle:
        json.dump(metrics, handle, ensure_ascii=False, indent=2, allow_nan=False)
    with (output_dir / "environment.json").open("w", encoding="utf-8") as handle:
        json.dump(environment, handle, ensure_ascii=False, indent=2, allow_nan=False)
    with (output_dir / "metrics.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["AUC", "Spearman", "NDCG@20", "rows"])
        writer.writeheader()
        writer.writerow(
            {
                "AUC": metrics["auc"],
                "Spearman": metrics["spearman"],
                "NDCG@20": metrics["ndcg_at_20"],
                "rows": metrics["rows"],
            }
        )

    print(json.dumps(metrics, ensure_ascii=False, indent=2, allow_nan=False))
    print(f"Saved evaluation artifacts to {output_dir}")


if __name__ == "__main__":
    main()
