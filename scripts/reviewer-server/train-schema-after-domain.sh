#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${REVIEWER_SERVER_SCRIPT_DIR}/common.sh"
DOMAIN_PID_FILE="${ONESCIENCE_SERVER_ROOT}/logs/domain-train.pid"
DOMAIN_ADAPTER="${ONESCIENCE_SERVER_ROOT}/outputs/qwen3-4b-instruct-2507/domain-lora/adapter_config.json"

if [[ ! -f "${DOMAIN_PID_FILE}" ]]; then
  echo "找不到 domain 训练 PID 文件：${DOMAIN_PID_FILE}" >&2
  exit 1
fi
DOMAIN_PID="$(tr -d '[:space:]' < "${DOMAIN_PID_FILE}")"
if [[ ! "${DOMAIN_PID}" =~ ^[0-9]+$ ]]; then
  echo "domain 训练 PID 无效。" >&2
  exit 1
fi

while kill -0 "${DOMAIN_PID}" 2>/dev/null; do
  sleep 30
done

if [[ ! -f "${DOMAIN_ADAPTER}" ]]; then
  echo "domain 训练未生成最终 adapter，Schema 训练不会启动。" >&2
  exit 1
fi

exec bash "${REVIEWER_SERVER_SCRIPT_DIR}/train-schema.sh"
