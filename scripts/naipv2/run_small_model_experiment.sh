#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：$0 <qwen25-3b|qwen3-0.6b>" >&2
  exit 2
fi

MODEL_KEY="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OFFICIAL_RUNTIME="${NAIPV2_RUNTIME_ROOT:-${PROJECT_ROOT}/runtime/naipv2-official}"
PYTHON_BIN="${NAIPV2_PYTHON:-${OFFICIAL_RUNTIME}/.venv/bin/python}"
PACKAGE_DIR="${NAIPV2_SMALL_PACKAGE_DIR:-${PROJECT_ROOT}/runtime/naipv2-small/packages}"
PATCHED_SOURCE="${NAIPV2_PATCHED_DIR:-${OFFICIAL_RUNTIME}/patched-source}"
TRAIN_CSV="${NAIPV2_TRAIN_CSV:-${PROJECT_ROOT}/data/naipv2-official/NAIDv2-train.csv}"
TEST_CSV="${NAIPV2_TEST_CSV:-${PROJECT_ROOT}/data/naipv2-official/NAIDv2-test.csv}"
RUN_ROOT="${NAIPV2_SMALL_RUN_ROOT:-${PROJECT_ROOT}/evaluation/naipv2-small-models/runs}"

case "${MODEL_KEY}" in
  qwen25-3b)
    MODEL_ID="Qwen/Qwen2.5-3B"
    BASE_MODEL="${PROJECT_ROOT}/models/Qwen2.5-3B"
    ;;
  qwen3-0.6b)
    MODEL_ID="Qwen/Qwen3-0.6B"
    BASE_MODEL="${PROJECT_ROOT}/models/Qwen3-0.6B"
    ;;
  *)
    echo "不支持的模型键：${MODEL_KEY}" >&2
    exit 2
    ;;
esac

RUN_DIR="${RUN_ROOT}/${MODEL_KEY}-naipv2-seed42"
EVAL_DIR="${RUN_ROOT}/${MODEL_KEY}-naipv2-seed42-public-test"
LOG_DIR="${PROJECT_ROOT}/logs/naipv2-small-models"
LOCK_DIR="${RUN_ROOT}/.training-lock"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "小模型训练需要 NVIDIA Linux 服务器。" >&2
  exit 1
fi
for path in "${PYTHON_BIN}" "${TRAIN_CSV}" "${TEST_CSV}" "${PATCHED_SOURCE}/v2_resource/v2_finetune.py"; do
  if [[ ! -e "${path}" ]]; then
    echo "缺少训练资产：${path}" >&2
    exit 1
  fi
done
if [[ ! -d "${PACKAGE_DIR}" ]]; then
  echo "请先运行 scripts/naipv2/bootstrap_small_model_runtime.sh" >&2
  exit 1
fi
if [[ -e "${RUN_DIR}/adapter_config.json" || -e "${RUN_DIR}/adapter_model.bin" ]]; then
  echo "训练输出已存在，拒绝覆盖：${RUN_DIR}" >&2
  exit 1
fi
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "已有小模型训练任务持有锁：${LOCK_DIR}" >&2
  exit 1
fi
cleanup() { rmdir "${LOCK_DIR}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

mkdir -p "${RUN_DIR}" "${EVAL_DIR}" "${LOG_DIR}"
export PYTHONPATH="${PACKAGE_DIR}:${PATCHED_SOURCE}${PYTHONPATH:+:${PYTHONPATH}}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
export OMP_NUM_THREADS=1
export TOKENIZERS_PARALLELISM=false

if [[ ! -f "${BASE_MODEL}/onescience-download-manifest.json" ]]; then
  HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}" \
  HF_HUB_DISABLE_XET=1 \
  "${PYTHON_BIN}" "${SCRIPT_DIR}/download_small_model.py" \
    --model-id "${MODEL_ID}" \
    --local-dir "${BASE_MODEL}"
fi

"${PYTHON_BIN}" -m accelerate.commands.launch \
  --num_processes 1 \
  --main_process_port "${NAIPV2_PORT:-29543}" \
  "${PATCHED_SOURCE}/v2_resource/v2_finetune.py" \
  --total_epochs 1 \
  --batch_size 8 \
  --max_pairs 10000 \
  --data_path "${TRAIN_CSV}" \
  --checkpoint "${BASE_MODEL}" \
  --gt_field RTS \
  --loss_func default \
  --max_length 512 \
  --learning_rate 1e-4 \
  --weight_decay 1e-2 \
  --warmup_ratio 0.1 \
  --lora_r 16 \
  --lora_alpha 32 \
  --lora_dropout 0.05 \
  --target_modules q_proj,v_proj \
  --seed 42 \
  --shuffle_train false \
  --runs_dir "${RUN_DIR}" \
  2>&1 | tee "${LOG_DIR}/${MODEL_KEY}-train.log"

"${PYTHON_BIN}" "${SCRIPT_DIR}/eval_retrained_adapter.py" \
  --base-model "${BASE_MODEL}" \
  --adapter "${RUN_DIR}" \
  --test-csv "${TEST_CSV}" \
  --output-dir "${EVAL_DIR}" \
  --batch-size 8 \
  --max-length 512 \
  --seed 42 \
  2>&1 | tee "${LOG_DIR}/${MODEL_KEY}-eval.log"

"${PYTHON_BIN}" - "${MODEL_KEY}" "${MODEL_ID}" "${RUN_DIR}" <<'PY'
import json
import pathlib
import sys

key, model_id, run_dir = sys.argv[1:]
path = pathlib.Path(run_dir) / "onescience-experiment.json"
payload = {
    "schema_version": "1.0.0",
    "model_key": key,
    "model_id": model_id,
    "protocol": "NAIPv2 paper-faithful seed42 small-model comparison",
    "seed": 42,
    "max_pairs": 10000,
    "max_length": 512,
    "epochs": 1,
    "batch_size": 8,
    "learning_rate": 1e-4,
    "lora": {"r": 16, "alpha": 32, "dropout": 0.05, "target_modules": ["q_proj", "v_proj"]},
}
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

echo "完成 ${MODEL_KEY}：${EVAL_DIR}/metrics.json"
