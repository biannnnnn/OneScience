#!/usr/bin/env python3
"""Run one real NAIPv2 Ranker optimizer step with the official stack."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import torch
from accelerate.utils import set_seed
from torch.optim import AdamW
from torch.utils.data import DataLoader


PROMPT_TEMPLATE = (
    "Given a scientific paper, Title: {title}\n"
    "Abstract: {abstract}\n"
    "Please evaluate the overall scientific quality:"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--patched-source", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--train-csv", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--max-pairs", type=int, default=10_000)
    return parser.parse_args()


def gpu_snapshot() -> str | None:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,used_memory",
                "--format=csv,noheader,nounits",
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
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    sys.path.insert(0, str(Path(args.patched_source).resolve()))
    from v2_resource.NAIDv2.dataset import PairwisePaperDataset
    from v2_resource.v2_finetune import PairwiseBCELoss, get_model_and_tokenizer

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required")
    set_seed(args.seed)
    before_gpu = gpu_snapshot()
    model_args = SimpleNamespace(
        checkpoint=str(Path(args.checkpoint).resolve()),
        num_labels=1,
        loss_func="default",
        target_modules="q_proj,v_proj",
        lora_r=16,
        lora_alpha=32,
        lora_dropout=0.05,
    )
    started = time.time()
    tokenizer, model = get_model_and_tokenizer(model_args)

    frame = pd.read_csv(args.train_csv)
    shuffled = frame.sample(frac=1.0, random_state=args.seed).reset_index(drop=True)
    train_frame = shuffled.iloc[: int(len(shuffled) * 0.9)].reset_index(drop=True)
    dataset = PairwisePaperDataset(
        data=train_frame,
        tokenizer=tokenizer,
        max_length=512,
        prompt_template=PROMPT_TEMPLATE,
        gt_field="RTS",
        max_pairs=args.max_pairs,
        seed=args.seed,
        group_by_cluster_year=True,
        group_keys=("pub_year", "cluster_cat"),
        min_diff=0.05,
        bucket_edges=[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, float("inf")],
        target_ratio=[0.03, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16, 0.27, 0.00],
        curriculum=True,
        balance=True,
        cap_per_paper=32,
        use_weight=True,
        weight_mode="linear_clip",
        weight_clip_min=0.2,
        weight_clip_max=1.0,
        verbose=True,
    )
    loader = DataLoader(
        dataset,
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=lambda rows: rows,
    )
    optimizer = AdamW(model.parameters(), lr=1e-4, weight_decay=1e-2)
    loss_fn = PairwiseBCELoss()
    model.train()
    trainable_before = {
        name: parameter.detach().cpu().clone()
        for name, parameter in model.named_parameters()
        if parameter.requires_grad
    }
    torch.cuda.reset_peak_memory_stats()
    batch = next(iter(loader))
    device = torch.device("cuda:0")
    input_ids_a = torch.stack([row["input_ids_a"] for row in batch]).to(device)
    attention_a = torch.stack([row["attention_mask_a"] for row in batch]).to(device)
    input_ids_b = torch.stack([row["input_ids_b"] for row in batch]).to(device)
    attention_b = torch.stack([row["attention_mask_b"] for row in batch]).to(device)
    score_a = torch.stack([row["gt_a"] for row in batch]).to(device)
    score_b = torch.stack([row["gt_b"] for row in batch]).to(device)

    pred_a_before, pred_b_before = model(input_ids_a, attention_a, input_ids_b, attention_b)
    loss = loss_fn(pred_a_before, pred_b_before, score_a, score_b)
    loss.backward()
    trainable_gradients = {
        name: float(parameter.grad.detach().float().norm().cpu())
        for name, parameter in model.named_parameters()
        if parameter.requires_grad and parameter.grad is not None
    }
    gradient_norm_before_clip = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0))
    optimizer.step()
    optimizer.zero_grad(set_to_none=True)
    changed = {}
    for name, parameter in model.named_parameters():
        if name in trainable_before:
            delta = float((parameter.detach().cpu() - trainable_before[name]).float().norm())
            if delta > 0:
                changed[name] = delta

    result = {
        "status": "ok",
        "seed": args.seed,
        "batch_size": args.batch_size,
        "max_pairs": args.max_pairs,
        "loss": float(loss.detach().cpu()),
        "prediction_diff_before": [
            float(value) for value in (pred_a_before - pred_b_before).detach().cpu()
        ],
        "gradient_norm_before_clip": gradient_norm_before_clip,
        "gradient_tensors": len(trainable_gradients),
        "nonzero_gradient_tensors": sum(value > 0 for value in trainable_gradients.values()),
        "changed_trainable_tensors": len(changed),
        "max_parameter_delta": max(changed.values(), default=0.0),
        "allocated_mib_after_step": round(torch.cuda.memory_allocated() / 1024**2, 2),
        "peak_allocated_mib_step": round(torch.cuda.max_memory_allocated() / 1024**2, 2),
        "peak_reserved_mib_step": round(torch.cuda.max_memory_reserved() / 1024**2, 2),
        "elapsed_seconds": round(time.time() - started, 3),
        "gpu_processes_before": before_gpu,
        "gpu_processes_after": gpu_snapshot(),
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
