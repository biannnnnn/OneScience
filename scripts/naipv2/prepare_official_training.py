#!/usr/bin/env python3
"""Prepare the pinned NAIPv2 release code and a deterministic pair manifest.

The public training entrypoint cannot run as released.  This script verifies the
pinned assets, copies the source tree, applies only the two required runtime
fixes, and records the exact curriculum pairs used by training.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib
import json
import random
import shutil
import sys
from pathlib import Path
from typing import Any

import pandas as pd


OFFICIAL_CODE_REVISION = "272a480713cb7412d889a061421559a16bf4e398"
OFFICIAL_TRAIN_ROWS = 23_246
OFFICIAL_TRAIN_SHA256 = "c5d42dea04e25b04a3e13bc02a8eb9733cb3261347a0f06ab478297601cf5241"
SOURCE_SHA256 = {
    "v2_resource/v2_finetune.py": "d311d70f68c9b08c42b7d0e812b5edc096cd25acc93e92d40480c80a70fbcbfc",
    "v2_resource/NAIDv2/dataset.py": "77d633b8f16e9311147021ed3745837edde1ed108fc84599fc183b0dd555a656",
    "v2_resource/shell/fine-tune.sh": "721b9169be131f7888430939f376f5e3e329a10775a8eb06ce0352015a050d35",
    "requirements.txt": "47a902e1b7f08bb32c7ac02fbd0bf6f31a0f93286065ee965aa53b965eba16c5",
}
BUCKET_EDGES = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, float("inf")]
TARGET_RATIO = [0.03, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16, 0.27, 0.00]
PROMPT_TEMPLATE = (
    "Given a scientific paper, Title: {title}\n"
    "Abstract: {abstract}\n"
    "Please evaluate the overall scientific quality:"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--patched-dir", required=True)
    parser.add_argument("--train-csv", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--max-pairs", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(path: Path, expected: str) -> None:
    if not path.is_file():
        raise SystemExit(f"Missing pinned asset: {path}")
    actual = sha256_file(path)
    if actual != expected:
        raise SystemExit(f"Checksum mismatch for {path}: expected {expected}, got {actual}")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one {label} patch site, found {count}")
    return text.replace(old, new, 1)


def prepare_patched_source(source_dir: Path, patched_dir: Path) -> dict[str, str]:
    for relative, expected in SOURCE_SHA256.items():
        verify_file(source_dir / relative, expected)

    if patched_dir.exists():
        raise SystemExit(
            f"Patched directory already exists: {patched_dir}. "
            "Remove it explicitly before rebuilding from pinned source."
        )
    shutil.copytree(source_dir, patched_dir)

    entrypoint = patched_dir / "v2_resource/v2_finetune.py"
    text = entrypoint.read_text(encoding="utf-8")
    text = replace_once(
        text,
        "    model = model.to(device)\n",
        "    # Minimal compatibility fix: an 8-bit model is already placed by device_map.\n",
        "8-bit .to(device)",
    )
    text = replace_once(
        text,
        "    loss_fn = PairwiseBCELoss(args)  # noqa: F405\n",
        "    loss_fn = PairwiseBCELoss()\n",
        "PairwiseBCELoss constructor",
    )
    entrypoint.write_text(text, encoding="utf-8")

    return {relative: sha256_file(patched_dir / relative) for relative in SOURCE_SHA256}


def bucket_index(value: float) -> int:
    for index, (low, high) in enumerate(zip(BUCKET_EDGES, BUCKET_EDGES[1:])):
        if low <= value < high or (high == float("inf") and value >= low):
            return index
    raise ValueError(value)


def stable_value(row: dict[str, Any], key: str) -> str:
    value = row.get(key, "")
    if pd.isna(value):
        return ""
    return str(value)


def write_pair_manifest(
    patched_dir: Path,
    frame: pd.DataFrame,
    output_dir: Path,
    max_pairs: int,
    seed: int,
) -> dict[str, Any]:
    sys.path.insert(0, str(patched_dir))
    try:
        dataset_module = importlib.import_module("v2_resource.NAIDv2.dataset")
        dataset_type = dataset_module.PairwisePaperDataset
    finally:
        sys.path.pop(0)

    shuffled = frame.sample(frac=1.0, random_state=seed).reset_index(drop=True)
    split_index = int(len(shuffled) * 0.9)
    train_frame = shuffled.iloc[:split_index].reset_index(drop=True)
    val_frame = shuffled.iloc[split_index:].reset_index(drop=True)

    dataset = dataset_type(
        data=train_frame,
        tokenizer=None,
        max_length=512,
        prompt_template=PROMPT_TEMPLATE,
        gt_field="RTS",
        max_pairs=max_pairs,
        seed=seed,
        group_by_cluster_year=True,
        group_keys=("pub_year", "cluster_cat"),
        min_diff=0.05,
        bucket_edges=BUCKET_EDGES,
        target_ratio=TARGET_RATIO,
        curriculum=True,
        balance=True,
        cap_per_paper=32,
        id_fields_priority=("id",),
        use_weight=True,
        weight_mode="linear_clip",
        weight_clip_min=0.2,
        weight_clip_max=1.0,
        additional_info=[],
        verbose=True,
    )

    # Pair balancing uses the dataset's private seeded RNG at access time.  Copy
    # its state so the manifest predicts the exact orientation without tokenizing.
    orientation_rng = random.Random()
    orientation_rng.setstate(dataset._rng.getstate())

    manifest_path = output_dir / "train_pairs.csv"
    fields = [
        "position",
        "id_a",
        "id_b",
        "rts_a",
        "rts_b",
        "signed_diff",
        "abs_diff",
        "bucket",
        "pub_year",
        "cluster_cat",
        "balanced_swap",
    ]
    bucket_counts = [0] * (len(BUCKET_EDGES) - 1)
    with manifest_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for position, (left, right, signed_diff) in enumerate(dataset.pairs):
            swap = orientation_rng.random() < 0.5
            if swap:
                left, right, signed_diff = right, left, -signed_diff
            index = bucket_index(abs(float(signed_diff)))
            bucket_counts[index] += 1
            writer.writerow(
                {
                    "position": position,
                    "id_a": stable_value(left, "id"),
                    "id_b": stable_value(right, "id"),
                    "rts_a": format(float(left["RTS"]), ".17g"),
                    "rts_b": format(float(right["RTS"]), ".17g"),
                    "signed_diff": format(float(signed_diff), ".17g"),
                    "abs_diff": format(abs(float(signed_diff)), ".17g"),
                    "bucket": index,
                    "pub_year": stable_value(left, "pub_year"),
                    "cluster_cat": stable_value(left, "cluster_cat"),
                    "balanced_swap": int(swap),
                }
            )

    train_ids_path = output_dir / "train_split_ids.txt"
    val_ids_path = output_dir / "validation_split_ids.txt"
    train_ids_path.write_text("\n".join(train_frame["id"].astype(str)) + "\n", encoding="utf-8")
    val_ids_path.write_text("\n".join(val_frame["id"].astype(str)) + "\n", encoding="utf-8")
    return {
        "train_rows": len(train_frame),
        "validation_rows": len(val_frame),
        "pairs": len(dataset),
        "bucket_counts": bucket_counts,
        "manifest_sha256": sha256_file(manifest_path),
        "train_split_ids_sha256": sha256_file(train_ids_path),
        "validation_split_ids_sha256": sha256_file(val_ids_path),
    }


def main() -> None:
    args = parse_args()
    source_dir = Path(args.source_dir).resolve()
    patched_dir = Path(args.patched_dir).resolve()
    train_csv = Path(args.train_csv).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    verify_file(train_csv, OFFICIAL_TRAIN_SHA256)
    frame = pd.read_csv(train_csv)
    if len(frame) != OFFICIAL_TRAIN_ROWS:
        raise SystemExit(f"Expected {OFFICIAL_TRAIN_ROWS} public rows, got {len(frame)}")
    required = {"id", "title", "abstract", "RTS", "pub_year", "cluster_cat"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise SystemExit(f"Training CSV is missing columns: {missing}")

    patched_hashes = prepare_patched_source(source_dir, patched_dir)
    manifest = write_pair_manifest(
        patched_dir, frame, output_dir, args.max_pairs, args.seed
    )
    metadata = {
        "official_code_revision": OFFICIAL_CODE_REVISION,
        "train_csv": str(train_csv),
        "train_csv_sha256": OFFICIAL_TRAIN_SHA256,
        "public_train_rows": len(frame),
        "paper_declared_train_rows": 23_247,
        "source_sha256": SOURCE_SHA256,
        "patched_sha256": patched_hashes,
        "minimal_patches": [
            "remove .to(device) on the already device-mapped 8-bit model",
            "construct PairwiseBCELoss without the unsupported args parameter",
        ],
        "training_profile": {
            "seed": args.seed,
            "max_pairs": args.max_pairs,
            "max_length": 512,
            "batch_size": 8,
            "epochs": 1,
            "learning_rate": 1e-4,
            "weight_decay": 1e-2,
            "warmup_ratio": 0.1,
            "lora_r": 16,
            "lora_alpha": 32,
            "lora_dropout": 0.05,
            "target_modules": ["q_proj", "v_proj"],
            "load_in_8bit": True,
            "shuffle_train": False,
            "shuffle_note": "false preserves the curriculum order described by the paper; the released parser default true would erase it",
        },
        **manifest,
    }
    metadata_path = output_dir / "preparation.json"
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
