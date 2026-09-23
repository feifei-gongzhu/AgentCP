"""OpenAI endpoint 契约（修订版）：保留两种调用场景的旧配置含义。

6c 曾把两种场景隐式统一为“未以 /v1 结尾自动加 /v1”，破坏自定义路径
前缀（如 https://relay.example/api）的 local-cli 旧配置。修订后：
- 默认各按历史语义（drivers=api_root、local_docker=service_root）；
- 互通只通过显式 ``extra["openai_url_style"]``。
完整参数化契约见 test_openai_url_compat.py；本文件用本地 HTTP 服务断言
两个 driver 的实际请求路径。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from src.sorne.openai_urls import openai_chat_completions_url


def test_helper_requires_explicit_style() -> None:
    with pytest.raises(TypeError):
        openai_chat_completions_url("https://relay.example.com")  # type: ignore[arg-type]


def test_helper_service_root_is_idempotent_for_v1() -> None:
    assert (
        openai_chat_completions_url("https://api.openai.com/v1", style="service_root")
        == "https://api.openai.com/v1/chat/completions"
    )
    assert (
        openai_chat_completions_url("https://api.openai.com", style="service_root")
        == "https://api.openai.com/v1/chat/completions"
    )


def test_helper_api_root_keeps_custom_prefix() -> None:
    assert (
        openai_chat_completions_url("https://relay.example/api", style="api_root")
        == "https://relay.example/api/chat/completions"
    )


class _CapturingHandler(BaseHTTPRequestHandler):
    captured: dict[str, str] = {}

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        type(self).captured["path"] = self.path
        type(self).captured["auth"] = self.headers.get("Authorization", "")
        body = json.dumps({
            "choices": [{"message": {"role": "assistant", "content": '{"kind":"none","reason":"ok"}'}}],
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        pass


@pytest.fixture()
def local_openai_server():
    server = HTTPServer(("127.0.0.1", 0), _CapturingHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", _CapturingHandler.captured
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_openai_driver_default_path_and_auth(
    local_openai_server, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, captured = local_openai_server
    monkeypatch.setenv("SORNE_TEST_OAI_KEY", "test-key")
    from src.sorne.drivers import DriverConfig, OpenAICompatibleDriver

    driver = OpenAICompatibleDriver(DriverConfig(
        type="openai-compatible",
        model="test-model",
        base_url=root,
        api_key_env="SORNE_TEST_OAI_KEY",
    ), timeout=10)
    payload = driver.run("prompt")
    assert payload["kind"] == "none"
    # local-cli 默认 api_root：base 原样拼 /chat/completions。
    assert captured["path"] == "/chat/completions"
    assert captured["auth"] == "Bearer test-key"


def test_local_docker_default_hits_v1_path(local_openai_server, tmp_path) -> None:
    root, captured = local_openai_server
    from src.sorne.drivers import DriverConfig
    from src.sorne.local_docker import LocalDockerRuntime

    runtime = LocalDockerRuntime(
        DriverConfig(
            type="claude-cli",
            base_url=root,
            extra={
                "project_path": str(tmp_path),
                "member_name": "m1",
                "claude_tool_compatibility": "openai",
            },
        ),
        timeout=30,
        cancel_check=lambda: False,
        progress_callback=lambda _event: None,
    )
    object.__setattr__(runtime.profile, "api_key", "test-key")
    response = runtime._openai_chat_completion(
        [{"role": "user", "content": "hi"}], [], timeout=5,
    )
    assert isinstance(response, dict)
    # local-docker 默认 service_root：base 拼出 /v1/chat/completions。
    assert captured["path"] == "/v1/chat/completions"
