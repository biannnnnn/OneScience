#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${REVIEWER_SERVER_SCRIPT_DIR}/common.sh"
: "${ONESCIENCE_REVIEWER_API_KEY:?必须设置 ONESCIENCE_REVIEWER_API_KEY}"

CASES="${ACCEPTANCE_CASES:-data/openreview/acceptance/proreview-v0.1/cases.jsonl}"
REVIEWS="${ACCEPTANCE_REVIEWS:-evaluation/acceptance/reviewer-features-qwen3-8b-v0.1.jsonl}"
FINAL_CASES="${ACCEPTANCE_FINAL_CASES:-${CASES}}"
MODEL="${ACCEPTANCE_MODEL:-outputs/acceptance/proreview-qwen3-8b-v0.1/model.json}"
REPORT="${ACCEPTANCE_REPORT:-evaluation/acceptance/proreview-qwen3-8b-v0.1-report.json}"
WORKERS="${ACCEPTANCE_WORKERS:-2}"

mkdir -p evaluation/acceptance outputs/acceptance/proreview-qwen3-8b-v0.1 logs

"${ONESCIENCE_SERVER_PYTHON}" scripts/acceptance-prediction/run_reviews.py \
  --cases "${CASES}" \
  --out "${REVIEWS}" \
  --base-url http://127.0.0.1:8787 \
  --workers "${WORKERS}" \
  --timeout 900 \
  --resume

# A second resumable pass retries only cases that did not produce a valid
# review in the first pass.
"${ONESCIENCE_SERVER_PYTHON}" scripts/acceptance-prediction/run_reviews.py \
  --cases "${CASES}" \
  --out "${REVIEWS}" \
  --base-url http://127.0.0.1:8787 \
  --workers "${WORKERS}" \
  --timeout 900 \
  --resume

if [[ -n "${ACCEPTANCE_FINAL_TRAIN:-}" ]]; then
  "${ONESCIENCE_SERVER_PYTHON}" scripts/acceptance-prediction/make_stratified_subset.py \
    --cases "${ACCEPTANCE_SOURCE_CASES:-data/openreview/acceptance/proreview-v0.1/cases.jsonl}" \
    --reviews "${REVIEWS}" \
    --out "${FINAL_CASES}" \
    --train "${ACCEPTANCE_FINAL_TRAIN}" \
    --validation "${ACCEPTANCE_FINAL_VALIDATION:?必须设置 ACCEPTANCE_FINAL_VALIDATION}" \
    --test "${ACCEPTANCE_FINAL_TEST:?必须设置 ACCEPTANCE_FINAL_TEST}" \
    --require-success
fi

"${ONESCIENCE_SERVER_PYTHON}" scripts/acceptance-prediction/train.py \
  --cases "${FINAL_CASES}" \
  --reviews "${REVIEWS}" \
  --out "${MODEL}" \
  --report "${REPORT}"
