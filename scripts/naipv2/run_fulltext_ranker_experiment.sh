#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：$0 <llama3-8b|qwen25-3b|qwen3-0.6b>" >&2
  exit 2
fi

MODEL_KEY="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OFFICIAL_RUNTIME="${NAIPV2_RUNTIME_ROOT:-${PROJECT_ROOT}/runtime/naipv2-official}"
PYTHON_BIN="${NAIPV2_PYTHON:-${OFFICIAL_RUNTIME}/.venv/bin/python}"
PACKAGE_DIR="${NAIPV2_SMALL_PACKAGE_DIR:-${PROJECT_ROOT}/runtime/naipv2-small/packages}"
PATCHED_SOURCE="${NAIPV2_PATCHED_DIR:-${OFFICIAL_RUNTIME}/patched-source}"
TRAIN_CSV="${FULLTEXT_TRAIN_CSV:-${PROJECT_ROOT}/data/naipv2-fulltext-evidence/proreview-train.csv}"
TEST_CSV="${FULLTEXT_TEST_CSV:-${PROJECT_ROOT}/data/naipv2-fulltext-evidence/proreview-test.csv}"
RUN_ROOT="${FULLTEXT_RUN_ROOT:-${PROJECT_ROOT}/evaluation/naipv2-fulltext-rankers/runs}"

case "${MODEL_KEY}" in
  llama3-8b)
    MODEL_ID="meta-llama/Meta-Llama-3-8B"
    BASE_MODEL="${PROJECT_ROOT}/models/Meta-Llama-3-8B"
    BATCH_SIZE=1
    EVAL_BATCH_SIZE=2
    ;;
  qwen25-3b)
    MODEL_ID="Qwen/Qwen2.5-3B"
    BASE_MODEL="${PROJECT_ROOT}/models/Qwen2.5-3B"
    BATCH_SIZE=2
    EVAL_BATCH_SIZE=4
    ;;
  qwen3-0.6b)
    MODEL_ID="Qwen/Qwen3-0.6B"
    BASE_MODEL="${PROJECT_ROOT}/models/Qwen3-0.6B"
    BATCH_SIZE=4
    EVAL_BATCH_SIZE=8
    ;;
  *)
    echo "不支持的模型键：${MODEL_KEY}" >&2
    exit 2
    ;;
esac

RUN_DIR="${RUN_ROOT}/${MODEL_KEY}-fulltext-evidence-seed42"
EVAL_DIR="${RUN_ROOT}/${MODEL_KEY}-fulltext-evidence-seed42-heldout"
LOG_DIR="${PROJECT_ROOT}/logs/naipv2-fulltext-rankers"
LOCK_DIR="${RUN_ROOT}/.training-lock"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "全文 Ranker 训练需要 NVIDIA Linux 服务器。" >&2
  exit 1
fi
for path in "${PYTHON_BIN}" "${TRAIN_CSV}" "${TEST_CSV}" "${BASE_MODEL}" \
  "${PATCHED_SOURCE}/v2_resource/v2_finetune.py" "${SCRIPT_DIR}/eval_fulltext_adapter.py"; do
  if [[ ! -e "${path}" ]]; then
    echo "缺少训练资产：${path}" >&2
    exit 1
  fi
done
if [[ ! -d "${PACKAGE_DIR}" ]]; then
  echo "缺少小模型兼容包目录：${PACKAGE_DIR}" >&2
  exit 1
fi
if [[ -e "${RUN_DIR}/adapter_config.json" || -e "${RUN_DIR}/adapter_model.bin" ]]; then
  echo "训练输出已存在，拒绝覆盖：${RUN_DIR}" >&2
  exit 1
fi
if ! mkdir -p "${RUN_ROOT}" || ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "已有 Ranker 训练任务持有锁：${LOCK_DIR}" >&2
  exit 1
