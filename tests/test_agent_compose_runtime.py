import json
from pathlib import Path

import pytest

from src.agent_control_plane import drivers as drivers_module
from src.agent_control_plane import agent_compose as agent_compose_module
from src.agent_control_plane import local_docker as local_docker_module
from src.agent_control_plane.agent_compose import (
    AgentComposeProfile,
    AgentComposeRuntime,
    profile_from_driver_config,
    _redact_runtime_text,
    shutdown_project_runtimes,
    _resolved_anthropic_auth_mode,
    find_docker_binary,
    _terminate_process,
    _extract_worker_result,
    _agent_compose_log_fragment,
)
from src.agent_control_plane.drivers import DriverConfig
from src.agent_control_plane.local_docker import (
    LocalDockerError,
    LocalDockerRuntime,
    _extract_runtime_payload,
    _redact,
)


def test_local_docker_error_redaction_preserves_failure_tail() -> None:
    output = "begin secret\n" + ("wide search result\n" * 500) + "FINAL provider error"

    redacted = _redact(output, "secret")

    assert len(redacted) == 4000
    assert redacted.startswith("begin [REDACTED]")
    assert "FINAL provider error" in redacted
    assert "omitted" in redacted


def _fake_binary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    binary = tmp_path / "agent-compose"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(0o755)
    monkeypatch.setenv("AGENTCP_AGENT_COMPOSE_BIN", str(binary))
    return binary


def test_configured_docker_binary_works_without_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    docker = tmp_path / "docker"
    docker.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    docker.chmod(0o755)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("AGENTCP_DOCKER_BIN", str(docker))

    assert find_docker_binary() == str(docker.resolve())


def test_finished_log_follower_cleanup_does_not_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FinishedProcess:
        pid = 12345

        @staticmethod
        def poll():
            return 0

    monkeypatch.setattr(
        agent_compose_module.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(AssertionError("不应清理已退出进程")),
    )

    _terminate_process(FinishedProcess())


def test_log_follower_permission_error_does_not_fail_model_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class RunningProcess:
        pid = 12345

        @staticmethod
        def poll():
            return None

    monkeypatch.setattr(
        agent_compose_module.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(PermissionError(1, "Operation not permitted")),
    )

    _terminate_process(RunningProcess())


def test_agent_compose_metadata_final_text_becomes_worker_result() -> None:
    detail = {
        "status": "succeeded",
        "result_json": json.dumps({
            "agent": "claude",
            "success": True,
            "finalText": '{"kind":"none","reason":"done"}',
        }),
        "output": "transcript",
    }

    assert _extract_worker_result(detail) == {"kind": "none", "reason": "done"}


def test_agent_compose_api_error_is_not_reported_as_success() -> None:
    detail = {
        "status": "succeeded",
        "result_json": json.dumps({
            "agent": "claude",
            "success": True,
            "finalText": "API Error: 402 Insufficient Balance",
        }),
    }

    with pytest.raises(
        agent_compose_module.AgentComposeError,
        match="HTTP 402 Insufficient Balance",
    ):
        _extract_worker_result(detail)


def test_agent_compose_runtime_metadata_is_rejected_as_worker_output() -> None:
    detail = {
        "status": "succeeded",
        "result_json": '{"agent":"claude","success":true,"exitCode":0}',
    }

    with pytest.raises(agent_compose_module.AgentComposeError, match="合法 kind"):
        _extract_worker_result(detail)


def test_local_docker_runtime_extracts_structured_worker_result() -> None:
    stdout = '__AGENT_RESULT__{"provider":"claude","finalText":"{\\"kind\\":\\"none\\",\\"reason\\":\\"done\\"}"}\n'

    assert _extract_runtime_payload(stdout) == {"kind": "none", "reason": "done"}


def test_local_docker_runtime_rejects_protocol_metadata() -> None:
    stdout = '__AGENT_RESULT__{"provider":"claude","finalText":"{\\"provider\\":\\"claude\\"}"}\n'

    with pytest.raises(LocalDockerError, match="合法 kind"):
        _extract_runtime_payload(stdout)


def test_local_docker_runtime_accepts_fenced_worker_json_without_strict_schema() -> None:
    stdout = '__AGENT_RESULT__{"provider":"codex","finalText":"Result:\\n```json\\n{\\"kind\\":\\"none\\",\\"reason\\":\\"done\\"}\\n```"}\n'

    assert _extract_runtime_payload(stdout) == {"kind": "none", "reason": "done"}


