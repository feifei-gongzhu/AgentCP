"""压力测试目录独立 conftest。

铁律：
1. 钥匙串隔离（照抄 tests/conftest.py 的 RuntimeSecretStore mock）；
2. SORNE_PROJECTS_DIR 指向 tmp_path，并把 store/webapp 模块级 PROJECTS
   常量一并指过去（PROJECTS 在 import 时绑定环境变量，仅 setenv 不够）；
3. 不触碰真实 projects/ 与真实钥匙串。
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from src.sorne import runtime_secrets as secrets_module
from src.sorne import store as store_module
from src.sorne import webapp as webapp_module
from src.sorne.runtime_secrets import RuntimeSecretStore


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
def isolated_projects(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    projects = tmp_path / "projects"
    monkeypatch.setenv("SORNE_PROJECTS_DIR", str(projects))
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    # 清空 webapp 模块级活动计数/删除标记，避免测试间串扰。
    monkeypatch.setattr(webapp_module, "_PROJECT_ACTIVITY", {})
    monkeypatch.setattr(webapp_module, "_PROJECTS_BEING_DELETED", set())
    monkeypatch.delenv("SORNE_SERVER_TOKEN", raising=False)
    yield projects


def run_threads(targets, *, timeout: float) -> float:
    """并行执行 target 列表，等待全部结束；超时视为死锁并失败。返回耗时秒数。"""
    threads = [threading.Thread(target=fn) for fn in targets]
    started = time.monotonic()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=timeout)
    elapsed = time.monotonic() - started
    stuck = [thread.name for thread in threads if thread.is_alive()]
    assert not stuck, f"疑似死锁：以下线程在 {timeout}s 内未结束: {stuck}"
    return elapsed
