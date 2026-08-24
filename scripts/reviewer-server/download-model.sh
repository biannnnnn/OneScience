#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${REVIEWER_SERVER_SCRIPT_DIR}/common.sh"
MODEL_DIR="${ONESCIENCE_SERVER_ROOT}/models/Qwen3-4B-Instruct-2507"
mkdir -p "${MODEL_DIR}"
exec "${ONESCIENCE_SERVER_PYTHON}" -m modelscope.cli.cli download \
  --model Qwen/Qwen3-4B-Instruct-2507 \
  --local_dir "${MODEL_DIR}"
