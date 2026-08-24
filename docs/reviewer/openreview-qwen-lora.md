# Qwen3-4B OpenReview 微调（Apple M1）

本阶段已经完成 OpenReview domain-SFT 和弱监督 Schema 对齐两轮烟雾微调。适配器可以被 MLX 推理器和 Reviewer Service 加载，但因为尚未通过完整审稿协议评测，当前不会替换默认模型。

本地依赖版本固定在 `requirements/reviewer-mlx.txt`。模型 revision 已缓存时，基线推理器和 Reviewer Service 会直接使用本地 snapshot，不再请求 Hugging Face，因此断网也能启动。

## 数据来源与冻结版本

- 数据集：[UKPLab/ProReviewer-Dataset](https://huggingface.co/datasets/UKPLab/ProReviewer-Dataset)；
- 固定 revision：`104e9b01c5d002f3f1775d38d3f5517f828cafd3`；
- 数据卡标注许可证：MIT；正式商业使用前仍需重新检查数据集与原始论文内容的授权边界；
- ICLR 2025：原始训练集；
- ICLR 2026：完整保留为时间外测试集，不参与训练或 Prompt 调整。

数据集提供版本匹配的初始投稿和初始评审，避免用 rebuttal 后论文训练 rebuttal 前评审。原始文件保存在 Git 忽略的 `data/openreview/external/proreview/`。

## 训练目标

本轮目标是 `openreview_review_content_sft`，学习人类评审中的：

- 论文概括；
- 优势；
- 核心问题；
- 作者问题。

以下字段明确不进入监督目标：录用决定、初始评分、meta-review、评审身份。OpenReview 自由文本没有可靠的段落级证据标注，因此本阶段不会伪造 `direct_quote`，也不宣称完成 `review-schema.json` 对齐。

## 数据转换

```bash
npm run reviewer:train:prepare -- \
  --dataset-revision 104e9b01c5d002f3f1775d38d3f5517f828cafd3
```

输出位于 `data/openreview/sft/proreview-domain-v0.1/`：

| Split | 样本数 | 来源 |
|---|---:|---|
| train | 3,605 | ICLR 2025 |
| valid | 406 | ICLR 2025，paper ID 固定哈希 |
| test | 997 | ICLR 2026 |

每篇论文最多选择一条高置信度评审，同一论文不会跨 split。输入从摘要、方法、实验、结果、讨论和结论等章节分配字符预算；目标不超过 1,200 字符。Qwen tokenizer 检查结果：P50 713 tokens、P95 797、最大 1,018，超过 1,024 的样本为 0。

## M1 烟雾 QLoRA

MLX-LM 官方支持量化模型上的 QLoRA、chat JSONL、Prompt masking、梯度累积和 gradient checkpointing；本机配置见 `config/reviewer-lora-smoke.m1.yaml`。

```bash
npm run reviewer:train:smoke
```

核心配置：

- Qwen3-4B MLX 4-bit；
- LoRA rank 4，只训练最后 4 层；
- 0.918M 可训练参数，占总参数约 0.023%；
- batch size 1，梯度累积 4；
- 最大序列 1,024；
- gradient checkpointing；
- 20 iterations，学习率 `1e-5`。

实测结果：

| 指标 | 结果 |
|---|---:|
| 初始 validation loss | 3.994 |
| 最终 validation loss | 3.521 |
| 最终 train loss | 3.540 |
| 训练 token | 4,613 |
| 峰值内存 | 3.740GB |
| 最终适配器大小 | 约 3.5MB |

适配器位于 Git 忽略的 `adapters/qwen3-4b-openreview-domain-v0.1-smoke/`。完整运行元数据保存在 `evaluation/reviewer-training/openreview-domain-v0.1-smoke.json`。

## 微调前后探针

在相同的 4 个 ICLR 2026 test batches 上：

| 模型 | Test loss | Perplexity |
|---|---:|---:|
| 未微调 Qwen3-4B | 3.842 | 46.600 |
| 20-step OpenReview LoRA | 3.642 | 38.167 |

这只能说明数据、梯度、适配器和测试链路工作，并有初步的领域建模信号。四个 batch 和 20 步训练不足以构成正式质量结论。

在原有两条结构化审稿样例上，LoRA 的 JSON 有效率仍为 100%，但 Schema 通过率仍为 0%，证据可定位率从未微调基线的 62.5% 降为 50%。因此适配器没有被提升为默认 Reviewer Service 模型。

## 第二阶段：弱监督 Schema 对齐

OpenReview 的自由文本评审没有段落级证据标注。为了先验证技术链路，`prepare_schema_alignment.py` 使用高阈值 TF-IDF 余弦匹配，将评审中的优势或问题与原稿段落对齐，并且只保留：

- 相似度不低于 `0.30`；
- 第一候选比第二候选至少高 `0.06`；
- 证据摘录能逐字回查原段落；
- 不包含评分、录用决定、meta-review 或评审身份。

这批标签的质量等级是 `weak_supervision_requires_expert_audit`，只用于工程验证，不视为人工金标，也不能直接用于产品上线。

```bash
npm run reviewer:train:prepare-schema -- \
  --dataset-revision 104e9b01c5d002f3f1775d38d3f5517f828cafd3
npm run reviewer:train:schema-smoke
```

输出位于 Git 忽略的 `data/openreview/sft/proreview-schema-weak-v0.1/`：train 3,154、valid 353、ICLR 2026 test 821，共得到 5,799 个高阈值对齐。训练输入的 token 长度 P50 为 893、P95 为 1,175、最大为 1,544。全量检查中 Schema 错误、不可回查摘录和无效 concern 引用均为 0。

第二轮从 domain-SFT 权重继续训练，使用同样的 LoRA rank 4 和最后 4 层，最大序列提高到 1,600。20 步训练实测峰值内存为 4.614GB。验证损失如下：

| Iteration | Validation loss |
|---:|---:|
| 1 | 2.512 |
| 5 | 2.239 |
| 10 | 2.095 |
| 15 | 2.017 |
| 20 | 2.400 |

第 15 步损失最低但当时未保存；第 10 步是最佳已保存检查点。第 20 步已经出现回升，因此没有把“最后一步”误当成“最佳模型”。

在相同的两条冻结结构化样例上：

| 模型 | JSON 有效 | Schema 通过 | 证据可定位 | 问题 F1 | 准备度准确率 |
|---|---:|---:|---:|---:|---:|
| 未微调 Qwen3-4B | 100% | 0% | 62.5% | 25% | 0% |
| Domain-SFT step 20 | 100% | 0% | 50% | 25% | 0% |
| Schema-SFT step 10 | 100% | 0% | 75% | 25% | 0% |
| Schema-SFT step 20 | 100% | 0% | 40% | 25% | 0% |

第 10 步的证据可定位率有改善，但两个样例仍把顶层 `limitations` 输出为字符串，且问题 F1、准备度结论均未改善。因此这轮结果仍被拒绝晋升。完整元数据见 `evaluation/reviewer-training/openreview-schema-weak-v0.1-smoke.json`。

## 加载适配器

仅用于实验验证：

```bash
npm run reviewer:serve:trained-smoke
```

默认的 `npm run reviewer:serve` 仍加载未经微调的冻结基线。实验配置为 `config/reviewer-baseline-openreview-smoke.m1.json`，服务健康检查会显示 `adapter_version=openreview-domain-v0.1-smoke-iter20`。

最佳已保存 Schema 检查点也只提供实验入口：

```bash
npm run reviewer:serve:schema-smoke
```

该命令加载 `openreview-schema-weak-v0.1-step10`，不会改变默认服务配置。

## 下一阶段

1. 从弱监督数据中分层抽样，由领域专家审核 concern—段落证据、类别和严重度；
2. 补充专门覆盖空数组、`limitations`、证据联合类型和 concern—task 引用关系的人工金标样本；
3. 使用更频繁的 checkpoint 保存和 early stopping，避免遗漏最佳验证点；
4. 在冻结的 OpenReview 时间留出集和独立专家盲评集上评测，而不是依赖两条烟雾样例；
5. 只有 Schema ≥99%、证据可定位率 ≥90% 且专家盲评通过时，才更新 Reviewer Service 默认模型。

MLX-LM LoRA 格式和低内存建议见其[官方文档](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md)。
