#!/usr/bin/env python3
"""Evaluate reviewer with lm-format-enforcer constrained decoding.

Bypasses LLaMA-Factory — loads model directly with transformers + PEFT + bnb.
Uses a custom prefix_allowed_tokens_fn that only constrains generated tokens
(not the chat template prompt).
"""

import argparse
import json
import os
import pathlib
import sys
import time

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from reviewer_service.core import build_request_context, assemble_review
from preprocess_schema import preprocess


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path):
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def make_request(case, language):
    manuscript = case["manuscript"]
    return {
        "request_id": case["case_id"],
        "review_type": "general",
        "review_language": language,
        "target_venue": None,
        "manuscript": {
            "paper_id": case["case_id"],
            "title": manuscript["title"],
            "language": manuscript["language"],
            "fingerprint": None,
            "paragraphs": manuscript["paragraphs"],
        },
    }


def schema_errors(validator, review):
    return [
        {
            "path": "/" + "/".join(str(p) for p in error.absolute_path),
            "message": error.message,
        }
        for error in sorted(validator.iter_errors(review), key=lambda e: list(e.absolute_path))
    ]


def main():
    parser = argparse.ArgumentParser(description="Constrained decoding evaluation")
    parser.add_argument("--config", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    config = load_json(args.config)
    cases = read_jsonl(args.cases)
    if args.limit:
        cases = cases[: args.limit]

    # ── Load & preprocess schema ──────────────────────────────
    raw_schema = load_json(args.schema)
    for key in ("$schema", "$id",):
        raw_schema.pop(key, None)
    if "$defs" in raw_schema:
        raw_schema["definitions"] = raw_schema.pop("$defs")
    lme_schema = preprocess(raw_schema)

    # ── Import heavy deps ─────────────────────────────────────
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
    from peft import PeftModel
    from lmformatenforcer import JsonSchemaParser, TokenEnforcer
    from lmformatenforcer.integrations.transformers import build_token_enforcer_tokenizer_data

    # ── Resolve model path ────────────────────────────────────
    model_id = config["model_id"].split("/")[-1]
    data2_model = f"/data2/liuheng/OneScience/models/{model_id}"
    if os.path.isdir(data2_model):
        model_path = data2_model
    else:
        model_path = os.path.join(str(PROJECT_ROOT), "models", model_id)

    data2_adapter = "/data2/liuheng/OneScience/outputs/qwen3-4b-instruct-2507/schema-lora"
    if os.path.isdir(data2_adapter):
        adapter_path = data2_adapter
    else:
        adapter_path = config.get("adapter_path", "")

    print(f"Model: {model_path}")
    print(f"Adapter: {adapter_path}")

    # ── Load model ────────────────────────────────────────────
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
    )

    print("Loading tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)

    print("Loading base model (4-bit)...")
    base_model = AutoModelForCausalLM.from_pretrained(
        model_path,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
    )

    print("Loading LoRA adapter...")
    model = PeftModel.from_pretrained(base_model, adapter_path)
    model.eval()

    # ── Build shared TokenEnforcer data ───────────────────────
    tokenizer_data = build_token_enforcer_tokenizer_data(tokenizer)

    # ── Schema validator for post-hoc check ───────────────────
    from jsonschema import Draft202012Validator, FormatChecker
    validator = Draft202012Validator(load_json(args.schema), format_checker=FormatChecker())

    # ── Run eval ──────────────────────────────────────────────
    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    completed = set()
    if args.resume and destination.exists():
        completed = {r.get("case_id") for r in read_jsonl(destination)}

    generation_cfg = config["generation"]
    max_tokens = int(generation_cfg["max_tokens"])
    temperature = float(generation_cfg.get("temperature", 0))

    mode = "a" if (args.resume and completed) else "w"
    with destination.open(mode, encoding="utf-8") as out:
        for idx, case in enumerate(cases, start=1):
            case_id = case["case_id"]
            if case_id in completed:
                continue

            request = make_request(case, config.get("review_language", "zh-CN"))
            _, effective_config, messages, coverage = build_request_context(request, config)

            # Build prompt using chat template, get token length
            try:
                prompt_text = tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                    enable_thinking=False,
                )
            except TypeError:
                prompt_text = tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                )

            prompt_ids = tokenizer.encode(prompt_text, add_special_tokens=False, return_tensors="pt").to(model.device)
            prompt_len = prompt_ids.shape[-1]

            # ── Build custom prefix_allowed_tokens_fn ──────────
            # The key: only pass the GENERATED text (not the prompt) to the TokenEnforcer
            json_parser = JsonSchemaParser(lme_schema)
            enforcer = TokenEnforcer(tokenizer_data, json_parser)
            all_tokens = list(range(len(tokenizer)))  # For "no constraint" mode

            def make_prefix_fn(p_len, tok, enf, all_toks):
                def prefix_fn(batch_id, input_ids):
                    # input_ids is 1D tensor of all tokens so far (prompt + generated)
                    if len(input_ids) <= p_len:
                        # No generated tokens yet — allow all tokens
                        return all_toks
                    gen_ids = input_ids[p_len:]
                    gen_text = tok.decode(gen_ids, skip_special_tokens=True)
                    try:
                        result = enf.get_allowed_tokens(gen_text)
                        if hasattr(result, 'allowed_tokens'):
                            tokens = result.allowed_tokens
                            if isinstance(tokens, list):
                                return tokens
                    except Exception:
                        pass
                    # If anything fails, fall back to all tokens
                    return all_toks
                return prefix_fn

            prefix_fn = make_prefix_fn(prompt_len, tokenizer, enforcer, all_tokens)

            started = time.perf_counter()
            try:
                with torch.no_grad():
                    output_ids = model.generate(
                        prompt_ids,
                        max_new_tokens=max_tokens,
                        temperature=temperature,
                        do_sample=temperature > 0,
                        prefix_allowed_tokens_fn=prefix_fn,
                        pad_token_id=tokenizer.eos_token_id,
                        eos_token_id=tokenizer.eos_token_id,
                    )
                latency_ms = round((time.perf_counter() - started) * 1000)

                generated_ids = output_ids[0][prompt_len:]
                raw_output = tokenizer.decode(generated_ids, skip_special_tokens=True).strip()

                # Extract JSON
                start_pos = raw_output.find("{")
                end_pos = raw_output.rfind("}")
                if start_pos >= 0 and end_pos > start_pos:
                    raw_output = raw_output[start_pos:end_pos + 1]

                try:
                    parsed = json.loads(raw_output)
                    parse_error = None
                except json.JSONDecodeError as e:
                    parsed = None
                    parse_error = str(e)

                review = None
                errors = []
                if isinstance(parsed, dict):
                    trace = {
                        "provider": "OneScience GPU Server (constrained)",
                        "model": config["model_id"],
                        "model_version": config.get("model_revision", "unversioned"),
                        "adapter_version": config.get("adapter_version"),
                        "prompt_version": "constrained-v3",
                        "quantization": "bnb-4bit+lora-r8",
                    }
                    review = assemble_review(
                        request, case, parsed, coverage, effective_config, latency_ms, trace
                    )
                    errors = schema_errors(validator, review)

                record = {
                    "case_id": case_id,
                    "status": "ok" if review is not None else "invalid_json",
                    "raw_output": raw_output,
                    "parse_error": parse_error,
                    "schema_valid": review is not None and not errors,
                    "schema_errors": errors,
                    "review": review,
                    "usage": {
                        "prompt_tokens": prompt_len,
                        "output_tokens": len(generated_ids),
                        "peak_memory_gb": round(torch.cuda.max_memory_allocated() / 1e9, 3),
                        "supplied_characters": coverage["supplied_characters"],
                    },
                }

            except Exception as e:
                import traceback
                latency_ms = round((time.perf_counter() - started) * 1000)
                record = {
                    "case_id": case_id,
                    "status": "error",
                    "error": type(e).__name__,
                    "message": str(e)[:500],
                    "traceback": traceback.format_exc()[-800:],
                    "schema_valid": False,
                    "schema_errors": [],
                    "review": None,
                    "usage": {},
                    "latency_ms": latency_ms,
                }

            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            out.flush()
            out_tokens = record.get("usage", {}).get("output_tokens", "?")
            print(
                f"[{idx}/{len(cases)}] {case_id}: {record['status']} "
                f"schema_valid={record['schema_valid']} "
                f"tokens={out_tokens}",
                flush=True,
            )

    print("Done.")


if __name__ == "__main__":
    main()
