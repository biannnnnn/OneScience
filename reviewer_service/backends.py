"""Replaceable inference backends for the local Reviewer Service."""

import datetime as dt
import json
import os
import pathlib
import time
import urllib.error
import urllib.request

from .core import assemble_review, build_request_context, parse_json_output, render_prompt
from .deepseek import DeepSeekStructurer, ScoreStructurer, StructuringError
from .nl_prompt import NL_SYSTEM_PROMPT
from .scoring import (
    assemble_score_batch,
    build_single_score_messages,
    normalize_single_score_output,
)


class BackendError(RuntimeError):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or []


class MockBackend:
    """Deterministic schema-valid backend for integration tests only."""

    name = "mock"

    def __init__(self, model_config):
        self.model_config = model_config

    def info(self):
        return {
            "backend": self.name,
            "provider": "OneScience",
            "model": "reviewer-mock",
            "model_version": "1.0.0",
            "adapter_version": None,
            "prompt_version": "mock-1.0.0",
            "quantization": None,
            "loaded": True,
        }

    def review(self, request):
        started = time.perf_counter()
        manuscript = request["manuscript"]
        sections = list(dict.fromkeys(item["section"] for item in manuscript["paragraphs"]))
        latency_ms = round((time.perf_counter() - started) * 1000)
        venue = request.get("target_venue")
        output_venue = None if venue is None else {
            key: venue.get(key) for key in ("id", "name", "scope_source", "scope_checked_at")
            if key in venue
        }
        review = {
            "schema_version": "1.0.0",
            "review_id": "review-mock-{}".format(request.get("request_id", "request")),
            "review_type": request["review_type"],
            "review_language": request["review_language"],
            "manuscript": {
                "paper_id": manuscript.get("paper_id"),
                "title": manuscript["title"],
                "language": manuscript["language"],
                "fingerprint": manuscript.get("fingerprint"),
            },
            "target_venue": output_venue,
            "recommendation": {
                "verdict": "insufficient_evidence",
                "rationale": "Mock 后端不执行真实学术判断，仅用于验证本地服务接口和数据协议。",
                "confidence": 0,
            },
            "summary": "这是由 Mock 后端生成的接口测试结果，不包含任何真实的论文质量或投稿准备度判断。",
            "central_contribution": None,
            "strengths": [],
            "major_concerns": [],
            "minor_concerns": [],
            "questions": [],
            "revision_tasks": [],
            "limitations": ["Mock 后端不执行真实学术审稿，仅用于验证服务接口。"],
            "input_coverage": {
                "analyzed_sections": sections,
                "omitted_sections": [],
                "total_paragraphs": len(manuscript["paragraphs"]),
                "analyzed_paragraphs": len(manuscript["paragraphs"]),
                "truncated": False,
            },
            "model_trace": {
                "provider": "OneScience",
                "model": "reviewer-mock",
                "model_version": "1.0.0",
                "adapter_version": None,
                "prompt_version": "mock-1.0.0",
                "quantization": None,
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "latency_ms": latency_ms,
            },
        }
        return {"review": review, "usage": {"prompt_tokens": 0, "output_tokens": 0, "peak_memory_gb": 0}}

    def score(self, request):
        started = time.perf_counter()
        scores = []
        for index, paper in enumerate(request["papers"]):
            base = 62 if paper["input_type"] == "manuscript" else 66
            scores.append({
                "paper_id": paper["paper_id"],
                "originality": base + 2,
                "rigor": base,
                "evidence": base - 2,
                "clarity": base + 3,
                "reproducibility": base - 4,
                "venue_fit": base + index,
                "overall": base,
                "confidence": 0 if self.name == "mock" else 0.5,
                "rationale": "Mock 后端仅验证批量评分协议，不执行真实学术判断。",
                "strengths": [],
                "risks": [],
                "limitations": ["Mock 结果不可用于投稿或录用判断。"],
            })
        trace = {
            "provider": "OneScience",
            "model": "reviewer-mock",
            "model_version": "1.0.0",
            "adapter_version": None,
            "prompt_version": "venue-score-mock-1.0.0",
            "quantization": None,
        }
        latency_ms = round((time.perf_counter() - started) * 1000)
        return {
            "score_batch": assemble_score_batch(request, {"scores": scores}, latency_ms, trace),
            "usage": {"prompt_tokens": 0, "output_tokens": 0, "peak_memory_gb": 0},
        }


