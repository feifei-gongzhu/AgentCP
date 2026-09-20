import json
import sys
import time
import subprocess
from pathlib import Path

import pytest

from src.agent_control_plane.drivers import ClaudeCliDriver, ContainerWorkerDriver, CodexCliDriver, DriverConfig, DriverError


def test_cli_process_can_be_cancelled() -> None:
    started = time.monotonic()
    driver = CodexCliDriver(
        DriverConfig(),
        timeout=5,
        cancel_check=lambda: time.monotonic() - started > 0.2,
    )
    with pytest.raises(DriverError, match="取消"):
        driver._run_cancellable([sys.executable, "-c", "import time; time.sleep(5)"])


def test_claude_process_can_be_cancelled_through_shared_runner() -> None:
    driver = ClaudeCliDriver(
        DriverConfig(type="claude-cli"),
        timeout=5,
        cancel_check=lambda: True,
    )
    with pytest.raises(DriverError, match="取消"):
        CodexCliDriver._run_cancellable(
            driver,
            [sys.executable, "-c", "import time; time.sleep(5)"],
        )


def test_shared_runner_drains_large_output_without_deadlock() -> None:
    driver = CodexCliDriver(DriverConfig(), timeout=5)
    result = driver._run_cancellable(
        [
            sys.executable,
            "-c",
            "import sys; sys.stdin.read(); sys.stdout.write('x' * 200000)",
        ],
        input_text="prompt",
    )

    assert result.returncode == 0
    assert len(result.stdout) == 200000


def test_shared_runner_preserves_real_error_when_stdin_closes_early() -> None:
    driver = CodexCliDriver(DriverConfig(), timeout=5)
    result = driver._run_cancellable(
        [sys.executable, "-c", "import sys; sys.stderr.write('startup rejected'); raise SystemExit(2)"],
        input_text="x" * 500000,
    )

    assert result.returncode == 2
    assert "startup rejected" in result.stderr


def test_container_command_is_restricted_by_default() -> None:
    driver = ContainerWorkerDriver(
        DriverConfig(
            type="container",
            extra={"image": "worker:test", "worker_command": ["worker", "--json"]},
        )
    )
    command = driver._docker_command()
    assert Path(command[0]).name == "docker"
    assert command[1:3] == ["run", "--rm"]
    assert command[command.index("--network") + 1] == "none"
    assert "no-new-privileges:true" in command
    assert "ALL" in command
    assert any(item.endswith(":/workspace:ro") for item in command)


def test_claude_driver_applies_frontend_relay_and_permissions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_run(self, cmd, input_text=None, env_override=None, cwd_override=None, line_callback=None):
        captured["cmd"] = cmd
        captured["env"] = env_override
        captured["cwd"] = cwd_override
        if line_callback:
            line_callback(json.dumps({"type": "result", "subtype": "success", "result": '{"kind":"none","reason":"ok"}'}) + "\n")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setenv("CLAUDE_RELAY_KEY", "test-secret")
    monkeypatch.setattr(CodexCliDriver, "_run_cancellable", fake_run)
    driver = ClaudeCliDriver(DriverConfig(
        type="claude-cli",
        model="deepseek-v4-pro",
        base_url="https://relay.example/anthropic/",
        api_key_env="CLAUDE_RELAY_KEY",
        auth_mode="bearer",
        sandbox="workspace-write",
    ))

    assert driver.run("prompt") == {"kind": "none", "reason": "ok"}
    assert captured["env"]["ANTHROPIC_BASE_URL"] == "https://relay.example/anthropic"
    assert captured["env"]["ANTHROPIC_AUTH_TOKEN"] == "test-secret"
    assert "ANTHROPIC_API_KEY" not in captured["env"]
    assert captured["cmd"][-2:] == ["--permission-mode", "auto"]
    assert "--no-session-persistence" in captured["cmd"]
    assert captured["cwd"] is not None


def test_claude_read_only_maps_to_plan_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(self, cmd, input_text=None, env_override=None, cwd_override=None, line_callback=None):
        captured["cmd"] = cmd
        if line_callback:
            line_callback(json.dumps({"type": "result", "subtype": "success", "result": '{"kind":"none","reason":"ok"}'}) + "\n")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(CodexCliDriver, "_run_cancellable", fake_run)
    driver = ClaudeCliDriver(DriverConfig(type="claude-cli", model="model", sandbox="read-only"))
    driver.run("prompt")

    permission_index = captured["cmd"].index("--permission-mode")
    assert captured["cmd"][permission_index:permission_index + 2] == ["--permission-mode", "plan"]
    assert "--tools" in captured["cmd"]
    sources_index = captured["cmd"].index("--setting-sources")
    assert "user" not in captured["cmd"][sources_index + 1].split(",")
    assert "local" not in captured["cmd"][sources_index + 1].split(",")


def test_claude_rejects_literal_key_in_api_key_env() -> None:
    driver = ClaudeCliDriver(DriverConfig(
        type="claude-cli",
        model="model",
        base_url="https://relay.example",
        api_key_env="not-a-variable-name",
    ))
    with pytest.raises(DriverError, match="环境变量名"):
        driver.run("prompt")
