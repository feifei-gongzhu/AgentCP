from __future__ import annotations

from pathlib import Path

import pytest

from src.sorne import runtime_secrets as secrets_module
from src.sorne.runtime_secrets import RuntimeSecretStore


@pytest.fixture(autouse=True)
def isolated_project_keychain(monkeypatch: pytest.MonkeyPatch):
    """照抄 tests/conftest.py：绝不读写用户真实钥匙串。"""
    keychain: dict = {}
    monkeypatch.setattr(secrets_module, "_keychain_read", lambda vendor: dict(keychain.get(vendor, {})))
    monkeypatch.setattr(secrets_module, "_keychain_write", lambda vendor, values: keychain.__setitem__(vendor, dict(values)))
    monkeypatch.setattr(secrets_module, "_keychain_delete", lambda vendor: keychain.pop(vendor, None))
    RuntimeSecretStore.clear()
    yield
    RuntimeSecretStore.clear()


@pytest.fixture(autouse=True)
def isolated_projects_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """隔离项目数据：环境变量 + 模块级 PROJECTS 双保险，绝不触碰真实 projects/。"""
    from src.sorne import store as store_module

    monkeypatch.setenv("SORNE_PROJECTS_DIR", str(tmp_path))
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    yield