class MlxBackend:
    """Persistent MLX-LM backend; model weights are loaded once at startup."""

    name = "mlx"

    def __init__(self, model_config, project_root):
        self.model_config = model_config
        self.project_root = pathlib.Path(project_root)
        try:
            import mlx.core as mx
            from huggingface_hub import snapshot_download
            from mlx_lm import generate, load
            from mlx_lm.sample_utils import make_sampler
        except ImportError as error:
            raise BackendError("BACKEND_UNAVAILABLE", "MLX 后端依赖未安装。", [str(error)]) from error

        source = model_config.get("model_path")
        if source:
            source = str((self.project_root / source).resolve()) if not pathlib.Path(source).is_absolute() else source
        else:
            cache_dir = model_config.get("model_cache_dir")
            if cache_dir and not pathlib.Path(cache_dir).is_absolute():
                cache_dir = str((self.project_root / cache_dir).resolve())
            revision = model_config.get("model_revision")
            cached_snapshot = pathlib.Path(cache_dir) / (
                "models--" + model_config["model_id"].replace("/", "--")
            ) / "snapshots" / revision
            source = str(cached_snapshot) if revision and cached_snapshot.is_dir() else snapshot_download(
                repo_id=model_config["model_id"], revision=revision, cache_dir=cache_dir,
            )
        self.mx = mx
        self.generate_text = generate
        self.make_sampler = make_sampler
        adapter_path = model_config.get("adapter_path")
        if adapter_path and not pathlib.Path(adapter_path).is_absolute():
            adapter_path = str((self.project_root / adapter_path).resolve())
        self.model, self.tokenizer = load(source, adapter_path=adapter_path)
        self.score_structurer = None
        fallback = model_config.get("deepseek_fallback") or {}
        fallback_api_key = fallback.get("api_key") or (
            os.environ.get(fallback.get("api_key_env"), "") if fallback.get("api_key_env") else ""
        )
        if fallback.get("enabled") and fallback_api_key:
            self.score_structurer = ScoreStructurer(
                api_key=fallback_api_key,
                schema_path=fallback.get("score_schema_path", "schemas/venue-score.json"),
                base_url=fallback.get("base_url"),
            )

    def info(self):
        return {
            "backend": self.name,
            "provider": "MLX",
            "model": self.model_config["model_id"],
            "model_version": self.model_config.get("model_revision", "unversioned"),
            "adapter_version": self.model_config.get("adapter_version"),
            "prompt_version": self.model_config["prompt_version"],
            "quantization": self.model_config.get("quantization"),
            "loaded": True,
        }

    def review(self, request):
        case, config, messages, coverage = build_request_context(request, self.model_config)
        prompt = render_prompt(self.tokenizer, messages)
        generation = config["generation"]
        kwargs = {
            "max_tokens": int(generation["max_tokens"]),
            "max_kv_size": int(generation["max_kv_size"]),
            "prefill_step_size": int(generation["prefill_step_size"]),
            "verbose": False,
        }
        if generation.get("kv_bits") is not None:
            kwargs["kv_bits"] = int(generation["kv_bits"])
        if float(generation.get("temperature", 0)) > 0:
            kwargs["sampler"] = self.make_sampler(temp=float(generation["temperature"]))
        if hasattr(self.mx, "reset_peak_memory"):
            self.mx.reset_peak_memory()
        started = time.perf_counter()
        raw_output = self.generate_text(self.model, self.tokenizer, prompt=prompt, **kwargs)
        latency_ms = round((time.perf_counter() - started) * 1000)
        parsed, parse_error = parse_json_output(raw_output)
        if parsed is None:
            raise BackendError("MODEL_INVALID_JSON", "模型未返回有效 JSON。", [parse_error])
        trace = {
            "provider": "MLX",
            "model": config["model_id"],
            "model_version": config.get("model_revision", "unversioned"),
            "adapter_version": config.get("adapter_version"),
            "prompt_version": config["prompt_version"],
            "quantization": config.get("quantization"),
        }
        review = assemble_review(request, case, parsed, coverage, config, latency_ms, trace)
        usage = {
            "prompt_tokens": len(self.tokenizer.encode(prompt)),
            "output_tokens": len(self.tokenizer.encode(raw_output)),
            "peak_memory_gb": round(float(self.mx.get_peak_memory()) / 1_000_000_000, 3),
            "supplied_characters": coverage["supplied_characters"],
        }
        self.mx.clear_cache()
        return {"review": review, "usage": usage}

    def score(self, request):
        trace = {
            "provider": "MLX",
            "model": self.model_config["model_id"],
            "model_version": self.model_config.get("model_revision", "unversioned"),
            "adapter_version": self.model_config.get("adapter_version"),
            "prompt_version": "venue-score-1.0.0",
            "quantization": self.model_config.get("quantization"),
        }
        scores = []
        total_latency = 0
        total_chars = 0
        prompt_tokens = 0
        output_tokens = 0
        peak_memory_gb = 0.0
        for paper in request["papers"]:
            config, messages, supplied_characters = build_single_score_messages(paper, request, self.model_config)
            prompt = render_prompt(self.tokenizer, messages)
            generation = config["generation"]
            kwargs = {
                "max_tokens": int(generation["max_tokens"]),
                "max_kv_size": int(generation["max_kv_size"]),
                "prefill_step_size": int(generation["prefill_step_size"]),
                "verbose": False,
            }
            if generation.get("kv_bits") is not None:
                kwargs["kv_bits"] = int(generation["kv_bits"])
            if float(generation.get("temperature", 0)) > 0:
                kwargs["sampler"] = self.make_sampler(temp=float(generation["temperature"]))
            if hasattr(self.mx, "reset_peak_memory"):
                self.mx.reset_peak_memory()
            started = time.perf_counter()
            raw_output = self.generate_text(self.model, self.tokenizer, prompt=prompt, **kwargs)
            latency_ms = round((time.perf_counter() - started) * 1000)
            total_latency += latency_ms
            score = normalize_single_score_output(paper, raw_output, self.score_structurer)
            if score is None:
                raise BackendError("MODEL_SCORE_INVALID", "模型没有为论文 {} 返回有效评分。".format(paper["paper_id"]))
            scores.append(score)
            total_chars += supplied_characters
            prompt_tokens += len(self.tokenizer.encode(prompt))
            output_tokens += len(self.tokenizer.encode(raw_output))
            peak_memory_gb = round(float(self.mx.get_peak_memory()) / 1_000_000_000, 3)
            self.mx.clear_cache()
        score_batch = assemble_score_batch(request, {"scores": scores}, total_latency, trace)
        return {
            "score_batch": score_batch,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "output_tokens": output_tokens,
                "peak_memory_gb": peak_memory_gb,
                "supplied_characters": total_chars,
            },
        }


