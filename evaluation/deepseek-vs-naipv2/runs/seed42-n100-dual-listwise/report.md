# 100 篇 DeepSeek 双向 Listwise API 测试

测试日期：2026-08-25

## 测试设置

- 数据：NAIDv2 固定公开 test 集分层子集；
- 论文数：100；
- Accept/Reject：50/50；
- Batch：25 批，每批 4 篇；
- API：`deepseek-v4-pro`；
- Prompt：`deepseek-paper-listwise-1.0.0`；
- Thinking：disabled；
- Temperature：0；
- 每批先做原序 listwise，再做完全倒序 listwise；
- 总请求数：50；
- 聚合：两次 rank 相加的 Borda rank sum。

## 排序效果

| 指标 | DeepSeek 双向 Borda | NAIPv2 同组基线 |
| --- | ---: | ---: |
| RTS non-tie accuracy | 0.6555 | 0.6711 |
| RTS tie-half accuracy | 0.6242 | 0.6711 |
| Accept non-tie accuracy | 0.7000 | 0.7500 |
| Accept tie-half accuracy | 0.6600 | 0.7500 |

- RTS 可比较论文对：149；
- RTS 聚合并列：30；
- 跨标签论文对：100；
- 跨标签聚合并列：20；
- 非并列覆盖率：80%；
- 非并列结果与 NAIPv2 排序一致率：72.5%。

100 篇结果没有复现 32 篇小样本上的领先表现。当前 DeepSeek 双向 listwise 仍弱于 NAIPv2，且聚合并列比例偏高，不适合直接替换正式 Ranker。

## 输入顺序影响

- 原序与倒序两次输出的 pair order agreement：69.33%；
- 原序输出遵循输入顺序：56%；
- 倒序输出遵循倒序输入：72%。

双向 Borda 可以缓解位置偏差，但不能完全消除，而且会产生较多 rank-sum 并列。

## API 耗时与 Token

### 原序 25 次

- 累计请求耗时：116.327 秒；
- 平均：4.653 秒；
- P50：4.678 秒；
- P95：5.242 秒；
- 最快：3.603 秒；
- 最慢：5.722 秒；
- Prompt tokens：32,396；
- Completion tokens：5,785；
- Total tokens：38,181；
- 平均每次：1,527.2 tokens。

### 倒序 25 次

- 累计请求耗时：155.958 秒；
- 平均：6.238 秒；
- P50：5.519 秒；
- P95：10.695 秒；
- 最快：4.373 秒；
- 最慢：10.986 秒；
- Prompt tokens：32,396；
- Completion tokens：5,658；
- Total tokens：38,054；
- 平均每次：1,522.2 tokens。

### 合计 50 次

- 累计请求耗时：272.285 秒（约 4 分 32 秒）；
- 平均：5.446 秒；
- P50：5.023 秒；
- P95：8.984 秒；
- 最快：3.603 秒；
- 最慢：10.986 秒；
- Prompt tokens：64,792；
- Completion tokens：11,443；
- Total tokens：76,235；
- 平均每次：1,524.7 tokens；
- 平均每个双向期刊批次：3,049.4 tokens、10.891 秒。

所有 50 次请求均成功返回完整 JSON 排名，没有 API 或结构化输出失败。

## 产品推算

默认 `k=5,n=3`：

- 每个期刊 2 次请求；
- 总计 10 次请求；
- 顺序执行约 54.5 秒；
- 约 15,247 tokens；
- 如果并发 2–3 本期刊，可降低墙钟时间，但不会减少 token。

## 当前结论

纯 API 双向 listwise 在工程上可运行、结构化输出稳定、时延可接受，但质量尚未达到专用 NAIPv2 Ranker。下一步若继续 API 路线，应优先测试：

1. 使用 validation 而非 test 构建少量无泄漏排序示例；
2. 改用多次随机置换加 rank aggregation，而不只原序/倒序；
3. 对并列结果增加专门 tie-break 请求，但严格控制额外成本；
4. 引入论文领域或任务类型，但继续禁止作者、机构、引用和 decision 信息；
5. 在独立 100+ 篇测试集上重新验收。
