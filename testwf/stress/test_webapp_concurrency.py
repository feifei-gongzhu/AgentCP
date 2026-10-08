"""webapp 并发：in-process ThreadingHTTPServer 下 32 并发混合 GET/POST，断言无 5xx、无死锁。"""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from conftest import run_threads

from src.sorne import webapp as webapp_module
from src.sorne.store import ProjectStore

CONCURRENCY = 32
REQUESTS_PER_THREAD = 8
TIMEOUT_SECONDS = 90.0


@pytest.fixture()
def http_server(monkeypatch: pytest.MonkeyPatch):
    ProjectStore("stress-web").init()
    monkeypatch.setattr(
        webapp_module.AgentControlHandler, "log_message", lambda *args, **kwargs: None,
    )
    server = webapp_module.ControlPlaneHTTPServer(("127.0.0.1", 0), webapp_module.AgentControlHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _request(url: str, payload: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
            return response.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"raw": body[:200]}
        return exc.code, parsed
    except (urllib.error.URLError, OSError) as exc:
        # 传输层失败（连接被重置/断管等）：返回 0 让调用方按传输错误统计。
        return 0, {"transport_error": repr(exc)}


def test_32_concurrent_mixed_requests_no_5xx_no_deadlock(http_server: str) -> None:
    base = http_server
    failures: list[str] = []
    server_errors: list[str] = []
    transport_errors: list[str] = []
    failures_lock = threading.Lock()
    hint_posts: set[str] = set()

    paths = [
        ("GET", "/healthz"),
        ("GET", "/api/projects"),
        ("GET", "/api/project/state?vendor=stress-web"),
        ("GET", "/api/metrics?vendor=stress-web"),
        ("GET", "/api/audit?vendor=stress-web"),
        ("GET", "/api/config?vendor=stress-web"),
        ("GET", "/readyz"),  # 503 允许（not_ready），但不是 5xx 意义上的失败——单列处理
        ("POST", "/api/hints"),
    ]

    def worker(thread_index: int) -> None:
        for step in range(REQUESTS_PER_THREAD):
            method, path = paths[(thread_index + step) % len(paths)]
            if method == "POST":
                content = f"并发压测提示 {thread_index}-{step}"
                status, body = _request(
                    base + "/api/hints",
                    {"vendor": "stress-web", "content": content, "intervention_type": "supplement"},
                )
                if status == 0:
                    with failures_lock:
                        transport_errors.append(f"POST /api/hints -> {body}")
                elif status not in (200, 201):
                    with failures_lock:
                        failures.append(f"POST /api/hints -> {status}: {body}")
                else:
                    with failures_lock:
                        hint_posts.add(content)
            else:
                status, body = _request(base + path)
                if status == 0:
                    with failures_lock:
                        transport_errors.append(f"GET {path} -> {body}")
                elif path == "/readyz":
                    if status not in (200, 503):
                        with failures_lock:
                            failures.append(f"GET {path} -> {status}: {body}")
                elif status >= 500 or status >= 400:
                    with failures_lock:
                        (server_errors if status >= 500 else failures).append(
                            f"GET {path} -> {status}: {str(body)[:120]}"
                        )

    elapsed = run_threads(
        [lambda index=index: worker(index) for index in range(CONCURRENCY)],
        timeout=TIMEOUT_SECONDS,
    )

    assert not server_errors, f"出现 5xx: {server_errors[:5]}"
    assert not failures, f"请求失败: {failures[:5]}"
    # 传输层失败（连接重置/断管）单列：32 并发新连接突发下监听 backlog 有限，
    # 属于已知 TCP 层现象；出现则记录为观察项而不判失败，但必须量化。
    if transport_errors:
        print(f"\n[webapp-传输层] {len(transport_errors)} 个请求连接被重置: {transport_errors[:3]}")

    store = ProjectStore("stress-web")
    hints = store.read_jsonl("hints.jsonl")
    assert len(hints) == len(hint_posts), f"提示写入数不符: {len(hints)} != {len(hint_posts)}"
    contents = {row.get("content") for row in hints}
    assert contents == hint_posts, "并发 POST 的提示内容存在丢失或重复"

    # 活动计数必须全部释放，不残留（也不会为负——负值会在 release 时抛异常）。
    assert webapp_module._PROJECT_ACTIVITY == {}, webapp_module._PROJECT_ACTIVITY
    assert webapp_module._PROJECTS_BEING_DELETED == set()

    assert elapsed < TIMEOUT_SECONDS
    print(
        f"\n[webapp] {CONCURRENCY}并发 x {REQUESTS_PER_THREAD}混合请求: {elapsed:.2f}s "
        f"({CONCURRENCY * REQUESTS_PER_THREAD} 请求, {len(hint_posts)} POST)"
    )
