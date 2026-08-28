# NAIPv2 小模型等效性实验

更新日期：2026-08-28

## 目标

比较约 3B 和 0.6B 的论文 Ranker 是否能接近当前生产 8B adapter，重点评估在保持论文排序能力的同时降低显存、推理时延和部署成本的可行性。

## 模型

- 生产基线：`Meta-Llama-3-8B + retrained-paper-faithful-seed42`；
- 3B 候选：`Qwen/Qwen2.5-3B`；
- 0.6B 候选：`Qwen/Qwen3-0.6B`。

两个候选均使用基础模型而非指令模型。Qwen3 系列没有恰好 3B 的基础模型，因此本轮 3B 与 0.6B 不属于同一代架构；结果首先用于参数规模筛选，不能把差异全部归因于参数量。

## 冻结训练协议

两组候选共用以下设置：

- NAIDv2 固定公开训练 CSV；
- seed 42 的固定 9:1 切分；
- 按年份和领域聚类构建的同一分布 10,000 个 pair；
- NAIPv2 官方 pointwise prompt；
- 最大输入 512 tokens；
- pairwise BCE / RankNet 目标；
- 1 epoch、batch size 8、线性 warmup 10%；
- AdamW，学习率 `1e-4`，weight decay `1e-2`；
- 8-bit base + LoRA，`r=16`、`alpha=32`、`dropout=0.05`；
- 仅适配 `q_proj,v_proj`；
- 保留由易到难的课程顺序，不 shuffle。

公开测试集共 1,028 篇，测试期间不选阈值、不调超参数。

## 评价与筛选口径

主指标为 ROC-AUC、RTS Spearman 和 NDCG@20。当前生产 8B adapter 在同一公开测试集上的冻结基线为：

| 指标 | 生产 8B |
| --- | ---: |
| AUC | 0.757137 |
| Spearman | 0.380845 |
| NDCG@20 | 0.781410 |

首轮“接近”筛选门槛在训练前冻结为：

- AUC 相对 8B 下降不超过 0.02；
- Spearman 相对 8B 下降不超过 0.03；
- NDCG@20 相对 8B 下降不超过 0.03。

三项同时达标只表示进入候选，不构成统计等效性结论。若进入候选，下一阶段还需进行配对 bootstrap、跨领域/跨年份审计、线上相同批次排序一致性、时延和峰值显存测试。

## 运行

在 NVIDIA 服务器项目根目录执行：

```bash
npm run ranker:small:bootstrap
npm run ranker:small:train:0.6b
npm run ranker:small:train:3b
npm run ranker:small:compare
```

训练脚本拒绝覆盖已有 adapter，并通过锁目录阻止两组训练同时争用 GPU。新版 Transformers/PEFT/bitsandbytes 安装在独立的 `runtime/naipv2-small/packages`，不会升级生产 Ranker 运行时。
