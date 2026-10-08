"""P1 七角色调度链定向测试：波次分组、能力认领、capability_missing 显式化、
review 阶段与旧团队兼容（方案 §12-P1 验收：本地夹具上七角色完整调度链）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne import team as team_module
from src.sorne.store import ProjectStore


SEVEN_ROLE_MEMBERS = [
    {"name": "planner-primary", "type": "mock", "role": "planner", "priority": 0},
    {"name": "orchestrator-main", "type": "mock", "role": "orchestrator", "priority": 0},
    {"name": "recon-scout", "type": "mock", "role": "recon", "priority": 1},
    {"name": "crack-verify", "type": "mock", "role": "crack", "priority": 1},
    {"name": "poc-verify", "type": "mock", "role": "poc", "priority": 1},
    {"name": "operator-primary", "type": "mock", "role": "operator", "priority": 2},
    {"name": "reviewer-quality", "type": "mock", "role": "reviewer", "priority": 3},
]


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    (team_module.TEAMS_DIR / "seven.json").write_text(
        json.dumps({"members": SEVEN_ROLE_MEMBERS}, ensure_ascii=False), encoding="utf-8"
    )
    store = ProjectStore("seven-fixture")
    store.init()
    target = store.read_json("target.json")
    target.update({"authorization": "authorized", "scope": ["*"], "targets": ["https://fixture.invalid"]})
    store.write_json("target.json", target)
    return store


def _register_direction(database, direction_id: str, verb: str) -> None:
    database.register_direction({
        "id": direction_id, "verb": verb, "target": "https://fixture.invalid/",
        "hypothesis": "h", "success_criteria": "s",
    })


def test_wave_groups_roles_by_kind_and_claims_by_capability(project: ProjectStore) -> None:
    from src.sorne.automation import AutomationEngine
    from src.sorne.database import ControlDatabase

    engine = AutomationEngine(project)
    database = ControlDatabase(project.path / "control_plane.db")
    run_id = database.create_run(project.vendor, "seven", 60, 4)
    # verify 需要 http_request（poc/operator 可领）；inspect 需要 workspace_read
    # （recon 也可领）；只有 recon 能领 inspect。
    _register_direction(database, "I-verify", "verify")
    _register_direction(database, "I-inspect", "inspect")

    engine._schedule_iteration(run_id)

    jobs = database.list_jobs(run_id, "swarm")
    by_role: dict[str, list[dict]] = {}
    for job in jobs:
        by_role.setdefault(job["role"], []).append(job)
    # 规划/编排/执行进入波次；reviewer 走独立 review 阶段（沿用既有阶段模型）。
    assert {"planner", "orchestrator"} <= set(by_role)
    assert "reviewer" not in by_role
    bound = {
        job["role"]: (job["payload"].get("direction") or {}).get("id")
        for job in jobs
        if job["payload"].get("direction")
    }
    # 专兵先认领：inspect（workspace_read）归 recon，verify（http_request）
    # 不归 recon/crack。
    assert bound.get("recon") == "I-inspect"
    verify_owner = {role for role, did in bound.items() if did == "I-verify"}
    assert verify_owner and verify_owner <= {"poc", "operator"}
    # 非执行角色（planner/orchestrator/reviewer）不认领方向。
    for role in ("planner", "orchestrator", "reviewer"):
        assert role not in bound, f"{role} 不得认领扫描任务（§13.1-2）"


def test_capability_missing_direction_stays_open_with_event(project: ProjectStore) -> None:
    """专兵团队（无 operator/poc）遇 verify 方向：无人具备 http_request →
    方向保持 open、记录 capability_missing，不换人顶替、不用假结果。"""
    from src.sorne.automation import AutomationEngine
    from src.sorne.database import ControlDatabase

    (team_module.TEAMS_DIR / "specialists.json").write_text(json.dumps({"members": [
        {"name": "planner-primary", "type": "mock", "role": "planner"},
        {"name": "recon-scout", "type": "mock", "role": "recon"},
        {"name": "crack-verify", "type": "mock", "role": "crack"},
    ]}, ensure_ascii=False), encoding="utf-8")
    engine = AutomationEngine(project)
    database = ControlDatabase(project.path / "control_plane.db")
    run_id = database.create_run(project.vendor, "specialists", 60, 4)
    _register_direction(database, "I-crack", "verify")

    engine._schedule_iteration(run_id)

    jobs = database.list_jobs(run_id, "swarm")
    assert not any((job["payload"] or {}).get("direction") for job in jobs)
    assert database.get_direction("I-crack")["status"] == "open"
    events = engine.status(run_id)["events"]
    gap = [item for item in events if item["event_type"] == "direction_capability_missing"]
    assert gap, "无认领者的方向必须显式记录缺口事件"
    data_json = json.dumps(gap[0]["data"], ensure_ascii=False)
    assert "http_request" in data_json
    # 缺口事件说明等待能力具备，而不是判定目标无问题。
    assert "capability_missing" in data_json


def test_legacy_executor_team_still_claims_directions(project: ProjectStore) -> None:
    """旧项目继续运行（§12-P1/§13.1-14）：旧 executor 团队能力认领不变。"""
    from src.sorne.automation import AutomationEngine
    from src.sorne.database import ControlDatabase

    (team_module.TEAMS_DIR / "legacy.json").write_text(json.dumps({"members": [
        {"name": "reason", "type": "mock", "role": "reason"},
        {"name": "executor-primary", "type": "mock", "role": "executor", "max_running": 2},
    ]}, ensure_ascii=False), encoding="utf-8")
    engine = AutomationEngine(project)
    database = ControlDatabase(project.path / "control_plane.db")
    run_id = database.create_run(project.vendor, "legacy", 60, 2)
    _register_direction(database, "I-legacy-verify", "verify")

    engine._schedule_iteration(run_id)

    jobs = database.list_jobs(run_id, "swarm")
    bound = [
        (job["payload"].get("direction") or {}).get("id")
        for job in jobs if job["role"] == "executor"
    ]
    assert bound == ["I-legacy-verify"]
    # 规划角色照常入波。
    assert any(job["role"] == "reason" for job in jobs)


def test_full_seven_role_wave_on_fixture(project: ProjectStore, monkeypatch: pytest.MonkeyPatch) -> None:
    """本地夹具上的七角色完整调度链：规划→执行（能力认领）→复核→提交。"""
    from src.sorne import automation as automation_module
    from src.sorne.automation import AutomationEngine
    from src.sorne.database import ControlDatabase

    payloads = {
        "planner": {"kind": "none", "reason": "画像不足，等待画像服务"},
        "orchestrator": {"kind": "none", "reason": "无可派发增量"},
        "recon": {"kind": "none", "reason": "等待采集引擎接入"},
        "crack": {"kind": "none", "reason": "无口令服务候选"},
        "poc": {"kind": "negative_evidence", "hypothesis": "组件 RCE",
                "target": "https://fixture.invalid/", "reason": "对照请求无差异",
                "method": "受控请求对照", "evidence_type": "target_negative",
                "evidence_paths": []},
        "operator": {"kind": "fact", "title": "备份文件暴露",
                     "category": "asset_web_directory", "classification": "risk_lead",
                     "evidence": "我请求了 /backup.zip 并观察到 200 响应",
                     "business_impact": "信息暴露，尚未形成漏洞闭环",
                     "evidence_path": "evidence/operator/backup.txt",
                     "severity": "low", "confidence": 0.6},
        "reviewer": {"kind": "decision", "action": "continue", "reason": "候选证据链完整"},
    }

    def fake_run_member(store, member, timeout, dry_run, context_suffix="", cancel_check=None,
                        progress_callback=None, **binding):
        # 断言服务端绑定注入（身份绑定用于工具网关；绝不取自模型输出）。
        assert member.role in payloads
        return {
            "member": member.name,
            "role": member.role,
            "status": "ok",
            "payload": dict(payloads[member.role]),
        }

    monkeypatch.setattr(automation_module, "_run_member", fake_run_member)
    engine = AutomationEngine(project)
    database = ControlDatabase(project.path / "control_plane.db")
    # 先放一个 verify 方向给 operator 认领。
    _register_direction(database, "I-wave", "verify")
    run_id = engine.start("seven", timeout=60, max_workers=4)
    engine.run(run_id)

    jobs = database.list_jobs(run_id)
    roles_run = {job["role"] for job in jobs}
    # 七个角色都真实上场（各自完成一次模型调用并提交结构化结果）。
    assert roles_run == {"planner", "orchestrator", "recon", "crack", "poc", "operator", "reviewer"}
    bound = [
        job for job in jobs
        if ((job["payload"] or {}).get("direction") or {}).get("id") == "I-wave"
    ]
    assert bound and bound[0]["role"] in {"poc", "operator"}
    # 执行结果经提交链落库。
    facts = project.read_jsonl("facts.jsonl")
    negative = project.read_jsonl("negative_evidence.jsonl")
    assert facts and facts[-1]["title"] == "备份文件暴露"
    assert negative and negative[-1]["hypothesis"] == "组件 RCE"
    # 认领的方向被正确终结。
    direction = database.get_direction("I-wave")
    # fact→completed；target_negative→rejected（无命中=完成语义，§4.4）。
    assert direction["status"] in {"completed", "released", "rejected"}
    # 复核决策入账。
    decisions = project.read_jsonl("decision_log.jsonl")
    assert decisions and decisions[-1]["action"] == "continue"
