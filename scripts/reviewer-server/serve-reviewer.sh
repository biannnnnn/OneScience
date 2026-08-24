#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${REVIEWER_SERVER_SCRIPT_DIR}/common.sh"
: "${ONESCIENCE_REVIEWER_API_KEY:?必须设置 ONESCIENCE_REVIEWER_API_KEY}"
: "${ONESCIENCE_UPSTREAM_API_KEY:?必须设置 ONESCIENCE_UPSTREAM_API_KEY}"
cd "${ONESCIENCE_SERVER_ROOT}"
exec "${ONESCIENCE_SERVER_PYTHON}" -m reviewer_service.app \
  --config config/reviewer-server/service.json
