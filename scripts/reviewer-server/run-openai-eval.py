#!/usr/bin/env python3
"""Run reviewer evaluation against a private OpenAI-compatible model API."""

import argparse
import concurrent.futures
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

from jsonschema import Draft202012Validator, FormatChecker

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from reviewer_service.core import assemble_review, build_request_context, parse_json_output


def load_json(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def schema_errors(validator, review):
    return [
        {
            "path": "/" + "/".join(str(part) for part in error.absolute_path),
            "message": error.message,
        }
        for error in sorted(validator.iter_errors(review), key=lambda item: list(item.absolute_path))
    ]


def call_model(url, api_key, payload, timeout):
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


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


def _repair_truncated_json(text):
    """Try to repair truncated JSON by closing unclosed brackets.
    Returns (repaired_text, was_repaired)."""
    text = text.strip()
    if not text.startswith("{"):
        return text, False
    # Count open/close
    depth = 0
    in_string = False
    escape = False
    for ch in text:
        if escape:
            escape = False
            continue
        if ch == '\\':
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
        elif not in_string:
            if ch in '{[':
                depth += 1
            elif ch in '}]':
                depth -= 1
    if depth <= 0 and not in_string:
        return text, False
    repaired = text
    if in_string:
        repaired += '"'
    # Re-count open brackets
    open_brackets = []
    in_string2 = False
    escape2 = False
    for ch in repaired:
        if escape2:
            escape2 = False
            continue
        if ch == '\\':
            escape2 = True
            continue
        if ch == '"':
            in_string2 = not in_string2
        elif not in_string2:
            if ch == '{':
                open_brackets.append('}')
            elif ch == '[':
                open_brackets.append(']')
            elif ch in '}]':
                if open_brackets and open_brackets[-1] == ch:
                    open_brackets.pop()
    for closer in reversed(open_brackets):
        repaired += closer
    if repaired == text:
        return text, False
    return repaired, True


def evaluate_case(case, config, validator, url, api_key, timeout):
    upstream = config["upstream"]
    request = make_request(case, config.get("review_language", "zh-CN"))
    _, effective_config, messages, coverage = build_request_context(request, config)
    # Append { to user message to prompt JSON start
    messages = list(messages)
    messages[-1]["content"] += "\n\n{"

    def do_call(msgs):
        payload = {
            "model": upstream["served_model_name"],
            "messages": msgs,
            "temperature": float(config["generation"].get("temperature", 0)),
            "max_tokens": int(config["generation"]["max_tokens"]),
            "stream": False,
            "response_format": {"type": "json_object"},
        }
        return call_model(url, api_key, payload, timeout)

    started = time.perf_counter()
    try:
        response = do_call(messages)
        latency_ms = round((time.perf_counter() - started) * 1000)
        choice = response["choices"][0]
        raw_output = choice["message"]["content"]
        parsed, parse_error = parse_json_output(raw_output)
        was_repaired = False

        # Try repairing truncated JSON
        if parsed is None:
            repaired, was_repaired = _repair_truncated_json(raw_output)
            if was_repaired:
                parsed, parse_error = parse_json_output(repaired)
                if parsed is not None:
                    raw_output = repaired

        # Retry once with stronger instructions
        if parsed is None and not was_repaired:
            retry_ms = list(messages)
            retry_ms.append({
                "role": "user",
                "content": "上次输出不是有效 JSON。请确保输出完整有效的 JSON 对象，以 } 结尾。\n\n{",
            })
            try:
                response = do_call(retry_ms)
                choice = response["choices"][0]
                raw_output = choice["message"]["content"]
                parsed, parse_error = parse_json_output(raw_output)
                if parsed is None:
                    repaired, was_repaired = _repair_truncated_json(raw_output)
                    if was_repaired:
                        parsed, parse_error = parse_json_output(repaired)
                        if parsed is not None:
                            raw_output = repaired
            except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError):
                pass

        review = None
        errors = []
        if isinstance(parsed, dict):
            trace = {
                "provider": config.get("provider", "OpenAI-compatible"),
                "model": config["model_id"],
                "model_version": config.get("model_revision", "unversioned"),
                "adapter_version": config.get("adapter_version"),
                "prompt_version": config["prompt_version"],
                "quantization": config.get("quantization"),
            }
            review = assemble_review(
                request, case, parsed, coverage, effective_config, latency_ms, trace
            )
            errors = schema_errors(validator, review)
        usage = response.get("usage") or {}
        return {
            "case_id": case["case_id"],
            "status": "ok" if review is not None else "invalid_json",
            "raw_output": raw_output,
            "parse_error": parse_error,
            "finish_reason": choice.get("finish_reason"),
            "schema_valid": review is not None and not errors,
            "schema_errors": errors,
            "review": review,
            "usage": {
                "prompt_tokens": usage.get("prompt_tokens"),
                "output_tokens": usage.get("completion_tokens"),
                "peak_memory_gb": None,
                "supplied_characters": coverage["supplied_characters"],
            },
        }
    except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as error:
        latency_ms = round((time.perf_counter() - started) * 1000)
        return {
            "case_id": case["case_id"],
            "status": "error",
            "error": type(error).__name__,
            "message": str(error),
            "schema_valid": False,
            "schema_errors": [],
            "review": None,
            "usage": {},
            "latency_ms": latency_ms,
        }


def main():
    parser = argparse.ArgumentParser(description="Evaluate the server Qwen reviewer")
    parser.add_argument("--config", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers 必须至少为 1。")

    config = load_json(args.config)
    validator = Draft202012Validator(load_json(args.schema), format_checker=FormatChecker())
    cases = read_jsonl(args.cases)
    if args.limit:
        cases = cases[:args.limit]

    upstream = config["upstream"]
    api_key_env = upstream.get("api_key_env")
    api_key = os.environ.get(api_key_env, "") if api_key_env else ""
    if api_key_env and not api_key:
        raise SystemExit("未设置模型服务密钥环境变量：{}".format(api_key_env))
    url = upstream["base_url"].rstrip("/") + "/chat/completions"
    timeout = float(upstream.get("timeout_seconds", 300))

    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    completed = set()
    if args.resume and destination.exists():
        completed = {item.get("case_id") for item in read_jsonl(destination)}
    mode = "a" if args.resume and destination.exists() else "w"
    pending = [
        (index, case)
        for index, case in enumerate(cases, start=1)
        if case["case_id"] not in completed
    ]

    with destination.open(mode, encoding="utf-8") as output:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(evaluate_case, case, config, validator, url, api_key, timeout): (index, case)
                for index, case in pending
            }
            for future in concurrent.futures.as_completed(futures):
                index, case = futures[future]
                record = future.result()
                output.write(json.dumps(record, ensure_ascii=False) + "\n")
                output.flush()
                print(
                    "[{}/{}] {}: {} schema_valid={}".format(
                        index, len(cases), case["case_id"], record["status"], record["schema_valid"]
                    ),
                    flush=True,
                )


if __name__ == "__main__":
    main()
