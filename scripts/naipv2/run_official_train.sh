#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_ROOT="${NAIPV2_RUNTIME_ROOT:-${PROJECT_ROOT}/runtime/naipv2-official}"
PYTHON_BIN="${NAIPV2_PYTHON:-${RUNTIME_ROOT}/.venv/bin/python}"
SOURCE_DIR="${NAIPV2_SOURCE_DIR:-${RUNTIME_ROOT}/source}"
PATCHED_DIR="${NAIPV2_PATCHED_DIR:-${RUNTIME_ROOT}/patched-source}"
TRAIN_CSV="${NAIPV2_TRAIN_CSV:-${PROJECT_ROOT}/data/naipv2-official/NAIDv2-train.csv}"
BASE_MODEL="${NAIPV2_BASE_MODEL:-${PROJECT_ROOT}/models/Meta-Llama-3-8B}"
RUN_DIR="${NAIPV2_RUN_DIR:-${PROJECT_ROOT}/evaluation/naipv2-official/runs/retrained-paper-faithful-seed42}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "NAIPv2 8-bit 训练需要 NVIDIA Linux 服务器。" >&2
  exit 1
fi
for path in "${PYTHON_BIN}" "${TRAIN_CSV}"; do
  if [[ ! -e "${path}" ]]; then
    echo "缺少训练资产：${path}" >&2
    exit 1
  fi
done
if [[ ! -d "${SOURCE_DIR}" || ! -d "${BASE_MODEL}" ]]; then
  echo "缺少官方源码或 Llama-3-8B 基础模型。" >&2
  exit 1
fi
if [[ -e "${RUN_DIR}/adapter_config.json" || -e "${RUN_DIR}/adapter_model.bin" ]]; then
  echo "训练输出已存在，拒绝覆盖：${RUN_DIR}" >&2
  exit 1
fi

mkdir -p "${RUN_DIR}"
if [[ ! -d "${PATCHED_DIR}" ]]; then
  "${PYTHON_BIN}" "${SCRIPT_DIR}/prepare_official_training.py" \
    --source-dir "${SOURCE_DIR}" \
    --patched-dir "${PATCHED_DIR}" \
    --train-csv "${TRAIN_CSV}" \
    --output-dir "${RUN_DIR}" \
    --max-pairs 10000 \
    --seed 42
fi

if [[ "${NAIPV2_SMOKE_ONLY:-0}" == "1" ]]; then
  exec "${PYTHON_BIN}" "${SCRIPT_DIR}/smoke_official_training.py" \
    --patched-source "${PATCHED_DIR}" \
    --checkpoint "${BASE_MODEL}" \
    --train-csv "${TRAIN_CSV}" \
    --output "${RUN_DIR}/smoke.json" \
    --seed 42 \
    --batch-size "${NAIPV2_SMOKE_BATCH_SIZE:-1}" \
    --max-pairs 10000
fi

export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
export OMP_NUM_THREADS=1
export PYTHONPATH="${PATCHED_DIR}${PYTHONPATH:+:${PYTHONPATH}}"

PORT="${NAIPV2_PORT:-29542}"
exec "${PYTHON_BIN}" -m accelerate.commands.launch \
  --num_processes 1 \
  --main_process_port "${PORT}" \
  "${PATCHED_DIR}/v2_resource/v2_finetune.py" \
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
  --runs_dir "${RUN_DIR}"
