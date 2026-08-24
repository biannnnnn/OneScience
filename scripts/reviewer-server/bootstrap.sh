#!/usr/bin/env bash
set -euo pipefail

REVIEWER_SERVER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${REVIEWER_SERVER_SCRIPT_DIR}/common.sh"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "该脚本只能在 NVIDIA Linux 服务器运行。" >&2
  exit 1
fi
command -v nvidia-smi >/dev/null
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader

mkdir -p \
  "${ONESCIENCE_SERVER_ROOT}/.cache/conda-pkgs" \
  "${ONESCIENCE_SERVER_ROOT}/.cache/huggingface" \
  "${ONESCIENCE_SERVER_ROOT}/.cache/pip" \
  "${ONESCIENCE_SERVER_ROOT}/logs" \
  "${ONESCIENCE_SERVER_ROOT}/outputs" \
  "${ONESCIENCE_SERVER_ROOT}/runtime"

FACTORY_DIR="${ONESCIENCE_SERVER_ROOT}/runtime/LLaMA-Factory"
FACTORY_REVISION="03a70ba8ddb9636b90627753d49a4a9a054585bd"
if [[ ! -d "${FACTORY_DIR}/.git" ]]; then
  git clone https://github.com/hiyouga/LLaMA-Factory.git "${FACTORY_DIR}"
fi
git -C "${FACTORY_DIR}" checkout "${FACTORY_REVISION}"

CONDA_BIN="${ONESCIENCE_CONDA_BIN:-/home/liuheng/miniconda3/bin/conda}"
export CONDA_PKGS_DIRS="${ONESCIENCE_SERVER_ROOT}/.cache/conda-pkgs"
USED_SEED_ENV=false
if [[ ! -x "${ONESCIENCE_SERVER_PYTHON}" ]]; then
  SEED_ENV="${ONESCIENCE_SEED_ENV:-/data3/liuyuan/miniconda3/envs/llama_factory}"
  if [[ -x "${SEED_ENV}/bin/python" ]]; then
    "${CONDA_BIN}" create --prefix "${ONESCIENCE_SERVER_ROOT}/.venv-server" --clone "${SEED_ENV}" -y
    USED_SEED_ENV=true
  else
    "${CONDA_BIN}" create --prefix "${ONESCIENCE_SERVER_ROOT}/.venv-server" python=3.11 pip -y
  fi
fi

"${ONESCIENCE_SERVER_PYTHON}" -m pip install --upgrade pip
if [[ "${USED_SEED_ENV}" == "true" ]]; then
  "${ONESCIENCE_SERVER_PYTHON}" -m pip install --no-deps -e "${FACTORY_DIR}"
else
  "${ONESCIENCE_SERVER_PYTHON}" -m pip install -e "${FACTORY_DIR}"
fi
"${ONESCIENCE_SERVER_PYTHON}" -m pip install bitsandbytes jsonschema
cp "${ONESCIENCE_SERVER_ROOT}/config/reviewer-server/dataset_info.json" \
  "${ONESCIENCE_SERVER_ROOT}/data/openreview/sft/dataset_info.json"

"${ONESCIENCE_SERVER_PYTHON}" -c "import bitsandbytes, torch; print('torch', torch.__version__, 'cuda', torch.version.cuda, 'available', torch.cuda.is_available()); print('bitsandbytes', bitsandbytes.__version__)"
