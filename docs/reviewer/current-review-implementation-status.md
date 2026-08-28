# 当前审稿流程实施状态

更新日期：2026-08-26

## 当前主链路

产品主评分已恢复为服务器上的 NAIPv2 Ranker 小模型。DeepSeek 仍可用于论文语义画像和候选期刊重排，但不再负责产品中的论文质量评分。

```text
上传论文
  → 规则 / DeepSeek 提取语义画像并生成检索规划
  → OpenAlex 发现 k 本有梯度的候选期刊
  → 每本期刊检索 n 篇近期相似论文
  → NAIPv2 Ranker 批量评分“用户稿件 + 该刊参考论文”
  → 将稿件分数与该刊近期论文分布比较
```

Ranker 严格使用标题和摘要，调用远程 `/v1/paper-scores` 批量接口。当前要求的模型签名为：

- 基座：`meta-llama/Meta-Llama-3-8B`
- adapter：`retrained-paper-faithful-seed42`
- prompt：`naipv2-official-pointwise-1.0.0`
- 能力：`paper_score_batch`

## 产品行为

- 每本期刊一次批量请求，同时评分用户稿件和有摘要的参考论文；
- 前端展示 Ranker 分、参考论文 P25 / 中位数 / P75，以及稿件相对基线；
- Ranker 不可用、签名不匹配、缺少批量能力或请求失败时，系统明确进入评分降级模式；
- 当前只展示论文质量的相对排序，不把分数解释为期刊适配度或录用概率；
- DeepSeek 评分代码、协议评测脚本和结果保留在仓库中，仅作为离线 A/B 对照资产。

## 已完成的 DeepSeek 对照验证

固定 100 篇 NAIDv2 测试中，DeepSeek 的多个确定性置换加 Borda 聚合没有超过已训练 Ranker：DeepSeek 的 tie-half 排序准确率为 0.6242，Ranker 为 0.6711；DeepSeek 的 accept tie-half 为 0.66，Ranker 为 0.75。该轮共调用 50 次，消耗 76,235 tokens，累计耗时 272.285 秒。

因此当前选择恢复 Ranker 作为产品评分器，同时保留实验数据，便于后续复现和改进大模型排序协议。

## 部署与验证

运行：

```bash
npm run preflight:current-review
npm run smoke:current-review
```

预检必须确认 Ranker 连接、模型签名、非 mock 后端、`paper_score_batch` 能力和 OpenAlex 状态；烟雾测试必须在一次批量请求中同时得到用户稿件与参考论文评分。若远程 Ranker 当前离线，代码切换仍然有效，但真实评分会保持降级状态，直到服务器恢复。
