"""公共 Runtime 抽取 6c：OpenAI endpoint 契约统一（本地 HTTP 服务断言实际请求路径）。"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from src.sorne.openai_urls import openai_chat_completions_url


@pytest.mark.parametrize(
    ("base_url", "expected"),
    [
        ("https://relay.example.com", "https://relay.example.com/v1/chat/completions"),
        ("https://relay.example.com/", "https://relay.example.com/v1/chat/completions"),
        ("https://relay.example.com/v1", "https://relay.example.com/v1/chat/completions"),
        ("https://relay.example.com/v1/", "https://relay.example.com/v1/chat/completions"),
        ("https://api.deepseek.com", "https://api.deepseek.com/v1/chat/completions"),
        ("http://127.0.0.1:8000", "http://127.0.0.1:8000/v1/chat/completions"),
        ("  https://relay.example.com  ", "https://relay.example.com/v1/chat/completions"),
    ],
)
def test_openai_url_contract(base_url: str, expected: str) -> None:
    assert openai_chat_completions_url(base_url) == expected


def test_openai_url_rejects_empty() -> None:
    with pytest.raises(ValueError):
        openai_chat_completions_url("")
    with pytest.raises(ValueError):
        openai_chat_completions_url(None)


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


@pytest.mark.parametrize("base_style", ["service_root", "api_root"])
def test_openai_driver_hits_contracted_path(
    local_openai_server, base_style: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, captured = local_openai_server
    base = root if base_style == "service_root" else f"{root}/v1"
    monkeypatch.setenv("SORNE_TEST_OAI_KEY", "test-key")
    from src.sorne.drivers import DriverConfig, OpenAICompatibleDriver

    driver = OpenAICompatibleDriver(DriverConfig(
        type="openai-compatible",
        model="test-model",
        base_url=base,
        api_key_env="SORNE_TEST_OAI_KEY",
    ), timeout=10)
    payload = driver.run("prompt")
    assert payload["kind"] == "none"
    # 统一契约：两种配置风格打到同一条实际路径。
    assert captured["path"] == "/v1/chat/completions"
    assert captured["auth"] == "Bearer test-key"


@pytest.mark.parametrize("base_style", ["service_root", "api_root"])
def test_local_docker_compatibility_hits_contracted_path(
    local_openai_server, base_style: str, tmp_path,
) -> None:
    root, captured = local_openai_server
    base = root if base_style == "service_root" else f"{root}/v1"
    from src.sorne.drivers import DriverConfig
    from src.sorne.local_docker import LocalDockerRuntime

    runtime = LocalDockerRuntime(
        DriverConfig(
            type="claude-cli",
            base_url=base,
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
    runtime.profile = type(runtime.profile)(
        project_path=runtime.profile.project_path,
        member_name=runtime.profile.member_name,
        provider=runtime.profile.provider,
        model=runtime.profile.model,
        base_url=base,
        auth_mode=runtime.profile.auth_mode,
        api_key="test-key",
        sandbox=runtime.profile.sandbox,
        target_path=runtime.profile.target_path,
        guest_image=runtime.profile.guest_image,
        external_host=runtime.profile.external_host,
    )
    response = runtime._openai_chat_completion(
        [{"role": "user", "content": "hi"}], [], timeout=5,
    )
    assert isinstance(response, dict)
    # 统一契约：两种配置风格打到同一条实际路径。
    assert captured["path"] == "/v1/chat/completions"
