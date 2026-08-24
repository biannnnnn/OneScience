#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONESCIENCE_SERVER_ROOT="$(cd "${REVIEWER_SERVER_SCRIPT_DIR}/../.." && pwd)"

export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
export HF_HOME="${ONESCIENCE_SERVER_ROOT}/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="${HF_HOME}/hub"
export MODELSCOPE_CACHE="${ONESCIENCE_SERVER_ROOT}/.cache/modelscope"
export USE_MODELSCOPE_HUB="1"
export PIP_CACHE_DIR="${ONESCIENCE_SERVER_ROOT}/.cache/pip"
export TOKENIZERS_PARALLELISM="false"

ONESCIENCE_SERVER_PYTHON="${ONESCIENCE_SERVER_ROOT}/.venv-server/bin/python"
ONESCIENCE_LLAMAFATORY="${ONESCIENCE_SERVER_ROOT}/.venv-server/bin/llamafactory-cli"

if [[ -f "${ONESCIENCE_SERVER_ROOT}/.server-secrets" ]]; then
  # shellcheck disable=SC1091
  source "${ONESCIENCE_SERVER_ROOT}/.server-secrets"
fi
