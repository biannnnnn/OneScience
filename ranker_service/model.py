"""Inference backends for the self-trained NAIPv2 paper Ranker."""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import pathlib
import re
import time


PROMPT_TEMPLATE = (
    "Given a certain paper, Title: {title}\n"
    "Abstract: {abstract}\n"
    "Evaluate the quality of this paper:"
)
PROMPT_VERSION = "naipv2-official-pointwise-1.0.0"
FULLTEXT_PROMPT_VERSION = "naipv2-fulltext-evidence-pointwise-1.0.0"
FULLTEXT_INPUT_SCHEMA = "fulltext_evidence_v1"
FULLTEXT_FIELDS = (
    ("[ABSTRACT]", "abstract"),
    ("[RESEARCH QUESTION AND MAIN CONTRIBUTIONS]", "research_question_contributions"),
    ("[EXPERIMENTAL SETUP AND DATASETS]", "experimental_setup_datasets"),
    ("[KEY FINDINGS AND CONCLUSION]", "key_findings_conclusion"),
)


class RankerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def normalize_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def evidence_for_paper(paper: dict, input_schema: str = "title_abstract_v1") -> str:
    if input_schema != FULLTEXT_INPUT_SCHEMA:
        return normalize_text(paper.get("abstract"))
    parts = []
    for label, field in FULLTEXT_FIELDS:
        value = normalize_text(paper.get(field))
        parts.extend((label, value or "[NOT PROVIDED]"))
    return "\n".join(parts)


def prompt_for_paper(paper: dict, input_schema: str = "title_abstract_v1") -> str:
    return PROMPT_TEMPLATE.format(
        title=normalize_text(paper.get("title")),
        abstract=evidence_for_paper(paper, input_schema),
    )


def prompt_version(input_schema: str) -> str:
    return FULLTEXT_PROMPT_VERSION if input_schema == FULLTEXT_INPUT_SCHEMA else PROMPT_VERSION


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def empirical_percentiles(raw_scores: list[float], reference: list[float]) -> list[float]:
    """Map scalar rank scores to 0-100 while preserving their ordering."""
    ordered = sorted(float(value) for value in reference if math.isfinite(float(value)))
    if not ordered:
        raise RankerError("CALIBRATION_EMPTY", "Ranker 分数标定集合为空。")
    if len(ordered) == 1:
        return [50.0 for _ in raw_scores]
    denominator = len(ordered) - 1
    result = []
    for value in raw_scores:
        left = bisect.bisect_left(ordered, value)
        right = bisect.bisect_right(ordered, value)
        midrank = (left + right - 1) / 2
        result.append(round(max(0.0, min(100.0, 100.0 * midrank / denominator)), 1))
    return result


class Calibration:
    def __init__(self, path: str | None):
        self.path = pathlib.Path(path).resolve() if path else None
        self.scores: list[float] = []
        self.metadata: dict = {}
        if self.path:
            if not self.path.is_file():
                raise RankerError("CALIBRATION_NOT_FOUND", "未找到 Ranker validation 标定文件。")
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            values = payload.get("scores")
            if not isinstance(values, list) or len(values) < 2:
                raise RankerError("CALIBRATION_INVALID", "Ranker validation 标定文件无有效分数。")
            self.scores = sorted(float(value) for value in values)
            self.metadata = {
                "rows": len(self.scores),
                "source": payload.get("source"),
                "sha256": sha256_file(self.path),
            }

    @property
    def available(self) -> bool:
        return len(self.scores) >= 2

    def map(self, raw_scores: list[float]) -> tuple[list[float], str]:
        if self.available:
            return empirical_percentiles(raw_scores, self.scores), "validation_empirical_cdf"
        return empirical_percentiles(raw_scores, raw_scores), "request_empirical_cdf"


class MockRanker:
    """Deterministic contract backend used only for local tests."""

    def __init__(self, config: dict):
        self.config = config
        self.calibration = Calibration(None)
        self.input_schema = str((config.get("model") or {}).get("input_schema", "title_abstract_v1"))

    def info(self) -> dict:
        return {
            "backend": "mock",
            "model": "naipv2-ranker-mock",
            "model_version": "contract-only",
            "adapter_version": "mock",
            "prompt_version": prompt_version(self.input_schema),
            "input_schema": self.input_schema,
            "quantization": None,
            "max_length": 512,
            "calibration": {"available": False, "method": "request_empirical_cdf"},
        }

    def score_raw(self, papers: list[dict]) -> list[float]:
        values = []
        for paper in papers:
            digest = hashlib.sha256(prompt_for_paper(paper, self.input_schema).encode("utf-8")).digest()
            values.append(round(int.from_bytes(digest[:4], "big") / (2**32 - 1) * 8 - 4, 6))
        return values

    def score(self, papers: list[dict]) -> dict:
        started = time.monotonic()
        raw_scores = self.score_raw(papers)
        scores, method = self.calibration.map(raw_scores)
        return assemble_result(papers, raw_scores, scores, method, self.info(), started)


