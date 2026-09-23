from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.database import ControlDatabase
from src.sorne.projector import Projector
from src.sorne.scheduler import Scheduler
from src.sorne.schemas import GateStatus
from src.sorne.store import ProjectStore
from src.sorne.worker import WorkerError, apply_worker_output, submit_payload


def _fact_args(vendor: str) -> argparse.Namespace:
    return argparse.Namespace(
        vendor=vendor,
        title="管理端命令注入",
        category="command_execution",
        evidence="运行 PoC 后观察到回显，服务端日志返回可复核的命令执行标记。",
        business_impact="攻击者可控制服务端进程并读取高价值业务数据。",
        reproduction_step=["发送受控请求", "核对服务端日志标记"],
        evidence_path="",
    )


def _facts_rows(store: ProjectStore) -> list[dict]:
    return store.read_jsonl("facts.jsonl")


def _database(store: ProjectStore) -> ControlDatabase:
    return ControlDatabase(store.path / "control_plane.db")


def _receipts(store: ProjectStore) -> list[tuple[str, str]]:
    with _database(store).connect() as db:
        return [
            (str(row["event_id"]), str(row["action_key"]))
            for row in db.execute("SELECT event_id,action_key FROM projection_receipts").fetchall()
        ]


def _events(store: ProjectStore, source_type: str) -> list[dict]:
    with _database(store).connect() as db:
        return [
            dict(row)
            for row in db.execute(
                "SELECT * FROM commit_events WHERE source_type=?", (source_type,)
            ).fetchall()
        ]


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    return store


def test_cli_add_fact_creates_commit_plan_and_receipt(project: ProjectStore) -> None:
    from src.sorne.cli import cmd_add_fact

    cmd_add_fact(_fact_args("vendor"))

    rows = _facts_rows(project)
    assert len(rows) == 1
    assert rows[0]["title"] == "管理端命令注入"
    assert rows[0]["_projection"]["event_id"].startswith("EV-")
    assert rows[0]["proposed_by"] == "project_owner"

    events = _events(project, "manual_cli_fact")
    assert len(events) == 1
    assert events[0]["status"] == "committed"

    receipts = _receipts(project)
    assert (events[0]["event_id"], "apply_worker_output:0") in receipts

    board = (project.path / "项目黑板_知识库.md").read_text(encoding="utf-8")
    assert "管理端命令注入" in board
    assert project.load_state().fact_count == 1


def test_manual_fact_without_valid_evidence_stays_phenomenon(
    project: ProjectStore,
) -> None:
    from src.sorne.cli import cmd_add_fact

    args = _fact_args("vendor")
    args.evidence = "可能存在命令注入。"
    args.business_impact = "有影响。"
    cmd_add_fact(args)

    rows = _facts_rows(project)
    assert rows[0]["status"] != "vulnerability"
    assert rows[0]["quality_notes"]
    assert project.load_state().vulnerability_count == 0


def test_manual_fact_allowed_while_gate_awaits(project: ProjectStore) -> None:
    from src.sorne.cli import cmd_add_fact

    Scheduler(project).complete_subtask("完成子任务")
    assert project.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value

    cmd_add_fact(_fact_args("vendor"))

    assert len(_facts_rows(project)) == 1
    state = project.load_state()
    assert state.gate_status == GateStatus.AWAITING_APPROVAL.value


def test_worker_submission_still_blocked_while_gate_awaits(
    project: ProjectStore,
) -> None:
    Scheduler(project).complete_subtask("完成子任务")
    with pytest.raises(WorkerError):
        apply_worker_output(project, {"kind": "none", "reason": "done"})


def test_crash_after_database_commit_recovers_and_projects_once(
    project: ProjectStore,
) -> None:
    def boom(point: str) -> None:
        if point == "after_database_commit":
            raise RuntimeError("simulated crash after durable accept")

    with pytest.raises(RuntimeError):
        submit_payload(
            project,
            {
                "kind": "fact",
                "title": "中断恢复",
                "category": "other",
                "evidence": "数据库已接受提交但投影前进程中断的长证据描述。",
                "business_impact": "验证恢复路径只投影一次。",
                "reproduction_steps": ["注入故障", "恢复投影"],
                "evidence_path": "",
            },
            source_type="manual_cli_fact",
            gate_required=False,
            fault_hook=boom,
        )

    events = _events(project, "manual_cli_fact")
    assert len(events) == 1

    Projector(project).recover()

    rows = _facts_rows(project)
    assert len(rows) == 1
    assert project.load_state().fact_count == 1
    receipts = _receipts(project)
    assert (events[0]["event_id"], "apply_worker_output:0") in receipts


def test_receipt_window_replay_does_not_double_count(project: ProjectStore) -> None:
    def boom(point: str) -> None:
        if point == "before_projection_receipt":
            raise RuntimeError("simulated crash before receipt")

    with pytest.raises(RuntimeError):
        submit_payload(
            project,
            {
                "kind": "fact",
                "title": "回执窗口中断",
                "category": "other",
                "evidence": "投影动作已执行但回执尚未写入时进程中断的证据描述。",
                "business_impact": "验证重放不重复累计计数。",
                "reproduction_steps": ["注入故障", "重放投影"],
                "evidence_path": "",
            },
            source_type="manual_cli_fact",
            gate_required=False,
            fault_hook=boom,
        )

    Projector(project).recover()

    rows = _facts_rows(project)
    assert len(rows) == 1
    assert project.load_state().fact_count == 1


def test_two_cli_add_fact_calls_are_two_operations(project: ProjectStore) -> None:
    from src.sorne.cli import cmd_add_fact

    cmd_add_fact(_fact_args("vendor"))
    cmd_add_fact(_fact_args("vendor"))

    assert len(_facts_rows(project)) == 2
    assert len(_events(project, "manual_cli_fact")) == 2
    assert project.load_state().fact_count == 2


def test_cli_assess_projects_scheduler_decision(project: ProjectStore) -> None:
    from src.sorne.cli import cmd_assess

    cmd_assess(argparse.Namespace(vendor="vendor"))

    with _database(project).connect() as db:
        events = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM commit_events WHERE event_type='scheduler_decision'"
            ).fetchall()
        ]
    assert len(events) == 1
    assert events[0]["status"] == "committed"

    decisions = project.read_jsonl("decision_log.jsonl")
    assert len(decisions) == 1
    assert decisions[0]["_projection"]["event_id"] == events[0]["event_id"]
    assert project.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value

    cmd_assess(argparse.Namespace(vendor="vendor"))
    assert len(project.read_jsonl("decision_log.jsonl")) == 2


def test_scheduler_exposes_public_commit_decision(project: ProjectStore) -> None:
    assert callable(getattr(Scheduler(project), "commit_decision"))
