"""统一单 Worker 执行服务（实施规格 7）：三入口共享真实执行流程。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import execution as execution_module
from src.sorne import store as store_module
from src.sorne.runtime_secrets import RuntimeSecretStore
from src.sorne.schemas import Hint
from src.sorne.store import ProjectStore
from src.sorne.worker import WorkerError, run_worker


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    target = store.read_json("target.json")
    target["targets"] = ["https://example.com"]
    store.write_json("target.json", target)
    return store


def _snapshots(store: ProjectStore) -> list[dict]:
    return store.read_jsonl("prompt_snapshots.jsonl")


def test_run_worker_writes_prompt_snapshot(project: ProjectStore) -> None:
    output = run_worker(
        project, role="reviewer", backend="mock", timeout=30, dry_run=False,
    )
    assert "none" in output or "无输出" in output
    snapshots = _snapshots(project)
    assert snapshots, "真实模型调用必须落脱敏 Prompt 快照（CLI 通道修复）"
    latest = snapshots[-1]
    assert latest["member"] == "reviewer"
    assert latest["runtime_mode"] == "local-docker"
    snapshot_file = project.path / latest["prompt_path"]
    assert snapshot_file.is_file()
    text = snapshot_file.read_text(encoding="utf-8")
    # 快照包含最终发送内容对应的运行目录说明（local-docker 约定注入后落盘）。
    assert "运行目录约定" in text
    assert "/workspace/evidence/" in text


def test_run_worker_keeps_local_docker_default_runtime(
    project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = {}

    def fake_driver(config, prompt, timeout=300, cancel_check=None, progress_callback=None):
        captured["config"] = config
        return {"kind": "none", "reason": "ok"}

    monkeypatch.setattr(execution_module, "run_driver", fake_driver)
    run_worker(project, role="reason", backend="mock", timeout=30, dry_run=False)
    # CLI 默认执行环境不变：显式 local-docker（与原 run_driver 兜底一致）。
    assert captured["config"].extra["runtime_mode"] == "local-docker"
    assert captured["config"].type == "mock"
    assert captured["config"].extra["member_name"] == "reason"


def test_run_worker_injects_runtime_secret_by_member_key(
    project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = {}

    def fake_driver(config, prompt, timeout=300, cancel_check=None, progress_callback=None):
        captured["config"] = config
        return {"kind": "none", "reason": "ok"}

    monkeypatch.setattr(execution_module, "run_driver", fake_driver)
    RuntimeSecretStore.set_many(
        project.vendor, {"reason": "session-secret"}, {"reason"},
    )
    try:
        run_worker(project, role="reason", backend="mock", timeout=30, dry_run=False)
    finally:
        RuntimeSecretStore.clear(project.vendor)
    config = captured["config"]
    assert config.api_key_env == "SORNE_RUNTIME_API_KEY"
    assert config.env["SORNE_RUNTIME_API_KEY"] == "session-secret"


def test_run_team_writes_prompt_snapshots_for_real_runs(
    project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.sorne.team import run_team

    (project.path / "team_config.json").write_text(json.dumps({
        "members": [{
            "name": "r1", "type": "mock", "role": "reason",
            "extra": {"payload": {"kind": "none", "reason": "done"}},
        }],
    }, ensure_ascii=False), encoding="utf-8")
    run_team(project, "default", timeout=30, dry_run=False)
    snapshots = _snapshots(project)
    assert snapshots and snapshots[-1]["member"] == "r1"


def test_stale_directive_context_is_rejected_after_execution(
    project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    project.append_jsonl("hints.jsonl", Hint(
        content="停止重复枚举，优先核对鉴权边界",
        intervention_type="redirect", priority=10,
    ))
    from src.sorne.team import TeamMember

    def stale_result(store, member, timeout, dry_run, context_suffix="", cancel_check=None, progress_callback=None):
        return {
            "member": member.name, "role": member.role, "status": "ok",
            "payload": {"kind": "none", "reason": "expired context"},
            "control_context": {"human_directive_ids": []},
        }

    monkeypatch.setattr(execution_module, "run_member", stale_result)
    with pytest.raises(WorkerError, match="项目所有者指令"):
        run_worker(project, role="reason", backend="mock", timeout=30, dry_run=False)


def test_matching_directive_context_passes(
    project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    hint = Hint(content="优先核对鉴权边界", intervention_type="redirect", priority=10)
    project.append_jsonl("hints.jsonl", hint)
    from src.sorne.team import TeamMember

    def fresh_result(store, member, timeout, dry_run, context_suffix="", cancel_check=None, progress_callback=None):
        return {
            "member": member.name, "role": member.role, "status": "ok",
            "payload": {"kind": "none", "reason": "fresh"},
            "control_context": {"human_directive_ids": [hint.id]},
        }

    monkeypatch.setattr(execution_module, "run_member", fresh_result)
    output = run_worker(project, role="reason", backend="mock", timeout=30, dry_run=False)
    assert "无输出" in output
