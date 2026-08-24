# 本地 Reviewer Service

Reviewer Service 把审稿协议与具体模型解耦，对上层系统提供稳定的本地 HTTP API。Apple M1 默认使用常驻的 MLX-LM 后端；替换基础模型、微调权重或 LoRA 时，只需要修改模型配置或新增后端适配器。

## 架构与边界

```text
OneScience / 其他客户端
        │ HTTP + JSON
        ▼
Reviewer Service
  ├─ 请求 Schema 校验
  ├─ 单任务推理锁
  ├─ 完整审稿与期刊批量评分 Schema 校验
  └─ Backend 接口
       ├─ mlx  —— Qwen3-4B / 后续微调权重
       └─ mock —— 接口测试，不做学术判断
```

- 默认只监听 `127.0.0.1:8787`，不对局域网或公网开放；
- 请求和稿件正文不落盘，日志不记录正文；
- M1 上一次只执行一个推理任务；繁忙时返回 HTTP 429；
- 原始模型输出必须通过对应 Schema，否则返回 HTTP 502，不静默编造缺失判断；
- `/v1/reviews` 不预测期刊录用概率，`recommendation` 只表示投稿前准备度；可选的独立 `/v1/acceptance-predictions` 校准层见 `acceptance-prediction.md`。
- 当前期刊检索流程使用 `/v1/venue-scores`，一次比较同一期刊下的用户稿件与近期参考论文；分数不是录用概率。

## 文件

```text
config/reviewer-service.m1.json        服务、端口和后端配置
schemas/reviewer-service-request.json  请求协议
schemas/review-schema.json             审稿结果协议
schemas/venue-score-request.json       期刊批量评分请求协议
schemas/venue-score-batch.json         期刊批量评分结果协议
reviewer_service/app.py                HTTP 服务与校验层
reviewer_service/backends.py           mock / MLX 可替换后端
reviewer_service/core.py               Prompt 和结果装配复用层
test/reviewer-service.test.mjs         端到端接口测试
```

## 启动

先运行无需加载模型的接口测试后端：

```bash
npm run reviewer:mock
```

启动真实 Qwen3-4B MLX 后端：

```bash
npm run baseline:preflight -- --json
npm run reviewer:serve
```

真实后端在进程启动时加载一次模型，后续请求复用已加载权重。模型 ID、固定 revision、缓存位置和生成参数读取自 `config/reviewer-baseline.m1.json`。

固定 revision 已存在于项目模型缓存时，服务直接从本地 snapshot 加载，不访问 Hugging Face；只有缓存缺失时才尝试下载。

可使用环境变量临时覆盖服务配置：

```bash
REVIEWER_BACKEND=mock REVIEWER_PORT=8790 npm run reviewer:mock
```

服务不支持通过 HTTP 请求修改模型路径或生成参数，避免不同配置被混入同一评测版本。

## API

### 健康检查

```bash
curl http://127.0.0.1:8787/health
```

返回服务状态、活动后端、模型 revision、Prompt 版本、协议版本和已完成请求数，不返回模型缓存绝对路径。

### 模型发现

```bash
curl http://127.0.0.1:8787/v1/models
```

### 生成审稿

```bash
curl http://127.0.0.1:8787/v1/reviews \
  -H 'Content-Type: application/json' \
  -d '{
    "request_id": "paper-001-run-01",
    "review_type": "general",
    "review_language": "zh-CN",
    "target_venue": null,
    "manuscript": {
      "paper_id": "paper-001",
      "title": "论文标题",
      "language": "zh-CN",
      "fingerprint": null,
      "paragraphs": [
        {
          "section": "摘要",
          "paragraph_id": "abstract-p01",
          "text": "论文摘要原文。"
        }
      ]
    }
  }'
```

成功响应包含 `review`、活动后端信息和 token/内存用量。目标期刊审稿使用 `review_type: venue_conditioned`，并在 `target_venue` 中提供期刊名称、范围和投稿要求；范围内容只进入当前 Prompt，不进入审稿结果协议。

### 同一期刊批量评分

```bash
curl http://127.0.0.1:8787/v1/venue-scores \
  -H 'Content-Type: application/json' \
  -d '{
    "request_id": "venue-score-001",
    "review_language": "zh-CN",
    "target_venue": {"id": "venue-01", "name": "目标期刊"},
    "papers": [
      {"paper_id": "user-paper", "title": "用户稿件", "input_type": "manuscript", "language": "zh-CN", "text": "用户论文正文……"},
      {"paper_id": "ref-01", "title": "近期论文", "input_type": "abstract", "language": "en", "text": "Recent paper abstract..."}
    ]
  }'
```

每批最多 9 篇、合计最多 48000 字符。结果包含六个维度、`overall`、`confidence`、证据限制和同一份模型 trace。服务必须在 `/health` 与 `/v1/models` 中声明 `venue_score_batch` 后，主站才会调用该接口。

## 错误约定

| HTTP | code | 含义 |
|---:|---|---|
| 400 | `INVALID_JSON` | 请求体不是有效 JSON |
| 413 | `REQUEST_TOO_LARGE` | 请求超过 2MB |
| 422 | `REQUEST_SCHEMA_INVALID` | 请求字段或段落 ID 不符合协议 |
| 422 | `SCORE_REQUEST_SCHEMA_INVALID` | 批量评分字段、论文 ID 或总文本长度不符合协议 |
| 429 | `REVIEWER_BUSY` | M1 正在处理另一个推理任务 |
| 502 | `MODEL_INVALID_JSON` | 模型未输出有效 JSON |
| 502 | `MODEL_OUTPUT_SCHEMA_INVALID` | 模型输出未通过审稿 Schema |
| 502 | `MODEL_SCORE_OUTPUT_SCHEMA_INVALID` | 模型输出未通过批量评分 Schema |

错误响应始终包含稳定的 `error.code`、中文说明和可定位的校验详情。服务不会在错误中返回论文正文或本地文件路径。

### Apple M1 实测

在当前 M1 8GB 设备上，MLX 服务已完成常驻启动和一条真实 HTTP 推理请求。健康检查正确报告固定模型 revision、Prompt 版本和 4-bit 量化状态；真实请求完成生成后，因为未微调模型把 `limitations` 错写成字符串，服务返回：

```json
{
  "status": "error",
  "error": {
    "code": "MODEL_OUTPUT_SCHEMA_INVALID",
    "message": "模型输出未通过 review-schema.json。",
    "details": [
      { "path": "/limitations", "message": "值不是 array" }
    ]
  }
}
```

这属于预期的安全失败：Reviewer Service 已可用，但当前零样本模型尚未达到产品输出门槛。完成 OpenReview 微调后，可以保持服务 API 不变重新验证。

## 替换模型

同一 MLX 架构下，修改 `config/reviewer-baseline.m1.json` 的以下字段即可：

- `model_id` 与 `model_revision`：Hugging Face 固定模型；
- `model_path`：本地完整模型或合并后的微调权重；
- `adapter_version`：写入每次审稿的模型追踪信息；
- `generation`：冻结的推理参数。

接入其他推理框架时，实现与 `MockBackend` / `MlxBackend` 相同的 `info()`、`review()` 和 `score()` 方法，并在 `create_backend()` 中注册。HTTP API、请求协议和结果校验不需要变化。
