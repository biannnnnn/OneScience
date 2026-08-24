# 目标期刊录用概率预测

## 定位与边界

录用概率预测是现有 Reviewer Service 之外的独立任务。Reviewer 继续输出投稿前准备度、问题和证据；预测层只消费初始投稿正文、目标期刊元数据和一个冻结 Reviewer 版本产生的结构化审稿结果。

预测目标是：

```text
P(accept | initial manuscript, target venue, frozen reviewer output)
```

它不是期刊的真实编辑决定。模型未通过时间外概率校准前，产品只能展示实验性风险分，不得宣传为可靠录用概率。

以下字段严禁作为预测输入：

- 人类审稿评分或置信度；
- meta-review；
- 最终 decision 文本；
- rebuttal、讨论后论文或最终发表版本；
- 作者、机构、声望和身份信息。

最终 `decision` 只作为训练标签。训练特征必须由同一个冻结 Reviewer 版本为 train、validation 和 test 全部重新生成，否则训练脚本会拒绝混合版本。

## 架构

```text
Qwen 7B/8B + Review LoRA（冻结）
            │
            ├── 目标期刊条件审稿、问题与证据
            │
            ▼
确定性特征提取
            │
            ▼
标准化逻辑回归
            │
            ▼
validation split 上的 Platt 概率校准
            │
            ▼
accept / borderline / reject + acceptance_probability
```

正式 8B 服务只在本地模型输出无法解析为 JSON 时调用 DeepSeek 做结构化兜底；可解析输出不会发送给 DeepSeek。该兜底不重新审稿，只整理 8B 已生成的内容。使用该模式时，公开历史论文的 8B 输出会发送给 DeepSeek API，部署方需要在隐私声明中明确这一点。

当前 MVP 没有直接微调第二个大模型。这样可以验证决策标签、时间外泛化和概率校准是否成立；只有在决策样本和期刊覆盖足够后，才考虑把分类器升级为同一 8B 基座上的独立 Decision LoRA 或分类头。

## 1. 准备决策数据

当前本地 ProReviewer 快照包含 ICLR 2025/2026 初始投稿和最终 decision。执行：

```bash
npm run acceptance:prepare -- \
  --dataset-revision <固定的数据集 revision> \
  --out data/openreview/acceptance/proreview-v0.1
```

输出：

- `cases.jsonl`：初始稿、目标 venue、二分类标签和冻结 split；
- `decision-audit.jsonl`：原始 decision 到二分类标签的审计记录；
- `manifest.json`：数据版本、排除原因和标签分布。

切分固定为 ICLR 2025 的 paper-hash train/validation，以及 ICLR 2026 时间外 test。validation 使用与 Reviewer SFT 相同的 seed 和 paper split，因此校准论文不会进入 Reviewer adapter 训练。空白或无法明确映射的 decision 会被排除，不会猜测标签。

## 2. 用冻结 Reviewer 生成特征

先启动已经选定并冻结版本的 Reviewer Service。然后运行：

GPU 服务器上的正式 8B 服务使用：

```bash
bash scripts/reviewer-server/serve-model-8b.sh
bash scripts/reviewer-server/serve-reviewer-8b.sh
```

```bash
npm run acceptance:review-features -- \
  --cases data/openreview/acceptance/proreview-v0.1/cases.jsonl \
  --out evaluation/acceptance/reviewer-features-v0.1.jsonl \
  --base-url http://127.0.0.1:8787 \
  --workers 2 \
  --resume
```

在 GPU 服务器上将命令名替换为 `acceptance:server:review-features`，使用服务器的 `.venv-server` 环境。

服务器完整的可恢复后台流水线入口是 `scripts/reviewer-server/run-acceptance-pipeline.sh`。它使用两个并发 worker、为失败 case 再运行一次 `--resume`，成功完成特征后自动训练并写出模型与报告，但不会自动把未经人工检查的模型提升为生产模型。

脚本发送给 Reviewer Service 的请求不包含 `decision_label`。所有请求使用 `venue_conditioned`，确保训练和线上推理都使用相同的目标期刊条件。

不要混用不同 adapter、Prompt 或模型版本的输出。若中断，`--resume` 只跳过已经成功的 case。

## 3. 训练与校准

```bash
npm run acceptance:train -- \
  --cases data/openreview/acceptance/proreview-v0.1/cases.jsonl \
  --reviews evaluation/acceptance/reviewer-features-v0.1.jsonl \
  --out outputs/acceptance/proreview-v0.1/model.json \
  --report evaluation/acceptance/proreview-v0.1-report.json
```

在 GPU 服务器上使用 `acceptance:server:train`。

训练集拟合标准化逻辑回归，validation split 只用于 Platt calibration，ICLR 2026 test 只报告时间外指标。报告包含：

- AUROC 与 Average Precision；
- Brier Score 和 Log Loss；
- 10-bin ECE 与校准分箱；
- train/validation/test 样本数和真实录用率。

命令默认要求 train、validation、test 至少分别有 100 条成功的冻结审稿输出，且每个 split 同时包含 accept 和 reject；不满足时会停止，而不会生成未经校准的生产模型。

概率上线门槛需要在正式实验前冻结。建议至少要求：时间外测试集样本充足、Brier Score 优于仅使用历史录用率的基线、ECE 不高于 0.05，并进行分研究方向与分 venue 审计。单个 ICLR 数据集不能支撑对任意期刊的泛化声明。

## 4. 接入 Reviewer Service

在 Reviewer Service 配置中增加：

```json
{
  "acceptance_prediction": {
    "model_path": "outputs/acceptance/proreview-v0.1/model.json",
    "request_schema_path": "schemas/acceptance-prediction-request.json",
    "output_schema_path": "schemas/acceptance-prediction.json"
  }
}
```

服务启动后，`GET /health` 会显示 `acceptance_prediction.loaded: true`。调用顺序为：

1. `POST /v1/reviews`，使用 `review_type: venue_conditioned`；
2. 将同一份 `manuscript`、`target_venue` 和返回的 `review` 发送到 `POST /v1/acceptance-predictions`。

请求示意：

```json
{
  "request_id": "prediction-001",
  "manuscript": {
    "title": "...",
    "language": "en",
    "paragraphs": [
      { "section": "Abstract", "paragraph_id": "abstract-p01", "text": "..." }
    ]
  },
  "target_venue": { "id": "ICLR.cc/2026/Conference", "name": "ICLR 2026" },
  "review": { "review_type": "venue_conditioned" }
}
```

完整请求和响应分别由 `schemas/acceptance-prediction-request.json` 与 `schemas/acceptance-prediction.json` 约束。服务会拒绝以下情况：

- 审稿结果不是目标期刊条件审稿；
- 审稿和预测的目标期刊不一致；
- 审稿模型版本与预测器训练版本不一致；
- 预测模型尚未配置。

未见过的 venue 会回退到训练集全局基础录用率，并明确标记 `out_of_distribution_venue: true` 和低置信度警告。

## 隐私与复现

- 生成的 cases、Reviewer 输出、模型权重和报告默认分别写入已忽略的 `data/openreview/`、`evaluation/acceptance/` 和 `outputs/`；
- 原始论文、标签和预测请求不由 Reviewer Service 持久化；
- 模型产物记录特征协议、Reviewer 签名、训练样本量、venue 先验和校准指标；
- 更新 Reviewer adapter 或 Prompt 后，必须为所有 split 重新生成特征并重训预测层。
