#!/usr/bin/env python3
"""Train a pairwise paper-quality scorer (NAIPv2 v0).

Fine-tune Qwen3-8B (4-bit QLoRA) with a scalar sequence-classification head on a
pairwise Bradley-Terry objective: given a pair (a, b), the label is I[RTS_a > RTS_b]
and the loss is BCE(sigmoid(score_a - score_b)) (NAIPv2 Eq. 4-5).

This mirrors NAIPv2's design but, for v0, groups pairs by year only (no domain
clustering) and skips curriculum learning.
"""

import argparse
import json
import pathlib
import random

import torch
import torch.nn.functional as F
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from torch.utils.data import DataLoader, Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    BitsAndBytesConfig,
    get_cosine_schedule_with_warmup,
)


class PairDataset(Dataset):
    def __init__(self, pairs, tokenizer, cutoff):
        self.tokenizer = tokenizer
        self.samples = []
        for pair in pairs:
            a = tokenizer(
                pair["a_text"],
                truncation=True,
                max_length=cutoff,
                padding="max_length",
                return_tensors="pt",
            )
            b = tokenizer(
                pair["b_text"],
                truncation=True,
                max_length=cutoff,
                padding="max_length",
                return_tensors="pt",
            )
            self.samples.append(
                {
                    "a_ids": a["input_ids"][0],
                    "a_mask": a["attention_mask"][0],
                    "b_ids": b["input_ids"][0],
                    "b_mask": b["attention_mask"][0],
                    "label": float(pair["label"]),
                }
            )

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, index):
        return self.samples[index]


def collate(batch):
    return {
        "a_ids": torch.stack([s["a_ids"] for s in batch]),
        "a_mask": torch.stack([s["a_mask"] for s in batch]),
        "b_ids": torch.stack([s["b_ids"] for s in batch]),
        "b_mask": torch.stack([s["b_mask"] for s in batch]),
        "label": torch.tensor([s["label"] for s in batch]),
    }


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main():
    parser = argparse.ArgumentParser(description="Train NAIPv2-style pairwise scorer")
    parser.add_argument("--model", default="models/Qwen3-8B")
    parser.add_argument("--pairs", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--grad-accum", type=int, default=2)
    parser.add_argument("--lr", type=float, default=3e-5)
    parser.add_argument("--warmup-ratio", type=float, default=0.05, help="fraction of update steps spent warming up")
    parser.add_argument("--max-grad-norm", type=float, default=1.0, help="gradient clipping norm")
    parser.add_argument("--cutoff", type=int, default=512)
    parser.add_argument("--lora-rank", type=int, default=8)
    parser.add_argument("--max-pairs", type=int, default=0)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=1,
        quantization_config=bnb,
        torch_dtype=torch.bfloat16,
        device_map={"": 0},
        trust_remote_code=True,
    )
    model.config.pad_token_id = tokenizer.pad_token_id
    model = prepare_model_for_kbit_training(model)
    lora_config = LoraConfig(
        r=args.lora_rank,
        lora_alpha=16,
        lora_dropout=0.05,
        bias="none",
        task_type="SEQ_CLS",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        modules_to_save=["score"],
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    pairs = read_jsonl(args.pairs)
    if args.max_pairs:
        pairs = pairs[: args.max_pairs]
    dataset = PairDataset(pairs, tokenizer, args.cutoff)
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True, collate_fn=collate)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    num_update_steps_per_epoch = max(1, (len(loader) + args.grad_accum - 1) // args.grad_accum)
    total_update_steps = num_update_steps_per_epoch * args.epochs
    warmup_steps = max(1, int(total_update_steps * args.warmup_ratio))
    scheduler = get_cosine_schedule_with_warmup(
        optimizer,
        num_warmup_steps=warmup_steps,
        num_training_steps=total_update_steps,
    )
    model.train()

    meta = {
        "model": args.model,
        "pairs": args.pairs,
        "num_pairs": len(pairs),
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "grad_accum": args.grad_accum,
        "lr": args.lr,
        "warmup_ratio": args.warmup_ratio,
        "max_grad_norm": args.max_grad_norm,
        "cutoff": args.cutoff,
        "lora_rank": args.lora_rank,
        "seed": args.seed,
    }

    def save_checkpoint(dest, epoch=None):
        out = pathlib.Path(dest)
        out.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(out)
        tokenizer.save_pretrained(out)
        m = dict(meta)
        if epoch is not None:
            m["epoch"] = epoch
        with (out / "train_meta.json").open("w", encoding="utf-8") as handle:
            json.dump(m, handle, ensure_ascii=False, indent=2)
        print("saved checkpoint to", dest, flush=True)

    global_step = 0
    for epoch in range(args.epochs):
        for batch in loader:
            a_ids = batch["a_ids"].to("cuda")
            a_mask = batch["a_mask"].to("cuda")
            b_ids = batch["b_ids"].to("cuda")
            b_mask = batch["b_mask"].to("cuda")
            labels = batch["label"].to("cuda")

            score_a = model(input_ids=a_ids, attention_mask=a_mask).logits.squeeze(-1)
            score_b = model(input_ids=b_ids, attention_mask=b_mask).logits.squeeze(-1)
            prob = torch.sigmoid(score_a - score_b)
            loss = F.binary_cross_entropy(prob, labels)
            loss = loss / args.grad_accum
            loss.backward()

            if (global_step + 1) % args.grad_accum == 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()

            if global_step % 20 == 0:
                print(
                    "epoch {} step {} loss {:.4f} lr {:.2e}".format(
                        epoch, global_step, loss.item() * args.grad_accum, scheduler.get_last_lr()[0]
                    ),
                    flush=True,
                )
            global_step += 1

        save_checkpoint(f"{args.out}-ep{epoch}", epoch=epoch)

    save_checkpoint(args.out, epoch=args.epochs - 1)


if __name__ == "__main__":
    main()
