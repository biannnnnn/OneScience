# Reviewer GPU 服务器迁移

服务器入口为 `/home/liuheng/OneScience`，实际数据存储在 `/data2/liuheng/OneScience`，以免占用接近满载的系统盘。GPU 训练固定使用 `CUDA_VISIBLE_DEVICES=0`。

## 目录与隐私

- 源码、OpenReview 数据、训练输出、模型缓存和运行日志全部位于 OneScience 目录；
- 不上传 Apple MLX 模型缓存、MLX 虚拟环境、MLX adapter、`node_modules`、投稿文件或本地密钥；
- `.server-secrets` 只在服务器生成，权限必须是 `0600`，不会进入 Git；
- LLaMA-Factory 模型 API 只监听 `127.0.0.1:8000`；
- 对外的 Reviewer Service 监听 `8787`，使用 Bearer API Key，并且不持久化论文正文。

## 初始化

```bash
ssh liuheng@100.91.253.128
cd /home/liuheng/OneScience
bash scripts/reviewer-server/bootstrap.sh
bash scripts/reviewer-server/download-model.sh
```

环境、Conda 包缓存、ModelScope 模型和训练输出都会写入 `/data2`。服务器无法稳定访问 Hugging Face，因此 Qwen3-4B-Instruct-2507 从 ModelScope 下载到项目内的 `models/`。LLaMA-Factory 固定 revision 为 `03a70ba8ddb9636b90627753d49a4a9a054585bd`。

## 两阶段训练

```bash
bash scripts/reviewer-server/train-domain.sh
bash scripts/reviewer-server/train-schema.sh
```

第一阶段使用 OpenReview domain-SFT；第二阶段从第一阶段 adapter 继续进行 Schema-SFT。两阶段均使用 Qwen3-4B-Instruct-2507、bitsandbytes 4-bit、LoRA rank 8，并通过独立 validation split 选择最佳检查点。

远程无人值守运行时，可在 domain 训练启动后运行 `train-schema-after-domain.sh`。它只在 domain 根目录生成最终 adapter 后启动 Schema 训练；domain 失败时会停止，不会使用不完整检查点。

查看当前进程、adapter 和最近训练指标：

```bash
bash scripts/reviewer-server/status.sh
```

## 启动服务

先在服务器生成两个不同的随机密钥并写入 `.server-secrets`：

```bash
export ONESCIENCE_UPSTREAM_API_KEY="..."
export ONESCIENCE_REVIEWER_API_KEY="..."
```

然后分别启动：

```bash
bash scripts/reviewer-server/serve-model.sh
bash scripts/reviewer-server/serve-reviewer.sh
```

OneScience 主站只保存 `ONESCIENCE_REVIEWER_API_KEY`。当前期刊流程通过 `http://100.91.253.128:8787/v1/venue-scores` 批量评分；`/v1/reviews` 仅保留给完整结构化审稿任务。上游模型密钥不离开服务器。

## 微调后评测

先把 Schema-SFT 的 ICLR 2026 隔离测试集转换为不包含训练目标的推理样本：

```bash
.venv-server/bin/python scripts/reviewer-server/prepare-heldout-eval.py \
  --input data/openreview/sft/proreview-schema-weak-v0.1/test.jsonl \
  --audit data/openreview/sft/proreview-schema-weak-v0.1/audit-test.jsonl \
  --out evaluation/reviewer-baseline/runs/openreview-2026-heldout-100.jsonl \
  --limit 100
```

加载 `.server-secrets` 后运行评测。`--resume` 会跳过已落盘的 case，服务器或 SSH 中断后可以继续；RTX 4090 使用两个 worker：

```bash
set -a
source .server-secrets
set +a
.venv-server/bin/python scripts/reviewer-server/run-openai-eval.py \
  --config config/reviewer-server/model-qwen3-4b-schema.json \
  --schema schemas/review-schema.json \
  --cases evaluation/reviewer-baseline/runs/openreview-2026-heldout-100.jsonl \
  --out evaluation/reviewer-baseline/runs/qwen3-4b-server-schema-heldout-100.jsonl \
  --resume \
  --workers 2
```

评测保留原始模型输出，同时分别记录 JSON 可解析率、完整 `review-schema.json` 通过率和 Schema 错误，不对 `null`、未闭合 JSON 或其他失败做静默修复。实时查看：

```bash
bash scripts/reviewer-server/status.sh
tail -f logs/heldout-eval.log
```
