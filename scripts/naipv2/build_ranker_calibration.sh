#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_ROOT="${NAIPV2_RUNTIME_ROOT:-${PROJECT_ROOT}/runtime/naipv2-official}"
PYTHON_BIN="${NAIPV2_PYTHON:-${RUNTIME_ROOT}/.venv/bin/python}"
BASE_MODEL="${NAIPV2_BASE_MODEL:-${PROJECT_ROOT}/models/Meta-Llama-3-8B}"
ADAPTER_DIR="${NAIPV2_ADAPTER_DIR:-${PROJECT_ROOT}/evaluation/naipv2-official/runs/retrained-paper-faithful-seed42}"
TRAIN_CSV="${NAIPV2_TRAIN_CSV:-${PROJECT_ROOT}/data/naipv2-official/NAIDv2-train.csv}"
VALIDATION_IDS="${NAIPV2_VALIDATION_IDS:-${ADAPTER_DIR}/validation_split_ids.txt}"
OUTPUT="${NAIPV2_CALIBRATION_PATH:-${ADAPTER_DIR}/validation-calibration.json}"

cd "${PROJECT_ROOT}"
exec "${PYTHON_BIN}" scripts/naipv2/build_ranker_calibration.py \
  --base-model "${BASE_MODEL}" \
  --adapter "${ADAPTER_DIR}" \
  --train-csv "${TRAIN_CSV}" \
  --validation-ids "${VALIDATION_IDS}" \
  --output "${OUTPUT}" \
  --batch-size "${NAIPV2_BATCH_SIZE:-8}" \
  --max-length 512
