#!/usr/bin/env python3
"""Score an arbitrary blind title/abstract JSONL with a trained NAIPv2 LoRA adapter."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import peft
import torch
import transformers
from peft import PeftModel
from torch.utils.data import DataLoader, Dataset
from tqdm.auto import tqdm
from transformers import AutoModelForSequenceClassification, AutoTokenizer, BitsAndBytesConfig


PROMPT_TEMPLATE = (
    "Given a certain paper, Title: {title}\n"
    "Abstract: {abstract}\n"
    "Evaluate the quality of this paper:"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-key", required=True)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def load_rows(path: Path) -> list[dict[str, str]]:
    rows = []
    seen = set()
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            paper_id = normalize(row.get("paper_id"))
            title = normalize(row.get("title"))
            abstract = normalize(row.get("abstract"))
            if not paper_id or not title or not abstract:
                raise ValueError(f"Incomplete blind input at line {line_number}")
            if paper_id in seen:
                raise ValueError(f"Duplicate paper_id: {paper_id}")
            seen.add(paper_id)
            rows.append({"paper_id": paper_id, "title": title, "abstract": abstract})
    if not rows:
        raise ValueError("Blind input is empty")
    return rows


class BlindDataset(Dataset):
    def __init__(self, rows: list[dict[str, str]], tokenizer, max_length: int):
        self.rows = rows
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        row = self.rows[index]
        encoded = self.tokenizer(
            PROMPT_TEMPLATE.format(title=row["title"], abstract=row["abstract"]),
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


def gpu_metadata() -> str | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "-i", "0", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None


def main() -> None:
    args = parse_args()
    base_model = Path(args.base_model).resolve()
    adapter = Path(args.adapter).resolve()
    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required")
    if not base_model.is_dir():
        raise SystemExit(f"Missing base model: {base_model}")
    if not (adapter / "adapter_config.json").is_file():
        raise SystemExit(f"Incomplete adapter: {adapter}")
    rows = load_rows(input_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    tokenizer = AutoTokenizer.from_pretrained(adapter, local_files_only=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

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
        BlindDataset(rows, tokenizer, args.max_length),
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
        pin_memory=True,
    )
    predictions: list[tuple[int, float]] = []
    with torch.inference_mode():
        for batch in tqdm(loader, desc=f"score {args.model_key}", unit="batch"):
            logits = model(
                input_ids=batch["input_ids"].to("cuda:0", non_blocking=True),
                attention_mask=batch["attention_mask"].to("cuda:0", non_blocking=True),
            ).logits.view(-1)
            predictions.extend(
                (int(index), float(score))
                for index, score in zip(batch["index"].numpy(), logits.float().cpu().numpy())
            )
    predictions.sort(key=lambda item: item[0])
    if len(predictions) != len(rows):
        raise RuntimeError(f"Expected {len(rows)} scores, got {len(predictions)}")

    score_rows = [
        {"paper_id": rows[index]["paper_id"], "raw_score": score}
        for index, score in predictions
    ]
    (output_dir / "scores.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in score_rows),
        encoding="utf-8",
    )
    adapter_files = ["adapter_config.json", "adapter_model.bin", "adapter_model.safetensors", "onescience-experiment.json"]
    run = {
        "schema_version": "1.0.0",
        "model_key": args.model_key,
        "base_model": str(base_model),
        "adapter": str(adapter),
        "papers": len(rows),
        "prompt_version": "naipv2-official-pointwise-1.0.0",
        "prompt_template": PROMPT_TEMPLATE,
        "max_length": args.max_length,
        "batch_size": args.batch_size,
        "quantization": "bitsandbytes-8bit",
        "seed": args.seed,
        "elapsed_seconds": round(time.time() - started, 3),
        "peak_gpu_memory_bytes": None,
        "input_sha256": sha256_file(input_path),
        "adapter_hashes": {
            name: sha256_file(adapter / name)
            for name in adapter_files
            if (adapter / name).is_file()
        },
        "gpu": gpu_metadata(),
        "python": sys.version,
        "platform": platform.platform(),
        "packages": {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__},
    }
    try:
        run["peak_gpu_memory_bytes"] = int(torch.cuda.max_memory_allocated(0))
    except RuntimeError:
        pass
    (output_dir / "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(run, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
