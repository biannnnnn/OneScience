#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_ROOT="${NAIPV2_RUNTIME_ROOT:-${PROJECT_ROOT}/runtime/naipv2-official}"
PYTHON_BIN="${NAIPV2_PYTHON:-${RUNTIME_ROOT}/.venv/bin/python}"

export NAIPV2_BASE_MODEL="${NAIPV2_BASE_MODEL:-${PROJECT_ROOT}/models/Meta-Llama-3-8B}"
export NAIPV2_ADAPTER_DIR="${NAIPV2_ADAPTER_DIR:-${PROJECT_ROOT}/evaluation/naipv2-official/runs/retrained-paper-faithful-seed42}"
export NAIPV2_CALIBRATION_PATH="${NAIPV2_CALIBRATION_PATH:-${NAIPV2_ADAPTER_DIR}/validation-calibration.json}"

cd "${PROJECT_ROOT}"
exec "${PYTHON_BIN}" -m ranker_service.app \
  --config config/ranker-server/service.json \
  --backend transformers