class TransformersRanker:
    """Llama-3 sequence-classification base with the reproduced NAIPv2 LoRA."""

    def __init__(self, config: dict):
        try:
            import torch
            from peft import PeftModel
            from transformers import AutoModelForSequenceClassification, AutoTokenizer, BitsAndBytesConfig
        except ImportError as error:
            raise RankerError("RUNTIME_MISSING", "Ranker 推理环境缺少 torch/transformers/peft。") from error

        model_config = config.get("model") or {}
        self.base_model = pathlib.Path(model_config.get("base_model_path", "")).resolve()
        self.adapter = pathlib.Path(model_config.get("adapter_path", "")).resolve()
        if not self.base_model.is_dir():
            raise RankerError("BASE_MODEL_NOT_FOUND", "未找到 Meta-Llama-3-8B 基础模型。")
        if not (self.adapter / "adapter_config.json").is_file():
            raise RankerError("ADAPTER_NOT_FOUND", "未找到训练完成的 NAIPv2 LoRA adapter。")

        self.torch = torch
        self.max_length = int(model_config.get("max_length", 512))
        self.batch_size = max(1, int(model_config.get("batch_size", 8)))
        self.input_schema = str(model_config.get("input_schema", "title_abstract_v1"))
        if self.input_schema not in ("title_abstract_v1", FULLTEXT_INPUT_SCHEMA):
            raise RankerError("INPUT_SCHEMA_UNKNOWN", "不支持的 Ranker 输入协议。")
        self.device = str(model_config.get("device", "cuda:0"))
        if not torch.cuda.is_available():
            raise RankerError("CUDA_REQUIRED", "NAIPv2 Ranker 需要 NVIDIA CUDA。")
        device_index = int(self.device.split(":", 1)[1]) if ":" in self.device else 0

        self.tokenizer = AutoTokenizer.from_pretrained(self.adapter, local_files_only=True)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        base = AutoModelForSequenceClassification.from_pretrained(
            self.base_model,
            num_labels=1,
            device_map={"": device_index},
            torch_dtype=torch.float16,
            quantization_config=BitsAndBytesConfig(load_in_8bit=True),
            local_files_only=True,
        )
        base.config.pad_token_id = self.tokenizer.pad_token_id
        self.model = PeftModel.from_pretrained(base, self.adapter, is_trainable=False)
        self.model.eval()
        calibration_path = model_config.get("calibration_path")
        self.calibration = Calibration(calibration_path)
        self._info = {
            "backend": "transformers",
            "model": model_config.get("model_name", "meta-llama/Meta-Llama-3-8B"),
            "model_version": model_config.get("model_version", self.base_model.name),
            "adapter_version": model_config.get("adapter_version", "retrained-paper-faithful-seed42"),
            "prompt_version": prompt_version(self.input_schema),
            "input_schema": self.input_schema,
            "quantization": "bitsandbytes-8bit",
            "max_length": self.max_length,
            "calibration": {
                "available": self.calibration.available,
                "method": "validation_empirical_cdf" if self.calibration.available else "request_empirical_cdf",
                **self.calibration.metadata,
            },
        }

    def info(self) -> dict:
        return self._info

    def score_raw(self, papers: list[dict]) -> list[float]:
        values: list[float] = []
        with self.torch.inference_mode():
            for start in range(0, len(papers), self.batch_size):
                prompts = [
                    prompt_for_paper(item, self.input_schema)
                    for item in papers[start:start + self.batch_size]
                ]
                encoded = self.tokenizer(
                    prompts,
                    max_length=self.max_length,
                    padding="max_length",
                    truncation=True,
                    return_tensors="pt",
                )
                logits = self.model(
                    input_ids=encoded["input_ids"].to(self.device, non_blocking=True),
                    attention_mask=encoded["attention_mask"].to(self.device, non_blocking=True),
                ).logits.view(-1)
                values.extend(float(value) for value in logits.float().cpu().tolist())
        return values

    def score(self, papers: list[dict]) -> dict:
        started = time.monotonic()
        raw_scores = self.score_raw(papers)
        scores, method = self.calibration.map(raw_scores)
        return assemble_result(papers, raw_scores, scores, method, self.info(), started)


def assemble_result(
    papers: list[dict],
    raw_scores: list[float],
    scores: list[float],
    method: str,
    model_info: dict,
    started: float,
) -> dict:
    return {
        "scores": [
            {
                "paper_id": paper["paper_id"],
                "title": paper["title"],
                "raw_score": round(raw_score, 6),
                "score": score,
                "score_method": method,
            }
            for paper, raw_score, score in zip(papers, raw_scores, scores)
        ],
        "model_trace": {
            **model_info,
            "latency_ms": round((time.monotonic() - started) * 1000),
        },
    }


def create_ranker(name: str, config: dict):
    normalized = str(name).strip().lower()
    if normalized == "mock":
        return MockRanker(config)
    if normalized == "transformers":
        return TransformersRanker(config)
    raise RankerError("BACKEND_UNKNOWN", "不支持的 Ranker 后端：{}。".format(name))
