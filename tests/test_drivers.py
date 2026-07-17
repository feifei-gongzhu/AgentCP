import json
import subprocess

import pytest

from src.agent_control_plane.drivers import (
    ClaudeCliDriver,
    CodexCliDriver,
    DriverConfig,
    DriverError,
    run_driver,
)
from src.agent_control_plane.store import ROOT


def emit_claude_result(line_callback, result: str = '{"kind":"none","reason":"ok"}') -> None:
    if line_callback:
        line_callback(json.dumps({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": result,
            "duration_ms": 12,
            "num_turns": 1,
        }) + "\n")


def test_driver_boundary_rejects_protocol_metadata() -> None:
    with pytest.raises(DriverError, match="合法 kind"):
        run_driver(
            DriverConfig(
                type="mock",
                extra={"payload": {"provider": "claude", "success": True}},
            ),
            "prompt",
        )


def test_claude_frontend_provider_is_isolated_and_prompt_uses_stdin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    prompt = "private audit prompt --settings user,local"
    frontend_secret = "frontend-session-secret"

    # These values model stale shell/CCSwitch routing. The test deliberately
    # sets process environment only; it never reads or writes Claude settings.
    inherited_provider_values = {
        "ANTHROPIC_BASE_URL": "https://inherited.invalid",
        "ANTHROPIC_API_KEY": "inherited-api-key",
        "ANTHROPIC_AUTH_TOKEN": "inherited-auth-token",
        "ANTHROPIC_MODEL": "inherited-model",
        "ANTHROPIC_SMALL_FAST_MODEL": "inherited-fast-model",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "inherited-haiku",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "inherited-sonnet",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "inherited-opus",
        "CLAUDE_CODE_SUBAGENT_MODEL": "inherited-subagent",
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "CLAUDE_CODE_USE_VERTEX": "1",
        "CLAUDE_CODE_USE_FOUNDRY": "1",
        "FRONTEND_RELAY_SECRET": "inherited-wrong-secret",
    }
    for name, value in inherited_provider_values.items():
        monkeypatch.setenv(name, value)

    def fake_run(
        self,
        cmd,
        input_text=None,
        env_override=None,
        cwd_override=None,
        line_callback=None,
    ):
        captured["cmd"] = cmd
        captured["input"] = input_text
        captured["env"] = env_override
        captured["cwd"] = cwd_override
        emit_claude_result(line_callback)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(CodexCliDriver, "_run_cancellable", fake_run)
    driver = ClaudeCliDriver(DriverConfig(
        type="claude-cli",
        model="frontend-model",
        base_url="https://frontend.example/anthropic/",
        api_key_env="FRONTEND_RELAY_SECRET",
        auth_mode="bearer",
        sandbox="read-only",
        env={"FRONTEND_RELAY_SECRET": frontend_secret},
    ))

    assert driver.run(prompt) == {"kind": "none", "reason": "ok"}

    cmd = captured["cmd"]
    env = captured["env"]
    assert isinstance(cmd, list)
    assert isinstance(env, dict)
    assert captured["input"] == prompt
    assert prompt not in cmd
    assert frontend_secret not in cmd
    assert captured["cwd"] == ROOT

    assert "--no-session-persistence" in cmd
    assert "--strict-mcp-config" in cmd
    assert cmd[cmd.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in cmd
    assert cmd[cmd.index("--settings") + 1] == "{}"
    setting_sources = cmd[cmd.index("--setting-sources") + 1].split(",")
    assert "user" not in setting_sources
    assert "local" not in setting_sources

    assert env["ANTHROPIC_BASE_URL"] == "https://frontend.example/anthropic"
    assert env["ANTHROPIC_AUTH_TOKEN"] == frontend_secret
    # Keep one canonical credential variable in the child environment; the
    # frontend/runtime store's custom source name must not duplicate the key.
    assert "FRONTEND_RELAY_SECRET" not in env
    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_MODEL" not in env
    assert "ANTHROPIC_SMALL_FAST_MODEL" not in env
    assert "ANTHROPIC_DEFAULT_HAIKU_MODEL" not in env
    assert "ANTHROPIC_DEFAULT_SONNET_MODEL" not in env
    assert "ANTHROPIC_DEFAULT_OPUS_MODEL" not in env
    assert "CLAUDE_CODE_SUBAGENT_MODEL" not in env
    assert "CLAUDE_CODE_USE_BEDROCK" not in env
    assert "CLAUDE_CODE_USE_VERTEX" not in env
    assert "CLAUDE_CODE_USE_FOUNDRY" not in env


def test_claude_x_api_key_clears_inherited_bearer_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    frontend_secret = "frontend-x-api-key"
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "inherited-token")

    def fake_run(
        self,
        cmd,
        input_text=None,
        env_override=None,
        cwd_override=None,
        line_callback=None,
    ):
        captured["cmd"] = cmd
        captured["input"] = input_text
        captured["env"] = env_override
        emit_claude_result(line_callback)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(CodexCliDriver, "_run_cancellable", fake_run)
    driver = ClaudeCliDriver(DriverConfig(
        type="claude-cli",
        model="frontend-model",
        base_url="https://frontend.example/anthropic",
        api_key_env="FRONTEND_API_KEY",
        auth_mode="x-api-key",
        sandbox="workspace-write",
        env={"FRONTEND_API_KEY": frontend_secret},
    ))

    driver.run("audit prompt")

    cmd = captured["cmd"]
    env = captured["env"]
    assert isinstance(cmd, list)
    assert isinstance(env, dict)
    assert env["ANTHROPIC_API_KEY"] == frontend_secret
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    assert frontend_secret not in cmd
    assert captured["input"] == "audit prompt"


