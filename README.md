# OneScience 当前审稿智能体

OneScience 是一个面向论文投稿前判断的可运行 MVP。当前版本只保留一条审稿主流程：从论文关键词出发发现有梯度的候选期刊，检索每本期刊的近期相似论文，用本地小模型统一评分，再判断用户稿件是否达到该刊近期论文基线。

> 旧的“质量初评 → 手动选刊 → 模拟审稿 → 投稿材料 → Rebuttal → 归档”流程已停止使用，不再作为产品入口或 API。

## 当前唯一流程

```text
上传论文
  → 提取关键词与语义画像
  → Web 检索 k 本差异化候选期刊
  → 每本期刊检索 n 篇近期相似论文
  → 自训练 NAIPv2 Ranker 使用标题与摘要批量评分（用户稿件 + n 篇参考论文）
  → 与该刊近期论文分布比较并给出录用判断
```

其中 `k`、`n` 和近期年份窗口均为可配置超参数。候选期刊尽量覆盖高挑战、稳健和广覆盖三档，并展示有来源的 JIF、CCF 和中科院分区。指标缺失时保持为空，禁止由模型编造。

## 判断口径

- Ranker 输出的是论文在学术质量排序轴上的标量分数，不输出期刊适配度或录用概率；
- 每本期刊只发起一次 `/v1/paper-scores` 批量推理，输入严格保持为训练时的标题与摘要；
- 每本期刊的 n 篇近期相似论文形成动态评分基线；
- 当前只展示“高于 / 接近 / 低于近期论文基线”，不展示录用概率；
- 所有结果均为投稿辅助判断，不替代真实同行评审或编辑决定。

完整的论文调研、训练方案、泄漏边界和评分协议见 [当前审稿流程研究说明](docs/reviewer/current-review-workflow-research.md)。

## 技术架构

- 前端：React 19、Vite；
- 主 API：Node.js、Express；
- 文档解析：Mammoth（DOCX）、pdf-parse（PDF）；
- 论文与期刊 Web 检索：OpenAlex Works/Sources API；
- 语义画像与候选重排：DeepSeek OpenAI 兼容接口（可选）；
- 论文评分：Meta-Llama-3-8B + 自训练 NAIPv2 LoRA、独立 Ranker HTTP 服务；
- 录用分类：冻结 Reviewer 特征 + 标准化逻辑回归 + validation Platt calibration；
- 持久化：项目元数据与评分结果写入 JSON，原始论文正文仅保存在进程内存中；
- 测试：Node.js Test Runner + Python unittest。

核心目录：

```text
src/                              当前四阶段审稿工作台
server/index.mjs                  API 与端到端流程编排
server/lib/scholarly-search.mjs  OpenAlex 期刊解析与近期论文检索
server/lib/reviewer-client.mjs   本地小模型审稿与录用预测客户端
server/lib/review-flow.mjs       期刊梯度、评分分布与基线判断
server/data/journals.mjs         期刊范围、CCF 与中科院分区
server/data/journal-metrics.mjs  有官方来源的稀疏 JIF 数据
reviewer_service/                 可替换的本地 Reviewer Service
ranker_service/                   自训练 NAIPv2 Ranker 评分服务
acceptance_prediction/            录用分类与概率校准
scripts/openreview/               OpenReview 采集、清洗和无泄漏切分
scripts/reviewer-training/        Reviewer 训练数据准备
scripts/acceptance-prediction/    录用分类训练与推理
schemas/                          Reviewer 与录用预测协议
docs/reviewer/                    训练、部署、评估和研究说明
```

## 环境配置

复制环境变量模板：

```bash
cp .env.example .env
```

主要配置：

```dotenv
# Web 学术检索；未配置时不会虚构近期论文
OPENALEX_API_KEY=your_openalex_key
OPENALEX_BASE_URL=https://api.openalex.org

# 可选：论文语义画像与候选期刊重排
DEEPSEEK_API_KEY=your_deepseek_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro

# 可选评分器：8B 保留旧变量兼容；3B 与 0.6B 分别连接各自服务
RANKER_SERVICE_URL=http://100.91.253.128:8788
RANKER_8B_SERVICE_URL=http://100.91.253.128:8788
RANKER_3B_SERVICE_URL=http://your-ranker-host:8789
RANKER_06B_SERVICE_URL=http://your-ranker-host:8790
RANKER_SERVICE_API_KEY=
```

