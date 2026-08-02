# OneScience 智能投稿智能体

OneScience 是一个可运行的学术论文全链路辅助投稿 MVP。它以统一工作台串联论文评估、期刊匹配、模拟审稿、投稿材料和 Rebuttal，帮助研究者记录每一步投稿决策及其依据。

> 当前版本采用“可解释规则 + DeepSeek V4 Pro 深度评估与期刊重排”的双通道架构；自主工具规划和专用 OpenReview 8B 模型仍在后续路线中。

## 功能

1. DOCX、PDF、TXT、Markdown 论文解析；
2. 结构完整性、创新表达、可复现性、证据充分性和写作清晰度评估；
3. 基于 30 本计算机领域期刊知识库的规则预筛选与 DeepSeek 可解释重排；
4. 目标期刊模拟审稿与修改任务；
5. Cover Letter、Highlights 和投稿检查清单；
6. 真实审稿意见解析与 Rebuttal 草稿；
7. 投稿流程归档。
8. DeepSeek V4 Pro 论文贡献、证据链和学术风险深度评估；
9. 期刊官方范围来源、核对日期、目标读者与证据偏好展示。

## 工作流程

```text
上传论文
  → 论文解析与质量初评
  → 候选期刊匹配
  → 目标期刊模拟审稿
  → 修改任务与投稿材料
  → Rebuttal 回复准备
  → 流程归档
```

## 技术架构

- 前端：React 19、Vite、Lucide Icons；
- 后端：Node.js、Express；
- 文档解析：Mammoth（DOCX）、pdf-parse（PDF）；
- 通用模型：DeepSeek V4 Pro（OpenAI兼容接口、JSON结构化输出）；
- 持久化：JSON 文件存储，接口可替换为 PostgreSQL；
- 测试：Node.js Test Runner。

核心目录：

```text
src/                    React 工作台
server/index.mjs        HTTP API 与流程入口
server/lib/extractor.mjs 文档解析
server/lib/analyzer.mjs  可解释质量评估
server/lib/workflow.mjs  期刊、审稿、材料与 Rebuttal
server/data/journals.mjs 计算机领域期刊知识库
server/lib/deepseek.mjs  DeepSeek 结构化分析与期刊重排
server/lib/store.mjs     项目状态持久化
test/                   自动化测试
```

## 环境要求

- Node.js 20 或更高版本；
- npm 10 或更高版本。

## 本地运行

复制环境变量模板，并填写自己的 DeepSeek API Key：

```bash
cp .env.example .env
```

```dotenv
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_THINKING=enabled
DEEPSEEK_REASONING_EFFORT=high
```

`.env` 已加入 `.gitignore`，禁止将真实密钥提交到仓库。

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。前端开发服务器会把 `/api` 请求代理到 `http://127.0.0.1:3001`。

首页可以选择“使用示例论文体验”，无需准备测试文件即可走完整流程。

生产模式：

```bash
npm run build
npm start
```

默认访问 `http://127.0.0.1:3001`。可以通过 `PORT` 环境变量修改端口。

## 验证

```bash
npm test
npm run build
```

## 期刊匹配方法

1. 确定性规则根据研究方向、标题、摘要、关键词、开放获取偏好和稿件准备度，从 30 本期刊中选出候选池；
2. DeepSeek 只能在候选池中重排，综合判断研究范围、目标读者和证据准备度；
3. 最终分数融合规则分与模型分，并展示推荐依据、投稿风险、针对性准备动作和官方范围来源；
4. 模型被禁止生成知识库未提供的影响因子、分区、录用率、费用和审稿周期；
5. 模型不可用时自动返回规则排序，不中断投稿流程。

## MVP 边界

- 当前质量分数由确定性、可解释规则生成，不是期刊录用概率。
- DeepSeek负责语义深度评估，但不会取代规则结果；远程调用失败时系统仍可完成基础分析。
- 当前知识库首批覆盖 30 本计算机与人工智能领域期刊，尚不代表完整期刊集合；范围和出版政策可能变化，正式投稿前必须核对卡片中的官方来源。
- 原始论文在内存中完成解析，不持久化保存；项目仅保存元数据、分析结果与工作流状态。
- Rebuttal 草稿保留页码、行号和证据占位符，必须由作者核实后提交。
- 项目数据暂存在 `server/storage/projects.json`；接入账户体系后可替换为 PostgreSQL。

## 数据与隐私

- 上传文件在内存中解析，原始论文全文不会写入项目存储；
- 开启 DeepSeek 深度评估时，论文正文会发送至 DeepSeek 官方 API；用户可以在上传页关闭该选项，仅使用本地规则检查；
- 本地项目状态保存在 `server/storage/projects.json`，该文件默认不会提交到 Git；
- `.env`、Word 需求文档和构建产物均已排除；
- 正式部署前仍需增加用户认证、数据保留策略、访问审计与加密存储。

## 后续模型接入点

后续可以保持现有 API 和前端流程不变，逐步增加以下专用模型：

- `server/lib/analyzer.mjs`：论文质量评价模型；
- `server/lib/workflow.mjs` 中的 `recommendJournals`：期刊检索与排序模型；
- `generateReview`：目标期刊审稿模型；
- `generateRebuttal`：Rebuttal 回复模型。

## License

当前仓库暂未指定开源许可证。如需公开分发或接受外部贡献，请先补充合适的 License。
