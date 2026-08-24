#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${REVIEWER_SERVER_SCRIPT_DIR}/common.sh"

show_process() {
  local label="$1"
  local pid_file="$2"
  if [[ ! -f "${pid_file}" ]]; then
    echo "${label}: not-started"
    return
  fi
  local process_id
  process_id="$(tr -d '[:space:]' < "${pid_file}")"
  if [[ "${process_id}" =~ ^[0-9]+$ ]] && kill -0 "${process_id}" 2>/dev/null; then
    echo "${label}: running (pid=${process_id})"
  else
    echo "${label}: stopped (last_pid=${process_id})"
  fi
}

show_process "domain" "${ONESCIENCE_SERVER_ROOT}/logs/domain-train.pid"
show_process "schema-watcher" "${ONESCIENCE_SERVER_ROOT}/logs/schema-watcher.pid"
show_process "model-service" "${ONESCIENCE_SERVER_ROOT}/logs/model-service.pid"
show_process "reviewer-service" "${ONESCIENCE_SERVER_ROOT}/logs/reviewer-service.pid"

if pgrep -f "llamafactory-cli api config/reviewer-server/inference-8b.yaml" >/dev/null; then
  echo "model-service-8b: running"
else
  echo "model-service-8b: stopped"
fi
if pgrep -f "reviewer_service.app.*model-qwen3-8b-schema.json" >/dev/null; then
  echo "reviewer-service-8b: running"
else
  echo "reviewer-service-8b: stopped"
fi

if [[ -f "${ONESCIENCE_SERVER_ROOT}/logs/acceptance-pipeline.pid" ]]; then
  show_process "acceptance-pipeline" "${ONESCIENCE_SERVER_ROOT}/logs/acceptance-pipeline.pid"
fi

ACCEPTANCE_CASES="${ONESCIENCE_SERVER_ROOT}/data/openreview/acceptance/proreview-v0.1/cases.jsonl"
if [[ -s "${ONESCIENCE_SERVER_ROOT}/logs/acceptance-cases.path" ]]; then
  ACCEPTANCE_CASES="$(head -n 1 "${ONESCIENCE_SERVER_ROOT}/logs/acceptance-cases.path")"
fi
ACCEPTANCE_REVIEWS="${ONESCIENCE_SERVER_ROOT}/evaluation/acceptance/reviewer-features-qwen3-8b-v0.1.jsonl"
if [[ -s "${ONESCIENCE_SERVER_ROOT}/logs/acceptance-reviews.path" ]]; then
  ACCEPTANCE_REVIEWS="$(head -n 1 "${ONESCIENCE_SERVER_ROOT}/logs/acceptance-reviews.path")"
fi
if [[ -f "${ACCEPTANCE_CASES}" ]]; then
  acceptance_total="$(wc -l < "${ACCEPTANCE_CASES}")"
  acceptance_ok=0
  if [[ -f "${ACCEPTANCE_REVIEWS}" ]]; then
    acceptance_progress="$("${ONESCIENCE_SERVER_PYTHON}" - "${ACCEPTANCE_CASES}" "${ACCEPTANCE_REVIEWS}" <<'PY'
import json, sys
cases = {}
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        row = json.loads(line)
        cases[row.get("case_id")] = row.get("split")
seen = set()
with open(sys.argv[2], encoding="utf-8") as handle:
    for line in handle:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("status") == "ok" and row.get("case_id") in cases:
            seen.add(row.get("case_id"))
split_ok = {
    split: sum(cases[case_id] == split for case_id in seen)
    for split in ("train", "validation", "test")
}
split_total = {
    split: sum(value == split for value in cases.values())
    for split in ("train", "validation", "test")
}
print("{}|{}".format(
    len(seen),
    ", ".join(
        "{}={}/{}".format(split, split_ok[split], split_total[split])
        for split in ("train", "validation", "test")
    ),
))
PY
)"
    acceptance_ok="${acceptance_progress%%|*}"
    acceptance_breakdown="${acceptance_progress#*|}"
  fi
  echo "acceptance features: ${acceptance_ok}/${acceptance_total} (${acceptance_breakdown:-no split details})"
fi
show_process "heldout-eval" "${ONESCIENCE_SERVER_ROOT}/logs/heldout-eval.pid"

HELDOUT_OUTPUT="${ONESCIENCE_SERVER_ROOT}/evaluation/reviewer-baseline/runs/qwen3-4b-server-schema-heldout-100.jsonl"
if [[ -f "${HELDOUT_OUTPUT}" ]]; then
  printf 'heldout-eval progress: %s/100\n' "$(wc -l < "${HELDOUT_OUTPUT}" | tr -d ' ')"
fi

for adapter in domain-lora schema-lora; do
  adapter_path="${ONESCIENCE_SERVER_ROOT}/outputs/qwen3-4b-instruct-2507/${adapter}/adapter_config.json"
  if [[ -f "${adapter_path}" ]]; then
    echo "${adapter}: ready"
  else
    echo "${adapter}: pending"
  fi
done

if [[ -f "${ONESCIENCE_SERVER_ROOT}/logs/domain-train.log" ]]; then
  echo "recent domain metrics:"
  tr '\r' '\n' < "${ONESCIENCE_SERVER_ROOT}/logs/domain-train.log" \
    | grep -E "\{'loss'|eval_loss" \
    | tail -n 5 || true
fi