def test_local_docker_codex_omits_incompatible_shared_output_schema(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    input_root = tmp_path / "input"
    input_root.mkdir()
    (input_root / "worker_output_schema.json").write_text("{}", encoding="utf-8")
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    monkeypatch.setattr(
        "src.agent_control_plane.local_docker.find_docker_binary",
        lambda: "/usr/bin/docker",
    )
    runtime = LocalDockerRuntime(
        DriverConfig(
            type="codex",
            model="configured-model",
            base_url="https://relay.example/v1",
            api_key_env="TEST_KEY",
            env={"TEST_KEY": "secret"},
            extra={"project_path": str(project), "member_name": "worker"},
        ),
        timeout=30,
        cancel_check=lambda: False,
        progress_callback=lambda _event: None,
    )

    command, _environment = runtime._command(input_root, runtime_root)

    assert "--output-schema-file" not in command
    assert command[-2:] == ["--model", "configured-model"]


def test_local_docker_preflights_shared_guest_image(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    observed: dict[str, object] = {}
    monkeypatch.setattr(
        local_docker_module,
        "ensure_local_guest_image",
        lambda image, **kwargs: observed.update({"image": image, **kwargs}),
    )
    runtime = LocalDockerRuntime(
        DriverConfig(
            type="claude-cli",
            api_key_env="TEST_KEY",
            env={"TEST_KEY": "secret"},
            extra={"project_path": str(project), "member_name": "worker"},
        ),
        timeout=30,
        cancel_check=lambda: False,
        progress_callback=lambda _event: None,
    )
    monkeypatch.setattr(runtime, "_command", lambda *_args: (["docker"], {}))
    monkeypatch.setattr(runtime, "_execute", lambda *_args: {"kind": "none", "reason": "ok"})

    assert runtime.run("prompt") == {"kind": "none", "reason": "ok"}
    assert observed["image"] == "agent-compose-guest:latest"
    assert observed["runtime"] == "local-docker"


@pytest.mark.parametrize(
    ("sandbox", "expected_mode"),
    [("read-only", "plan"), ("workspace-write", "auto")],
)
def test_local_docker_claude_keeps_stdin_open_and_uses_root_safe_permissions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sandbox: str,
    expected_mode: str,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    input_root = tmp_path / "input"
    input_root.mkdir()
    schema_source = (
        Path(__file__).resolve().parents[1]
        / "src" / "agent_control_plane" / "worker_output_schema.json"
    )
    (input_root / "worker_output_schema.json").write_bytes(schema_source.read_bytes())
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    monkeypatch.setattr(
        "src.agent_control_plane.local_docker.find_docker_binary",
        lambda: "/usr/bin/docker",
    )
    runtime = LocalDockerRuntime(
        DriverConfig(
            type="claude-cli",
            model="model",
            base_url="https://relay.example/anthropic",
            api_key_env="TEST_KEY",
            auth_mode="bearer",
            sandbox=sandbox,
            env={"TEST_KEY": "secret"},
            extra={"project_path": str(project), "member_name": "worker"},
        ),
        timeout=30,
        cancel_check=lambda: False,
        progress_callback=lambda _event: None,
    )

    command, _environment = runtime._command(input_root, runtime_root)

    assert command[1:6] == ["run", "--rm", "--init", "-i", "--network"]
    assert command[command.index("--permission-mode") + 1] == expected_mode
    assert "--dangerously-skip-permissions" not in command
    assert "bypassPermissions" not in command


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
        "target": "/agentcp-project",
        "read_only": False,
    }
    assert agent["image"] == "agent-compose-guest:latest"


def test_local_cli_mode_bypasses_agent_compose(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed = {}

    class FakeClaudeDriver:
        def __init__(self, config, timeout, cancel_check, progress_callback):
            observed["config"] = config

        def run(self, prompt):
            observed["prompt"] = prompt
            return {"kind": "none", "reason": "host native"}

    class ForbiddenComposeRuntime:
        def __init__(self, *args, **kwargs):
            raise AssertionError("local-cli 不应创建 agent-compose runtime")

    monkeypatch.setitem(drivers_module.DRIVERS, "claude-cli", FakeClaudeDriver)
    monkeypatch.setattr(drivers_module, "AgentComposeRuntime", ForbiddenComposeRuntime)
    result = drivers_module.run_driver(
        DriverConfig(
            type="claude-cli",
            extra={"runtime_mode": "local-cli"},
        ),
        "audit locally",
    )

    assert result == {"kind": "none", "reason": "host native"}
    assert observed["prompt"] == "audit locally"


def test_unknown_runtime_mode_is_rejected() -> None:
    with pytest.raises(drivers_module.DriverError, match="未知运行模式"):
        drivers_module.run_driver(
            DriverConfig(type="claude-cli", extra={"runtime_mode": "remote-magic"}),
            "audit",
        )


def test_local_cli_rejects_container_worker() -> None:
    with pytest.raises(drivers_module.DriverError, match="不能选择 Container Worker"):
        drivers_module.run_driver(
            DriverConfig(type="container", extra={"runtime_mode": "local-cli"}),
            "audit",
        )


def test_local_docker_mode_does_not_create_agent_compose_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed = {}

    class FakeLocalDockerRuntime:
        def __init__(self, config, timeout, cancel_check, progress_callback):
            observed["config"] = config

        def run(self, prompt):
            observed["prompt"] = prompt
            return {"kind": "none", "reason": "docker"}

    class ForbiddenComposeRuntime:
        def __init__(self, *args, **kwargs):
            raise AssertionError("local-docker 不应创建 agent-compose runtime")

    monkeypatch.setattr(drivers_module, "LocalDockerRuntime", FakeLocalDockerRuntime)
    monkeypatch.setattr(drivers_module, "AgentComposeRuntime", ForbiddenComposeRuntime)

    result = drivers_module.run_driver(
        DriverConfig(type="claude-cli", extra={"runtime_mode": "local-docker"}),
        "audit in docker",
    )

    assert result == {"kind": "none", "reason": "docker"}
    assert observed["prompt"] == "audit in docker"


def test_agent_compose_mode_is_explicit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    class FakeComposeRuntime:
        def __init__(self, *args, **kwargs):
            pass

        def run(self, prompt):
            return {"kind": "none", "reason": prompt}

    monkeypatch.setattr(drivers_module, "AgentComposeRuntime", FakeComposeRuntime)

    result = drivers_module.run_driver(
        DriverConfig(
            type="claude-cli",
            extra={"runtime_mode": "agent-compose", "project_path": str(project)},
        ),
        "compose only",
    )

    assert result == {"kind": "none", "reason": "compose only"}


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


def test_agent_compose_runtime_is_used_only_when_selected(
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
            extra={
                "runtime_mode": "agent-compose",
                "project_path": str(project),
                "member_name": "reason-main",
            },
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
    assert "--output-schema-file" in calls[0]
    schema_index = calls[0].index("--output-schema-file")
    assert Path(calls[0][schema_index + 1]).name == "worker_output_schema.json"
    assert calls[1][-3:] == ["inspect", "run", "run-1"]
    assert runtime._read_metadata()["sandbox_id"] == "sandbox-1"
    assert [item["status"] for item in events if item["event"] == "agent_compose_status"] == [
        "running", "succeeded",
    ]


def test_agent_compose_codex_omits_incompatible_shared_output_schema(
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
            provider="codex",
            model="configured-model",
            base_url="https://relay.example/v1",
            auth_mode="bearer",
            api_key="secret",
            sandbox="read-only",
        ),
        timeout=30,
        progress_callback=lambda _event: None,
    )
    runtime.runtime_dir.mkdir(parents=True)
    calls: list[list[str]] = []
    details = iter([
        {"id": "run-codex", "sandbox_id": "sandbox-codex", "status": "running"},
        {"id": "run-codex", "sandbox_id": "sandbox-codex", "status": "succeeded", "result_json": '{"kind":"none","reason":"done"}'},
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
    assert "--output-schema-file" not in calls[0]


def test_agent_compose_log_redaction_covers_frontend_secret_and_bearer() -> None:
    text = _redact_runtime_text(
        "Authorization: Bearer second-token api_key=first-token",
        "first-token",
    )
    assert "first-token" not in text
    assert "second-token" not in text
    assert text.count("[REDACTED]") == 2


def test_agent_compose_log_fragment_removes_prefix_and_preserves_token_space() -> None:
    assert _agent_compose_log_fragment(
        "reason-main-run-123 |  next token\n", None,
    ) == "  next token"


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
