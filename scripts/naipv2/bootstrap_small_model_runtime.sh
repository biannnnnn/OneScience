#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OFFICIAL_RUNTIME="${NAIPV2_RUNTIME_ROOT:-${PROJECT_ROOT}/runtime/naipv2-official}"
PYTHON_BIN="${NAIPV2_PYTHON:-${OFFICIAL_RUNTIME}/.venv/bin/python}"
PACKAGE_DIR="${NAIPV2_SMALL_PACKAGE_DIR:-${PROJECT_ROOT}/runtime/naipv2-small/packages}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "小模型训练运行时需要在 NVIDIA Linux 服务器上准备。" >&2
  exit 1
fi
if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "缺少 NAIPv2 Python 运行时：${PYTHON_BIN}" >&2
  exit 1
fi

mkdir -p "${PACKAGE_DIR}"
"${PYTHON_BIN}" -m pip install \
  --target "${PACKAGE_DIR}" \
  --upgrade \
  --no-deps \
  "transformers==4.53.2" \
  "peft==0.15.2" \
  "accelerate==1.7.0" \
  "bitsandbytes==0.46.1" \
  "huggingface-hub==0.33.2" \
  "tokenizers==0.21.4"

PYTHONPATH="${PACKAGE_DIR}${PYTHONPATH:+:${PYTHONPATH}}" "${PYTHON_BIN}" -c \
  'import accelerate, bitsandbytes, peft, torch, transformers; print({"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__, "accelerate": accelerate.__version__, "bitsandbytes": bitsandbytes.__version__})'
