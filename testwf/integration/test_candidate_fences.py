"""集成：候选收敛栅栏。

- 执行期新增 owner 指令 → 旧上下文结果被丢弃（human_directive_fence）；
- control_version 失效 → 收敛门与投影层双重拒绝旧候选。
"""

from __future__ import annotations

from pathlib import Path

import pytest

import src.sorne.automation as automation_module
from src.sorne.automation import AutomationEngine
from src.sorne.commits import CommitCoordinator, CommitPlanner
from src.sorne.database import ControlDatabase
from src.sorne.projector import Projector
from src.sorne.schemas import Hint
from src.sorne.store import ProjectStore

STALE_FACT = {
    "kind": "fact",
    "title": "旧上下文事实",
    "category": "attack_surface",
    "assets": [],
    "evidence": "旧上下文下完成的分析，未观测到项目所有者的最新指令。",
    "business_impact": "验证栅栏丢弃旧上下文候选。",
    "reproduction_steps": ["旧上下文分析"],
    "evidence_path": "",
    "severity": "unknown",
    "confidence": 0.7,
}


def test_owner_directive_added_during_execution_discards_stale_fact(
    project: ProjectStore,
    team_writer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Worker 结果未观测执行期新增的 owner 指令 → 业务写入被栅栏丢弃。"""
    team_writer("fenced", [
        {"name": "reason-old", "type": "mock", "role": "reason",
         "extra": {"payload": STALE_FACT}},
    ])

    def stale_run_member(store, member, timeout, dry_run, context_suffix="", cancel_check=None, progress_callback=None):
        return {
            "member": member.name,
            "role": member.role,
            "status": "ok",
            "payload": STALE_FACT,
            # Worker 在指令发布前拿到的上下文：未观测到任何指令。
            "control_context": {"human_directive_ids": []},
        }

    monkeypatch.setattr(automation_module, "_run_member", stale_run_member)

    engine = AutomationEngine(project)
    run_id = engine.start("fenced", timeout=60, max_workers=1)
    # Run 启动后（执行期）项目所有者下达新指令
    project.append_jsonl("hints.jsonl", Hint(
        content="停止旧规划，按我的新方向执行",
        priority=10,
        intervention_type="redirect",
        applies_to_run_id=run_id,
    ))

    engine.run(run_id)
    status = engine.status(run_id)

    # 旧上下文结果被丢弃：不写事实
    assert project.read_jsonl("facts.jsonl") == []
    assert project.load_state().fact_count == 0
    assert any(
        event["event_type"] == "human_directive_fence_rejected"
        for event in status["events"]
    )
    # 被丢弃的 Job 以“已收敛”收尾（committed 带拒绝原因），Run 正常完成
    reason_jobs = [j for j in status["jobs"] if j["role"] == "reason"]
    assert reason_jobs and all(j["committed_at"] for j in reason_jobs)
    assert status["run"]["status"] == "completed"


def _stale_job_setup(project: ProjectStore, engine: AutomationEngine) -> tuple[str, dict]:
    run_id = engine.db.create_run(project.vendor, "default", 60, 1)
    job_id = engine.db.enqueue_job(
        run_id, "swarm", "reason", "reason",
        {"member": {"name": "reason", "type": "mock", "role": "reason"}},
    )
    claimed = engine.db.claim_job(run_id, "swarm", "worker-1")
    assert claimed and claimed["id"] == job_id
    engine.db.complete_job(job_id, "worker-1", {
        "member": "reason",
        "role": "reason",
        "status": "ok",
        "payload": STALE_FACT,
    })
    return job_id, engine.db.get_run(run_id)


def _bump_control_version(project: ProjectStore, run_id: str) -> None:
    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        db.execute(
            "UPDATE automation_runs SET control_version=control_version+1 WHERE id=?",
            (run_id,),
        )


def test_stale_control_version_candidate_rejected_at_convergence_gate(
    project: ProjectStore,
) -> None:
    """control_version 失效的候选在收敛门被拒绝，不写业务结果。"""
    engine = AutomationEngine(project)
    job_id, run = _stale_job_setup(project, engine)
    assert int(engine.db.get_run(run["id"])["control_version"]) == int(
        engine.db.list_jobs(run["id"])[0]["control_version"]
    )
    # 模拟控制器推进 Run 控制版本（旧 Job 由此失效）
    _bump_control_version(project, run["id"])

    summaries = engine._commit_candidates(run["id"])
    assert summaries == []  # 收敛门静默拒绝，只落 stale_candidate_rejected 事件
    events = engine.db.events(run["id"])
    job = next(j for j in engine.db.list_jobs(run["id"]) if j["id"] == job_id)

    assert any(e["event_type"] == "stale_candidate_rejected" for e in events)
    assert not job["committed_at"], "被栅栏拒绝的候选不得标记为已提交"
    assert project.read_jsonl("facts.jsonl") == []
    assert project.load_state().fact_count == 0


def test_stale_control_version_candidate_discarded_at_projection_layer(
    project: ProjectStore,
) -> None:
    """已入队的旧候选事件在投影层按控制版本拒绝并丢弃。"""
    engine = AutomationEngine(project)
    job_id, run = _stale_job_setup(project, engine)
    control_version = int(run["control_version"])
    plan = CommitPlanner().freeze_worker_output(
        STALE_FACT,
        source_type="automation_job",
        source_id=str(job_id),
        idempotency_key=f"job:{job_id}:fact",
        run_id=str(run["id"]),
        job_id=str(job_id),
        control_version=control_version,
    )

    def boom(point: str) -> None:
        if point == "after_database_commit":
            raise RuntimeError("simulated crash after durable accept")

    with pytest.raises(RuntimeError):
        CommitCoordinator(project, engine.db, fault_hook=boom).submit(plan)

    # 事件已 durable 入队（Job commit_state=enqueued）
    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        state = db.execute(
            "SELECT commit_state FROM jobs WHERE id=?", (job_id,)
        ).fetchone()
        assert str(state["commit_state"]) == "enqueued"

    # 入队后 Run 控制版本被推进：投影恢复必须拒绝该旧候选
    _bump_control_version(project, run["id"])
    Projector(project).recover()

    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        event = dict(db.execute(
            "SELECT status,last_error FROM commit_events WHERE event_id=?",
            (plan.event.event_id,),
        ).fetchone())
        job_state = str(db.execute(
            "SELECT commit_state FROM jobs WHERE id=?", (job_id,)
        ).fetchone()["commit_state"])
    assert event["status"] == "discarded"
    assert "控制版本" in str(event["last_error"])
    assert job_state == "rejected"
    assert project.read_jsonl("facts.jsonl") == []
    assert project.load_state().fact_count == 0
