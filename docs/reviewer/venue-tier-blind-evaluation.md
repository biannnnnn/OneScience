# 跨期刊层级盲测评估

本流程检验评分模型能否在同领域、相近年份和相同论文类型的论文对中，将较高层级期刊论文排在较低层级期刊论文之前。期刊等级是大规模弱标签，不代表任意一篇高层级论文都必然优于低层级论文。

## 1. 输入数据

输入为 JSONL，每行一篇论文：

```json
{"paper_id":"doi-or-stable-id","title":"...","abstract":"...","venue":"Journal A","venue_tier":"CCF-A","tier_rank":1,"field":"computer science / ai","topic":"graph learning","article_type":"research article","year":2025,"source_id":"openalex-id"}
```

`tier_rank` 越小表示层级越高。等级体系必须在单次实验开始前冻结，并在 manifest 外另存其来源、版本和核验日期；不要在同一学科内无规则地混合 CCF、JCR 分区和影响因子。摘要必须可用，综述、社论和研究论文应使用不同的 `article_type`。

## 2. 生成匿名匹配对

仓库附带一个基于 CCF 2025 T1/T2 目录、覆盖五个主题的扩充配置。先通过 OpenAlex 采集标题和摘要：

```bash
npm run venue-tier:collect -- \
  --config config/venue-tier-expanded.json \
  --output-dir evaluation/venue-tier/runs/expanded-ccf-2025
```

采集产物 `papers.source.private.jsonl` 和 `retrieval-manifest.private.json` 包含真实来源信息，必须作为私有文件保管。然后生成盲测对：

```bash
npm run venue-tier:prepare -- \
  --input evaluation/venue-tier/runs/expanded-ccf-2025/papers.source.private.jsonl \
  --output-dir evaluation/venue-tier/runs/expanded-ccf-2025 \
  --max-year-gap 2 --min-similarity 0.02 --seed 42
```

匹配要求同领域、同论文类型、有 topic 时同 topic，并按标题与摘要的 TF-IDF 余弦相似度贪心一对一匹配；A/B 位置按固定种子平衡分配，避免位置标签偏差。输出包括：

- `papers.blind.jsonl`：只含匿名 ID、标题和摘要，可交给模型；
- `pairs.dataset.jsonl`：可直接使用的两两配对数据集，包含匿名论文 A/B 和期刊层级弱标签；
- `pairs.private.jsonl`：真实期刊、等级和答案，只供评估者保管；
- `manifest.json`：参数和泄漏字段审计。

更大规模实验建议先用科学论文 embedding 生成候选，再沿用本流程的严格过滤和一对一约束。

### 1000 对数据集

1000 对版本覆盖13个主题检索组，使用8年采集时间窗，并限制每篇论文最多出现在3个不同论文对中；配对论文的发表年份差不超过3年：

```bash
npm run venue-tier:collect -- \
  --config config/venue-tier-1000.json \
  --output-dir evaluation/venue-tier/runs/ccf-1000

npm run venue-tier:prepare -- \
  --input evaluation/venue-tier/runs/ccf-1000/papers.source.private.jsonl \
  --output-dir evaluation/venue-tier/runs/ccf-1000 \
  --max-year-gap 3 --min-similarity 0.02 \
  --max-pairs 1000 --max-uses-per-paper 3 --seed 42
```

构建数据集不运行 Ranker，也不消耗模型 token。`manifest.json` 记录实际复用分布、主题分布、A/B 标签平衡、年份差和主题相似度统计。

### CCF-A/C 国际期刊 1000 对数据集

CCF-A/C 版本使用 CCF 第七版推荐国际学术会议和期刊目录正式版（2026-04-09），只选择国际期刊，不包含会议，也不与 T1/T2/T3 国内科技期刊目录混用。先从 CCF 官方十个学科分类页同步 A/C 期刊清单：

```bash
npm run venue-tier:sync-ccf-international -- \
  --output data/ccf-international-2026-journals.json

npm run venue-tier:collect -- \
  --config config/venue-tier-ccf-ac-1000.json \
  --output-dir evaluation/venue-tier/runs/ccf-ac-1000

npm run venue-tier:prepare -- \
  --input evaluation/venue-tier/runs/ccf-ac-1000/papers.source.private.jsonl \
  --output-dir evaluation/venue-tier/runs/ccf-ac-1000 \
  --max-year-gap 3 --min-similarity 0.02 \
  --max-pairs 1000 --max-uses-per-paper 3 --seed 42
```

该版本实际包含1000对、1707篇唯一论文、13个主题和8个CCF学科领域；高等级论文位于A/B两侧各500次。完整限制与审计结果见运行目录中的 `dataset-card.md` 和 `manifest.json`。

## 3. 运行 Ranker

启动已训练 Ranker 后执行：

```bash
npm run venue-tier:score -- \
  --input evaluation/venue-tier/runs/expanded-ccf-2025/papers.blind.jsonl \
  --output-dir evaluation/venue-tier/runs/expanded-ccf-2025
```

评估默认优先使用 `raw_score`，避免多个请求批次各自计算经验百分位造成不可比。整个数据集必须固定同一模型、adapter、prompt 和校准版本。

## 4. 生成报告

```bash
npm run venue-tier:evaluate -- \
  --pairs evaluation/venue-tier/runs/expanded-ccf-2025/pairs.private.jsonl \
  --scores evaluation/venue-tier/runs/expanded-ccf-2025/ranker-scores.jsonl \
  --output evaluation/venue-tier/runs/expanded-ccf-2025/metrics.json
```

报告包含期刊弱标签下的非平局准确率及其 95% Wilson 区间、平局按半分计算的准确率、平均分差，以及分学科和难度结果。

## 5. 实验纪律

- 训练集、调参集和最终测试集按论文与期刊隔离，不能让同一论文出现在不同集合。
- 正式报告至少包含未见期刊和训练截止日期之后的时间外测试。
- 运行输入顺序翻转审计；模型不应因 A/B 位置改变而改变物理论文胜者。
- 不把作者、机构、引用数、期刊或最终决定提供给评分模型。
- 结果只能称为实验性相对质量信号，不能解释为录用概率或客观论文质量。
