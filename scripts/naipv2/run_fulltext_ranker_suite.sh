#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_ROOT="${FULLTEXT_RUN_ROOT:-${PROJECT_ROOT}/evaluation/naipv2-fulltext-rankers/runs}"
SUITE_LOG="${PROJECT_ROOT}/logs/naipv2-fulltext-rankers/suite.log"
PYTHON_BIN="${NAIPV2_PYTHON:-${PROJECT_ROOT}/runtime/naipv2-official/.venv/bin/python}"
SERVICE_PATTERN="ranker_service.app --config config/ranker-server/service.json"
SERVICE_WAS_RUNNING=false
SERVICE_PAUSED=false

mkdir -p "$(dirname "${SUITE_LOG}")"

log() {
  echo "$(date -Iseconds) $*" | tee -a "${SUITE_LOG}"
}

restart_service() {
  if [[ "${SERVICE_PAUSED}" == true && "${SERVICE_WAS_RUNNING}" == true ]]; then
    if ! pgrep -f "${SERVICE_PATTERN}" >/dev/null; then
      log "恢复原 Ranker 服务"
      cd "${PROJECT_ROOT}"
      nohup npm run ranker:serve > logs/ranker-service-after-fulltext.log 2>&1 < /dev/null &
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        if pgrep -f "${SERVICE_PATTERN}" >/dev/null; then
          log "Ranker 服务进程已恢复"
          SERVICE_PAUSED=false
          return 0
        fi
        sleep 3
      done
      log "警告：未检测到恢复后的 Ranker 服务进程"
      return 1
    fi
    SERVICE_PAUSED=false
  fi
}

trap restart_service EXIT
trap 'exit 130' INT TERM

cd "${PROJECT_ROOT}"
log "等待正在运行的 0.6B 全文 Ranker 完成"
while pgrep -f '[r]un_fulltext_ranker_experiment.sh qwen3-0.6b' >/dev/null; do
  sleep 30
done
if [[ ! -f "${RUN_ROOT}/qwen3-0.6b-fulltext-evidence-seed42-heldout/metrics.json" ]]; then
  log "0.6B 未产生评测结果，停止套件"
  exit 1
fi

log "启动 3B 全文 Ranker"
bash "${SCRIPT_DIR}/run_fulltext_ranker_experiment.sh" qwen25-3b

if pgrep -f "${SERVICE_PATTERN}" >/dev/null; then
  SERVICE_WAS_RUNNING=true
  SERVICE_PAUSED=true
  log "8B 训练前暂停原 Ranker 服务以释放显存"
  mapfile -t SERVICE_PIDS < <(pgrep -f "${SERVICE_PATTERN}" || true)
  mapfile -t NPM_PIDS < <(pgrep -f '^npm run ranker:serve$' || true)
  if [[ ${#SERVICE_PIDS[@]} -gt 0 ]]; then kill -TERM "${SERVICE_PIDS[@]}"; fi
  if [[ ${#NPM_PIDS[@]} -gt 0 ]]; then kill -TERM "${NPM_PIDS[@]}"; fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! pgrep -f "${SERVICE_PATTERN}" >/dev/null; then break; fi
    sleep 3
  done
  if pgrep -f "${SERVICE_PATTERN}" >/dev/null; then
    log "无法释放原 Ranker 服务显存，停止 8B 训练"
    exit 1
  fi
fi

log "启动 8B 全文 Ranker"
bash "${SCRIPT_DIR}/run_fulltext_ranker_experiment.sh" llama3-8b
restart_service

"${PYTHON_BIN}" "${SCRIPT_DIR}/compare_fulltext_rankers.py" \
  --run "8B=${RUN_ROOT}/llama3-8b-fulltext-evidence-seed42-heldout/metrics.json" \
  --run "3B=${RUN_ROOT}/qwen25-3b-fulltext-evidence-seed42-heldout/metrics.json" \
  --run "0.6B=${RUN_ROOT}/qwen3-0.6b-fulltext-evidence-seed42-heldout/metrics.json" \
  --out "${PROJECT_ROOT}/evaluation/naipv2-fulltext-rankers/comparison.json" \
  2>&1 | tee -a "${SUITE_LOG}"
log "三个全文 Ranker 训练评测全部完成"
trap - EXIT INT TERM
