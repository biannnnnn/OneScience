#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_ROOT="${NAIPV2_SMALL_RUN_ROOT:-${PROJECT_ROOT}/evaluation/naipv2-small-models/runs}"
LOCK_DIR="${RUN_ROOT}/.training-lock"
FIRST_METRICS="${RUN_ROOT}/qwen3-0.6b-naipv2-seed42-public-test/metrics.json"

while [[ -d "${LOCK_DIR}" ]]; do
  sleep 30
done

if [[ ! -f "${FIRST_METRICS}" ]]; then
  echo "0.6B 实验未产生完整指标，不启动 3B。" >&2
  exit 1
fi

exec bash "${SCRIPT_DIR}/run_small_model_experiment.sh" qwen25-3b
