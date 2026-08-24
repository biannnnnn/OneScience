# 当前审稿流程实施状态

更新日期：2026-08-16

## 已完成

- OpenAlex API key 已配置并通过真实 Source/Works 请求；
- IEEE Access 已解析为 OpenAlex Source `S2485537415`；
- 已取回真实近期论文、DOI 与摘要；
- 私有 Reviewer Service 的连接、Bearer 鉴权和模型签名均已验证；
- 冻结模型仍为 `qwen/Qwen3-8B` + `schema-lora-v1`，没有重新训练或静默换模；
- 主站已改为每本期刊一次批量调用，同时评分用户稿件与 n 篇近期参照论文；
- 新增 `/v1/venue-scores`、输入/输出 JSON Schema、能力发现和 Mock 集成测试；
- 当前 37 项 Node 自动化测试全部通过。

## 真实联调发现

旧 `/v1/reviews` 是完整结构化审稿接口，不适合只提供摘要的近期论文。真实请求曾出现：

- `limitations`、`minor_concerns` 等数组输出为 `null`；
- concern 缺少必填证据字段；
- 文本退化性重复并超过 Schema 长度；
- 单篇请求约需数分钟，默认 `k=5,n=3` 时需要 20 次推理。

因此当前流程不再拿旧接口逐篇评分。新版 `/v1/venue-scores` 使用更小的数值评分协议，在同一次推理内比较“1 篇用户稿件 + n 篇参照论文”，默认只需 k 次推理。摘要证据不足必须反映在 `confidence` 与 `limitations` 中，`overall` 明确不是录用概率。

## 当前唯一阻塞

代码已经在本地完成，但 `http://100.91.253.128:8787` 仍运行旧版 `1.1.0-server`，尚未声明 `venue_score_batch` 能力。主站会快速显示降级分和部署提示，不再调用已知慢且不稳定的旧路径。

需要将本仓库变更同步到 `/home/liuheng/OneScience`，并重启 Reviewer Service（上游 Qwen 模型无需重训或重启）：

```bash
ssh liuheng@100.91.253.128
cd /home/liuheng/OneScience
# 在确认工作区状态后同步/拉取本次代码
bash scripts/reviewer-server/status.sh
# 使用服务器现有的进程管理方式重启 serve-reviewer-8b.sh
```

不要覆盖服务器的 `.server-secrets`。本地未持有可用的 SSH 登录凭据，因此部署必须由具有服务器权限的人执行。

部署完成后依次运行：

```bash
npm run preflight:current-review
npm run smoke:current-review
```

预检必须出现 `venue_score_batch`；烟雾测试必须在一次批量推理中同时返回参考论文和用户稿件评分。通过后再建立 30–50 篇多期刊时间外验证集。

## 尚未完成

- 远程 Reviewer Service 部署与真实批量评分烟雾测试；
- 30–50 篇人工核验的多期刊端到端验证集；
- 基于冻结 Reviewer 特征重新生成并训练录用分类器；
- validation 集概率校准与 temporal test 验收。

在最后两项完成前，产品只能展示相对近期论文基线，不展示录用概率。
