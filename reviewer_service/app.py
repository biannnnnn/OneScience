#!/usr/bin/env python3
"""Local HTTP service for replaceable OneScience reviewer models."""

import argparse
import hmac
import json
import os
import pathlib
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from jsonschema import Draft202012Validator, FormatChecker

from acceptance_prediction import AcceptancePredictor, ModelError

from . import __version__
from .backends import BackendError, create_backend


PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def resolve_path(path):
    candidate = pathlib.Path(path)
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def validation_errors(validator, value):
    errors = []
    for error in sorted(validator.iter_errors(value), key=lambda item: list(item.absolute_path)):
        location = "/" + "/".join(str(item) for item in error.absolute_path)
        errors.append({"path": location, "message": error.message})
    return errors


class ApiError(RuntimeError):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or []


class ReviewerService:
    def __init__(self, config, backend_name, model_config_path=None):
        self.config = config
        self.started_at = time.time()
        self.max_concurrent = max(1, int((config.get("server") or {}).get("max_concurrent", 1)))
        self.inference_slots = threading.BoundedSemaphore(self.max_concurrent)
        self.active_inferences = 0
        self.active_inferences_lock = threading.Lock()
        self.request_count = 0
        self.score_batch_count = 0
        self.prediction_count = 0
        request_schema = load_json(resolve_path(config["request_schema_path"]))
        review_schema = load_json(resolve_path(config["review_schema_path"]))
        checker = FormatChecker()
        self.request_validator = Draft202012Validator(request_schema, format_checker=checker)
        self.review_validator = Draft202012Validator(review_schema, format_checker=checker)
        self.score_request_validator = Draft202012Validator(
            load_json(resolve_path(config.get(
                "score_request_schema_path", "schemas/venue-score-request.json"
            ))),
            format_checker=checker,
        )
        self.score_output_validator = Draft202012Validator(
            load_json(resolve_path(config.get(
                "score_output_schema_path", "schemas/venue-score-batch.json"
            ))),
            format_checker=checker,
        )
        prediction_config = config.get("acceptance_prediction") or {}
        prediction_request_path = prediction_config.get(
            "request_schema_path", "schemas/acceptance-prediction-request.json"
        )
        prediction_output_path = prediction_config.get(
            "output_schema_path", "schemas/acceptance-prediction.json"
        )
        self.prediction_request_validator = Draft202012Validator(
            load_json(resolve_path(prediction_request_path)), format_checker=checker
        )
        self.prediction_output_validator = Draft202012Validator(
            load_json(resolve_path(prediction_output_path)), format_checker=checker
        )
        prediction_score_request_path = prediction_config.get(
            "score_request_schema_path", "schemas/acceptance-prediction-score-request.json"
        )
        self.prediction_score_request_validator = Draft202012Validator(
            load_json(resolve_path(prediction_score_request_path)), format_checker=checker
        )
        model_path = prediction_config.get("model_path")
        self.acceptance_predictor = AcceptancePredictor.load(resolve_path(model_path)) if model_path else None
        api_key_env = (config.get("auth") or {}).get("api_key_env")
        self.api_key = os.environ.get(api_key_env, "") if api_key_env else ""
        if api_key_env and not self.api_key:
            raise RuntimeError("未设置 Reviewer Service 密钥环境变量：{}。".format(api_key_env))
        self.model_config = load_json(resolve_path(model_config_path or config["model_config_path"]))
        self.backend = create_backend(backend_name, self.model_config, PROJECT_ROOT)

    @property
    def busy(self):
        with self.active_inferences_lock:
            return self.active_inferences >= self.max_concurrent

    def health(self):
        return {
            "ok": True,
            "status": "busy" if self.busy else "ready",
            "service": "onescience-reviewer-service",
            "service_version": self.config["service_version"],
            "schema_version": "1.0.0",
            "backend": self.backend.info(),
            "requests_completed": self.request_count,
            "score_batches_completed": self.score_batch_count,
            "predictions_completed": self.prediction_count,
            "active_inferences": self.active_inferences,
            "max_concurrent": self.max_concurrent,
            "uptime_seconds": round(time.time() - self.started_at),
            "privacy": self.config["privacy"],
            "capabilities": ["structured_review", "venue_score_batch"],
            "acceptance_prediction": (
                {"loaded": True, **self.acceptance_predictor.info()}
                if self.acceptance_predictor else {"loaded": False}
            ),
        }

    def authorize(self, authorization):
        if not self.api_key:
            return True
        prefix = "Bearer "
        if not authorization or not authorization.startswith(prefix):
            return False
        return hmac.compare_digest(authorization[len(prefix):], self.api_key)

    def review(self, payload):
        errors = validation_errors(self.request_validator, payload)
        paragraph_ids = [item.get("paragraph_id") for item in payload.get("manuscript", {}).get("paragraphs", [])]
        if len(paragraph_ids) != len(set(paragraph_ids)):
            errors.append({"path": "/manuscript/paragraphs", "message": "paragraph_id 必须唯一。"})
        if errors:
            raise ApiError(422, "REQUEST_SCHEMA_INVALID", "审稿请求不符合服务协议。", errors)

        payload = dict(payload)
        payload["request_id"] = payload.get("request_id") or str(uuid.uuid4())
        if not self.inference_slots.acquire(blocking=False):
            raise ApiError(429, "REVIEWER_BUSY", "本地审稿模型正在处理另一个请求，请稍后重试。")
        with self.active_inferences_lock:
            self.active_inferences += 1
        try:
            result = self.backend.review(payload)
            review = result.get("review")
            if review is None:
                raise ApiError(502, "MODEL_OUTPUT_EMPTY", "模型没有生成审稿结果。")
            output_errors = validation_errors(self.review_validator, review)
            if output_errors:
                raise ApiError(502, "MODEL_OUTPUT_SCHEMA_INVALID", "模型输出未通过 review-schema.json。", output_errors)
            self.request_count += 1
            return {
                "request_id": payload["request_id"],
                "status": "completed",
                "service_version": self.config["service_version"],
                "schema_version": review["schema_version"],
                "backend": self.backend.info(),
                "review": review,
                "usage": result.get("usage", {}),
            }
        except BackendError as error:
            raise ApiError(502, error.code, str(error), error.details) from error
        finally:
            with self.active_inferences_lock:
                self.active_inferences -= 1
            self.inference_slots.release()

    def predict_acceptance(self, payload):
        if self.acceptance_predictor is None:
            raise ApiError(
                503,
                "ACCEPTANCE_MODEL_NOT_CONFIGURED",
                "录用预测模型尚未训练或配置。",
            )
        contract = getattr(self.acceptance_predictor, "feature_contract", "review")
        paragraph_ids = [
            item.get("paragraph_id")
            for item in payload.get("manuscript", {}).get("paragraphs", [])
        ]
        target_venue = payload.get("target_venue") or {}

        if contract == "score":
            errors = validation_errors(self.prediction_score_request_validator, payload)
            if len(paragraph_ids) != len(set(paragraph_ids)):
                errors.append({"path": "/manuscript/paragraphs", "message": "paragraph_id 必须唯一。"})
            if errors:
                raise ApiError(422, "PREDICTION_REQUEST_SCHEMA_INVALID", "录用预测请求不符合服务协议。", errors)
            try:
                prediction = self.acceptance_predictor.predict_from_score(
                    payload["manuscript"],
                    target_venue,
                    payload.get("score") or {},
                    payload.get("model_trace") or {},
                )
            except ModelError as error:
                raise ApiError(422, "PREDICTION_MODEL_INCOMPATIBLE", str(error)) from error
        else:
            errors = validation_errors(self.prediction_request_validator, payload)
            errors.extend(validation_errors(self.review_validator, payload.get("review")))
            if len(paragraph_ids) != len(set(paragraph_ids)):
                errors.append({"path": "/manuscript/paragraphs", "message": "paragraph_id 必须唯一。"})
            review = payload.get("review") or {}
            if review.get("review_type") != "venue_conditioned":
                errors.append({"path": "/review/review_type", "message": "录用预测必须使用目标期刊条件审稿。"})
            review_venue = review.get("target_venue") or {}
            if review_venue.get("name") != target_venue.get("name"):
                errors.append({"path": "/review/target_venue/name", "message": "审稿目标期刊与预测目标期刊不一致。"})
            if errors:
                raise ApiError(422, "PREDICTION_REQUEST_SCHEMA_INVALID", "录用预测请求不符合服务协议。", errors)
            try:
                prediction = self.acceptance_predictor.predict(
                    payload["manuscript"], target_venue, review
                )
            except ModelError as error:
                raise ApiError(422, "PREDICTION_MODEL_INCOMPATIBLE", str(error)) from error

        output_errors = validation_errors(self.prediction_output_validator, prediction)
        if output_errors:
            raise ApiError(
                500,
                "PREDICTION_OUTPUT_SCHEMA_INVALID",
                "录用预测结果未通过输出协议。",
                output_errors,
            )
        self.prediction_count += 1
        return {
            "request_id": payload.get("request_id") or str(uuid.uuid4()),
            "status": "completed",
            "service_version": self.config["service_version"],
            "prediction": prediction,
        }

    def score_venue(self, payload):
        errors = validation_errors(self.score_request_validator, payload)
        papers = payload.get("papers")
        papers = papers if isinstance(papers, list) else []
        paper_ids = [item.get("paper_id") for item in papers if isinstance(item, dict)]
        if len(paper_ids) != len(set(paper_ids)):
            errors.append({"path": "/papers", "message": "paper_id 必须唯一。"})
        supplied_characters = sum(
            len(item.get("text", "")) for item in papers
            if isinstance(item, dict)
        )
        if supplied_characters > 48000:
            errors.append({
                "path": "/papers",
                "message": "单批论文文本合计不能超过 48000 字符。",
            })
        if errors:
            raise ApiError(422, "SCORE_REQUEST_SCHEMA_INVALID", "批量评分请求不符合服务协议。", errors)

        payload = dict(payload)
        payload["request_id"] = payload.get("request_id") or str(uuid.uuid4())
        if not self.inference_slots.acquire(blocking=False):
            raise ApiError(429, "REVIEWER_BUSY", "本地审稿模型正在处理另一个请求，请稍后重试。")
        with self.active_inferences_lock:
            self.active_inferences += 1
        try:
            result = self.backend.score(payload)
            score_batch = result.get("score_batch")
            if score_batch is None:
                raise ApiError(502, "MODEL_SCORE_OUTPUT_EMPTY", "模型没有生成批量评分结果。")
            output_errors = validation_errors(self.score_output_validator, score_batch)
            if output_errors:
                raise ApiError(
                    502,
                    "MODEL_SCORE_OUTPUT_SCHEMA_INVALID",
                    "模型输出未通过 venue-score-batch.json。",
                    output_errors,
                )
            self.score_batch_count += 1
            return {
                "request_id": payload["request_id"],
                "status": "completed",
                "service_version": self.config["service_version"],
                "schema_version": score_batch["schema_version"],
                "backend": self.backend.info(),
                "score_batch": score_batch,
                "usage": result.get("usage", {}),
            }
        except BackendError as error:
            raise ApiError(502, error.code, str(error), error.details) from error
        finally:
            with self.active_inferences_lock:
                self.active_inferences -= 1
            self.inference_slots.release()


