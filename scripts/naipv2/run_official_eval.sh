#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PYTHON_BIN="${NAIPV2_PYTHON:-${PROJECT_ROOT}/.venv-server/bin/python}"
MODEL_REVISION="174b3728a2517012b26b51764252c1688fab7ba0"
MODEL_PATH="${NAIPV2_MODEL_PATH:-${PROJECT_ROOT}/.cache/huggingface/models--ssocean--NAIPv2/snapshots/${MODEL_REVISION}}"
TEST_CSV="${NAIPV2_TEST_CSV:-${PROJECT_ROOT}/data/naipv2-official/NAIDv2-test.csv}"
OUTPUT_DIR="${NAIPV2_OUTPUT_DIR:-${PROJECT_ROOT}/evaluation/naipv2-official/runs/official-weights-public-test}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "NAIPv2 官方 8-bit 评测需要 NVIDIA Linux 服务器。" >&2
  exit 1
fi
if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "找不到 Python 环境：${PYTHON_BIN}" >&2
  exit 1
fi
if [[ ! -d "${MODEL_PATH}" ]]; then
  echo "找不到固定版本的官方权重：${MODEL_PATH}" >&2
  exit 1
fi
if [[ ! -f "${TEST_CSV}" ]]; then
  echo "找不到官方测试集：${TEST_CSV}" >&2
  exit 1
fi

export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
exec "${PYTHON_BIN}" "${SCRIPT_DIR}/eval_official_weights.py" \
  --model "${MODEL_PATH}" \
  --test-csv "${TEST_CSV}" \
  --output-dir "${OUTPUT_DIR}" \
  --batch-size "${NAIPV2_BATCH_SIZE:-8}" \
  --max-length 512 \
  --precision 8bit \
  --seed 42
