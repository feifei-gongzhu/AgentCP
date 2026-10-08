"""testwf/ui 专用夹具：钥匙串隔离 + 项目数据目录隔离。

铁律：
- 绝不读写真实钥匙串（照抄 tests/conftest.py 的 RuntimeSecretStore mock）；
- 绝不触碰仓库根的 projects/（其中有真实数据），一切项目数据落在 pytest tmp；
- 子进程启动的真实服务也必须带 SORNE_PROJECTS_DIR 指向 tmp 目录。
"""
from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import time
from pathlib import Path

import pytest

from src.sorne import runtime_secrets as secrets_module
from src.sorne import store as store_module
from src.sorne import webapp as webapp_module
from src.sorne.runtime_secrets import RuntimeSecretStore

ROOT = Path(__file__).resolve().parents[2]
SORNE_LAUNCHER = ROOT / "sorne"
SERVER_PORT = 28765


@pytest.fixture(autouse=True)
def isolated_project_keychain(monkeypatch: pytest.MonkeyPatch):
    """Never let the test suite read or mutate the user's real Keychain."""
    keychain: dict[str, dict[str, str]] = {}
    monkeypatch.setattr(secrets_module, "_keychain_read", lambda vendor: dict(keychain.get(vendor, {})))
    monkeypatch.setattr(secrets_module, "_keychain_write", lambda vendor, values: keychain.__setitem__(vendor, dict(values)))
    monkeypatch.setattr(secrets_module, "_keychain_delete", lambda vendor: keychain.pop(vendor, None))
    RuntimeSecretStore.clear()
    yield
    RuntimeSecretStore.clear()


@pytest.fixture(autouse=True)
def isolated_projects_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """项目数据一律落到 tmp：环境变量 + 模块级 PROJECTS 双保险。

    store.py 在 import 时读 SORNE_PROJECTS_DIR，因此对进程内代码还必须
    同时 monkeypatch 模块属性；对子进程服务则通过 env 注入。
    """
    projects = tmp_path / "ui-projects"
    projects.mkdir()
    monkeypatch.setenv("SORNE_PROJECTS_DIR", str(projects))
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    return projects


def _raw_request(method: str, path: str, timeout: float = 10.0):
    """不走 urllib 的自动重定向与路径规范化，原样发送请求行。"""
    conn = http.client.HTTPConnection("127.0.0.1", SERVER_PORT, timeout=timeout)
    try:
        conn.putrequest(method, path, skip_accept_encoding=True)
        conn.putheader("Host", f"127.0.0.1:{SERVER_PORT}")
        conn.putheader("Connection", "close")
        conn.endheaders()
        response = conn.getresponse()
        body = response.read()
        headers = {k.lower(): v for k, v in response.getheaders()}
        return response.status, headers, body
    finally:
        conn.close()


def _get_json(path: str):
    status, headers, body = _raw_request("GET", path)
    assert headers.get("content-type", "").startswith("application/json"), (path, headers)
    return status, json.loads(body.decode("utf-8"))


class LiveServer:
    def __init__(self, projects_dir: Path, process: subprocess.Popen, log_path: Path) -> None:
        self.projects_dir = projects_dir
        self.process = process
        self.log_path = log_path

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{SERVER_PORT}"

    def request(self, method: str, path: str):
        return _raw_request(method, path)

    def get_json(self, path: str):
        return _get_json(path)


def _port_is_free() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", SERVER_PORT))
        except OSError:
            return False
    return True


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    """子进程启动真实 `sorne serve`，SORNE_PROJECTS_DIR 指向独立 tmp 目录。

    teardown 必须终止进程（terminate → wait → kill 兜底）。
    """
    if not _port_is_free():
        raise RuntimeError(f"端口 {SERVER_PORT} 已被占用，无法启动测试服务")
    projects_dir = tmp_path_factory.mktemp("ui_live_server") / "projects"
    projects_dir.mkdir()
    log_path = tmp_path_factory.mktemp("ui_live_server") / "server.log"
    env = dict(os.environ)
    env["SORNE_PROJECTS_DIR"] = str(projects_dir)
    env.pop("SORNE_SERVER_TOKEN", None)  # 仅本机回环绑定，无需令牌
    venv_python = ROOT / ".venv" / "bin" / "python"
    assert venv_python.is_file(), "缺少 .venv/bin/python"
    log_file = log_path.open("w")
    process = subprocess.Popen(
        [str(venv_python), str(SORNE_LAUNCHER), "serve", "--port", str(SERVER_PORT)],
        cwd=str(ROOT),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.monotonic() + 30.0
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(
                    f"sorne serve 提前退出 code={process.returncode}，日志：\n{log_path.read_text(encoding='utf-8', errors='replace')}"
                )
            try:
                status, payload = _get_json("/healthz")
                if status == 200 and payload.get("ok") is True:
                    break
            except (OSError, json.JSONDecodeError, AssertionError) as exc:
                last_error = exc
            time.sleep(0.2)
        else:
            raise RuntimeError(f"服务 30s 内未就绪：{last_error}，日志：\n{log_path.read_text(encoding='utf-8', errors='replace')}")
        yield LiveServer(projects_dir, process, log_path)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        log_file.close()


@pytest.fixture()
def server_projects(live_server: LiveServer, monkeypatch: pytest.MonkeyPatch) -> Path:
    """让本进程与子进程服务共享同一个隔离项目目录。"""
    monkeypatch.setattr(store_module, "PROJECTS", live_server.projects_dir)
    monkeypatch.setattr(webapp_module, "PROJECTS", live_server.projects_dir)
    return live_server.projects_dir
