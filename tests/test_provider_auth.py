from __future__ import annotations

from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.agent_compose import AgentComposeError, _resolved_anthropic_auth_mode
from src.sorne.drivers import DriverError, _resolved_claude_auth
from src.sorne.local_docker import LocalDockerRuntime
from src.sorne.provider_auth import (
    anthropic_secret_env_var,
    normalize_base_url,
    resolve_anthropic_auth_mode,
)
from src.sorne.store import ProjectStore


@pytest.mark.parametrize(
    ("auth_mode", "base_url", "expected"),
    [
        ("bearer", "https://relay.example.com", "bearer"),
        ("bearer", None, "bearer"),
        ("x-api-key", "https://relay.example.com", "x-api-key"),
        ("auto", None, "x-api-key"),
        ("auto", "", "x-api-key"),
        ("auto", "https://api.anthropic.com", "x-api-key"),
        ("auto", "https://api.anthropic.com/v1/messages", "x-api-key"),
        ("auto", "API.ANTHROPIC.COM", "x-api-key"),
        ("auto", "https://relay.example.com", "bearer"),
        ("auto", "https://api.deepseek.com/anthropic", "bearer"),
        # 伪装域名与路径/查询中出现的官方域名不算官方地址。
        ("auto", "https://api.anthropic.com.example.org", "bearer"),
        ("auto", "https://evil.com/api.anthropic.com", "bearer"),
        ("auto", "https://evil.com/?relay=api.anthropic.com", "bearer"),
    ],
)
def test_resolve_anthropic_auth_mode(
    auth_mode: str, base_url: str | None, expected: str
) -> None:
    assert resolve_anthropic_auth_mode(auth_mode, base_url) == expected


@pytest.mark.parametrize("auth_mode", ["basic", ""])
def test_resolve_rejects_invalid_mode(auth_mode: object) -> None:
    with pytest.raises(ValueError):
        resolve_anthropic_auth_mode(auth_mode, "https://relay.example.com")


def test_resolve_treats_none_as_auto() -> None:
    assert resolve_anthropic_auth_mode(None, "https://relay.example.com") == "bearer"


def test_resolve_accepts_case_insensitive_explicit_mode() -> None:
    assert resolve_anthropic_auth_mode(" Bearer ", "https://relay.example.com") == "bearer"
    assert resolve_anthropic_auth_mode("X-API-KEY", "https://relay.example.com") == "x-api-key"


def test_resolve_rejects_invalid_url() -> None:
    with pytest.raises(ValueError):
        resolve_anthropic_auth_mode("auto", "https://[::bad")


def test_secret_env_var_mapping() -> None:
    assert anthropic_secret_env_var("bearer") == "ANTHROPIC_AUTH_TOKEN"
    assert anthropic_secret_env_var("x-api-key") == "ANTHROPIC_API_KEY"
    with pytest.raises(ValueError):
        anthropic_secret_env_var("auto")


def test_normalize_base_url() -> None:
    assert normalize_base_url(" https://relay.example.com/ ") == "https://relay.example.com"
    assert normalize_base_url(None) == ""


def test_agent_compose_wrapper_keeps_error_type() -> None:
    assert (
        _resolved_anthropic_auth_mode("auto", "https://api.anthropic.com")
        == "x-api-key"
    )
    with pytest.raises(AgentComposeError):
        _resolved_anthropic_auth_mode("basic", "https://relay.example.com")


def test_drivers_wrapper_keeps_error_type() -> None:
    assert _resolved_claude_auth("auto", None) == "x-api-key"
    with pytest.raises(DriverError):
        _resolved_claude_auth("basic", "https://relay.example.com")


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    return store


def _local_docker_runtime(project: ProjectStore, base_url: str | None, auth_mode: str):
    from src.sorne.drivers import DriverConfig

    config = DriverConfig(
        type="claude-cli",
        auth_mode=auth_mode,
        base_url=base_url,
        extra={"project_path": str(project.path.resolve()), "member_name": "m1"},
    )
    return LocalDockerRuntime(
        config,
        timeout=60,
        cancel_check=lambda: False,
        progress_callback=lambda _event: None,
    )


@pytest.mark.parametrize(
    ("base_url", "auth_mode", "expected_var"),
    [
        (None, "auto", "ANTHROPIC_API_KEY"),
        ("https://api.anthropic.com", "auto", "ANTHROPIC_API_KEY"),
        ("https://api.deepseek.com/anthropic", "auto", "ANTHROPIC_AUTH_TOKEN"),
        ("https://api.anthropic.com.example.org", "auto", "ANTHROPIC_AUTH_TOKEN"),
        ("https://relay.example.com", "x-api-key", "ANTHROPIC_API_KEY"),
        ("https://api.anthropic.com", "bearer", "ANTHROPIC_AUTH_TOKEN"),
    ],
)
def test_all_runtimes_agree_on_auth_resolution(
    project: ProjectStore,
    base_url: str | None,
    auth_mode: str,
    expected_var: str,
) -> None:
    # 三种运行模式的解析入口对同一配置必须得到同一结果。
    resolved = resolve_anthropic_auth_mode(auth_mode, base_url)
    assert anthropic_secret_env_var(resolved) == expected_var
    assert anthropic_secret_env_var(_resolved_claude_auth(auth_mode, base_url)) == expected_var
    assert (
        anthropic_secret_env_var(_resolved_anthropic_auth_mode(auth_mode, base_url))
        == expected_var
    )
    runtime = _local_docker_runtime(project, base_url, auth_mode)
    values = runtime._provider_environment()
    assert expected_var in values
    other = (
        "ANTHROPIC_AUTH_TOKEN"
        if expected_var == "ANTHROPIC_API_KEY"
        else "ANTHROPIC_API_KEY"
    )
    assert other not in values
    if base_url:
        assert values["ANTHROPIC_BASE_URL"] == normalize_base_url(base_url)
