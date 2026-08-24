#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_ROOT="${NAIPV2_RUNTIME_ROOT:-${PROJECT_ROOT}/runtime/naipv2-official}"
PYTHON_BIN="${NAIPV2_PYTHON:-${RUNTIME_ROOT}/.venv/bin/python}"
BASE_MODEL="${NAIPV2_BASE_MODEL:-${PROJECT_ROOT}/models/Meta-Llama-3-8B}"
ADAPTER_DIR="${NAIPV2_ADAPTER_DIR:-${PROJECT_ROOT}/evaluation/naipv2-official/runs/retrained-paper-faithful-seed42}"
TEST_CSV="${NAIPV2_TEST_CSV:-${PROJECT_ROOT}/data/naipv2-official/NAIDv2-test.csv}"
OUTPUT_DIR="${NAIPV2_OUTPUT_DIR:-${PROJECT_ROOT}/evaluation/naipv2-official/runs/retrained-paper-faithful-seed42-public-test}"

if [[ ! -f "${ADAPTER_DIR}/adapter_config.json" ]]; then
  echo "训练尚未完成或 adapter 不完整：${ADAPTER_DIR}" >&2
  exit 1
fi
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
exec "${PYTHON_BIN}" "${SCRIPT_DIR}/eval_retrained_adapter.py" \
  --base-model "${BASE_MODEL}" \
  --adapter "${ADAPTER_DIR}" \
  --test-csv "${TEST_CSV}" \
  --output-dir "${OUTPUT_DIR}" \
  --batch-size 8 \
  --max-length 512 \
  --seed 42