def test_claude_failure_does_not_expose_frontend_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend_secret = "secret-that-must-not-reach-errors"

    def fake_run(
        self,
        cmd,
        input_text=None,
        env_override=None,
        cwd_override=None,
        line_callback=None,
    ):
        # A defensive regression case: even a child process that echoes its
        # environment must not make the configured secret user-visible.
        return subprocess.CompletedProcess(
            cmd,
            1,
            f"stdout accidentally echoed {frontend_secret}",
            f"stderr accidentally echoed {frontend_secret}",
        )

    monkeypatch.setattr(CodexCliDriver, "_run_cancellable", fake_run)
    driver = ClaudeCliDriver(DriverConfig(
        type="claude-cli",
        model="frontend-model",
        base_url="https://frontend.example/anthropic",
        api_key_env="FRONTEND_API_KEY",
        auth_mode="bearer",
        sandbox="read-only",
        env={"FRONTEND_API_KEY": frontend_secret},
    ))

    with pytest.raises(DriverError) as exc_info:
        driver.run("audit prompt")
    assert frontend_secret not in str(exc_info.value)


def test_claude_invalid_json_does_not_expose_frontend_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend_secret = "secret-in-invalid-model-output"

    def fake_run(self, cmd, input_text=None, env_override=None, cwd_override=None, line_callback=None):
        emit_claude_result(line_callback, f"not-json {frontend_secret}")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(CodexCliDriver, "_run_cancellable", fake_run)
    driver = ClaudeCliDriver(DriverConfig(
        type="claude-cli",
        base_url="https://frontend.example/anthropic",
        api_key_env="FRONTEND_API_KEY",
        auth_mode="bearer",
        sandbox="read-only",
        env={"FRONTEND_API_KEY": frontend_secret},
    ))

    with pytest.raises(DriverError) as exc_info:
        driver.run("audit prompt")
    assert frontend_secret not in str(exc_info.value)
    assert "[REDACTED]" in str(exc_info.value)


def test_claude_stream_api_error_is_concise(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(self, cmd, input_text=None, env_override=None, cwd_override=None, line_callback=None):
        messages = [
            {"type": "system", "subtype": "init", "session_id": "session-402", "tools": ["Read"]},
            {
                "type": "result",
                "subtype": "success",
                "is_error": True,
                "api_error_status": 402,
                "terminal_reason": "api_error",
                "result": "API Error: 402 Insufficient Balance",
            },
        ]
        for message in messages:
            if line_callback:
                line_callback(json.dumps(message) + "\n")
        return subprocess.CompletedProcess(cmd, 1, "very long stream-json initialization payload", "")

    monkeypatch.setattr(CodexCliDriver, "_run_cancellable", fake_run)
    driver = ClaudeCliDriver(DriverConfig(type="claude-cli", sandbox="read-only"))

    with pytest.raises(DriverError) as exc_info:
        driver.run("prompt")
    assert str(exc_info.value) == "Claude API 调用失败: HTTP 402 Insufficient Balance"
    assert "initialization payload" not in str(exc_info.value)


def test_claude_stream_emits_tool_progress_and_redacts_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend_secret = "stream-secret"
    progress: list[dict[str, object]] = []

    def fake_run(self, cmd, input_text=None, env_override=None, cwd_override=None, line_callback=None):
        messages = [
            {"type": "system", "subtype": "init", "session_id": "session-1", "tools": ["Bash", "Read"]},
            {
                "type": "assistant",
                "message": {"content": [{
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "Bash",
                    "input": {
                        "command": "curl https://example.test/health",
                        "api_key": frontend_secret,
                    },
                }]},
            },
            {
                "type": "user",
                "message": {"content": [{
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "is_error": False,
                    "content": f"HTTP 200 {frontend_secret}",
                }]},
            },
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "正在整理结果"}]}},
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "duration_ms": 1250,
                "num_turns": 2,
                "result": '{"kind":"none","reason":"done"}',
            },
        ]
        for message in messages:
            if line_callback:
                line_callback(json.dumps(message, ensure_ascii=False) + "\n")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(CodexCliDriver, "_run_cancellable", fake_run)
    driver = ClaudeCliDriver(
        DriverConfig(
            type="claude-cli",
            api_key_env="FRONTEND_KEY",
            auth_mode="bearer",
            env={"FRONTEND_KEY": frontend_secret},
        ),
        progress_callback=progress.append,
    )

    assert driver.run("prompt") == {"kind": "none", "reason": "done"}
    assert [event["event"] for event in progress] == [
        "stream_started",
        "tool_started",
        "tool_completed",
        "assistant_update",
        "stream_result",
    ]
    tool_started = progress[1]
    tool_completed = progress[2]
    assert tool_started["tool_name"] == "Bash"
    assert "curl https://example.test/health" in str(tool_started["input_summary"])
    assert frontend_secret not in json.dumps(progress, ensure_ascii=False)
    assert "[REDACTED]" in str(tool_started["input_summary"])
    assert tool_completed["tool_name"] == "Bash"
