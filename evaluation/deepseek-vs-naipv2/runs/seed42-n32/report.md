# DeepSeek vs NAIPv2 初始 A/B 评测

评测日期：2026-08-25

## 结论

在当前固定的 32 篇 NAIDv2 分层子集上，关闭 thinking 的 `deepseek-v4-pro` 明显弱于 NAIPv2 官方权重。DeepSeek 暂时不适合直接替代小模型成为正式质量排序器；更适合作为解释层，或在完成 prompt/标定实验后再次评估。

## 数据与方法

- 数据：固定公开 NAIDv2 test CSV，SHA-256 `bbbd4ccc1a84761579e6faf54c3248bba0c3456696c0a9897889390aaef2095e`；
- 子集：32 篇，accept/reject 各 16 篇；分别在两类中按 RTS 从低到高等距抽样；
- 输入：两个模型均只使用标题和摘要；
- DeepSeek：`deepseek-v4-pro`、prompt `deepseek-paper-batch-rubric-1.0.0`、thinking disabled、4 批 × 8 篇；
- 小模型：仓库归档的 NAIPv2 官方公开权重预测；远程私有重训练 Ranker 当前不可访问，因此本轮不是对私有 adapter 的直接测试；
- 指标：accept AUC、RTS Spearman、RTS pairwise accuracy，以及同一请求批次内的 AUC/pairwise accuracy。

## 结果

| 指标 | DeepSeek | NAIPv2 官方权重 |
| --- | ---: | ---: |
| Accept AUC | 0.5723 | 0.7852 |
| RTS Spearman | 0.0657 | 0.3724 |
| RTS pairwise accuracy | 0.5303 | 0.6310 |
| 批内 Accept AUC | 0.5625 | 0.8125 |
| 批内 RTS pairwise accuracy | 0.5714 | 0.7054 |

DeepSeek 与 NAIPv2 的分数 Spearman 仅为 `0.2111`，pairwise 排序一致率为 `0.5931`。

DeepSeek 的 accept 平均分为 `73.38`，reject 平均分为 `72.13`，仅相差 `1.25` 分。32 篇分数集中在 `65–82`，标准差 `4.49`，只有 12 个不同分值，存在明显分数压缩。这意味着当前产品使用的固定 `±5` 阈值不能直接视为已经适配 DeepSeek。

## 时延与用量

- 请求数：4；
- 总请求时间：92.65 秒；
- 平均每批：23.16 秒；
- Prompt tokens：10,320；
- Completion tokens：5,466；
- 总 tokens：15,786。

thinking-enabled 的首批请求超过 75 秒后返回了非法 JSON，未形成可用对照结果。这说明直接开启 thinking 不只增加延迟，当前结构化输出稳定性也不足。

## 初步原因

DeepSeek 更倾向根据摘要中呈现的“新颖性叙述、实验规模和结果措辞”给出较高分，但对训练数据中的细粒度相对质量信号不敏感。典型现象包括：

- 一篇 reject 论文 `Blind Coreset Selection` 被评为 78 分；模型主要依据“问题重要、方法新颖、ImageNet 结果强”；
- 一篇高 RTS accept 论文 `DeepLTL` 仅为 66 分；模型因摘要没有具体数值和理论贡献描述而强烈扣分。

这说明当前 rubric 容易评价“摘要写得是否像一篇完整强论文”，不等同于 NAIPv2 学到的相对质量/录用信号。

## 下一轮建议

1. 暂不删除 NAIPv2 线上接口和离线资产；
2. 将 DeepSeek 从绝对 0–100 打分改为显式 pairwise/listwise 排序，减少分数压缩；
3. 使用 NAIDv2 validation 的少量示例做 rubric few-shot，但严格不使用 test 标签；
4. 对 DeepSeek 输出做 validation 单调标定后再讨论 `±5` 阈值；
5. 恢复私有 Ranker 后，在同一 32 篇上补做“私有 adapter vs DeepSeek”的直接对照；
6. 扩大到至少 100 篇后再做最终架构决策。

后续 listwise/pairwise API 协议测试见 [DeepSeek API 排序协议评测](../api-ranking-route-report.md)。