最终评分可在参数页选择 8B、3B、0.6B Ranker 或 DeepSeek。三个 Ranker URL 应分别指向加载对应模型的服务；未配置所选服务时，界面会显示降级分。选择 DeepSeek 时复用上述 `DEEPSEEK_*` 配置，并会产生外部 API 调用。OpenAlex API 未配置时不会执行 Web 检索。

配置后先运行真实链路预检：

```bash
npm run preflight:current-review
```

预检会核对 Ranker 的服务鉴权、模型、adapter、官方 pointwise prompt、`paper_score_batch` 能力和 OpenAlex 状态，但不会输出任何密钥。

PDF 上传默认优先通过 Microsoft MarkItDown 转换为 Markdown，再识别标题、摘要和关键词。首次使用先安装隔离的 PDF 转换环境：

```bash
npm run setup:markitdown
```

服务默认使用项目内的 `.venv-markitdown/bin/python`。部署时也可通过
`MARKITDOWN_PYTHON=/absolute/path/to/python` 指定已安装
`markitdown[pdf]==0.1.7` 的 Python；转换失败时系统会明确标注并回退到
`pdf-parse`，不会阻断上传。

## 本地运行

安装依赖并启动主应用：

```bash
npm install
npm run dev
```

默认地址：

- 前端：`http://127.0.0.1:5173`
- 主 API：`http://127.0.0.1:3001`

启动 Ranker 的 mock 接口测试后端：

```bash
npm run ranker:mock
```

NVIDIA 服务器上的正式 Ranker：

```bash
npm run ranker:serve
```

正式服务需要设置 `NAIPV2_BASE_MODEL`、`NAIPV2_ADAPTER_DIR` 和 `NAIPV2_CALIBRATION_PATH`；生产环境建议同时设置 `ONESCIENCE_RANKER_API_KEY` 并将服务配置中的鉴权改为必需。mock 后端只验证协议，不执行真实学术判断。

生产模式：

```bash
npm run build
npm start
```

## 训练与校准

OpenReview 数据和 Reviewer 训练流程见：

- [OpenReview 数据流水线](docs/reviewer/openreview-data-pipeline.md)
- [Qwen 基线](docs/reviewer/qwen3-4b-baseline.md)
- [OpenReview Qwen LoRA](docs/reviewer/openreview-qwen-lora.md)
- [本地 Reviewer Service](docs/reviewer/local-reviewer-service.md)
- [目标期刊录用概率预测](docs/reviewer/acceptance-prediction.md)

录用预测的基本顺序：

```bash
npm run acceptance:prepare -- --dataset-revision <fixed-revision> --out <cases-dir>
npm run acceptance:review-features -- --cases <cases.jsonl> --out <reviews.jsonl>
npm run acceptance:train -- --cases <cases.jsonl> --reviews <reviews.jsonl> --out <model.json>
```

训练严格禁止使用人类审稿文本、meta-review、rebuttal、最终版本、作者/机构身份或最终 decision 文本作为输入。decision 只允许作为标签。

## 验证

```bash
npm test
npm run build
```

Python 录用分类器测试：

```bash
python3 -m unittest test_py.test_acceptance_prediction
```

## 数据与隐私

- 上传的原始论文正文不写入项目存储，只保存在当前 Node 进程内存中；
- 进程重启后，已有项目仍能查看历史结果，但重新进行全文评分需要再次上传论文；
- 开启 DeepSeek 时，论文正文会发送至配置的 DeepSeek API；
- 开启 OpenAlex 时，只发送检索关键词、期刊名称和过滤参数，不发送论文全文；
- Ranker Service 不持久化标题、摘要或预测请求；
- 正式部署仍需补充身份认证、加密、数据保留策略和审计日志。

## License

当前仓库暂未指定开源许可证。公开分发或接受外部贡献前应先补充 License。
