# Qwen3-4B 未微调审稿基线（Apple M1）

本基线用于回答一个明确问题：在不做 OpenReview 微调的情况下，Qwen3-4B 能否按照 OneScience 审稿协议发现有依据的问题，并在本地 M1 设备上以可接受的资源开销运行。

## 当前机器结论

检测到的环境：

- Apple M1，8 核；
- 8GB 统一内存；
- macOS 15.6.1；
- 系统 Python 3.9；
- MLX 0.29.3、MLX-LM 0.29.1；
- 模型缓存约 2.0GB，独立 Python 环境约 243MB；
- 实测推理峰值内存 2.934GB，两个样本均完成生成。

模型配置使用官方 `Qwen/Qwen3-4B-MLX-4bit`，固定到 revision `52a5ab34fa604bc8af6d3ce0cac0cab10b7eb495`。M1 8GB 可以作为最低规格进行短上下文、单样本串行推理；本次在约 6GB 以上可用空间时完成下载和运行。为了给缓存、临时文件及后续数据集留出余量，日常仍建议保留至少 10GB，或把 Hugging Face 缓存放到外置磁盘。

## 文件

```text
config/reviewer-baseline.m1.json              M1 推理参数
evaluation/reviewer-baseline/case-schema.json 评测样本协议
evaluation/reviewer-baseline/cases.sample.jsonl 两个烟雾测试样本
scripts/reviewer-baseline/preflight.mjs        硬件与环境检查
scripts/reviewer-baseline/prepare.mjs          清洗数据转评测样本
scripts/reviewer-baseline/run_mlx.py           MLX 顺序推理
scripts/reviewer-baseline/evaluate.mjs         自动指标与报告
```

## 1. 环境检查

```bash
npm run baseline:preflight
```

首次下载模型前建议满足以下条件：

- macOS arm64；
- 至少 8GB 统一内存；
- 至少 10GB 可用磁盘；
- Python 环境可以导入 `mlx` 和 `mlx_lm`。

模型固定 revision 已完整缓存时，磁盘低于 10GB 只作为容量警告，不阻止推理；Apple Silicon、最低内存和 MLX 环境仍是硬性检查。

默认模型缓存位于项目下被 Git 忽略的 `.model-cache/huggingface`。如果使用外置磁盘保存模型，可在 `config/reviewer-baseline.m1.json` 中把 `model_cache_dir` 改为外置磁盘的绝对路径。

也可以为其他 Hugging Face 工具设置：

```bash
export HF_HOME='/Volumes/外置磁盘/huggingface-cache'
```

## 2. 安装 MLX 环境

创建独立环境：

```bash
python3 -m venv .venv-mlx
source .venv-mlx/bin/activate
python -m pip install --upgrade pip
python -m pip install --no-cache-dir mlx-lm jsonschema
```

MLX-LM 是面向 Apple Silicon 的推理和微调工具，支持直接从 Hugging Face 加载量化模型以及限制 KV cache。本基线固定使用 MLX-LM 0.29.1 和 MLX 0.29.3，实际版本也随每次报告写入元数据。

## 3. 无模型检查 Prompt

不安装 MLX 也可以先检查样本截断和 Prompt：

```bash
npm run baseline:dry -- \
  --config config/reviewer-baseline.m1.json \
  --cases evaluation/reviewer-baseline/cases.sample.jsonl \
  --out evaluation/reviewer-baseline/runs/dry-run.jsonl
```

## 4. 准备正式评测样本

将第二项成果生成的清洗测试集转换为评测输入：

```bash
npm run baseline:prepare -- \
  --input data/openreview/splits/v1/test.jsonl \
  --split test \
  --limit 100 \
  --out evaluation/reviewer-baseline/runs/openreview-test.jsonl
```

转换结果会保留匿名化后的人类评审作为 `human_references`，但 `gold` 默认为 `null`。要计算问题精确率、召回率和准备度准确率，需要按照审稿标注规范补充黄金问题及证据段落；未标注样本仍可计算结构化输出和证据可定位指标，并用于专家盲评。

烟雾样本只验证流水线，不能用于宣称模型质量。

## 5. 运行 Qwen3-4B

激活 MLX 环境后运行：

```bash
source .venv-mlx/bin/activate
npm run baseline:run -- \
  --config config/reviewer-baseline.m1.json \
  --cases evaluation/reviewer-baseline/cases.sample.jsonl \
  --out evaluation/reviewer-baseline/runs/qwen3-4b-smoke.jsonl
```

M1 8GB 固定配置：

