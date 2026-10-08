"""P2 端到端研究环定向测试：画像/技能路由 → 计划任务图 → 依赖门控执行 →
nuclei 证据落盘 → 独立研判附加记录 → review/Guardian 回流 → 覆盖与重规划
上下文（方案 §12-P2 交付；§13.2 研究环场景的本地夹具版）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne.database import ControlDatabase
from src.sorne.tool_gateway import GatewayIdentity, ToolGateway


SEVEN_ROLE_MEMBERS = [
    {"name": "planner-primary", "type": "mock", "role": "planner", "priority": 0},
    {"name": "orchestrator-main", "type": "mock", "role": "orchestrator", "priority": 0},
    {"name": "recon-scout", "type": "mock", "role": "recon", "priority": 1},
    {"name": "poc-verify", "type": "mock", "role": "poc", "priority": 1},
    {"name": "operator-primary", "type": "mock", "role": "operator", "priority": 2},
    {"name": "reviewer-quality", "type": "mock", "role": "reviewer", "priority": 3},
]


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    from src.sorne import team as team_module

    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    (team_module.TEAMS_DIR / "seven.json").write_text(
        json.dumps({"members": SEVEN_ROLE_MEMBERS}, ensure_ascii=False), encoding="utf-8",
    )
    store = ProjectStore("p2-e2e")
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized",
        "scope": ["fixture.invalid"],
        "out_of_scope": [],
        "targets": ["https://fixture.invalid"],
    }))
    return store


NUCLEI_HIT = json.dumps({
    "template-id": "apache-shiro-cve-2016-4437",
    "info": {"name": "Apache Shiro rememberMe", "severity": "critical"},
    "host": "https://fixture.invalid",
    "matched-at": "https://fixture.invalid/login",
    "matcher-status": True,
    "request": "GET /login HTTP/1.1\r\nHost: fixture.invalid",
    "response": "HTTP/1.1 200\r\nSet-Cookie: rememberMe=deleteMe",
})


class _FakeCompleted:
    returncode = 0
    stderr = ""
    stdout = NUCLEI_HIT + "\n"


ANALYZER_OUTPUT = {
    "kind": "analysis_record",
    "analyzer_kind": "poc",
    "observations": [{
        "text": "命中响应带 rememberMe=deleteMe 标记",
        "evidence_ref": "evidence/poc/x.jsonl", "kind": "observed",
    }],
    "candidate_assessments": [{
        "candidate_ref": "apache-shiro-cve-2016-4437@https://fixture.invalid/login",
        "assessment": "supported",
        "rationale": "命中语义与指纹一致",
        "evidence_refs": ["evidence/poc/x.jsonl"],
    }],
    "recommended_followups": [{
        "preconditions": ["版本证据"], "target_ref": "https://fixture.invalid",
        "expected_evidence": "版本对照",
    }],
    "uncertainties": ["exact version unknown"],
}


def _gateway(
    project: ProjectStore, role: str, run_id: str, control_version: int,
    task_id=None, claim_worker=None, claim_version=None,
) -> ToolGateway:
    return ToolGateway(project, GatewayIdentity(
        vendor=project.vendor, member_name=f"{role}-e2e", role=role,
        run_id=run_id, task_id=task_id, control_version=control_version,
        claim_worker=claim_worker, claim_version=claim_version,
    ))


def test_research_loop_end_to_end(
    project: ProjectStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.sorne.analysis_service import AnalysisService
    from src.sorne.context_compiler import compile_worker_context
    from src.sorne.coverage_ledger import coverage_summary
    from src.sorne.engine_adapters import nuclei_adapter
    from src.sorne.tool_registry import register_engine_availability

    database = ControlDatabase(project.path / "control_plane.db")
    run_id = database.create_run(project.vendor, "seven", 60, 4)
    control_version = int(database.get_run(run_id)["control_version"])
    # 引擎可用（测试注入）与 mock 分析模型
    register_engine_availability("poc_scan", lambda: (True, ""))
    real_run_scan = nuclei_adapter.run_scan
    monkeypatch.setattr(
        nuclei_adapter, "run_scan",
        lambda store, args, **kw: real_run_scan(
            store, args, **{**kw, "runner": lambda argv, **k: _FakeCompleted()},
        ),
    )
    (project.path / "analysis_config.json").write_text(
        json.dumps({"analyzers": {"poc": {"type": "mock", "model": "mock-analyzer"}}}),
        encoding="utf-8",
    )
    import src.sorne.analysis_service as service_module

    monkeypatch.setattr(
        service_module, "run_driver",
        lambda config, prompt, timeout=300, cancel_check=None, progress_callback=None: dict(ANALYZER_OUTPUT),
    )

    # ① 指纹特征 → 技能路由（shiro 短卡）
    planner = _gateway(project, "planner", run_id, control_version)
    routing, is_error = planner.dispatch("skill_query", {"features": ["rememberMe=deleteMe", "apache shiro"]})
    assert not is_error
    matches = json.loads(routing)["matches"]
    assert "shiro-verification" in [item["skill_id"] for item in matches]

    # ② planner 提交带依赖的任务图（recon 先行，poc 组件验证依赖命中）
    plan_output, plan_error = planner.dispatch("submit_plan", {"plan": {
        "kind": "plan_batch",
        "strategy_summary": "指纹→组件验证",
        "tasks": [
            {
                "task_key": "fingerprint-check", "verb": "collect",
                "goal": "核实 rememberMe 指纹", "assigned_role": "recon",
                "targets": ["https://fixture.invalid/"],
                "success_criteria": "指纹证据登记",
                "depends_on": [],
                "skill_ids": ["component-verification"],
            },
            {
                "task_key": "shiro-poc", "verb": "verify",
                "goal": "验证 Shiro 组件候选", "assigned_role": "poc",
                "tool_id": "poc_scan",
                "tool_arguments": {"targets": ["https://fixture.invalid"]},
                "targets": ["https://fixture.invalid/"],
                "success_criteria": "命中判定或排除",
                "depends_on": ["fingerprint-check"],
                "skill_ids": ["shiro-verification"],
            },
        ],
    }})
    assert not plan_error, plan_output
    plan = json.loads(plan_output)
    assert len(plan["tasks"]) == 2
    recon_direction = plan["tasks"][0]["direction_id"]
    poc_direction = plan["tasks"][1]["direction_id"]

    # ③ 依赖门控：recon 未完成前 poc 任务不可认领（自动化调度只给 recon 派活）
    from src.sorne.automation import AutomationEngine

    engine = AutomationEngine(project)
    engine._schedule_iteration(run_id)
    jobs = database.list_jobs(run_id, "swarm")
    bound = {
        job["role"]: (job["payload"].get("direction") or {}).get("id")
        for job in jobs if job["payload"].get("direction")
    }
    assert bound.get("recon") == recon_direction
    assert "poc" not in bound  # 依赖未满足，不认领

    # ④ recon 任务完成（生产路径：automation 在候选提交后调用
    #    _finish_bound_direction → finish_direction + _after_direction_finished）
    recon_state = database.get_direction(recon_direction)
    assert recon_state["status"] == "claimed" and recon_state["claimed_by"]
    database.finish_direction(
        recon_direction, recon_state["claimed_by"],
        outcome="completed", reason="指纹已登记",
        claim_version=recon_state["claim_version"],
    )
    engine._after_direction_finished(recon_direction, "completed")
    from src.sorne.automation import _member_claim_filter

    assert _member_claim_filter("recon", {"verb": "collect", "assigned_role": "recon"})
    summary = coverage_summary(project)
    assert summary["entry_count"] >= 1
    assert summary["dimensions"]["component-verification"]["no_hit"] == 1

    # ⑤ poc 认领并执行 poc_scan：请求/响应证据落盘 + 研判任务异步入队
    claimed_poc = database.claim_direction(
        "w-poc",
        intent_filter=lambda intent: _member_claim_filter("poc", intent),
    )
    assert claimed_poc["id"] == poc_direction
    poc_gw = _gateway(project, "poc", run_id, control_version, task_id=poc_direction)
    scan_output, scan_error = poc_gw.dispatch("poc_scan", {"targets": ["https://fixture.invalid"]})
    assert not scan_error, scan_output
    scan = json.loads(scan_output)
    assert scan["hit_count"] == 1
    assert (project.path / scan["evidence_path"]).is_file()
    assert (project.path / scan["hit_evidence_paths"][0]).is_file()
    assert scan["analysis_enqueued"]["created"]

    # ⑥ 独立研判：附加记录（版本/输入哈希/证据引用可追溯；建议未自动派发）
    service = AnalysisService(project, database)
    drained = service.drain(worker_id="an-1")
    assert any("分析完成" in item for item in drained), drained
    records = service.query_records(analyzer_kind="poc")
    assert records and records[0]["record"]["model_analysis"] is True
    assert records[0]["record"]["recommended_followups"][0]["adopted"] is False
    # 研判记录可经 analysis_query 查询（planner 视角）
    query_output, query_error = planner.dispatch("analysis_query", {"analyzer_kind": "poc"})
    assert not query_error
    queried = json.loads(query_output)
    assert queried["records"] and "模型分析" in queried["note"]

    # ⑦ poc 提交候选（record_finding → Guardian 只降不升）
    finding_output, finding_error = poc_gw.dispatch("record_finding", {
        "title": "Apache Shiro rememberMe 组件验证候选",
        "classification": "vulnerability",
        "evidence": "我执行了 poc_scan（shiro 模板），观察到 rememberMe=deleteMe 命中响应",
        "business_impact": "若默认密钥未更换，攻击者可能反序列化执行代码",
        "evidence_path": scan["hit_evidence_paths"][0],
        "severity": "high",
        "assets": ["https://fixture.invalid"],
    })
    assert not finding_error, finding_output
    facts = project.read_jsonl("facts.jsonl")
    assert facts and facts[-1]["intent_id"] == poc_direction

    # ⑧ reviewer finding_review 回流（不确认漏洞、不改 Guardian）
    reviewer = _gateway(project, "reviewer", run_id, control_version)
    review_output, review_error = reviewer.dispatch("submit_review", {
        "mode": "finding_review",
        "payload": {
            "candidate_ids": [facts[-1]["id"]],
            "evidence_sufficiency": "partial",
            "recommendation": "request_evidence",
            "missing_items": ["版本对照请求"],
            "linked_analysis_ids": [records[0]["id"]],
        },
    })
    assert not review_error, review_output

    # ⑨ 任务终态（生产路径同 ④：automation 服务端收尾）→ 覆盖账本更新
    poc_state = database.get_direction(poc_direction)
    database.finish_direction(
        poc_direction, poc_state["claimed_by"],
        outcome="completed", reason="组件验证完成",
        claim_version=poc_state["claim_version"],
    )
    engine._after_direction_finished(poc_direction, "completed")
    direction_after = database.get_direction(poc_direction)
    assert direction_after["status"] == "completed"
    summary_after = coverage_summary(project)
    assert any(
        entry["direction_id"] == poc_direction
        for entry in summary_after["recent"]
    )

    # ⑩ planner 上下文消费：覆盖摘要 + 分析记录进入规划输入（负结果驱动重规划）
    context = compile_worker_context(project, "planner")
    rendered = json.dumps(context.context if hasattr(context, "context") else {}, ensure_ascii=False)
    assert "coverage_summary" in rendered or "recent_analysis_records" in rendered


def test_submit_plan_via_gateway_rejects_invalid_graph(
    project: ProjectStore,
) -> None:
    database = ControlDatabase(project.path / "control_plane.db")
    run_id = database.create_run(project.vendor, "seven", 60, 4)
    control_version = int(database.get_run(run_id)["control_version"])
    planner = _gateway(project, "planner", run_id, control_version)
    output, is_error = planner.dispatch("submit_plan", {"plan": {
        "kind": "plan_batch",
        "tasks": [{
            "task_key": "broken", "goal": "g",
            "targets": ["https://fixture.invalid/"], "success_criteria": "s",
            "depends_on": ["missing-parent"],
        }],
    }})
    assert is_error and "无法解析" in output
    # 整批拒绝：没有方向入库
    assert database.list_directions() == []
