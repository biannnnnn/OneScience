# OneScience 智能投稿智能体

OneScience 是一个可运行的学术论文全链路辅助投稿 MVP。它以统一工作台串联论文评估、期刊匹配、模拟审稿、投稿材料和 Rebuttal，帮助研究者记录每一步投稿决策及其依据。

> 当前版本是规则驱动、可解释的智能体工作流原型，尚未接入自主规划的大模型 Agent。

## 功能

1. DOCX、PDF、TXT、Markdown 论文解析；
2. 结构完整性、创新表达、可复现性、证据充分性和写作清晰度评估；
3. 基于演示期刊目录的可解释匹配；
4. 目标期刊模拟审稿与修改任务；
5. Cover Letter、Highlights 和投稿检查清单；
6. 真实审稿意见解析与 Rebuttal 草稿；
7. 投稿流程归档。

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
- 持久化：JSON 文件存储，接口可替换为 PostgreSQL；
- 测试：Node.js Test Runner。

核心目录：

```text
src/                    React 工作台
server/index.mjs        HTTP API 与流程入口
server/lib/extractor.mjs 文档解析
server/lib/analyzer.mjs  可解释质量评估
server/lib/workflow.mjs  期刊、审稿、材料与 Rebuttal
server/lib/store.mjs     项目状态持久化
test/                   自动化测试
```

## 环境要求

- Node.js 20 或更高版本；
- npm 10 或更高版本。

## 本地运行

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

## MVP 边界

- 当前质量分数由确定性、可解释规则生成，不是期刊录用概率。
- 当前期刊目录是流程验证用演示数据，正式投稿前必须核对期刊官网。
- 原始论文在内存中完成解析，不持久化保存；项目仅保存元数据、分析结果与工作流状态。
- Rebuttal 草稿保留页码、行号和证据占位符，必须由作者核实后提交。
- 项目数据暂存在 `server/storage/projects.json`；接入账户体系后可替换为 PostgreSQL。

## 数据与隐私

- 上传文件在内存中解析，原始论文全文不会写入项目存储；
- 本地项目状态保存在 `server/storage/projects.json`，该文件默认不会提交到 Git；
- `.env`、Word 需求文档和构建产物均已排除；
- 正式部署前仍需增加用户认证、数据保留策略、访问审计与加密存储。

## 后续模型接入点

后续可以保持现有 API 和前端流程不变，将以下确定性服务替换为专用模型：

- `server/lib/analyzer.mjs`：论文质量评价模型；
- `server/lib/workflow.mjs` 中的 `recommendJournals`：期刊检索与排序模型；
- `generateReview`：目标期刊审稿模型；
- `generateRebuttal`：Rebuttal 回复模型。

## License

当前仓库暂未指定开源许可证。如需公开分发或接受外部贡献，请先补充合适的 License。