- 4-bit 模型；
- `batch_size=1`，顺序推理；
- 关闭 Qwen thinking，避免额外输出和内存消耗；
- 最多输入 24,000 字符、80 个段落；
- 最多生成 1,600 tokens；
- KV cache 最大 4,096 tokens；当前 MLX-LM 0.29.1 不支持旋转 KV cache 与 KV 量化同时启用，因此本基线使用非量化 KV cache；
- prefill step 为 512，降低峰值内存。

这些是低内存基线参数，不代表质量最优参数。不同参数的结果不能混在同一个基线版本中。

## 6. 生成评测报告

```bash
npm run baseline:evaluate -- \
  --config config/reviewer-baseline.m1.json \
  --cases evaluation/reviewer-baseline/cases.sample.jsonl \
  --predictions evaluation/reviewer-baseline/runs/qwen3-4b-smoke.jsonl \
  --out evaluation/reviewer-baseline/runs/qwen3-4b-report
```

输出：

- `metrics.json`：机器可读指标和逐样本错误；
- `report.md`：人类可读基线报告。

### 本机烟雾测试实测结果

本次使用 Prompt `reviewer-zero-shot-1.0.2`，对两个合成样例各运行一次，未人工修复输出：

| 指标 | 实测结果 |
|---|---:|
| 生成成功率 | 100.0% |
| JSON 有效率 | 100.0% |
| 完整 Schema / 核心协议通过率 | 0.0% |
| 证据可定位率 | 62.5% |
| 问题精确率 / 召回率 / F1（宏平均） | 25.0% / 25.0% / 25.0% |
| 准备度结论准确率 | 0.0% |
| P50 / P95 时延 | 43.787 秒 / 68.131 秒 |
| 峰值内存 | 2.934GB |

两个输出都能解析为 JSON，但模型把 `limitations` 数组错误输出成字符串，因此均未通过 `review-schema.json`。此外，模型对存在重大方法缺失的样例仍给出 `ready_for_submission`，说明未微调模型不能直接作为可靠审稿器。这些结果保留为真实零样本基线，不进行后处理修正。

样本只有两条，以上数字用于验证端到端评测链路及记录初始失败模式，不能代表总体审稿质量。正式模型比较必须在冻结的 OpenReview 时间留出集和专家盲评集上进行。

## 7. 自动指标

| 指标 | 含义 |
|---|---|
| 生成成功率 | 模型完成推理并得到可解析结果的样本比例 |
| JSON 有效率 | 原始输出可以解析为 JSON 的比例 |
| 核心协议通过率 | 必填字段、问题字段、证据和任务引用满足要求的比例 |
| 证据可定位率 | 段落存在、章节一致且摘录可以在原段落逐字找到的比例 |
| 问题精确率 | 与黄金严重度、类别和证据位置匹配的生成问题比例 |
| 问题召回率 | 黄金问题被模型覆盖的比例 |
| 问题 F1 | 精确率和召回率的调和平均 |
| 准备度准确率 | verdict 位于专家允许结论集合的比例 |
| P50/P95 时延 | 单篇推理时延分布 |
| 峰值内存 | MLX 报告的峰值内存 |

自动匹配只能衡量已结构化的问题类别和证据位置，不能替代专家判断。正式报告还应加入盲评：正确性、重要性、可操作性、重复问题和有害误导。

## 8. 正式基线协议

1. 冻结模型 ID、模型 revision、MLX-LM 版本、Prompt 和生成参数；
2. 测试集按论坛、重复组和年份隔离，不参与 Prompt 调整；
3. 先在 validation 集调整输入长度和 Prompt；
4. 温度为 0，每个测试样本运行一次；
5. 记录失败、截断、时延、内存和原始输出，不静默重试或人工修复 JSON；
6. 至少抽取 100 篇做双人盲评，分歧由第三人裁决；
7. 同时报告全部样本和成功生成子集，禁止只报告成功样本。

首版建议上线门槛仍为：JSON/协议通过率 ≥99%、证据可定位率 ≥90%、严重事实幻觉率 ≤2%。这些门槛用于决定是否进入产品，不用于选择性美化基线结果。

## 9. 当前结论与下一步

真实模型烟雾测试已经完成，Apple M1 8GB 的本地运行路线可行。当前瓶颈不是硬件，而是未微调模型的协议遵循、证据忠实度和准备度判断能力。下一步应冻结本基线，使用 OpenReview 训练集进行微调，并在未参与 Prompt 调整的 validation/test 集上复测；产品层可在 Reviewer Service 中增加 Schema 校验和失败重试，但不能把自动修复后的格式成绩冒充原始模型协议通过率。
