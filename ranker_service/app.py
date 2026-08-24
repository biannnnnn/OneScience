#!/usr/bin/env python3
"""HTTP service exposing the self-trained NAIPv2 Ranker to OneScience."""

from __future__ import annotations

import argparse
import hmac
import json
import os
import pathlib
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__
from .model import RankerError, create_ranker


PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent


class ApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, details: list | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or []


def load_config(path: str) -> dict:
    target = pathlib.Path(path)
    if not target.is_absolute():
        target = PROJECT_ROOT / target
    with target.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize_config(config: dict) -> dict:
    result = json.loads(json.dumps(config))
    model = result.setdefault("model", {})
    env_mappings = {
        "base_model_path": "NAIPV2_BASE_MODEL",
        "adapter_path": "NAIPV2_ADAPTER_DIR",
        "calibration_path": "NAIPV2_CALIBRATION_PATH",
    }
    for key, env_name in env_mappings.items():
        if os.environ.get(env_name):
            model[key] = os.environ[env_name]
    return result


def validate_papers(payload: object) -> list[dict]:
    if not isinstance(payload, dict):
        raise ApiError(422, "RANKER_REQUEST_INVALID", "评分请求必须是 JSON 对象。")
    papers = payload.get("papers")
    if not isinstance(papers, list) or not 1 <= len(papers) <= 64:
        raise ApiError(422, "RANKER_REQUEST_INVALID", "papers 必须包含 1 到 64 篇论文。")
    result = []
    seen = set()
    details = []
    for index, paper in enumerate(papers):
        location = "/papers/{}".format(index)
        if not isinstance(paper, dict):
            details.append({"path": location, "message": "论文必须是对象。"})
            continue
        paper_id = str(paper.get("paper_id") or "").strip()
        title = str(paper.get("title") or "").strip()
        abstract = str(paper.get("abstract") or "").strip()
        if not paper_id or len(paper_id) > 256:
            details.append({"path": location + "/paper_id", "message": "paper_id 不能为空且不超过 256 字符。"})
        elif paper_id in seen:
            details.append({"path": location + "/paper_id", "message": "paper_id 必须唯一。"})
        seen.add(paper_id)
        if not title or len(title) > 1000:
            details.append({"path": location + "/title", "message": "title 不能为空且不超过 1000 字符。"})
        if not abstract or len(abstract) > 24000:
            details.append({"path": location + "/abstract", "message": "abstract 不能为空且不超过 24000 字符。"})
        result.append({"paper_id": paper_id, "title": title, "abstract": abstract})
    if details:
        raise ApiError(422, "RANKER_REQUEST_INVALID", "论文评分请求不符合接口协议。", details)
    return result


class RankerService:
    def __init__(self, config: dict, backend_name: str):
        self.config = normalize_config(config)
        server = self.config.get("server") or {}
        self.max_concurrent = max(1, int(server.get("max_concurrent", 1)))
        self.inference_slots = threading.BoundedSemaphore(self.max_concurrent)
        self.active_inferences = 0
        self.active_lock = threading.Lock()
        self.started_at = time.time()
        self.completed = 0
        auth_env = (self.config.get("auth") or {}).get("api_key_env")
        self.api_key = os.environ.get(auth_env, "") if auth_env else ""
        if auth_env and (self.config.get("auth") or {}).get("required", False) and not self.api_key:
            raise RuntimeError("未设置 Ranker Service 密钥环境变量：{}。".format(auth_env))
        self.ranker = create_ranker(backend_name, self.config)

    @property
    def busy(self) -> bool:
        with self.active_lock:
            return self.active_inferences >= self.max_concurrent

    def authorize(self, authorization: str | None) -> bool:
        if not self.api_key:
            return True
        prefix = "Bearer "
        return bool(authorization and authorization.startswith(prefix)) and hmac.compare_digest(
            authorization[len(prefix):], self.api_key
        )

    def health(self) -> dict:
        return {
            "ok": True,
            "status": "busy" if self.busy else "ready",
            "service": "onescience-naipv2-ranker",
            "service_version": __version__,
            "backend": self.ranker.info(),
            "capabilities": ["paper_score_batch"],
            "batches_completed": self.completed,
            "active_inferences": self.active_inferences,
            "max_concurrent": self.max_concurrent,
            "uptime_seconds": round(time.time() - self.started_at),
            "privacy": self.config.get("privacy") or {},
        }

    def score(self, payload: dict) -> dict:
        papers = validate_papers(payload)
        request_id = str(payload.get("request_id") or uuid.uuid4())
        if len(request_id) > 64:
            raise ApiError(422, "RANKER_REQUEST_INVALID", "request_id 不能超过 64 字符。")
        if not self.inference_slots.acquire(blocking=False):
            raise ApiError(429, "RANKER_BUSY", "Ranker 正在处理另一个评分批次，请稍后重试。")
        with self.active_lock:
            self.active_inferences += 1
        try:
            result = self.ranker.score(papers)
            self.completed += 1
            return {
                "request_id": request_id,
                "status": "completed",
                "schema_version": "1.0.0",
                "scores": result["scores"],
                "model_trace": result["model_trace"],
                "disclaimer": "Ranker 分数只表示论文在学术质量排序轴上的相对位置，不是期刊录用概率。",
            }
        except RankerError as error:
            raise ApiError(502, error.code, str(error)) from error
        finally:
            with self.active_lock:
                self.active_inferences -= 1
            self.inference_slots.release()


