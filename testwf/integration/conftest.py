"""testwf/integration 独立测试配置。

铁律：
- 绝不读写真实钥匙串（照抄 tests/conftest.py 的隔离 fixture）；
- 绝不触碰真实 projects/ 与 teams/，全部数据落在 pytest tmp_path；
- 只用 mock 模型驱动，绝不发起外部网络请求。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import pytest

from src.sorne import runtime_secrets as secrets_module
from src.sorne import store as store_module
from src.sorne import team as team_module
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
    projects_root = tmp_path / "projects"
    monkeypatch.setenv("SORNE_PROJECTS_DIR", str(projects_root))
    # store.PROJECTS 在 import 时已解析为常量，必须同步打补丁才真正隔离。
    monkeypatch.setattr(store_module, "PROJECTS", projects_root)
    projects_root.mkdir(parents=True, exist_ok=True)
    yield projects_root


@pytest.fixture(autouse=True)
def isolated_teams_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    teams_dir = tmp_path / "teams"
    monkeypatch.setattr(team_module, "TEAMS_DIR", teams_dir)
    teams_dir.mkdir(parents=True, exist_ok=True)
    yield teams_dir


@pytest.fixture(autouse=True)
def no_external_mrecon(monkeypatch: pytest.MonkeyPatch) -> None:
    """基础画像前置的确定性采集器会真实发起 HTTP 请求；测试必须禁外网。"""
    from src.sorne import mrecon as mrecon_module

    monkeypatch.setattr(mrecon_module, "collect_mrecon", lambda *args, **kwargs: [])


@pytest.fixture()
def project(isolated_projects_dir: Path) -> ProjectStore:
    store = ProjectStore("integration-vendor")
    store.init()
    return store


@pytest.fixture()
def team_writer(isolated_teams_dir: Path) -> Callable[[str, list], None]:
    def _write(name: str, members: list) -> None:
        (isolated_teams_dir / f"{name}.json").write_text(
            json.dumps({"members": members}, ensure_ascii=False), encoding="utf-8",
        )

    return _write
