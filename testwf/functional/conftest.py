"""功能测试共享夹具：钥匙串隔离 + 项目数据隔离 + in-process Web API 请求。

铁律来源：tests/conftest.py（RuntimeSecretStore mock）与 tests/test_webapp.py
（object.__new__(AgentControlHandler) 的 in-process 模式）。绝不触碰真实
钥匙串与真实 projects/ 数据。
"""
from __future__ import annotations

import email.message
import json
from io import BytesIO
from pathlib import Path

import pytest

from src.sorne import runtime_secrets as secrets_module
from src.sorne import store as store_module
from src.sorne import webapp as webapp_module
from src.sorne.runtime_secrets import RuntimeSecretStore
from src.sorne.store import ProjectStore


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
    """Isolate all project data into tmp_path (env + module constants)."""
    projects = tmp_path / "projects"
    monkeypatch.setenv("SORNE_PROJECTS_DIR", str(projects))
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    return projects


@pytest.fixture
def projects_dir(isolated_projects_dir: Path) -> Path:
    return isolated_projects_dir


@pytest.fixture
def project(projects_dir: Path) -> ProjectStore:
    store = ProjectStore("fn-web")
    store.init()
    return store


class InProcessResponse:
    def __init__(self, status: int | None, body: bytes) -> None:
        self.status = status
        self.body = body
        try:
            self.json = json.loads(body.decode("utf-8")) if body else None
        except json.JSONDecodeError:
            self.json = None


@pytest.fixture
def api():
    """In-process AgentControlHandler invocation: no socket, no port, no subprocess."""

    def _call(
        method: str,
        path: str,
        *,
        json_body: dict | None = None,
        token: str | None = None,
    ) -> InProcessResponse:
        handler = object.__new__(webapp_module.AgentControlHandler)
        handler.command = method
        handler.path = path
        handler.headers = email.message.Message()
        data = b"" if json_body is None else json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        handler.headers["Content-Length"] = str(len(data))
        if token:
            handler.headers["Authorization"] = f"Bearer {token}"
        handler.rfile = BytesIO(data)
        handler.wfile = BytesIO()
        captured: dict[str, int | None] = {"status": None}

        def _send_response(status, message=None):
            captured["status"] = status

        handler.send_response = _send_response
        handler.send_header = lambda key, value: None
        handler.end_headers = lambda: None
        handler.log_request = lambda *args, **kwargs: None
        if method == "GET":
            handler.do_GET()
        else:
            handler.do_POST()
        return InProcessResponse(captured["status"], handler.wfile.getvalue())

    return _call
