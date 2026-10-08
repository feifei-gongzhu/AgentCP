"""回归：serve() 的监听 backlog 必须能承受并发连接突发。

历史缺陷（2026-10-08 六类测试确认并已修复）：serve() 直接使用
`ThreadingHTTPServer((host, port), AgentControlHandler)`，未调大
request_queue_size（socketserver 默认 5）。32 路并发新连接突发下，
macOS 对超出 backlog 的挂起连接直接 RST，客户端约 60-70% 请求收到
Connection reset / Broken pipe，且没有任何 HTTP 响应。修复引入
`webapp.ControlPlaneHTTPServer`（request_queue_size=128）；本测试用
同一类构造服务器，保证该回归不再复发。对照实验：backlog>=64 时
0 传输错误。
"""
from __future__ import annotations

import threading
import urllib.error
import urllib.request

import pytest

from conftest import run_threads

from src.sorne import webapp as webapp_module
from src.sorne.store import ProjectStore

BURST_THREADS = 32
BURST_ROUNDS = 4
TIMEOUT_SECONDS = 30.0


@pytest.fixture()
def serve_style_server(monkeypatch: pytest.MonkeyPatch):
    """与 serve() 完全相同的构造方式（修复后的 ControlPlaneHTTPServer）。"""
    ProjectStore("stress-backlog").init()
    monkeypatch.setattr(
        webapp_module.AgentControlHandler, "log_message", lambda *args, **kwargs: None,
    )
    server = webapp_module.ControlPlaneHTTPServer(
        ("127.0.0.1", 0), webapp_module.AgentControlHandler,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _get(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            response.read()
            return str(response.status)
    except urllib.error.HTTPError as exc:
        exc.read()
        return str(exc.code)
    except (urllib.error.URLError, OSError) as exc:
        return f"TRANSPORT:{type(exc).__name__}"


def test_32_way_connection_burst_is_not_reset_by_listen_backlog(
    serve_style_server: str,
) -> None:
    base = serve_style_server
    # 预热：排除冷启动因素，只测连接突发。
    assert _get(base + "/healthz") == "200"

    outcomes: list[tuple[str, int]] = []
    outcomes_lock = threading.Lock()
    barrier = threading.Barrier(BURST_THREADS)

    def worker(index: int) -> None:
        barrier.wait()
        local: list[tuple[str, int]] = [
            (_get(base + "/healthz"), index) for _ in range(BURST_ROUNDS)
        ]
        with outcomes_lock:
            outcomes.extend(local)

    elapsed = run_threads(
        [lambda index=index: worker(index) for index in range(BURST_THREADS)],
        timeout=TIMEOUT_SECONDS,
    )
    transport_failures = [status for status, _ in outcomes if status.startswith("TRANSPORT")]
    assert not transport_failures, (
        f"{len(transport_failures)}/{len(outcomes)} 个突发连接被重置（无 HTTP 响应）"
    )
    assert all(status == "200" for status, _ in outcomes)
    assert elapsed < TIMEOUT_SECONDS
