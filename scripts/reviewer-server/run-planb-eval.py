#!/usr/bin/env python3
"""Evaluate the Plan B pipeline (7B Domain-SFT → DeepSeek V4) end-to-end.

Calls the local Reviewer Service's /v1/reviews endpoint (which runs the full
Plan B backend) and records JSON validity, schema validity, and latency.

Usage:
    python scripts/reviewer-server/run-planb-eval.py \
      --service http://127.0.0.1:8787 \
      --api-key-env ONESCIENCE_REVIEWER_API_KEY \
      --cases evaluation/reviewer-baseline/runs/openreview-2026-heldout-100.jsonl \
      --schema schemas/review-schema.json \
      --out evaluation/reviewer-baseline/runs/planb-7b-deepseek-heldout.jsonl \
      --limit 20 --resume
"""

import argparse
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from jsonschema import Draft202012Validator, FormatChecker


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path):
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def schema_errors(validator, review):
    return [
        {
            "path": "/" + "/".join(str(p) for p in error.absolute_path),
            "message": error.message,
        }
        for error in sorted(validator.iter_errors(review), key=lambda e: list(e.absolute_path))
    ]


def make_request(case, language="zh-CN"):
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


def call_service(base_url, api_key, payload, timeout):
    url = base_url.rstrip("/") + "/v1/reviews"
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


def evaluate_case(case, base_url, api_key, timeout, validator):
    request = make_request(case)
    started = time.perf_counter()
    try:
        response = call_service(base_url, api_key, request, timeout)
        latency_ms = round((time.perf_counter() - started) * 1000)
        review = response.get("review")
        usage = response.get("usage", {})
        errors = []
        if review is not None:
            errors = schema_errors(validator, review)
        return {
            "case_id": case["case_id"],
            "status": response.get("status", "unknown"),
            "schema_valid": review is not None and not errors,
            "schema_errors": errors,
            "review": review,
            "usage": usage,
            "latency_ms": latency_ms,
        }
    except urllib.error.HTTPError as error:
        latency_ms = round((time.perf_counter() - started) * 1000)
        body = ""
        try:
            body = error.read().decode("utf-8")[:500]
        except Exception:
            pass
        return {
            "case_id": case["case_id"],
            "status": "http_error",
            "http_code": error.code,
            "message": body,
            "schema_valid": False,
            "schema_errors": [],
            "review": None,
            "usage": {},
            "latency_ms": latency_ms,
        }
    except (urllib.error.URLError, TimeoutError) as error:
        latency_ms = round((time.perf_counter() - started) * 1000)
        return {
            "case_id": case["case_id"],
            "status": "error",
            "error": type(error).__name__,
            "message": str(getattr(error, "reason", error))[:500],
            "schema_valid": False,
            "schema_errors": [],
            "review": None,
            "usage": {},
            "latency_ms": latency_ms,
        }


def main():
    parser = argparse.ArgumentParser(description="Evaluate Plan B pipeline")
    parser.add_argument("--service", default="http://127.0.0.1:8787")
    parser.add_argument("--api-key-env", default="ONESCIENCE_REVIEWER_API_KEY")
    parser.add_argument("--schema", default="schemas/review-schema.json")
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise SystemExit("未设置服务密钥环境变量：{}".format(args.api_key_env))

    validator = Draft202012Validator(load_json(args.schema), format_checker=FormatChecker())
    cases = read_jsonl(args.cases)
    if args.limit:
        cases = cases[: args.limit]

    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    completed = set()
    if args.resume and destination.exists():
        completed = {item.get("case_id") for item in read_jsonl(destination)}

    timeout = 300  # Plan B is slow: 7B generation + DeepSeek structuring

    with destination.open("a" if completed else "w", encoding="utf-8") as output:
        for idx, case in enumerate(cases, start=1):
            case_id = case["case_id"]
            if case_id in completed:
                continue
            record = evaluate_case(case, args.service, api_key, timeout, validator)
            output.write(json.dumps(record, ensure_ascii=False) + "\n")
            output.flush()
            latency = record.get("latency_ms", "?")
            print(
                "[{}/{}] {}: {} schema_valid={} latency={}ms".format(
                    idx, len(cases), case_id, record["status"], record["schema_valid"], latency
                ),
                flush=True,
            )

    # Print summary
    all_records = read_jsonl(destination)
    total = len(all_records)
    schema_valid = sum(1 for r in all_records if r.get("schema_valid"))
    print("\n=== Summary ===")
    print("Total: {}".format(total))
    print("Schema valid: {}/{} ({:.1f}%)".format(schema_valid, total, 100 * schema_valid / total if total else 0))
    latencies = [r.get("latency_ms", 0) for r in all_records if r.get("latency_ms")]
    if latencies:
        latencies.sort()
        p50 = latencies[len(latencies) // 2]
        p95 = latencies[int(len(latencies) * 0.95)]
        print("P50 latency: {}ms".format(p50))
        print("P95 latency: {}ms".format(p95))


if __name__ == "__main__":
    main()
