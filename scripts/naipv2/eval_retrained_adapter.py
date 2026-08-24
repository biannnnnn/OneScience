#!/usr/bin/env python3
"""Evaluate a reproduced NAIPv2 LoRA adapter on the fixed public test set."""

from __future__ import annotations

import argparse
import json
import os
import platform
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
from peft import PeftModel
from scipy.stats import spearmanr
from sklearn.metrics import ndcg_score, roc_auc_score
from torch.utils.data import DataLoader
from tqdm.auto import tqdm
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    BitsAndBytesConfig,
)

from eval_official_weights import (
    OFFICIAL_CODE_REVISION,
    OFFICIAL_TEST_SHA256,
    PUBLIC_TEST_ROWS,
    OfficialPointwiseDataset,
    safe_minmax,
    sha256_file,
    threshold_metrics,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--test-csv", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


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


def adapter_hashes(adapter_dir: Path) -> dict[str, str]:
    names = (
        "adapter_config.json",
        "adapter_model.bin",
        "adapter_model.safetensors",
        "args.json",
        "preparation.json",
    )
    return {
        name: sha256_file(adapter_dir / name)
        for name in names
        if (adapter_dir / name).is_file()
    }


def main() -> None:
    args = parse_args()
    base_model = Path(args.base_model).resolve()
    adapter_dir = Path(args.adapter).resolve()
    test_csv = Path(args.test_csv).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required")
    if not base_model.is_dir():
        raise SystemExit(f"Missing base model: {base_model}")
    if not (adapter_dir / "adapter_config.json").is_file():
        raise SystemExit(f"Training adapter is incomplete: {adapter_dir}")
    if sha256_file(test_csv) != OFFICIAL_TEST_SHA256:
        raise SystemExit("Fixed public test CSV checksum mismatch")

    frame = pd.read_csv(test_csv)
    if len(frame) != PUBLIC_TEST_ROWS:
        raise SystemExit(f"Expected {PUBLIC_TEST_ROWS} public test rows, got {len(frame)}")
    required = {"id", "title", "abstract", "RTS", "accept"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise SystemExit(f"Test CSV is missing columns: {missing}")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    tokenizer = AutoTokenizer.from_pretrained(adapter_dir, local_files_only=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    started_at = time.time()
    base = AutoModelForSequenceClassification.from_pretrained(
        base_model,
        num_labels=1,
        device_map={"": 0},
        torch_dtype=torch.float16,
        quantization_config=BitsAndBytesConfig(load_in_8bit=True),
        local_files_only=True,
    )
    base.config.pad_token_id = tokenizer.pad_token_id
    model = PeftModel.from_pretrained(base, adapter_dir, is_trainable=False)
    model.eval()

    loader = DataLoader(
        OfficialPointwiseDataset(frame, tokenizer, args.max_length),
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
        pin_memory=True,
    )
    rows: list[tuple[int, float]] = []
    with torch.inference_mode():
        for batch in tqdm(loader, desc="NAIPv2 reproduced adapter eval", unit="batch"):
            logits = model(
                input_ids=batch["input_ids"].to("cuda:0", non_blocking=True),
                attention_mask=batch["attention_mask"].to("cuda:0", non_blocking=True),
            ).logits.view(-1)
            rows.extend(
                (int(index), float(score))
                for index, score in zip(
                    batch["index"].numpy(), logits.float().cpu().numpy()
                )
            )

    rows.sort(key=lambda item: item[0])
    if len(rows) != len(frame):
        raise RuntimeError(f"Expected {len(frame)} predictions, got {len(rows)}")
    scores = np.asarray([score for _, score in rows], dtype=float)
    rts = frame["RTS"].to_numpy(dtype=float)
    accepts = frame["accept"].to_numpy(dtype=int)
    spearman_value = spearmanr(rts, scores).statistic
    metrics = {
        "auc": float(roc_auc_score(accepts, scores)),
        "spearman": 0.0 if np.isnan(spearman_value) else float(spearman_value),
        "ndcg_at_20": float(ndcg_score([safe_minmax(rts)], [safe_minmax(scores)], k=20)),
        "thresholds_on_test_for_official_parity_only": threshold_metrics(scores, accepts),
        "rows": len(frame),
        "elapsed_seconds": round(time.time() - started_at, 3),
    }

    predictions = frame[["id", "pub_year", "cluster_cat", "RTS", "accept"]].copy()
    predictions["pred"] = scores
    predictions["abs_error"] = np.abs(rts - scores)
    predictions.to_csv(output_dir / "predictions.csv", index=False)
    (output_dir / "metrics.json").write_text(
        json.dumps(metrics, indent=2) + "\n", encoding="utf-8"
    )
    pd.DataFrame(
        [{key: metrics[key] for key in ("auc", "spearman", "ndcg_at_20", "rows", "elapsed_seconds")}]
    ).to_csv(output_dir / "metrics.csv", index=False)
    environment = {
        "official_code_revision": OFFICIAL_CODE_REVISION,
        "base_model": str(base_model),
        "adapter": str(adapter_dir),
        "adapter_hashes": adapter_hashes(adapter_dir),
        "test_csv": str(test_csv),
        "test_csv_sha256": OFFICIAL_TEST_SHA256,
        "python": sys.version,
        "platform": platform.platform(),
        "gpu": gpu_metadata(),
        "packages": {
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "accelerate": accelerate.__version__,
            "peft": peft.__version__,
            "bitsandbytes": bitsandbytes.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scipy": scipy.__version__,
            "scikit_learn": sklearn.__version__,
        },
    }
    (output_dir / "environment.json").write_text(
        json.dumps(environment, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
