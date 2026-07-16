import json
from pathlib import Path

import pytest

from src.agent_control_plane import drivers as drivers_module
from src.agent_control_plane import agent_compose as agent_compose_module
from src.agent_control_plane.agent_compose import (
    AgentComposeProfile,
    AgentComposeRuntime,
    profile_from_driver_config,
    _redact_runtime_text,
    shutdown_project_runtimes,
    _resolved_anthropic_auth_mode,
)
from src.agent_control_plane.drivers import DriverConfig


def _fake_binary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    binary = tmp_path / "agent-compose"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(0o755)
    monkeypatch.setenv("AGENTCP_AGENT_COMPOSE_BIN", str(binary))
    return binary


def test_frontend_claude_config_becomes_daemon_profile(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    config = DriverConfig(
        type="claude-cli",
        model="deepseek-v4-pro",
        base_url="https://relay.example/anthropic",
        api_key_env="AGENTCP_RUNTIME_API_KEY",
        auth_mode="bearer",
        env={"AGENTCP_RUNTIME_API_KEY": "frontend-secret"},
        extra={"project_path": str(project), "member_name": "reason-main"},
    )

    profile = profile_from_driver_config(config)

    assert profile.provider == "claude"
    assert profile.api_key == "frontend-secret"
    assert profile.base_url == "https://relay.example/anthropic"


def test_compose_spec_mounts_workspace_but_never_persists_api_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_binary(tmp_path, monkeypatch)
    project = tmp_path / "project"
    project.mkdir()
    runtime = AgentComposeRuntime(
        AgentComposeProfile(
            project_path=project,
            member_name="executor-primary",
            provider="claude",
            model="model",
            base_url="https://relay.example",
            auth_mode="bearer",
            api_key="do-not-write-me",
            sandbox="workspace-write",
        ),
        timeout=30,
    )
    runtime.runtime_dir.mkdir(parents=True)

    runtime._write_compose_file()

    raw = runtime.compose_file.read_text(encoding="utf-8")
    document = json.loads(raw)
    assert "do-not-write-me" not in raw
    agent = document["agents"]["executor-primary"]
    assert agent["provider"] == "claude"
    assert agent["volumes"][0] == {
        "type": "bind",
        "source": str(project.resolve()),
        "target": "/workspace",
        "read_only": False,
    }


def test_changed_frontend_key_uses_a_new_daemon_provider_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_binary(tmp_path, monkeypatch)
    project = tmp_path / "project"
    project.mkdir()

    def make_runtime(secret: str) -> AgentComposeRuntime:
        return AgentComposeRuntime(
            AgentComposeProfile(
                project_path=project,
                member_name="reason-main",
                provider="claude",
                model="model",
                base_url="https://relay.example",
                auth_mode="bearer",
                api_key=secret,
                sandbox="read-only",
            ),
            timeout=30,
        )

    first = make_runtime("first-key")
    second = make_runtime("second-key")
    first_env = first._daemon_environment(17001, "/tmp/one.sock")
    second_env = second._daemon_environment(17002, "/tmp/two.sock")

    assert first_env["ANTHROPIC_AUTH_TOKEN"] == "first-key"
    assert second_env["ANTHROPIC_AUTH_TOKEN"] == "second-key"
    assert first_env["DATA_ROOT"] != second_env["DATA_ROOT"]


def test_auto_auth_uses_bearer_for_relay_and_api_key_for_anthropic() -> None:
    assert _resolved_anthropic_auth_mode("auto", "https://api.deepseek.com/anthropic") == "bearer"
    assert _resolved_anthropic_auth_mode("auto", "https://api.anthropic.com") == "x-api-key"
    assert _resolved_anthropic_auth_mode("x-api-key", "https://relay.example") == "x-api-key"


def test_non_mock_driver_is_forced_through_agent_compose(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    observed = {}

    class FakeRuntime:
        def __init__(self, profile, timeout, cancel_check, progress_callback):
            observed["profile"] = profile

        def run(self, prompt):
            observed["prompt"] = prompt
            return {"kind": "none", "reason": "via compose"}

    monkeypatch.setattr(drivers_module, "AgentComposeRuntime", FakeRuntime)
    result = drivers_module.run_driver(
        DriverConfig(
            type="claude-cli",
            api_key_env="KEY",
            env={"KEY": "secret"},
            extra={"project_path": str(project), "member_name": "reason-main"},
        ),
        "audit",
    )

    assert result == {"kind": "none", "reason": "via compose"}
    assert observed["profile"].provider == "claude"
    assert observed["prompt"] == "audit"


def test_detached_run_polls_status_and_exposes_native_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_binary(tmp_path, monkeypatch)
    project = tmp_path / "project"
    project.mkdir()
    events = []
    runtime = AgentComposeRuntime(
        AgentComposeProfile(
            project_path=project,
            member_name="reason-main",
            provider="claude",
            model="model",
            base_url="https://relay.example",
            auth_mode="bearer",
            api_key="secret",
            sandbox="read-only",
        ),
        timeout=30,
        progress_callback=events.append,
    )
    runtime.runtime_dir.mkdir(parents=True)
    calls = []
    details = iter([
        {"id": "run-1", "sandbox_id": "sandbox-1", "status": "running"},
        {"id": "run-1", "sandbox_id": "sandbox-1", "status": "running"},
        {"id": "run-1", "sandbox_id": "sandbox-1", "status": "succeeded", "result_json": '{"kind":"none","reason":"done"}'},
    ])

    def fake_execute(args, timeout):
        calls.append(args)
        return next(details)

    class FakeThread:
        def join(self, timeout=None):
            return None

    monkeypatch.setattr(runtime, "_execute_json", fake_execute)
    monkeypatch.setattr(runtime, "_follow_logs", lambda host, run_id: (object(), FakeThread()))
    monkeypatch.setattr(agent_compose_module, "_terminate_process", lambda process: None)
    monkeypatch.setattr(agent_compose_module.time, "sleep", lambda seconds: None)

    detail = runtime._run_detached("http://127.0.0.1:1234", "audit")

    assert detail["status"] == "succeeded"
    assert "--detach" in calls[0]
    assert "--keep-running" in calls[0]
    assert "--rm" not in calls[0]
    assert calls[1][-3:] == ["inspect", "run", "run-1"]
    assert runtime._read_metadata()["sandbox_id"] == "sandbox-1"
    assert [item["status"] for item in events if item["event"] == "agent_compose_status"] == [
        "running", "succeeded",
    ]


def test_agent_compose_log_redaction_covers_frontend_secret_and_bearer() -> None:
    text = _redact_runtime_text(
        "Authorization: Bearer second-token api_key=first-token",
        "first-token",
    )
    assert "first-token" not in text
    assert "second-token" not in text
    assert text.count("[REDACTED]") == 2


def test_stale_cached_sandbox_is_replaced_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_binary(tmp_path, monkeypatch)
    project = tmp_path / "project"
    project.mkdir()
    runtime = AgentComposeRuntime(
        AgentComposeProfile(
            project_path=project,
            member_name="reason-main",
            provider="claude",
            model="model",
            base_url=None,
            auth_mode="x-api-key",
            api_key="secret",
            sandbox="read-only",
        ),
        timeout=30,
    )
    runtime.runtime_dir.mkdir(parents=True)
    runtime.metadata_file.write_text('{"sandbox_id":"stale-sandbox"}\n', encoding="utf-8")
    calls = []

    def fake_execute(args, timeout):
        calls.append(list(args))
        if len(calls) == 1:
            raise agent_compose_module.AgentComposeError("sandbox not found")
        if len(calls) == 2:
            return {"id": "run-new", "sandbox_id": "sandbox-new", "status": "running"}
        return {"id": "run-new", "sandbox_id": "sandbox-new", "status": "succeeded", "result_json": '{"kind":"none"}'}

    class FakeThread:
        def join(self, timeout=None):
            return None

    monkeypatch.setattr(runtime, "_execute_json", fake_execute)
    monkeypatch.setattr(runtime, "_follow_logs", lambda host, run_id: (object(), FakeThread()))
    monkeypatch.setattr(agent_compose_module, "_terminate_process", lambda process: None)

    detail = runtime._run_detached("http://127.0.0.1:1234", "audit")

    assert detail["status"] == "succeeded"
    assert calls[0][-2:] == ["--sandbox", "stale-sandbox"]
    assert "--sandbox" not in calls[1]
    assert runtime._read_metadata()["sandbox_id"] == "sandbox-new"


def test_project_runtime_shutdown_only_terminates_owned_daemons(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    for role, pid in (("reason", 11), ("executor", 22)):
        runtime = project / ".agent-compose" / role
        runtime.mkdir(parents=True)
        (runtime / "daemon.json").write_text(
            json.dumps({"pid": pid, "host": f"http://127.0.0.1:{7000 + pid}"}),
            encoding="utf-8",
        )
        (runtime / "agent-compose.yml").write_text("{}", encoding="utf-8")
    binary = tmp_path / "agent-compose"
    binary.write_text("binary", encoding="utf-8")
    terminated = []
    down_calls = []
    monkeypatch.setattr(agent_compose_module, "_find_binary", lambda: binary)
    monkeypatch.setattr(agent_compose_module, "_pid_is_ours", lambda pid, candidate: pid == 11)
    monkeypatch.setattr(agent_compose_module, "_terminate_owned_daemon", lambda pid, candidate: terminated.append(pid))
    monkeypatch.setattr(agent_compose_module.subprocess, "run", lambda command, **kwargs: down_calls.append(command))

    stopped = shutdown_project_runtimes(project)

    assert stopped == 1
    assert terminated == [11]
    assert len(down_calls) == 1
    assert "http://127.0.0.1:7011" in down_calls[0]
