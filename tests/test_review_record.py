"""P2 review 两模式定向测试（方案 §3.2/§3.4；验收 §13.1-10）。

action_review 与 finding_review 不混淆；票据只绑定
(task_id, tool_id, params_digest, control_version)，旧票据不能授权新参数；
finding_review 不改变 Guardian 判定；submit_review 只归 reviewer。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne.database import ControlDatabase
from src.sorne.tool_gateway import GatewayIdentity, ToolGateway


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("review-fixture")
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized",
        "scope": ["fixture.invalid"],
        "out_of_scope": [],
        "targets": ["https://fixture.invalid"],
    }))
    return store


@pytest.fixture()
def database(project: ProjectStore) -> ControlDatabase:
    database = ControlDatabase(project.path / "control_plane.db")
    database.register_direction({
        "id": "I-TASK", "verb": "verify", "target": "https://fixture.invalid/",
        "hypothesis": "h", "success_criteria": "s",
        "assigned_role": "poc", "tool_id": "poc_scan",
        "requires_human_confirmation": True,
    })
    return database


@pytest.fixture()
def run(database: ControlDatabase, project: ProjectStore) -> tuple[str, int]:
    run_id = database.create_run(project.vendor, "default", 60, 4)
    control_version = int(database.get_run(run_id)["control_version"])
    return run_id, control_version


def _reviewer(project, run) -> ToolGateway:
    run_id, control_version = run
    return ToolGateway(project, GatewayIdentity(
        vendor=project.vendor, member_name="reviewer-1", role="reviewer",
        run_id=run_id, control_version=control_version,
    ))


def _poc(project, run) -> ToolGateway:
    run_id, control_version = run
    return ToolGateway(project, GatewayIdentity(
        vendor=project.vendor, member_name="poc-1", role="poc",
        run_id=run_id, task_id="I-TASK", control_version=control_version,
    ))


def test_action_review_ticket_binding_rules(project, database, run) -> None:
    reviewer = _reviewer(project, run)
    output, is_error = reviewer.dispatch("submit_review", {
        "mode": "action_review",
        "payload": {
            "task_id": "I-TASK", "tool_id": "poc_scan",
            "params_digest": "digest-A", "decision": "approve",
            "rationale": "参数与申请一致，风险受控",
        },
    })
    assert not is_error, output
    _, control_version = run
    # 票据只绑定原参数摘要与控制版本
    assert database.find_action_ticket(
        task_id="I-TASK", tool_id="poc_scan",
        params_digest="digest-A", control_version=control_version,
    )
    # 参数改变 → 旧票据不得授权新参数（§13.1-10）
    assert database.find_action_ticket(
        task_id="I-TASK", tool_id="poc_scan",
        params_digest="digest-B", control_version=control_version,
    ) is None
    # 控制版本变化 → 票据失效
    assert database.find_action_ticket(
        task_id="I-TASK", tool_id="poc_scan",
        params_digest="digest-A", control_version=control_version + 1,
    ) is None
    # deny 不生成可用票据
    reviewer.dispatch("submit_review", {
        "mode": "action_review",
        "payload": {
            "task_id": "I-TASK", "tool_id": "http_request",
            "params_digest": "digest-C", "decision": "deny", "rationale": "越权风险",
        },
    })
    assert database.find_action_ticket(
        task_id="I-TASK", tool_id="http_request",
        params_digest="digest-C", control_version=control_version,
    ) is None


def test_action_review_invalid_decision_rejected(project, run) -> None:
    reviewer = _reviewer(project, run)
    output, is_error = reviewer.dispatch("submit_review", {
        "mode": "action_review",
        "payload": {
            "task_id": "I-TASK", "tool_id": "poc_scan",
            "params_digest": "d", "decision": "confirmed", "rationale": "x",
        },
    })
    assert is_error and "decision" in output


def test_finding_review_validates_candidates_and_keeps_guardian(
    project, database, run,
) -> None:
    reviewer = _reviewer(project, run)
    # 未知事实在工具边界被拒绝
    output, is_error = reviewer.dispatch("submit_review", {
        "mode": "finding_review",
        "payload": {
            "candidate_ids": ["F-MISSING"], "evidence_sufficiency": "insufficient",
            "recommendation": "request_evidence",
        },
    })
    assert is_error and "不存在" in output
    # 合法 finding_review
    project.append_jsonl("facts.jsonl", {
        "id": "F-1", "title": "t", "classification": "risk_lead", "status": "phenomenon",
    })
    output, is_error = reviewer.dispatch("submit_review", {
        "mode": "finding_review",
        "payload": {
            "candidate_ids": ["F-1"], "evidence_sufficiency": "partial",
            "recommendation": "suspect_false_positive",
            "missing_items": ["缺少对照请求"],
        },
    })
    assert not is_error, output
    # suspect_false_positive 只是建议：原始事实未被删除/改写
    facts = project.read_jsonl("facts.jsonl")
    assert len(facts) == 1 and facts[0]["id"] == "F-1"
    assert facts[0].get("classification") == "risk_lead"
    # 回流标记可查（Guardian 只降不升的机制不受影响）
    flags = project.read_jsonl("review_flags.jsonl")
    assert flags and flags[0]["fact_ids"] == ["F-1"]
    records = database.list_review_records(mode="finding_review")
    assert records and records[0]["recommendation"] == "suspect_false_positive"


def test_only_reviewer_can_submit_review(project, run) -> None:
    run_id, control_version = run
    operator = ToolGateway(project, GatewayIdentity(
        vendor=project.vendor, member_name="operator-1", role="operator",
        run_id=run_id, control_version=control_version,
    ))
    output, is_error = operator.dispatch("submit_review", {
        "mode": "action_review", "payload": {},
    })
    assert is_error
    # 网关角色白名单拒绝（submit_review 不在 operator 能力集）
    assert "permission_denied" in output


def test_modes_not_confused_in_records(project, database, run) -> None:
    reviewer = _reviewer(project, run)
    reviewer.dispatch("submit_review", {
        "mode": "action_review",
        "payload": {
            "task_id": "I-TASK", "tool_id": "poc_scan", "params_digest": "d1",
            "decision": "escalate", "rationale": "需要人工判断",
        },
    })
    project.append_jsonl("facts.jsonl", {"id": "F-2", "title": "t", "classification": "risk_lead"})
    reviewer.dispatch("submit_review", {
        "mode": "finding_review",
        "payload": {
            "candidate_ids": ["F-2"], "evidence_sufficiency": "sufficient",
            "recommendation": "accept_candidate",
        },
    })
    action = database.list_review_records(mode="action_review")
    finding = database.list_review_records(mode="finding_review")
    # 两模式记录分开，字段不串（action 有 decision 无 recommendation 字段语义）
    assert action and action[0]["decision"] == "escalate"
    assert finding and finding[0]["recommendation"] == "accept_candidate"
    assert all(row["mode"] == "action_review" for row in action)
    assert all(row["mode"] == "finding_review" for row in finding)


def test_pending_approval_visible_and_gates_poc_scan(
    project, database, run, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """requires_human_confirmation 方向：poc_scan 无票据被拒 + 待审批清单可见。"""
    from src.sorne.tool_registry import register_engine_availability

    register_engine_availability("poc_scan", lambda: (True, ""))
    poc = _poc(project, run)
    output, is_error = poc.dispatch("poc_scan", {"targets": ["https://fixture.invalid"]})
    assert is_error and "approval_required" in output
    # 待审批登记（reviewer 输入来源）
    reviewer = _reviewer(project, run)
    execution = json.loads(reviewer.dispatch("query_execution", {})[0])
    pending = execution["pending_approvals"]
    assert pending and pending[0]["task_id"] == "I-TASK"
    assert pending[0]["tool_id"] == "poc_scan"
    assert pending[0]["params_digest"]
    # 非本任务参数的票据不能放行（params_digest 不匹配）
    reviewer.dispatch("submit_review", {
        "mode": "action_review",
        "payload": {
            "task_id": "I-TASK", "tool_id": "poc_scan",
            "params_digest": "not-the-right-digest", "decision": "approve",
            "rationale": "错误的票据",
        },
    })
    output2, is_error2 = poc.dispatch("poc_scan", {"targets": ["https://fixture.invalid"]})
    assert is_error2 and "approval_required" in output2
