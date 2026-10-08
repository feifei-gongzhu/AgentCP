"""testwf/fuzz 专属 conftest：钥匙串隔离 + 项目数据目录隔离。

铁律：
- 绝不读写用户真实钥匙串（照抄 tests/conftest.py 的 RuntimeSecretStore mock）；
- 项目数据只写入 tmp_path（SORNE_PROJECTS_DIR 指向 tmp_path，
  并同步 patch store/webapp 模块内已按值绑定的 PROJECTS 常量）；
- 绝不触碰仓库根真实 projects/。
"""

from __future__ import annotations

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
def isolated_projects_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """项目数据一律落在 tmp_path/projects，与真实 projects/ 完全隔离。"""
    projects = tmp_path / "projects"
    projects.mkdir(parents=True)
    monkeypatch.setenv("SORNE_PROJECTS_DIR", str(projects))
    # PROJECTS 在 store 模块导入时已按值解析，必须同时 patch 按值导入的模块。
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    monkeypatch.delenv("SORNE_SERVER_TOKEN", raising=False)
    return projects
