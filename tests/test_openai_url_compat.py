"""补修 E：OpenAI URL 构造保留旧配置含义 + 显式 style 开关（用户复核问题 8）。

历史（旧配置）含义必须保留：
- drivers.OpenAICompatibleDriver（local-cli）：base_url 直接拼
  ``/chat/completions``——base_url 是**含自定义路径前缀的 API 根**
  （如 https://relay.example/api → https://relay.example/api/chat/completions）；
- local_docker：base_url 拼 ``/v1/chat/completions``——base_url 是服务根。

统一 helper 不得给未以 /v1 结尾的地址自动加 /v1（会破坏自定义路径前缀）。
互通通过**显式**配置 ``extra["openai_url_style"]``（"api_root" /
"service_root"）实现，可迁移且不隐式改语义。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from src.sorne.openai_urls import openai_chat_completions_url


@pytest.mark.parametrize(
    ("base_url", "style", "expected"),
    [
        # api_root（local-cli 旧语义）：base 原样 + /chat/completions，
        # 自定义路径前缀保留，不自动加 /v1。
        ("https://relay.example/api", "api_root", "https://relay.example/api/chat/completions"),
        ("https://relay.example/api/", "api_root", "https://relay.example/api/chat/completions"),
        ("https://api.openai.com/v1", "api_root", "https://api.openai.com/v1/chat/completions"),
        ("https://deepseek.example", "api_root", "https://deepseek.example/chat/completions"),
        # service_root（local-docker 旧语义）：base + /v1/chat/completions。
        ("https://relay.example", "service_root", "https://relay.example/v1/chat/completions"),
        ("https://relay.example/", "service_root", "https://relay.example/v1/chat/completions"),
        # service_root 且 base 已含 /v1：不重复叠 /v1（幂等归一）。
        ("https://api.openai.com/v1", "service_root", "https://api.openai.com/v1/chat/completions"),
        ("https://api.openai.com/v1/", "service_root", "https://api.openai.com/v1/chat/completions"),
    ],
)
def test_url_contract_preserves_legacy_meaning(
    base_url: str, style: str, expected: str,
) -> None:
    assert openai_chat_completions_url(base_url, style=style) == expected


def test_url_rejects_empty_and_unknown_style() -> None:
    with pytest.raises(ValueError):
        openai_chat_completions_url("", style="api_root")
    with pytest.raises(ValueError):
        openai_chat_completions_url("https://relay.example", style="bogus")  # type: ignore[arg-type]


class _CapturingHandler(BaseHTTPRequestHandler):
    captured: dict[str, str] = {}

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        type(self).captured["path"] = self.path
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


def test_local_cli_default_keeps_custom_prefix_path(
    local_openai_server, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """local-cli 默认行为（api_root）：自定义路径前缀不加 /v1。"""
    root, captured = local_openai_server
    monkeypatch.setenv("SORNE_TEST_OAI_KEY", "test-key")
    from src.sorne.drivers import DriverConfig, OpenAICompatibleDriver

    driver = OpenAICompatibleDriver(DriverConfig(
        type="openai-compatible",
        model="test-model",
        base_url=f"{root}/api",
        api_key_env="SORNE_TEST_OAI_KEY",
    ), timeout=10)
    payload = driver.run("prompt")
    assert payload["kind"] == "none"
    assert captured["path"] == "/api/chat/completions"

    # 显式切到 service_root 后走 /v1 路径（可迁移的显式配置）。
    captured["path"] = ""
    driver = OpenAICompatibleDriver(DriverConfig(
        type="openai-compatible",
        model="test-model",
        base_url=root,
        api_key_env="SORNE_TEST_OAI_KEY",
        extra={"openai_url_style": "service_root"},
    ), timeout=10)
    driver.run("prompt")
    assert captured["path"] == "/v1/chat/completions"


def test_local_docker_default_keeps_service_root(
    local_openai_server, tmp_path,
) -> None:
    """local-docker 默认行为（service_root）：base 为服务根拼 /v1。"""
    root, captured = local_openai_server
    from src.sorne.drivers import DriverConfig
    from src.sorne.local_docker import LocalDockerRuntime

    def _runtime(extra: dict) -> LocalDockerRuntime:
        runtime = LocalDockerRuntime(
            DriverConfig(type="claude-cli", base_url=root, extra={
                "project_path": str(tmp_path),
                "member_name": "m1",
                "claude_tool_compatibility": "openai",
                **extra,
            }),
            timeout=30,
            cancel_check=lambda: False,
            progress_callback=lambda _event: None,
        )
        profile = runtime.profile
        object.__setattr__(profile, "api_key", "test-key")
        return runtime

    response = _runtime({})._openai_chat_completion(
        [{"role": "user", "content": "hi"}], [], timeout=5,
    )
    assert isinstance(response, dict)
    assert captured["path"] == "/v1/chat/completions"

    # base 已含 /v1 时不叠加（旧实现会产生 /v1/v1）。
    captured["path"] = ""
    response = _runtime({})._openai_chat_completion(
        [{"role": "user", "content": "hi"}], [], timeout=5,
    )
    assert isinstance(response, dict)

    # 显式切到 api_root 后保留自定义路径前缀。
    captured["path"] = ""
    runtime = _runtime({"openai_url_style": "api_root"})
    object.__setattr__(runtime.profile, "base_url", f"{root}/api")
    response = runtime._openai_chat_completion(
        [{"role": "user", "content": "hi"}], [], timeout=5,
    )
    assert isinstance(response, dict)
    assert captured["path"] == "/api/chat/completions"
