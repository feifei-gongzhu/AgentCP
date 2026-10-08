"""P2 依赖图定向测试：depends_on 校验（缺失字段/缺失父任务/跨项目/环/能力/
越界）、依赖门控认领、级联取消、覆盖账本（方案 §4.2-4.4；验收 §13.1-7）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne.database import ControlDatabase
from src.sorne.plan_graph import (
    PlanGraphError,
    cascade_cancel_on_no_hit,
    dependency_blockers,
    direction_has_hit,
    submit_plan_graph,
)
from src.sorne.coverage_ledger import (
    coverage_summary,
    record_direction_coverage,
)


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("pg-fixture")
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized",
        "scope": ["fixture.invalid"],
        "out_of_scope": ["denied.example"],
        "targets": ["https://fixture.invalid"],
    }))
    return store


@pytest.fixture()
def database(project: ProjectStore) -> ControlDatabase:
    return ControlDatabase(project.path / "control_plane.db")


def _task(key: str, depends: list[str], **overrides) -> dict:
    task = {
        "task_key": key,
        "goal": f"目标 {key}",
        "verb": "verify",
        "targets": ["https://fixture.invalid/"],
        "success_criteria": "有验证结果或有依据的排除",
        "depends_on": depends,
    }
    task.update(overrides)
    return task


def test_missing_depends_on_field_rejects_plan(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    raw = _task("x", [])
    del raw["depends_on"]
    with pytest.raises(PlanGraphError, match="depends_on"):
        submit_plan_graph(project, database, {"tasks": [raw]}, proposed_by="planner-1")
    assert database.list_directions() == []


def test_missing_parent_and_cross_project_reference_rejected(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    with pytest.raises(PlanGraphError, match="无法解析"):
        submit_plan_graph(
            project, database,
            {"tasks": [_task("y", ["I-FROM-ANOTHER-PROJECT"])]},
            proposed_by="planner-1",
        )


def test_cycle_rejected(project: ProjectStore, database: ControlDatabase) -> None:
    with pytest.raises(PlanGraphError, match="循环依赖"):
        submit_plan_graph(
            project, database,
            {"tasks": [_task("a", ["b"]), _task("b", ["a"])]},
            proposed_by="planner-1",
        )


def test_capability_mismatch_rejected(project: ProjectStore, database: ControlDatabase) -> None:
    # recon 白名单不含 poc_scan（组件利用禁止）
    with pytest.raises(PlanGraphError, match="能力不满足"):
        submit_plan_graph(
            project, database,
            {"tasks": [_task("c", [], assigned_role="recon", tool_id="poc_scan")]},
            proposed_by="planner-1",
        )


def test_unknown_role_rejected(project: ProjectStore, database: ControlDatabase) -> None:
    with pytest.raises(PlanGraphError, match="不是已注册角色"):
        submit_plan_graph(
            project, database,
            {"tasks": [_task("d", [], assigned_role="commander")]},
            proposed_by="planner-1",
        )


def test_out_of_scope_target_rejected(project: ProjectStore, database: ControlDatabase) -> None:
    with pytest.raises(PlanGraphError, match="授权范围"):
        submit_plan_graph(
            project, database,
            {"tasks": [_task("e", [], targets=["https://outside.example/"])]},
            proposed_by="planner-1",
        )


def test_plan_registers_directions_with_capsule_fields(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    record = submit_plan_graph(
        project, database,
        {"tasks": [
            _task("recon-base", [], verb="collect"),
            _task(
                "poc-shiro", ["recon-base"],
                assigned_role="poc", tool_id="poc_scan",
                tool_arguments={"targets": ["https://fixture.invalid/"]},
                skill_ids=["shiro-verification"],
            ),
        ]},
        proposed_by="planner-1",
    )
    assert len(record["tasks"]) == 2
    by_key = {item["task_key"]: item for item in record["tasks"]}
    parent = database.get_direction(by_key["recon-base"]["direction_id"])
    child = database.get_direction(by_key["poc-shiro"]["direction_id"])
    assert child["assigned_role"] == "poc"
    assert child["depends_on"] == [parent["id"]]
    assert child["tool_ref"]["tool_id"] == "poc_scan"
    # 技能在任务注册时固定版本/内容哈希（§5.3）
    assert child["intent"]["skill_snapshot"]["shiro-verification"]["content_sha256"]


def test_dependency_gates_claiming(project: ProjectStore, database: ControlDatabase) -> None:
    record = submit_plan_graph(
        project, database,
        {"tasks": [_task("parent", []), _task("child", ["parent"])]},
        proposed_by="planner-1",
    )
    parent_id = next(t["direction_id"] for t in record["tasks"] if t["task_key"] == "parent")
    child_id = next(t["direction_id"] for t in record["tasks"] if t["task_key"] == "child")
    # 父未完成：只能认领父
    claimed = database.claim_direction("w1")
    assert claimed["id"] == parent_id
    assert database.claim_direction("w2") is None
    assert database.finish_direction(parent_id, "w1", outcome="completed", reason="ok")
    # 父完成后子可认领
    claimed_child = database.claim_direction("w2")
    assert claimed_child["id"] == child_id


def test_waiting_dependency_explanation(project: ProjectStore, database: ControlDatabase) -> None:
    record = submit_plan_graph(
        project, database,
        {"tasks": [_task("p1", []), _task("c1", ["p1"])]},
        proposed_by="planner-1",
    )
    child_id = next(t["direction_id"] for t in record["tasks"] if t["task_key"] == "c1")
    blockers = dependency_blockers(database, child_id)
    assert blockers and blockers[0]["status"] in {"open", "missing"}


def test_cascade_cancel_only_requires_hit_children(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    record = submit_plan_graph(
        project, database,
        {"tasks": [_task("parent", [])]},
        proposed_by="planner-1",
    )
    parent_id = record["tasks"][0]["direction_id"]
    follow = submit_plan_graph(
        project, database,
        {"tasks": [
            _task("needs-hit", [parent_id], requires_parent_hit=True),
            _task("ordering-only", [parent_id]),
        ]},
        proposed_by="planner-1",
    )
    # 父无命中 → 只取消 needs-hit
    cancelled = cascade_cancel_on_no_hit(project, database, parent_id)
    needs_hit = next(t["direction_id"] for t in follow["tasks"] if t["task_key"] == "needs-hit")
    ordering = next(t["direction_id"] for t in follow["tasks"] if t["task_key"] == "ordering-only")
    assert needs_hit in cancelled
    assert ordering not in cancelled
    # 父有命中 → 不取消任何子任务
    project.append_jsonl("facts.jsonl", {
        "id": "F-1", "intent_id": parent_id, "classification": "risk_lead",
    })
    assert direction_has_hit(project, parent_id)
    assert cascade_cancel_on_no_hit(project, database, parent_id) == []


def test_coverage_ledger_records_outcomes(project: ProjectStore, database: ControlDatabase) -> None:
    record = submit_plan_graph(
        project, database,
        {"tasks": [_task("t1", [], skill_ids=["shiro-verification"])]},
        proposed_by="planner-1",
    )
    direction = database.get_direction(record["tasks"][0]["direction_id"])
    direction["status"] = "completed"
    entry = record_direction_coverage(project, direction, has_hit=False)
    assert entry["outcome"] == "covered_no_hit"
    assert entry["skill_ids"] == ["shiro-verification"]
    # 幂等：同方向不重复记录
    again = record_direction_coverage(project, direction, has_hit=True)
    assert again["id"] == entry["id"]
    summary = coverage_summary(project)
    assert summary["entry_count"] == 1
    assert summary["dimensions"]["shiro-verification"]["no_hit"] == 1
