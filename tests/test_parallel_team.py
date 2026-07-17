import json
from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane import team as team_module
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.runtime_secrets import RuntimeSecretStore


def test_parallel_batch_commits_then_waits_for_approval(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir()
    config = {
        "members": [
            {"name": "reason", "type": "mock", "role": "reason", "extra": {"payload": {"kind": "none", "reason": "reason done"}}},
            {"name": "metacog", "type": "mock", "role": "metacog", "extra": {"payload": {"kind": "none", "reason": "metacog done"}}},
            {"name": "reviewer", "type": "mock", "role": "reviewer", "extra": {"payload": {"kind": "none", "reason": "reviewer done"}}},
        ]
    }
    (team_module.TEAMS_DIR / "parallel.json").write_text(json.dumps(config), encoding="utf-8")
    store = ProjectStore("vendor")
    store.init()

    output = team_module.run_team(store, "parallel", max_workers=3)

    assert "reason done" in output
    assert "metacog done" in output
    assert "reviewer done" in output
    assert store.load_state().gate_status == "awaiting_approval"
    assert len(store.read_jsonl("team_runs.jsonl")) == 1


def test_project_team_config_overrides_default_team(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir()
    (team_module.TEAMS_DIR / "default.json").write_text(
        json.dumps({"members": [{"name": "global", "type": "codex", "role": "reason"}]}),
        encoding="utf-8",
    )
    store = ProjectStore("production-security")
    store.init()
    (store.path / "team_config.json").write_text(
        json.dumps({"members": [{"name": "project-executor", "type": "codex", "role": "executor"}]}),
        encoding="utf-8",
    )

    members = team_module.load_team("default", store)
    assert [item.name for item in members] == ["project-executor"]


def test_runtime_secret_from_frontend_reaches_driver_without_persistence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("client-security")
    store.init()
    captured = {}

    def fake_driver(config, prompt, timeout=300, cancel_check=None, progress_callback=None):
        captured["config"] = config
        captured["prompt"] = prompt
        return {"kind": "none", "reason": "ok"}

    monkeypatch.setattr(team_module, "run_driver", fake_driver)
    RuntimeSecretStore.clear(store.vendor)
    RuntimeSecretStore.set_many(store.vendor, {"reason-claude": "session-only-secret"}, {"reason-claude"})
    try:
        member = team_module.TeamMember(
            name="reason-claude",
            type="claude-cli",
            role="reason",
            custom_prompt="只输出能够被 Executor 直接执行的方向，禁止重复枚举。",
            model="model-id",
            base_url="https://relay.example/anthropic",
            api_key_env="CLAUDE_RELAY_KEY",
            auth_mode="bearer",
            sandbox="read-only",
        )
        team_module._run_member(store, member, timeout=30, dry_run=False)
    finally:
        RuntimeSecretStore.clear(store.vendor)

    config = captured["config"]
    assert config.api_key_env == "AGENTCP_RUNTIME_API_KEY"
    assert config.env["AGENTCP_RUNTIME_API_KEY"] == "session-only-secret"
    assert config.extra["runtime_mode"] == "local-docker"
    assert "项目所有者为当前 Agent 配置的专属提示词" in captured["prompt"]
    assert "只输出能够被 Executor 直接执行的方向，禁止重复枚举。" in captured["prompt"]
    assert "/workspace/evidence/" in captured["prompt"]
    assert "session-only-secret" not in (store.path / "target.json").read_text(encoding="utf-8")
