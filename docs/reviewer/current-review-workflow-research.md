# 当前审稿流程：研究依据、训练方案与评分协议

更新日期：2026-08-26

## 1. 唯一生效的产品流程

```text
上传论文
  → 提取关键词与论文语义画像
  → Web 检索并选择 k 本有梯度的候选期刊
  → 每本期刊检索 n 篇近期相似论文
  → 自训练 NAIPv2 Ranker 为参考论文和用户稿件批量评分
  → 将用户稿件分数与每本期刊的近期分布比较
  → 校准分类器可用时输出录用概率；否则只输出相对基线判断
```

此前的“质量初评 → 手动选刊 → 模拟审稿 → 投稿材料 → Rebuttal → 归档”不再是产品审稿流程。

## 2. Web 检索与期刊推荐依据

### 2.1 期刊不应只有一个粗粒度画像

de Campos、Fernández-Luna 和 Huete 的期刊推荐研究将期刊表示为由论文聚类形成的多个主题子画像，再用信息检索方法将待投稿论文与这些子画像比较。这与本项目“每刊取 n 篇近期相似论文”的设计直接一致：近期论文集合既是检索证据，也是当前期刊主题的动态画像。

- [Publication venue recommendation using profiles based on clustering](https://arxiv.org/abs/2401.10611)

FPSRS 同时编码标题、摘要、关键词和期刊 Aim & Scope，并融合内容相似度。这支持将论文语义匹配与期刊官方范围作为两个独立信号，而不是把影响因子当作主题适配度。

- [FPSRS: A Fusion Approach for Paper Submission Recommendation System](https://arxiv.org/abs/2205.05965)

### 2.2 当前实现为什么使用 OpenAlex

OpenAlex 提供开放的 Works、Sources、Venue 和引用元数据。其官方文档建议先搜索期刊得到 Source ID，再用该 ID 过滤 Works；Works 搜索覆盖标题、摘要和全文，并能同时按发表日期过滤。当前实现严格采用这个两步模式，避免用期刊名称字符串直接猜测过滤条件。

- [OpenAlex 数据论文](https://arxiv.org/abs/2205.01833)
- [OpenAlex 两步实体解析模式](https://developers.openalex.org/guides/key-concepts)
- [OpenAlex Works 搜索](https://developers.openalex.org/guides/searching)
- [OpenAlex 过滤语法](https://developers.openalex.org/guides/filtering)

OpenAlex 在当前 API 文档中要求 API key。未配置 `OPENALEX_API_KEY` 时，产品必须显示“未执行 Web 检索”，不得生成虚构论文。

### 2.3 k 本期刊如何保持区分度

候选池先按主题适配排序，再在候选充足时至少覆盖三档：

1. 高挑战：CCF-A、中科院 1 区或经官方页面核验的高 JIF；
2. 稳健：CCF-B、中科院 2 区或中等 JIF；
3. 广覆盖：其余主题合适、范围更宽的期刊。

JIF、CCF 和中科院分区只用于候选集多样化与结果解释，不直接增加稿件质量分。JIF 必须同时保存数值、年份、官方来源和核对日期；缺失时保留 `null`，禁止模型补写。OpenAlex 的 `2yr_mean_citedness` 不是 JIF，界面必须分别标注。

## 3. 小模型训练方案

### 3.1 数据集与任务定义

PeerRead 公开了论文草稿、同行评审和最终决定，并把论文录用预测定义为二分类任务。它是建立可复现基线的合理起点，但其早期数据只覆盖少数计算机会议，不能直接声称对所有期刊泛化。

- [PeerRead: A Dataset of Peer Reviews](https://aclanthology.org/N18-1149/)

Automatic Academic Paper Rating（AAPR）使用模块化层次 CNN 对论文不同章节建模，说明评分模型应保留章节结构，而不是把全文粗暴截断成一个字符串。

- [Automatic Academic Paper Rating Based on Modularized Hierarchical CNN](https://aclanthology.org/P18-2079/)

Fytas 等人在 ICLR 开放评审数据上发现原创性、清晰度和实质性与推荐录用相关，同时明确提醒全局语言特征不能作因果解释。这支持我们的多维评分协议，也要求产品将解释称为“相关因素”而非“录用原因”。

- [What Makes a Scientific Paper be Accepted for Publication?](https://aclanthology.org/2021.cinlp-1.4/)

### 3.2 推荐的三层模型

#### A. 期刊召回模型

- 输入：标题、摘要、关键词、可选全文结构；
- 正样本：论文实际发表期刊；
- 难负样本：同一学科、主题相近但不同期刊，尤其是不同等级期刊；
- 模型：SciBERT/SPECTER 类双塔编码器或小型 embedding 模型；
- 损失：in-batch contrastive loss + 难负样本；
- 指标：Recall@k、NDCG@k、MRR，并单独报告候选等级覆盖率。

不使用作者姓名、机构、历史声望等身份特征。

#### B. 当前 NAIPv2 论文评分模型

- 基座：`meta-llama/Meta-Llama-3-8B`；
- adapter：`retrained-paper-faithful-seed42`；
- 输入：论文标题与摘要，不输入作者、机构、引用量、期刊声望或最终 decision；
- 训练协议：NAIPv2 官方 pointwise prompt，输出单篇论文的连续质量分；
- 在线接口：每个候选期刊批量提交用户稿件和近期参考论文，再比较同刊分布；
- 评估：ROC-AUC、Spearman、pairwise accuracy、跨年份与跨领域稳定性。

DeepSeek 批量打分、listwise 与 Borda 聚合代码继续作为离线 A/B 资产，不是当前产品评分依赖。固定 100 篇实验中其排序指标未超过已训练 Ranker，因此暂不替换主链路。

近期已发表论文只能作为动态比较基线，不能一律当作“高质量正样本”；否则模型会把幸存者偏差学成质量标准。

#### C. 录用分类与概率校准

分类器的目标是：

```text
P(accept | initial manuscript, target venue, frozen reviewer output, recent venue baseline)
```

首版优先使用可解释的标准化逻辑回归或梯度提升树，输入冻结 Reviewer 的结构化输出、稿件与近期论文分布差值、venue 先验和覆盖度。训练集拟合分类器，validation 只做 Platt 或 isotonic calibration，最新年份作为完全隔离的时间外测试集。

只有满足以下条件才展示概率：

- 时间外测试样本量充足；
- Brier Score 优于只预测历史录用率的基线；
- ECE 达到预先冻结的门槛（建议不高于 0.05）；
- 分领域、分期刊和未见期刊审计通过；
- 推理时 Reviewer 的模型、adapter、prompt 和 schema 签名与训练时完全一致。

否则产品只展示“高于 / 接近 / 低于该刊近期论文基线”，不得把它写成录用概率。

### 3.3 严格禁止的数据泄漏

以下信息不能进入投稿前预测特征：

- 人类审稿分数、审稿文本和 meta-review；
- rebuttal、讨论后版本、camera-ready 或最终发表版全文；
- 最终 decision 文本（只允许作为训练标签）；
- 作者、机构、合作者网络和声望；
- 在该论文最终决定之后才产生的引用数。

DeepSentiPeer 和 HabNet 证明了审稿文本能有效预测最终决定，但这类输入在线上投稿前并不存在，因此只能作为“有审稿意见后的辅助决策”研究，不能当作本产品投稿前模型的可用特征。

- [DeepSentiPeer](https://aclanthology.org/P19-1106/)
- [Hierarchical Bi-Directional Self-Attention Networks for Paper Review Rating Recommendation](https://aclanthology.org/2020.coling-main.555/)

## 4. 当前评分与展示协议

当 Ranker 在线时，每篇论文得到 0–100 的论文质量排序分，同时保留置信度、解释信息和模型签名。用户稿件与每本候选期刊的近期参考论文通过同一 Ranker 协议评分，再进行同刊分布比较；该分数不是录用概率。

每本期刊计算近期 n 篇参考论文的 P25、中位数和 P75，并输出：

```text
score_delta = manuscript_score - recent_paper_median

score_delta >=  5  → 高于近期论文基线
-5 <= delta < 5   → 接近期刊论文基线
score_delta <  -5 → 低于近期论文基线
```

该阈值只是产品级实验规则，后续必须在验证集上冻结和审计。参考论文不足时输出 `insufficient_reference_data`，不强行判断。

## 5. 与仓库现有训练资产的关系

仓库已有：

- OpenReview 数据采集、去泄漏切分和 Reviewer LoRA 流程；
- 目标期刊条件 Reviewer Service；
- 冻结 Reviewer 输出之上的逻辑回归与 Platt 校准；
- Brier、Log Loss、ECE、AUROC 和 Average Precision 评估。

下一步训练工作的重点不是重新造一套分类器，而是：

1. 将训练覆盖从单一 ICLR 扩展到多个期刊/会议；
2. 把“近期期刊论文分布特征”加入冻结特征协议；
3. 增加 venue-holdout 与学科分层审计；
4. 在数据规模足够前继续把产品结果标为实验性判断。