def make_handler(service, max_request_bytes):
    class RequestHandler(BaseHTTPRequestHandler):
        server_version = "OneScienceReviewer/1.0"
        sys_version = ""

        def log_message(self, message_format, *args):
            print("reviewer-service: " + message_format % args, flush=True)

        def send_json(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def error_response(self, error, request_id=None):
            payload = {
                "request_id": request_id,
                "status": "error",
                "error": {
                    "code": error.code,
                    "message": str(error),
                    "details": error.details,
                },
            }
            self.send_json(error.status, payload)

        def require_authorization(self):
            if service.authorize(self.headers.get("Authorization")):
                return True
            self.error_response(ApiError(401, "UNAUTHORIZED", "缺少或使用了无效的服务访问密钥。"))
            return False

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, service.health())
                return
            if self.path == "/v1/models":
                if not self.require_authorization():
                    return
                self.send_json(200, {
                    "service_version": service.config["service_version"],
                    "active": service.backend.info(),
                    "available_backends": ["mlx", "openai_compatible", "mock", "plan_b"],
                    "capabilities": ["structured_review", "venue_score_batch"],
                    "acceptance_predictor": (
                        service.acceptance_predictor.info()
                        if service.acceptance_predictor else None
                    ),
                })
                return
            self.error_response(ApiError(404, "NOT_FOUND", "未找到该接口。"))

        def do_POST(self):
            if self.path not in ("/v1/reviews", "/v1/venue-scores", "/v1/acceptance-predictions"):
                self.error_response(ApiError(404, "NOT_FOUND", "未找到该接口。"))
                return
            if not self.require_authorization():
                return
            request_id = None
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                if content_length <= 0:
                    raise ApiError(400, "EMPTY_BODY", "请求体不能为空。")
                if content_length > max_request_bytes:
                    raise ApiError(413, "REQUEST_TOO_LARGE", "请求体超过本地服务限制。")
                raw_body = self.rfile.read(content_length)
                try:
                    payload = json.loads(raw_body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ApiError(400, "INVALID_JSON", "请求体不是有效的 UTF-8 JSON。") from error
                if not isinstance(payload, dict):
                    raise ApiError(422, "REQUEST_SCHEMA_INVALID", "审稿请求必须是 JSON 对象。")
                request_id = payload.get("request_id")
                if self.path == "/v1/reviews":
                    result = service.review(payload)
                elif self.path == "/v1/venue-scores":
                    result = service.score_venue(payload)
                else:
                    result = service.predict_acceptance(payload)
                self.send_json(200, result)
            except ApiError as error:
                self.error_response(error, request_id)
            except Exception as error:  # Avoid exposing local paths or model internals.
                print("reviewer-service internal error: {}".format(error), flush=True)
                self.error_response(ApiError(500, "INTERNAL_ERROR", "本地审稿服务发生内部错误。"), request_id)

    return RequestHandler


def main():
    parser = argparse.ArgumentParser(description="Run the OneScience local Reviewer Service")
    parser.add_argument("--config", default="config/reviewer-service.m1.json")
    parser.add_argument("--backend", choices=("mlx", "openai_compatible", "mock", "plan_b"))
    parser.add_argument("--model-config")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()

    config = load_json(resolve_path(args.config))
    backend_name = args.backend or os.environ.get("REVIEWER_BACKEND") or config["backend"]
    host = args.host or os.environ.get("REVIEWER_HOST") or config["server"]["host"]
    port = args.port if args.port is not None else int(os.environ.get("REVIEWER_PORT", config["server"]["port"]))
    model_config_path = args.model_config or os.environ.get("REVIEWER_MODEL_CONFIG")
    service = ReviewerService(config, backend_name, model_config_path)
    handler = make_handler(service, int(config["server"]["max_request_bytes"]))
    server = ThreadingHTTPServer((host, port), handler)
    actual_port = server.server_address[1]
    print(json.dumps({
        "event": "ready",
        "service": "onescience-reviewer-service",
        "backend": backend_name,
        "url": "http://{}:{}".format(host, actual_port),
    }, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
