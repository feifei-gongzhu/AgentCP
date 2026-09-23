from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.schemas import normalize_role
from src.sorne.store import ProjectStore
from src.sorne.team import load_team
from src.sorne.worker import WorkerError, build_worker_prompt, run_worker


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    return store


def test_normalize_role_alias_and_unknown() -> None:
    assert normalize_role("pentester") == "executor"
    assert normalize_role("executor") == "executor"
    assert normalize_role(" reason ") == "reason"
    with pytest.raises(ValueError):
        normalize_role("chief_hacker")


def _write_team(store: ProjectStore, members: list[dict]) -> None:
    (store.path / "team_config.json").write_text(
        json.dumps({"members": members}, ensure_ascii=False), encoding="utf-8"
    )


def test_legacy_pentester_team_config_loads_as_executor(
    project: ProjectStore,
) -> None:
    _write_team(project, [{"name": "p1", "type": "mock", "role": "pentester"}])
    members = load_team("default", project)
    assert [item.role for item in members] == ["executor"]
    # 读取不重写文件：磁盘上仍是旧角色，保存流程才写回规范角色。
    saved = json.loads((project.path / "team_config.json").read_text(encoding="utf-8"))
    assert saved["members"][0]["role"] == "pentester"


def test_webapp_save_normalizes_legacy_role(project: ProjectStore) -> None:
    from src.sorne.webapp import WebAppError, _normalize_team_config

    normalized = _normalize_team_config({
        "members": [
            {"name": "p1", "type": "codex", "role": "pentester"},
            {"name": "r1", "type": "codex", "role": "reason"},
        ]
    })
    roles = [item["role"] for item in normalized["members"]]
    assert roles == ["executor", "reason"]
    assert "pentester" not in json.dumps(normalized, ensure_ascii=False)

    with pytest.raises(WebAppError):
        _normalize_team_config({
            "members": [{"name": "x", "type": "codex", "role": "chief_hacker"}]
        })


def test_webapp_load_config_normalizes_role(project: ProjectStore) -> None:
    from src.sorne.webapp import _load_config

    _write_team(project, [{"name": "p1", "type": "codex", "role": "pentester"}])
    config = _load_config(project)
    assert config["members"][0]["role"] == "executor"


def test_both_role_names_share_prompt(project: ProjectStore) -> None:
    assert (
        build_worker_prompt(project, "pentester")
        == build_worker_prompt(project, "executor")
    )
    assert "两种调用上下文" in build_worker_prompt(project, "executor")


def test_cli_parser_defaults_and_task_args() -> None:
    from src.sorne.cli import build_parser

    parser = build_parser()
    worker_args = parser.parse_args(["run-worker", "vendor", "--dry-run"])
    assert worker_args.role == "executor"
    assert worker_args.task is None
    aliased = parser.parse_args(["run-worker", "vendor", "--role", "pentester", "--dry-run"])
    assert normalize_role(aliased.role) == "executor"
    team_args = parser.parse_args(["run-team", "vendor", "--dry-run"])
    assert team_args.task is None


def test_run_worker_executor_requires_task_for_real_run(
    project: ProjectStore,
) -> None:
    with pytest.raises(WorkerError, match="--task"):
        run_worker(project, role="executor", backend="mock", dry_run=False)


def test_run_worker_executor_task_flows_into_prompt(project: ProjectStore) -> None:
    prompt = run_worker(
        project,
        role="executor",
        backend="mock",
        dry_run=True,
        task="验证 https://example.com 登录接口的未授权访问",
    )
    assert "验证 https://example.com 登录接口的未授权访问" in prompt
    # 上下文 B 约束注入单次执行 prompt。
    assert "不声称自己已认领" in prompt


def test_run_worker_other_roles_do_not_require_task(project: ProjectStore) -> None:
    prompt = run_worker(project, role="reason", backend="mock", dry_run=True)
    assert "分析黑板" in prompt or "审计方向" in prompt or "# Sorne" in prompt


def test_run_team_executor_requires_explicit_task(project: ProjectStore) -> None:
    from src.sorne.team import run_team

    _write_team(project, [{"name": "p1", "type": "mock", "role": "pentester"}])
    with pytest.raises(WorkerError, match="--task"):
        run_team(project, "default", dry_run=True)


def test_run_team_executor_runs_with_task(project: ProjectStore) -> None:
    from src.sorne.team import run_team

    _write_team(project, [
        {"name": "p1", "type": "mock", "role": "pentester",
         "extra": {"payload": {"kind": "none", "reason": "done"}}},
    ])
    output = run_team(
        project, "default", dry_run=True,
        task="检查 example.com 的备份文件暴露",
    )
    assert "p1" in output


def test_automation_member_normalization_helper(project: ProjectStore) -> None:
    from src.sorne.automation import _model_activity
    from src.sorne.team import TeamMember

    member = TeamMember(name="p1", type="mock", role="pentester")
    member.role = normalize_role(member.role)
    activity = _model_activity(member, None)
    assert activity["kind"] == "role"
