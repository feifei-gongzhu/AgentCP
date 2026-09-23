from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.drivers import DriverError, run_driver
from src.sorne.runtime_config import canonical_runtime_mode, effective_backend
from src.sorne.store import ProjectStore
from src.sorne.team import TeamMember, WorkerError, load_team


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("local-cli", "local-cli"),
        ("local-docker", "local-docker"),
        ("agent-compose", "agent-compose"),
        ("host-native", "local-cli"),
        ("ct-agent-compose", "agent-compose"),
        (None, "local-docker"),
        ("", "local-docker"),
        ("  local-docker ", "local-docker"),
    ],
)
def test_canonical_runtime_mode(raw: object, expected: str) -> None:
    assert canonical_runtime_mode(raw) == expected


def test_canonical_runtime_mode_rejects_unknown() -> None:
    with pytest.raises(ValueError):
        canonical_runtime_mode("docker-compose-native")


def test_effective_backend_precedence() -> None:
    assert effective_backend("codex", "claude-cli") == "codex"
    assert effective_backend("", "claude-cli") == "claude-cli"
    assert effective_backend(None, None) == "codex"
    assert effective_backend("  ", "  ollama  ") == "ollama"


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    return store


def _write_team(store: ProjectStore, members: list[dict]) -> None:
    (store.path / "team_config.json").write_text(
        json.dumps({"members": members}, ensure_ascii=False), encoding="utf-8"
    )


def test_team_load_type_wins_over_legacy_backend(project: ProjectStore) -> None:
    _write_team(project, [
        {"name": "m1", "type": "codex", "backend": "claude-cli", "role": "reason"},
    ])
    member = load_team("default", project)[0]
    assert member.type == "codex"
    assert member.backend == "codex"


def test_team_load_backend_fallback(project: ProjectStore) -> None:
    _write_team(project, [
        {"name": "m1", "backend": "claude-cli", "role": "reason"},
    ])
    member = load_team("default", project)[0]
    assert member.type == "claude-cli"
    assert member.backend == "claude-cli"


def test_team_load_migrates_legacy_runtime_mode(project: ProjectStore) -> None:
    _write_team(project, [
        {"name": "m1", "type": "codex", "role": "reason", "runtime_mode": "host-native"},
        {"name": "m2", "type": "codex", "role": "reviewer", "runtime_mode": "ct-agent-compose"},
    ])
    modes = {item.name: item.runtime_mode for item in load_team("default", project)}
    assert modes["m1"] == "local-cli"
    assert modes["m2"] == "agent-compose"


def test_team_load_rejects_unknown_runtime_mode(project: ProjectStore) -> None:
    _write_team(project, [
        {"name": "m1", "type": "codex", "role": "reason", "runtime_mode": "teleport"},
    ])
    with pytest.raises(WorkerError):
        load_team("default", project)


def test_webapp_load_config_uses_shared_rules(project: ProjectStore) -> None:
    from src.sorne.webapp import WebAppError, _load_config, _normalize_team_config

    _write_team(project, [
        {"name": "m1", "backend": "claude-cli", "role": "reason",
         "runtime_mode": "host-native"},
    ])
    config = _load_config(project)
    member = config["members"][0]
    assert member["type"] == "claude-cli"
    assert "backend" not in member
    assert member["runtime_mode"] == "local-cli"

    normalized = _normalize_team_config({
        "members": [
            {"name": "m1", "backend": "ollama", "type": "codex", "role": "reason"},
        ]
    })
    assert normalized["members"][0]["type"] == "codex"

    with pytest.raises(WebAppError):
        _normalize_team_config({
            "members": [
                {"name": "m1", "type": "codex", "role": "reason",
                 "runtime_mode": "teleport"},
            ]
        })


def test_run_driver_rejects_unknown_runtime_mode() -> None:
    from src.sorne.drivers import DriverConfig

    with pytest.raises(DriverError):
        run_driver(
            DriverConfig(
                type="mock",
                extra={"runtime_mode": "teleport"},
            ),
            "prompt",
        )


def test_teammember_defaults_remain_compatible() -> None:
    member = TeamMember(name="m1", type="mock", role="reason")
    assert member.runtime_mode == "local-docker"
    assert member.backend == "codex"