class OpenAICompatibleBackend:
    """Call a private OpenAI-compatible model server such as LLaMA-Factory or vLLM."""

    name = "openai_compatible"

    def __init__(self, model_config):
        self.model_config = model_config
        upstream = model_config.get("upstream") or {}
        base_url = str(upstream.get("base_url", "")).rstrip("/")
        if not base_url:
            raise BackendError("BACKEND_CONFIG_INVALID", "缺少上游模型服务 base_url。")
        self.completions_url = base_url + "/chat/completions"
        self.timeout_seconds = float(upstream.get("timeout_seconds", 300))
        self.served_model_name = upstream.get("served_model_name") or model_config["model_id"]
        api_key_env = upstream.get("api_key_env")
        self.api_key = os.environ.get(api_key_env, "") if api_key_env else ""
        if api_key_env and not self.api_key:
            raise BackendError(
                "BACKEND_CONFIG_INVALID",
                "未设置上游模型服务密钥环境变量：{}。".format(api_key_env),
            )
        fallback = model_config.get("deepseek_fallback") or {}
        fallback_api_key_env = fallback.get("api_key_env")
        fallback_api_key = fallback.get("api_key") or (
            os.environ.get(fallback_api_key_env, "") if fallback_api_key_env else ""
        )
        self.json_fallback = None
        self.score_structurer = None
        if fallback.get("enabled"):
            if not fallback_api_key:
                raise BackendError(
                    "BACKEND_CONFIG_INVALID",
                    "未设置 JSON 结构化兜底密钥环境变量：{}。".format(fallback_api_key_env),
                )
            self.json_fallback = DeepSeekStructurer(
                api_key=fallback_api_key,
                schema_path=fallback.get("schema_path", "schemas/review-schema.json"),
                base_url=fallback.get("base_url"),
            )
            self.score_structurer = ScoreStructurer(
                api_key=fallback_api_key,
                schema_path=fallback.get("score_schema_path", "schemas/venue-score.json"),
                base_url=fallback.get("base_url"),
            )

    def info(self):
        return {
            "backend": self.name,
            "provider": self.model_config.get("provider", "OpenAI-compatible"),
            "model": self.model_config["model_id"],
            "model_version": self.model_config.get("model_revision", "unversioned"),
            "adapter_version": self.model_config.get("adapter_version"),
            "prompt_version": self.model_config["prompt_version"],
            "quantization": self.model_config.get("quantization"),
            "loaded": True,
        }

    @staticmethod
    def _repair_truncated_json(text):
        """Try to repair a truncated JSON by closing unclosed brackets and braces.
        Returns (repaired_text, was_repaired)."""
        text = text.strip()
        # Try progressively: close unclosed strings, then brackets
        # First, count open/close
        depth = 0
        in_string = False
        escape = False
        for ch in text:
            if escape:
                escape = False
                continue
            if ch == '\\':
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
            elif not in_string:
                if ch in '{[':
                    depth += 1
                elif ch in '}]':
                    depth -= 1
        if depth <= 0 and not in_string:
            return text, False  # balanced, nothing to repair

        # Close unclosed string
        repaired = text
        if in_string:
            repaired += '"'

        # Try closing brackets - count from the end
        open_brackets = []
        in_string2 = False
        escape2 = False
        for ch in repaired:
            if escape2:
                escape2 = False
                continue
            if ch == '\\':
                escape2 = True
                continue
            if ch == '"':
                in_string2 = not in_string2
            elif not in_string2:
                if ch == '{':
                    open_brackets.append('}')
                elif ch == '[':
                    open_brackets.append(']')
                elif ch in '}]':
                    if open_brackets and open_brackets[-1] == ch:
                        open_brackets.pop()

        # Close in reverse order
        for closer in reversed(open_brackets):
            repaired += closer

        if repaired == text:
            return text, False
        return repaired, True

    def _call_model(self, messages, config):
        """Call the upstream model API and return (raw_output, upstream_usage)."""
        generation = config["generation"]
        payload = {
            "model": self.served_model_name,
            "messages": messages,
            "temperature": float(generation.get("temperature", 0)),
            "max_tokens": int(generation["max_tokens"]),
            "stream": False,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        upstream_request = urllib.request.Request(
            self.completions_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(upstream_request, timeout=self.timeout_seconds) as response:
                upstream_result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise BackendError(
                "UPSTREAM_HTTP_ERROR",
                "上游模型服务返回 HTTP {}。".format(error.code),
            ) from error
        except (urllib.error.URLError, TimeoutError) as error:
            reason = getattr(error, "reason", error)
            raise BackendError("UPSTREAM_UNAVAILABLE", "无法连接上游模型服务。", [str(reason)]) from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BackendError("UPSTREAM_INVALID_RESPONSE", "上游模型服务返回了无效 JSON。") from error

        try:
            raw_output = upstream_result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise BackendError("UPSTREAM_INVALID_RESPONSE", "上游模型响应缺少生成文本。") from error
        return raw_output, upstream_result.get("usage") or {}

    def review(self, request):
        case, config, messages, coverage = build_request_context(request, self.model_config)
        # Append { to user message to prompt JSON start
        json_messages = list(messages)
        json_messages[-1]["content"] += "\n\n{"

        started = time.perf_counter()
        raw_output, upstream_usage = self._call_model(json_messages, config)
        latency_ms = round((time.perf_counter() - started) * 1000)

        # Try normal parse
        parsed, parse_error = parse_json_output(raw_output)
        was_repaired = False

        # If parse failed, try repairing truncated JSON
        if parsed is None:
            repaired, was_repaired = self._repair_truncated_json(raw_output)
            if was_repaired:
                parsed, parse_error = parse_json_output(repaired)
                if parsed is not None:
                    raw_output = repaired

        # If still failed, retry once with stronger instructions
        # When an external JSON structurer is configured, avoid a second long
        # local generation and send the first substantive output to the
        # structurer instead.
        if parsed is None and not was_repaired and self.json_fallback is None:
            retry_messages = list(messages)
            retry_messages.append({
                "role": "user",
                "content": "上次输出不是有效 JSON。请确保输出完整有效的 JSON 对象，以 } 结尾。\n\n{",
            })
            try:
                raw_output, upstream_usage = self._call_model(retry_messages, config)
                parsed, parse_error = parse_json_output(raw_output)
                if parsed is None:
                    repaired, was_repaired = self._repair_truncated_json(raw_output)
                    if was_repaired:
                        parsed, parse_error = parse_json_output(repaired)
                        if parsed is not None:
                            raw_output = repaired
            except BackendError:
                pass  # Retry failed, fall through to error

        used_json_fallback = False
        if parsed is None and self.json_fallback is not None:
            try:
                parsed = self.json_fallback.structure(
                    raw_output,
                    manuscript_title=request["manuscript"].get("title", ""),
                )
                used_json_fallback = isinstance(parsed, dict)
            except StructuringError:
                parsed = None

        if parsed is None:
            raise BackendError("MODEL_INVALID_JSON", "模型未返回有效 JSON。", [parse_error])

        trace = {
            "provider": self.model_config.get("provider", "OpenAI-compatible"),
            "model": config["model_id"],
            "model_version": config.get("model_revision", "unversioned"),
            "adapter_version": config.get("adapter_version"),
            "prompt_version": config["prompt_version"],
            "quantization": config.get("quantization"),
        }
        review = assemble_review(request, case, parsed, coverage, config, latency_ms, trace)
        usage = {
            "prompt_tokens": upstream_usage.get("prompt_tokens"),
            "output_tokens": upstream_usage.get("completion_tokens"),
            "peak_memory_gb": None,
            "supplied_characters": coverage["supplied_characters"],
            "json_fallback_used": used_json_fallback,
        }
        return {"review": review, "usage": usage}

    def score(self, request):
        trace = {
            "provider": self.model_config.get("provider", "OpenAI-compatible"),
            "model": self.model_config["model_id"],
            "model_version": self.model_config.get("model_revision", "unversioned"),
            "adapter_version": self.model_config.get("adapter_version"),
            "prompt_version": "venue-score-1.0.0",
            "quantization": self.model_config.get("quantization"),
        }
        scores = []
        total_latency = 0
        total_chars = 0
        prompt_tokens = 0
        output_tokens = 0
        for paper in request["papers"]:
            config, messages, supplied_characters = build_single_score_messages(paper, request, self.model_config)
            started = time.perf_counter()
            raw_output, upstream_usage = self._call_model(messages, config)
            latency_ms = round((time.perf_counter() - started) * 1000)
            total_latency += latency_ms
            score = normalize_single_score_output(paper, raw_output, self.score_structurer)
            if score is None:
                raise BackendError("MODEL_SCORE_INVALID", "模型没有为论文 {} 返回有效评分。".format(paper["paper_id"]))
            scores.append(score)
            total_chars += supplied_characters
            prompt_tokens += int(upstream_usage.get("prompt_tokens") or 0)
            output_tokens += int(upstream_usage.get("completion_tokens") or 0)
        score_batch = assemble_score_batch(request, {"scores": scores}, total_latency, trace)
        return {
            "score_batch": score_batch,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "output_tokens": output_tokens,
                "peak_memory_gb": None,
                "supplied_characters": total_chars,
            },
        }


class PlanBBackend:
    """Two-stage Plan B backend: 7B Domain-SFT (NL review) → DeepSeek V4 (JSON).

    Stage 1: Calls a local 7B model (Qwen2.5-7B-Instruct + domain-lora) via an
             OpenAI-compatible endpoint to produce a natural language review.
    Stage 2: Sends the NL review to DeepSeek V4 Pro for structuring into JSON
             conforming to review-schema.json.
    """

    name = "plan_b"

    def __init__(self, model_config, project_root=None):
        self.model_config = model_config
        self.project_root = pathlib.Path(project_root) if project_root else None

        # ── Stage 1: 7B model endpoint ──────────────────────────
        upstream = model_config.get("upstream") or {}
        base_url = str(upstream.get("base_url", "")).rstrip("/")
        if not base_url:
            raise BackendError("BACKEND_CONFIG_INVALID", "缺少上游模型服务 base_url。")
        self.completions_url = base_url + "/chat/completions"
        self.timeout_seconds = float(upstream.get("timeout_seconds", 300))
        self.served_model_name = upstream.get("served_model_name") or model_config["model_id"]
        api_key_env = upstream.get("api_key_env")
        self.api_key_7b = os.environ.get(api_key_env, "") if api_key_env else ""

        # ── Stage 2: DeepSeek V4 Pro structurer ─────────────────
        deepseek_cfg = model_config.get("deepseek", {})
        deepseek_api_key = deepseek_cfg.get("api_key", "")
        deepseek_base = deepseek_cfg.get("base_url")
        schema_path = deepseek_cfg.get("schema_path", "schemas/review-schema.json")
        if not deepseek_api_key:
            raise BackendError(
                "BACKEND_CONFIG_INVALID",
                "缺少 DeepSeek API key（在 model config 的 deepseek.api_key 字段中配置）。",
            )
        self.structurer = DeepSeekStructurer(
            api_key=deepseek_api_key,
            schema_path=schema_path,
            base_url=deepseek_base,
        )
        self.score_structurer = ScoreStructurer(
            api_key=deepseek_api_key,
            schema_path=deepseek_cfg.get("score_schema_path", "schemas/venue-score.json"),
            base_url=deepseek_base,
        )

    def info(self):
        return {
            "backend": self.name,
            "provider": self.model_config.get("provider", "OneScience Plan B"),
            "model": self.model_config["model_id"],
            "model_version": self.model_config.get("model_revision", "unversioned"),
            "adapter_version": self.model_config.get("adapter_version"),
            "prompt_version": self.model_config["prompt_version"],
            "quantization": self.model_config.get("quantization"),
            "loaded": True,
        }

    def _call_7b(self, messages, config):
        """Call the 7B domain-lora model for natural language output."""
        generation = config["generation"]
        payload = {
            "model": self.served_model_name,
            "messages": messages,
            "temperature": float(generation.get("temperature", 0)),
            "max_tokens": int(generation["max_tokens"]),
            "stream": False,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key_7b:
            headers["Authorization"] = "Bearer " + self.api_key_7b

        request = urllib.request.Request(
            self.completions_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise BackendError(
                "UPSTREAM_HTTP_ERROR",
                "上游模型服务返回 HTTP {}。".format(error.code),
            ) from error
        except (urllib.error.URLError, TimeoutError) as error:
            reason = getattr(error, "reason", error)
            raise BackendError(
                "UPSTREAM_UNAVAILABLE", "无法连接上游模型服务。", [str(reason)]
            ) from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BackendError("UPSTREAM_INVALID_RESPONSE", "上游模型服务返回了无效 JSON。") from error

        try:
            raw_output = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise BackendError("UPSTREAM_INVALID_RESPONSE", "上游模型响应缺少生成文本。") from error
        return raw_output, result.get("usage") or {}

    def review(self, request):
        case, config, messages, coverage = build_request_context(request, self.model_config)

        # ── Stage 1: Natural language review from 7B ─────────────
        # Swap system prompt to natural language (no JSON format requirements)
        nl_messages = list(messages)
        nl_messages[0] = {"role": "system", "content": NL_SYSTEM_PROMPT}
        # Add venue context if present (same as build_request_context does)
        venue = request.get("target_venue")
        if request["review_type"] == "venue_conditioned" and venue:
            venue_lines = ["目标期刊：{}".format(venue["name"])]
            if venue.get("scope"):
                venue_lines.append("期刊范围：{}".format(venue["scope"]))
            requirements = venue.get("requirements") or []
            if requirements:
                venue_lines.append("投稿要求：{}".format("；".join(requirements)))
            nl_messages[1]["content"] += "\n\n" + "\n".join(venue_lines)

        started = time.perf_counter()
        try:
            nl_review, stage1_usage = self._call_7b(nl_messages, config)
        except BackendError:
            raise
        stage1_latency_ms = round((time.perf_counter() - started) * 1000)

        # ── Stage 2: DeepSeek V4 Pro structuring ─────────────────
        manuscript_title = request["manuscript"].get("title", "")
        try:
            parsed = self.structurer.structure(nl_review, manuscript_title)
        except StructuringError as error:
            raise BackendError(
                "DEEPSEEK_STRUCTURING_FAILED",
                "DeepSeek 结构化失败：{}".format(error),
                error.details,
            ) from error

        total_latency_ms = round((time.perf_counter() - started) * 1000)

        # ── Assemble final review ────────────────────────────────
        trace = {
            "provider": self.model_config.get("provider", "OneScience Plan B"),
            "model": config["model_id"],
            "model_version": config.get("model_revision", "unversioned"),
            "adapter_version": config.get("adapter_version"),
            "prompt_version": config["prompt_version"],
            "quantization": config.get("quantization"),
        }
        review = assemble_review(request, case, parsed, coverage, config, total_latency_ms, trace)
        # Plan B diagnostics live in `usage` (not schema-validated), not in `model_trace`
        # (review-schema.json disallows additional properties there).
        usage = {
            "prompt_tokens": stage1_usage.get("prompt_tokens"),
            "output_tokens": stage1_usage.get("completion_tokens"),
            "peak_memory_gb": None,
            "supplied_characters": coverage["supplied_characters"],
            "plan_b": {
                "stage1_model": "Qwen2.5-7B-Instruct + domain-lora",
                "stage1_latency_ms": stage1_latency_ms,
                "stage2_model": "DeepSeek V4 Pro",
                "stage2_latency_ms": total_latency_ms - stage1_latency_ms,
                "nl_review_chars": len(nl_review),
            },
        }
        return {"review": review, "usage": usage}

    def score(self, request):
        trace = {
            "provider": self.model_config.get("provider", "OneScience Plan B"),
            "model": self.model_config["model_id"],
            "model_version": self.model_config.get("model_revision", "unversioned"),
            "adapter_version": self.model_config.get("adapter_version"),
            "prompt_version": "venue-score-1.0.0",
            "quantization": self.model_config.get("quantization"),
        }
        scores = []
        total_latency = 0
        total_chars = 0
        prompt_tokens = 0
        output_tokens = 0
        for paper in request["papers"]:
            config, messages, supplied_characters = build_single_score_messages(paper, request, self.model_config)
            started = time.perf_counter()
            raw_output, upstream_usage = self._call_7b(messages, config)
            latency_ms = round((time.perf_counter() - started) * 1000)
            total_latency += latency_ms
            score = normalize_single_score_output(paper, raw_output, self.score_structurer)
            if score is None:
                raise BackendError("MODEL_SCORE_INVALID", "模型没有为论文 {} 返回有效评分。".format(paper["paper_id"]))
            scores.append(score)
            total_chars += supplied_characters
            prompt_tokens += int(upstream_usage.get("prompt_tokens") or 0)
            output_tokens += int(upstream_usage.get("completion_tokens") or 0)
        score_batch = assemble_score_batch(request, {"scores": scores}, total_latency, trace)
        return {
            "score_batch": score_batch,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "output_tokens": output_tokens,
                "peak_memory_gb": None,
                "supplied_characters": total_chars,
            },
        }


def create_backend(name, model_config, project_root):
    normalized = str(name).strip().lower()
    if normalized == "mock":
        return MockBackend(model_config)
    if normalized == "mlx":
        return MlxBackend(model_config, project_root)
    if normalized == "openai_compatible":
        return OpenAICompatibleBackend(model_config)
    if normalized == "plan_b":
        return PlanBBackend(model_config, project_root)
    raise BackendError("BACKEND_UNKNOWN", "不支持的 Reviewer 后端：{}。".format(name))
