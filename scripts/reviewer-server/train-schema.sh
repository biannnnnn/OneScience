#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${REVIEWER_SERVER_SCRIPT_DIR}/common.sh"
cd "${ONESCIENCE_SERVER_ROOT}"
exec "${ONESCIENCE_LLAMAFATORY}" train config/reviewer-server/train-schema-4090.yaml