fi
cleanup() { rmdir "${LOCK_DIR}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

mkdir -p "${RUN_DIR}" "${EVAL_DIR}" "${LOG_DIR}"
export PYTHONPATH="${PACKAGE_DIR}:${PATCHED_SOURCE}${PYTHONPATH:+:${PYTHONPATH}}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
export OMP_NUM_THREADS=1
export TOKENIZERS_PARALLELISM=false

TRAIN_STARTED_EPOCH="$(date +%s)"
"${PYTHON_BIN}" -m accelerate.commands.launch \
  --num_processes 1 \
  --main_process_port "${NAIPV2_PORT:-29544}" \
  "${PATCHED_SOURCE}/v2_resource/v2_finetune.py" \
  --total_epochs 1 \
  --batch_size "${BATCH_SIZE}" \
  --max_pairs 10000 \
  --data_path "${TRAIN_CSV}" \
  --checkpoint "${BASE_MODEL}" \
  --gt_field RTS \
  --loss_func default \
  --max_length 1024 \
  --learning_rate 1e-4 \
  --weight_decay 1e-2 \
  --warmup_ratio 0.1 \
  --lora_r 16 \
  --lora_alpha 32 \
  --lora_dropout 0.05 \
  --target_modules q_proj,v_proj \
  --pw_min_diff 0.5 \
  --pw_bucket_edges '[0,0.5,1,1.5,2,2.5,3,4,5,10,"inf"]' \
  --pw_target_ratio '[0,0.15,0.18,0.17,0.14,0.11,0.10,0.08,0.07,0]' \
  --pw_cap_per_paper 32 \
  --pair_val_max_pairs 10000 \
  --seed 42 \
  --shuffle_train false \
  --runs_dir "${RUN_DIR}" \
  2>&1 | tee "${LOG_DIR}/${MODEL_KEY}-train.log"
TRAIN_FINISHED_EPOCH="$(date +%s)"

"${PYTHON_BIN}" "${SCRIPT_DIR}/build_fulltext_calibration.py" \
  --predictions "${RUN_DIR}/val_pointwise_preds_latest.csv" \
  --train-csv "${TRAIN_CSV}" \
  --adapter "${RUN_DIR}" \
  --output "${RUN_DIR}/validation-calibration.json"

"${PYTHON_BIN}" "${SCRIPT_DIR}/eval_fulltext_adapter.py" \
  --base-model "${BASE_MODEL}" \
  --adapter "${RUN_DIR}" \
  --test-csv "${TEST_CSV}" \
  --output-dir "${EVAL_DIR}" \
  --model-key "${MODEL_KEY}" \
  --text-column abstract \
  --batch-size "${EVAL_BATCH_SIZE}" \
  --max-length 1024 \
  --seed 42 \
  2>&1 | tee "${LOG_DIR}/${MODEL_KEY}-eval.log"

"${PYTHON_BIN}" - "${MODEL_KEY}" "${MODEL_ID}" "${RUN_DIR}" "${TRAIN_CSV}" \
  "${TRAIN_STARTED_EPOCH}" "${TRAIN_FINISHED_EPOCH}" "${BATCH_SIZE}" <<'PY'
import hashlib
import json
import pathlib
import sys

key, model_id, run_dir, train_csv, started, finished, batch_size = sys.argv[1:]
def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

payload = {
    "schema_version": "1.0.0",
    "model_key": key,
    "model_id": model_id,
    "protocol": "ProReview full-text evidence pairwise Ranker seed42",
    "target": "confidence-weighted reviewer overall rating",
    "seed": 42,
    "max_pairs": 10000,
    "max_length": 1024,
    "epochs": 1,
    "batch_size": int(batch_size),
    "learning_rate": 1e-4,
    "training_elapsed_seconds": int(finished) - int(started),
    "training_api_tokens": 0,
    "train_csv_sha256": sha256(train_csv),
    "model_input": [
        "title", "abstract", "research question and main contributions",
        "experimental setup and datasets", "key findings and conclusion",
    ],
    "excluded_from_model_input": [
        "authors", "affiliations", "venue", "citations", "references",
        "reviews", "meta-review", "decision",
    ],
    "lora": {"r": 16, "alpha": 32, "dropout": 0.05, "target_modules": ["q_proj", "v_proj"]},
}
pathlib.Path(run_dir, "onescience-experiment.json").write_text(
    json.dumps(payload, indent=2) + "\n", encoding="utf-8"
)
PY

echo "完成 ${MODEL_KEY}：${EVAL_DIR}/metrics.json"