def make_handler(service: RankerService, max_request_bytes: int):
    class RequestHandler(BaseHTTPRequestHandler):
        server_version = "OneScienceRanker/1.0"
        sys_version = ""

        def log_message(self, message_format, *args):
            print("ranker-service: " + message_format % args, flush=True)

        def send_json(self, status: int, payload: dict):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def send_error_payload(self, error: ApiError, request_id=None):
            self.send_json(error.status, {
                "request_id": request_id,
                "status": "error",
                "error": {"code": error.code, "message": str(error), "details": error.details},
            })

        def require_auth(self) -> bool:
            if service.authorize(self.headers.get("Authorization")):
                return True
            self.send_error_payload(ApiError(401, "UNAUTHORIZED", "缺少或使用了无效的 Ranker 服务密钥。"))
            return False

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, service.health())
                return
            if self.path == "/v1/models":
                if not self.require_auth():
                    return
                self.send_json(200, {
                    "service_version": __version__,
                    "active": service.ranker.info(),
                    "capabilities": ["paper_score_batch"],
                })
                return
            self.send_error_payload(ApiError(404, "NOT_FOUND", "未找到该接口。"))

        def do_POST(self):
            if self.path != "/v1/paper-scores":
                self.send_error_payload(ApiError(404, "NOT_FOUND", "未找到该接口。"))
                return
            if not self.require_auth():
                return
            request_id = None
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                if content_length <= 0:
                    raise ApiError(400, "EMPTY_BODY", "请求体不能为空。")
                if content_length > max_request_bytes:
                    raise ApiError(413, "REQUEST_TOO_LARGE", "请求体超过 Ranker 服务限制。")
                try:
                    payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ApiError(400, "INVALID_JSON", "请求体不是有效的 UTF-8 JSON。") from error
                request_id = payload.get("request_id") if isinstance(payload, dict) else None
                self.send_json(200, service.score(payload))
            except ApiError as error:
                self.send_error_payload(error, request_id)
            except Exception as error:
                print("ranker-service internal error: {}".format(error), flush=True)
                self.send_error_payload(ApiError(500, "INTERNAL_ERROR", "Ranker 服务发生内部错误。"), request_id)

    return RequestHandler


def main():
    parser = argparse.ArgumentParser(description="Run the OneScience NAIPv2 Ranker Service")
    parser.add_argument("--config", default="config/ranker-service.mock.json")
    parser.add_argument("--backend", choices=("mock", "transformers"))
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()

    config = load_config(args.config)
    backend_name = args.backend or os.environ.get("RANKER_BACKEND") or config.get("backend", "mock")
    service = RankerService(config, backend_name)
    server_config = service.config.get("server") or {}
    host = args.host or os.environ.get("RANKER_HOST") or server_config.get("host", "127.0.0.1")
    port = args.port if args.port is not None else int(os.environ.get("RANKER_PORT", server_config.get("port", 8788)))
    server = ThreadingHTTPServer((host, port), make_handler(
        service, int(server_config.get("max_request_bytes", 2_097_152))
    ))
    print(json.dumps({
        "event": "ready",
        "service": "onescience-naipv2-ranker",
        "backend": backend_name,
        "url": "http://{}:{}".format(host, server.server_address[1]),
    }, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
