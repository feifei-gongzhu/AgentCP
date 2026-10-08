"""集成：提交链恢复窗口——fault_hook 注入崩溃后重启恢复，业务结果恰好落一次。

注入点（src/sorne/commits.py:231 after_database_commit；store.py:273 after_jsonl_append）：
- after_database_commit：数据库已持久接受、投影未执行；
- after_jsonl_append：业务行已写入 facts.jsonl、回执未写（回执窗口重放）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

import src.sorne.automation as automation_module
from src.sorne.automation import AutomationEngine
from src.sorne.database import ControlDatabase
from src.sorne.projector import Projector
from src.sorne.store import ProjectStore

FACT_PAYLOAD = {
    "kind": "fact",
    "title": "提交链恢复窗口事实",
    "category": "attack_surface",
    "assets": [],
    "evidence": "数据库已接受提交但投影前进程中断，重启后恢复投影的长证据描述。",
    "business_impact": "验证恢复路径只投影一次，不重复累计计数。",
    "reproduction_steps": ["注入故障", "重启恢复"],
    "evidence_path": "",
    "severity": "unknown",
    "confidence": 0.7,
}


def _install_crash(monkeypatch: pytest.MonkeyPatch, point: str, armed: list[bool], fired: list[str]) -> None:
    """给自动化提交路径挂 fault_hook：armed[0] 为 True 时在注入点抛错。"""
    real_apply = automation_module.apply_worker_output

    def crashing_apply(store, payload, **kwargs):
        def hook(p: str) -> None:
            if p == point and armed[0]:
                fired.append(p)
                raise RuntimeError(f"simulated crash at {p}")

        kwargs["fault_hook"] = hook
        return real_apply(store, payload, **kwargs)

    monkeypatch.setattr(automation_module, "apply_worker_output", crashing_apply)


def _db(store: ProjectStore):
    return ControlDatabase(store.path / "control_plane.db")


def _receipts(store: ProjectStore) -> list[tuple[str, str]]:
    with _db(store).connect() as db:
        return [
            (str(row["event_id"]), str(row["action_key"]))
            for row in db.execute(
                "SELECT event_id,action_key FROM projection_receipts"
            ).fetchall()
        ]


def _events(store: ProjectStore, source_type: str) -> list[dict]:
    with _db(store).connect() as db:
        return [
            dict(row)
            for row in db.execute(
                "SELECT * FROM commit_events WHERE source_type=?", (source_type,)
            ).fetchall()
        ]


def _fact_event_id(store: ProjectStore, job_id: str) -> str:
    with _db(store).connect() as db:
        row = db.execute(
            "SELECT event_id FROM commit_events WHERE source_type='automation_job' AND source_id=?",
            (job_id,),
        ).fetchone()
    assert row is not None, "崩溃点在数据库提交之后，事件应已持久化"
    return str(row["event_id"])


def _first_reason_job_id(store: ProjectStore, run_id: str) -> str:
    with _db(store).connect() as db:
        row = db.execute(
            "SELECT id FROM jobs WHERE run_id=? AND role='reason' ORDER BY created_at LIMIT 1",
            (run_id,),
        ).fetchone()
    assert row is not None
    return str(row["id"])


def test_crash_after_database_commit_recovers_exactly_once(
    project: ProjectStore,
    team_writer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    team_writer("crashy", [
        {"name": "reason", "type": "mock", "role": "reason",
         "extra": {"payload": FACT_PAYLOAD}},
    ])
    armed = [True]
    fired: list[str] = []
    _install_crash(monkeypatch, "after_database_commit", armed, fired)

    engine = AutomationEngine(project)
    run_id = engine.start("crashy", timeout=60, max_workers=1)
    engine.run(run_id)
    assert fired, "故障必须真实注入过"

    # 崩溃窗口内：durable commit 已入队，但业务结果尚未投影，Run 安全暂停
    job_id = _first_reason_job_id(project, run_id)
    event_id = _fact_event_id(project, job_id)
    assert project.read_jsonl("facts.jsonl") == [], "崩溃点之前不得写入业务结果"
    events = {row["event_id"]: row for row in _events(project, "automation_job")}
    assert events[event_id]["status"] != "committed"
    assert engine.status(run_id)["run"]["status"] == "paused"

    # “重启”：解除故障后执行投影恢复
    armed[0] = False
    Projector(project).recover()

    # 恢复后：崩溃事件的业务结果恰好落一次
    rows = [r for r in project.read_jsonl("facts.jsonl") if r.get("_projection", {}).get("event_id") == event_id]
    assert len(rows) == 1, "恢复投影必须恰好落一次"
    assert _receipts(project).count((event_id, "apply_worker_output:0")) == 1

    # 恢复后继续把 Run 跑完：同一事件不再重复落盘
    engine2 = AutomationEngine(project)
    engine2.run(run_id)
    status = engine2.status(run_id)
    assert status["run"]["status"] == "completed", status["run"]
    rows = [r for r in project.read_jsonl("facts.jsonl") if r.get("_projection", {}).get("event_id") == event_id]
    assert len(rows) == 1
    assert project.load_state().fact_count == len(project.read_jsonl("facts.jsonl"))
    events = {row["event_id"]: row for row in _events(project, "automation_job")}
    assert events[event_id]["status"] == "committed"


def test_crash_after_jsonl_append_replays_without_double_count(
    project: ProjectStore,
    team_writer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    team_writer("crashy", [
        {"name": "reason", "type": "mock", "role": "reason",
         "extra": {"payload": FACT_PAYLOAD}},
    ])
    # 只崩一次：业务行已 append、回执未写，随后的重放必须靠幂等标记去重。
    fired: list[str] = []

    def once_hook(p: str) -> None:
        if p == "after_jsonl_append" and not fired:
            fired.append(p)
            raise RuntimeError("simulated crash after business row append")

    real_apply = automation_module.apply_worker_output

    def crashing_apply(store, payload, **kwargs):
        kwargs["fault_hook"] = once_hook
        return real_apply(store, payload, **kwargs)

    monkeypatch.setattr(automation_module, "apply_worker_output", crashing_apply)

    engine = AutomationEngine(project)
    run_id = engine.start("crashy", timeout=60, max_workers=1)
    engine.run(run_id)
    assert fired, "故障必须真实注入过"

    job_id = _first_reason_job_id(project, run_id)
    event_id = _fact_event_id(project, job_id)
    status = engine.status(run_id)
    assert status["run"]["status"] == "completed", status["run"]

    # 动作被执行过两次（崩溃 + 重放），但业务结果只落一次
    rows = [r for r in project.read_jsonl("facts.jsonl") if r.get("_projection", {}).get("event_id") == event_id]
    assert len(rows) == 1, "回执窗口重放不得重复追加业务结果"
    assert _receipts(project).count((event_id, "apply_worker_output:0")) == 1
    assert project.load_state().fact_count == len(project.read_jsonl("facts.jsonl"))

    # 再次“重启”投影恢复：幂等，不产生新回执/新行
    Projector(project).recover()
    rows = [r for r in project.read_jsonl("facts.jsonl") if r.get("_projection", {}).get("event_id") == event_id]
    assert len(rows) == 1
    assert _receipts(project).count((event_id, "apply_worker_output:0")) == 1
