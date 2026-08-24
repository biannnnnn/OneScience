# NAIPv2 官方权重复现

本基线只回答一个问题：公开的 `ssocean/NAIPv2` 权重在公开的
`NAIDv2-test.csv` 上能否复现论文报告的排序指标。它不使用本项目的
ProReviewer 数据，也不接入期刊检索或 Reviewer API。

## 固定资产

- NAIP 代码提交：`272a480713cb7412d889a061421559a16bf4e398`
- Hugging Face 模型 revision：`174b3728a2517012b26b51764252c1688fab7ba0`
- 测试 CSV SHA-256：`bbbd4ccc1a84761579e6faf54c3248bba0c3456696c0a9897889390aaef2095e`
- 模型输入长度：512 tokens
- 推理精度：bitsandbytes 8-bit
- batch size：8
- 随机种子：42

论文描述测试集包含 1,029 篇，但上述固定 GitHub 提交的公开 CSV 用 pandas
解析后包含 1,028 篇，其中接受 329 篇、拒绝 699 篇。复现报告必须保留这个
差异，不能人为增加或删除记录。

## 与官方测试脚本的唯一兼容性修正

公开仓库的 `v2_test.py` 使用 `AutoPeftModelForSequenceClassification`。发布到
Hugging Face 的快照则包含四个完整 safetensors 分片和
`LlamaForSequenceClassification` 配置，没有 `adapter_config.json`，因此不能被
PEFT loader 直接加载。

本项目使用 `AutoModelForSequenceClassification` 加载发布权重。提示词、文本清洗、
padding、截断、AUC、Spearman 和 NDCG@20 计算保持公开代码语义不变。

## 服务器准备

在 NVIDIA Linux 服务器的项目根目录下载固定测试集：

```bash
mkdir -p data/naipv2-official .cache/huggingface
curl -fL --retry 3 \
  --output data/naipv2-official/NAIDv2-test.csv \
  https://raw.githubusercontent.com/ssocean/NAIP/272a480713cb7412d889a061421559a16bf4e398/v2_resource/NAIDv2/NAIDv2-test.csv
sha256sum data/naipv2-official/NAIDv2-test.csv
```

若服务器不能直连 Hugging Face，可通过可访问的镜像下载固定模型 revision：

```bash
HF_ENDPOINT=https://hf-mirror.com \
HF_HUB_DISABLE_XET=1 \
HF_HUB_ENABLE_HF_TRANSFER=1 \
.venv-server/bin/python -c \
"from huggingface_hub import snapshot_download; print(snapshot_download(repo_id='ssocean/NAIPv2', revision='174b3728a2517012b26b51764252c1688fab7ba0', cache_dir='.cache/huggingface', max_workers=4))"
```

## 运行

```bash
bash scripts/naipv2/run_official_eval.sh
```

评测产物写到
`evaluation/naipv2-official/runs/official-weights-public-test/`：

- `metrics.json`：AUC、Spearman、NDCG@20 和仅用于官方行为对齐的测试集最优阈值；
- `metrics.csv`：核心指标摘要；
- `predictions.csv`：全部逐篇原始 logit；
- `environment.json`：数据哈希、模型/代码 revision、GPU 和 Python 包版本。

测试集最优 F1/Accuracy 阈值只用于复现公开评测行为，不能作为产品阈值。产品阈值
必须在独立 validation set 上确定。

## 2026-08-20 实测结果

运行环境为 RTX 4090 24 GB、Python 3.11.15、PyTorch 2.10.0+cu128、
Transformers 4.57.1 和 bitsandbytes 0.50.0。模型加载与全量推理共耗时
105.603 秒，推理期间既有 Reviewer 服务保持运行。

| 指标 | 论文报告 | 公开权重实测 | 差值 |
| --- | ---: | ---: | ---: |
| AUC | 0.782 | 0.782296 | +0.000296 |
| Spearman | 0.432 | 0.426185 | -0.005815 |
| NDCG@20 | — | 0.758780 | — |

AUC 与论文结果对齐；Spearman 差异小于预先设定的 0.02 复现容差。公开测试文件
比论文声明少一篇，因此不能声称逐位完全复现，但可以判定官方权重的核心排序能力
已经复现成功。

## 官方训练复现

训练复现使用同一个固定代码提交，并另外固定以下资产：

- 公开训练 CSV SHA-256：`c5d42dea04e25b04a3e13bc02a8eb9733cb3261347a0f06ab478297601cf5241`；
- Meta-Llama-3-8B：ModelScope 认证镜像的完整 safetensors 分片；
- Python 隔离环境：Torch 2.3.0+cu121、Transformers 4.41.1、Accelerate
  0.30.1、PEFT 0.11.1、bitsandbytes 0.42.0；
- 论文参数：1 epoch、batch size 8、10,000 pairs、512 tokens、AdamW
  `lr=1e-4`、`weight_decay=1e-2`、10% linear warmup、8-bit base、LoRA
  `r=16`、`alpha=32`、`dropout=0.05`、目标层 `q_proj,v_proj`、seed 42。

公开训练 CSV 实际有 23,246 行，而论文写 23,247 行。固定 seed 42 的 9:1
划分得到 20,921 篇训练样本和 2,325 篇验证样本。

### 公开训练代码中必须显式处理的问题

固定提交不能原样启动：

1. shell 调用了不存在的 `v2_resource/v2_train.py`，实际文件名是
   `v2_resource/v2_finetune.py`；
2. `PairwiseBCELoss.__init__()` 不接收参数，但入口传入了 `args`；
3. 8-bit 模型已经由 `device_map` 放入 GPU，入口随后再次调用 `.to(device)`；
4. 默认 `gt_field=gt`，公开 CSV 的目标列实际是 `RTS`；
5. 数据集先按 RTS 差值从大到小排序来实现论文所述 curriculum learning，随后
   DataLoader 的默认 `shuffle_train=true` 又会打乱该顺序。

训练封装只对第 2、3 项修改固定源码；第 1、4 项由启动参数选择正确入口和
`--gt_field RTS` 处理。第 5 项使用 `--shuffle_train false`，以忠实保留论文明确
描述的由易到难课程顺序。所有修改及修改前后源码哈希都写入
`preparation.json`，不把它们伪装成“官方代码可原样运行”。

### 可审计的训练配对

运行以下命令会先核对所有资产哈希，再复制并最小修补固定源码，最后生成训练清单：

```bash
NAIPV2_SMOKE_ONLY=1 bash scripts/naipv2/run_official_train.sh
```

本次生成的 `train_pairs.csv` 包含 10,000 对论文、RTS 差、课程位置以及随机左右
平衡方向，SHA-256 为
`88a3a70e6260fc4cc6b747466ad7dc066d6bf561a8cd115db524db37c77815f8`。
官方采样器在高差值桶样本不足时从其他桶回填，因此实际桶计数为
`[300, 400, 675, 5725, 2136, 644, 104, 14, 2, 0]`，并不等于配置中的目标比例。
这是固定提交的真实行为。

### 冒烟测试与当前显存条件

在既有 Reviewer 8B 服务占用约 7.9 GB 显存时，真实首个 batch 的 batch size 1
训练步骤成功：loss `1.1517465`，裁剪前梯度范数 `33.6929`，129 个可训练参数
张量全部发生更新，训练进程峰值分配约 10,016 MiB。

同一份 10,000-pair 清单以官方 batch size 8 执行首个前向时 OOM。失败进程退出后
Reviewer 服务仍正常。完整严格训练必须暂时释放该服务占用的显存；改为微批次或
梯度累积虽然可以共存，但已经不是官方优化步骤，不能作为严格复现结果。
