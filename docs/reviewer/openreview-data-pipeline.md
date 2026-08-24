# OpenReview 数据流水线

本流水线对应第一轮开发的第二项成果：采集公开 OpenReview 论坛，清洗和匿名化论文—评审数据，并按论坛、近重复论文和时间进行无泄漏切分。

## 数据边界

- 使用 OpenReview API2；
- 只保留 Note `readers` 中包含 `everyone` 的公开 Submission 和 reply；
- Reply 按 invitation 识别为 Official Review、Meta Review、Decision、Author Response 或 Comment；
- 论文元数据可用于索引，但论文全文只有许可证位于显式允许清单时才会下载、解析并进入可训练记录；
- 默认全文允许清单只有 `CC BY 4.0` 和 `CC0 1.0`；扩大允许清单前必须单独进行许可证审查；
- 公开评论按 OpenReview 条款记录为 `CC BY 4.0`；
- 原始采集层可能包含公开作者字段，仅允许在受控本地环境短期保存，严禁提交 Git 或直接用于训练；
- 清洗层移除作者字段，并替换邮箱、OpenReview Profile ID、ORCID 和已知作者姓名。

OpenReview 的 venue 表单并不完全统一，所以字段映射按语义别名处理，原始 `rating` 和 `confidence` 同时保留文本与解析后的数值。它们不会直接转换为 OneScience 的投稿前准备度。

## 目录

```text
scripts/openreview/collect.mjs  API2 公开数据采集和可选 PDF 下载
scripts/openreview/clean.mjs    字段归一化、匿名化、PDF 解析和质量标记
scripts/openreview/split.mjs    论坛级、近重复分组和时间切分
scripts/openreview/lib.mjs      公共函数
config/openreview-venues.example.json  venue 采集配置示例
config/openreview-split.example.json   切分配置示例
```

运行产生的数据默认位于 `data/openreview/`，整个目录已被 `.gitignore` 排除。

## 1. 配置 Venue

复制示例配置：

```bash
cp config/openreview-venues.example.json config/openreview-venues.local.json
```

每个 venue 建议显式填写：

- `venue_id`：例如 `ICLR.cc/2024/Conference`；
- `year`：用于时间切分；
- `submission_invitation`：API2 Submission invitation；
- `download_pdfs`：只有需要全文且完成许可证检查时才设为 `true`；
- `allowed_article_licenses`：全文允许清单；
- `max_submissions`：`0` 表示不限制，试运行建议设为 20。

如果省略 `submission_invitation`，脚本会尝试读取 venue group 的 `submission_name`。不同年份可能使用 API1 或不同 invitation，正式批量采集前应先用小规模限制验证。

## 2. 采集

```bash
npm run data:openreview:collect -- \
  --config config/openreview-venues.local.json \
  --out data/openreview/raw \
  --limit 20
```

每个 venue 输出：

- `<venue>.jsonl`：一个论坛一行，包含 Submission、公开 replies 和 PDF 状态；
- `<venue>.manifest.json`：论坛数量、跳过的非公开内容数量和 reply 类型统计；
- `pdfs/`：仅在允许且配置下载时存在。

脚本优先使用访客只读访问。OpenReview 当前网关可能对部分访客批量请求返回 HTTP 403，此时可通过环境变量提供认证：

```bash
export OPENREVIEW_TOKEN='短期访问令牌'
```

也支持 `OPENREVIEW_USERNAME` 与 `OPENREVIEW_PASSWORD` 登录，但启用 MFA 的账号应使用官方客户端生成短期 token。凭证只能通过环境变量提供，不得写入 venue 配置、命令参数、输出文件或 Git。无论是否认证，脚本仍只保留 `readers` 包含 `everyone` 的公开 Note，不采集账号有权访问的私有评审。

## 3. 清洗

```bash
npm run data:openreview:clean -- \
  --input data/openreview/raw/ICLR.cc_2024_Conference.jsonl \
  --out data/openreview/clean/ICLR-2024.jsonl
```

主要处理：

1. 统一不同 review 表单中的 summary、strengths、weaknesses、questions、rating 和 confidence；
2. 移除身份字段并对文本做基础 PII 替换；
3. 验证论文全文许可证；
4. 解析获准下载的 PDF，并生成稳定章节/段落 ID；
5. 生成标题哈希、全文哈希和质量标记；
6. 只有“全文许可证允许、正文存在、摘要存在、至少一条实质 Official Review”的记录才标为 `training_eligible`。

常见 `quality_flags`：

- `missing_article_license`；
- `article_license_not_allowed`；
- `missing_manuscript_text`；
- `missing_official_review`；
- `reviews_too_short`；
- `review_missing_critique`。

清洗脚本只完成结构化和资格判断，不会自动把人类评审转换成 `review-schema.json`。证据对齐与审稿样本构造将在后续标注阶段完成。

## 4. 切分

```bash
npm run data:openreview:split -- \
  --input data/openreview/clean/ICLR-2022.jsonl,data/openreview/clean/ICLR-2023.jsonl,data/openreview/clean/ICLR-2024.jsonl \
  --config config/openreview-split.example.json \
  --out data/openreview/splits/v1
```

切分顺序：

1. 默认排除 `training_eligible=false` 的记录；
2. 相同标题哈希、相同全文哈希或标题 token Jaccard 达到阈值的记录组成同一重复组；
3. 重复组中的任一论文属于测试年份时，整组进入测试集；其次是验证集；
4. 未配置年份时，按论坛组 ID 和固定 seed 做确定性哈希切分；
5. 输出 `train.jsonl`、`validation.jsonl`、`test.jsonl` 和统计清单 `manifest.json`。

同一论坛及其论文版本、评审、回复和决定天然保存在同一行；重复组整体分配，避免相同论文跨数据集泄漏。

## 5. 批量运行前检查

- [ ] Venue 是 API2，或已单独实现 API1 兼容；
- [ ] 如访客访问被拒绝，使用短期 token，且没有把凭证写入配置或日志；
- [ ] Submission invitation 已用少量样本验证；
- [ ] 所有输出均位于 Git 忽略目录；
- [ ] PDF 下载默认关闭；
- [ ] 全文许可证允许清单经过项目负责人确认；
- [ ] 原始目录有访问控制与删除周期；
- [ ] 清洗样本中不再包含作者、邮箱、Profile ID 或 ORCID；
- [ ] 时间切分年份与研究评测方案一致；
- [ ] manifest 中的排除数量和质量标记已人工抽查。

## 6. 已知限制

- 当前只实现 API2；老 venue 可能需要 OpenReview API1；
- PDF 文本提取无法可靠恢复所有表格、公式和双栏阅读顺序；
- 基础 PII 规则不能保证识别所有身份线索，黄金评测集仍需人工复核；
- 标题近重复只能作为初筛，跨语言标题和大幅改名版本可能漏检；
- 本流水线不构成法律意见，数据发布或商业训练前仍需许可证和隐私复核。
