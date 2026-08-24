#!/usr/bin/env python3
"""Generate leakage-safe frozen-reviewer features for decision cases."""

import argparse
import concurrent.futures
import json
import os
import pathlib
import time
import urllib.error
import urllib.request


FORBIDDEN_TARGET_VENUE_TOKENS = (
    "reject",
    "withdraw",
    "poster",
    "spotlight",
    "oral",
    "acceptance decision",
)


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def validate_target_venues(cases):
    for case in cases:
        venue = case.get("target_venue") or {}
        value = "{} {}".format(venue.get("id") or "", venue.get("name") or "").lower()
        matched = next(
            (token for token in FORBIDDEN_TARGET_VENUE_TOKENS if token in value), None
        )
        if matched:
            raise SystemExit(
                "target_venue 包含疑似结果字段 {!r}（case_id={}），拒绝生成审稿特征。".format(
                    matched, case.get("case_id")
                )
            )


def call_reviewer(case, base_url, api_key, timeout, busy_retries):
    # decision_label is deliberately not copied into this request.
    payload = {
        "request_id": case["case_id"],
        "review_type": "venue_conditioned",
        "review_language": "en" if case["manuscript"].get("language") == "en" else "zh-CN",
        "manuscript": case["manuscript"],
        "target_venue": case["target_venue"],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    request = urllib.request.Request(
        base_url.rstrip("/") + "/v1/reviews",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    for attempt in range(busy_retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            return {
                "case_id": case["case_id"],
                "status": "ok",
                "review": result["review"],
                "backend": result.get("backend"),
                "usage": result.get("usage", {}),
            }
        except urllib.error.HTTPError as error:
            try:
                body = json.loads(error.read().decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                body = None
            if error.code == 429 and attempt < busy_retries:
                time.sleep(min(5.0, 0.5 * (2 ** attempt)))
                continue
            return {
                "case_id": case["case_id"],
                "status": "error",
                "error": "HTTP {}".format(error.code),
                "details": body,
                "review": None,
            }
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError) as error:
            return {
                "case_id": case["case_id"],
                "status": "error",
                "error": type(error).__name__,
                "message": str(error),
                "review": None,
            }


def main():
    parser = argparse.ArgumentParser(description="Run frozen reviewer over decision cases")
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8787")
    parser.add_argument("--api-key-env", default="ONESCIENCE_REVIEWER_API_KEY")
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--busy-retries", type=int, default=6)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers 必须至少为 1")
    api_key = os.environ.get(args.api_key_env, "") if args.api_key_env else ""
    cases = read_jsonl(args.cases)
    validate_target_venues(cases)
    if args.limit:
        cases = cases[: args.limit]
    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    completed = set()
    if args.resume and destination.exists():
        completed = {row["case_id"] for row in read_jsonl(destination) if row.get("status") == "ok"}
    pending = [case for case in cases if case["case_id"] not in completed]
    mode = "a" if args.resume and destination.exists() else "w"
    with destination.open(mode, encoding="utf-8") as output:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(
                    call_reviewer,
                    case,
                    args.base_url,
                    api_key,
                    args.timeout,
                    args.busy_retries,
                ): case
                for case in pending
            }
            for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
                result = future.result()
                output.write(json.dumps(result, ensure_ascii=False) + "\n")
                output.flush()
                print("[{}/{}] {} {}".format(index, len(pending), result["case_id"], result["status"]), flush=True)


if __name__ == "__main__":
    main()
