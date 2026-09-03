#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：$0 <llama3-8b|qwen25-3b|qwen3-0.6b>" >&2
  exit 2
fi

MODEL_KEY="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PYTHON_BIN="${NAIPV2_PYTHON:-${PROJECT_ROOT}/runtime/naipv2-official/.venv/bin/python}"
RUN_DIR="${PROJECT_ROOT}/evaluation/naipv2-fulltext-rankers/runs/${MODEL_KEY}-fulltext-evidence-seed42"
TRAIN_CSV="${PROJECT_ROOT}/data/naipv2-fulltext-evidence/proreview-train.csv"
PREDICTIONS="${RUN_DIR}/val_pointwise_preds_latest.csv"
OUTPUT="${RUN_DIR}/validation-calibration.json"

for _ in $(seq 1 2880); do
  if [[ -f "${RUN_DIR}/adapter_config.json" && -f "${PREDICTIONS}" ]]; then
    exec "${PYTHON_BIN}" "${SCRIPT_DIR}/build_fulltext_calibration.py" \
      --predictions "${PREDICTIONS}" \
      --train-csv "${TRAIN_CSV}" \
      --adapter "${RUN_DIR}" \
      --output "${OUTPUT}"
  fi
  sleep 30
done

echo "等待 ${MODEL_KEY} 验证预测超时。" >&2
exit 1
