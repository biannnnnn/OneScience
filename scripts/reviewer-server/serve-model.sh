#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${REVIEWER_SERVER_SCRIPT_DIR}/common.sh"
: "${ONESCIENCE_UPSTREAM_API_KEY:?必须设置 ONESCIENCE_UPSTREAM_API_KEY}"
export API_HOST="127.0.0.1"
export API_PORT="8000"
export API_KEY="${ONESCIENCE_UPSTREAM_API_KEY}"
export API_MODEL_NAME="onescience-reviewer-qwen3-4b"
export MAX_CONCURRENT="${ONESCIENCE_MAX_CONCURRENT:-2}"
cd "${ONESCIENCE_SERVER_ROOT}"
exec "${ONESCIENCE_LLAMAFATORY}" api config/reviewer-server/inference-schema.yaml
