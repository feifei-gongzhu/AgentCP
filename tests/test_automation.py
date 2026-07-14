import json
from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane import team as team_module
from src.agent_control_plane import automation as automation_module
from src.agent_control_plane.automation import AutomationEngine, _model_endpoint, _model_error_is_retryable
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.scheduler import Scheduler
from src.agent_control_plane.worker import WorkerError


def test_model_endpoint_never_exposes_url_credentials() -> None:
    assert _model_endpoint("https://user:secret@relay.example:8443/anthropic") == "relay.example"


def test_invalid_http_header_error_is_not_retried() -> None:
    assert not _model_error_is_retryable("Header '14' has invalid value: Bearer [REDACTED]")


def test_permanent_payment_error_is_not_retried() -> None:
    assert not _model_error_is_retryable("Claude API 调用失败: HTTP 402 Insufficient Balance")
    assert _model_error_is_retryable("Claude API 调用失败: HTTP 429 Too Many Requests")
    assert _model_error_is_retryable("Claude API 调用失败: HTTP 503 Service Unavailable")


def test_cancelled_run_cannot_be_resumed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("cancelled-project")
    store.init()
    engine = AutomationEngine(store)
    run_id = engine.start(max_workers=1)
    engine.cancel(run_id, "test")

    with pytest.raises(WorkerError, match="不能恢复"):
        engine.resume(run_id)


def test_stigmergy_iteration_persists_candidates_and_enters_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir()
    config = {
        "members": [
            {"name": role, "type": "mock", "role": role, "extra": {"payload": {"kind": "none", "reason": f"{role} done"}}}
            for role in ("reason", "metacog", "reviewer")
        ]
    }
    (team_module.TEAMS_DIR / "automation.json").write_text(json.dumps(config), encoding="utf-8")
    store = ProjectStore("vendor")
    store.init()
    engine = AutomationEngine(store)

    run_id = engine.start("automation", timeout=30, max_workers=3)
    engine.run(run_id)
    status = engine.status(run_id)

    assert status["run"]["status"] == "completed"
    assert store.load_state().gate_status == "awaiting_approval"
    assert all(job["committed_at"] for job in status["jobs"])
    assert any(event["event_type"] == "job_claimed" for event in status["events"])
    assert any(event["event_type"] == "model_call_started" for event in status["events"])
    assert any(event["event_type"] == "model_call_completed" for event in status["events"])
    started = next(event for event in status["events"] if event["event_type"] == "model_call_started")
    assert started["data"]["activity"]["target"]
    assert started["data"]["activity"]["success_criteria"]


def test_model_tool_progress_is_persisted_as_run_events(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir()
    (team_module.TEAMS_DIR / "streaming.json").write_text(
        json.dumps({"members": [{"name": "reason", "type": "mock", "role": "reason"}]}),
        encoding="utf-8",
    )

    def fake_run_member(store, member, timeout, dry_run, context_suffix="", cancel_check=None, progress_callback=None):
        assert progress_callback is not None
        progress_callback({
            "event": "tool_started",
            "tool_use_id": "tool-1",
            "tool_name": "Read",
            "input_summary": '{"file_path":"/target/app.py"}',
        })
        progress_callback({
            "event": "tool_completed",
            "tool_use_id": "tool-1",
            "tool_name": "Read",
            "is_error": False,
            "output_summary": "42 lines",
        })
        return {
            "member": member.name,
            "role": member.role,
            "status": "ok",
            "payload": {"kind": "none", "reason": "done"},
        }

    monkeypatch.setattr(automation_module, "_run_member", fake_run_member)
    store = ProjectStore("streaming-vendor")
    store.init()
    engine = AutomationEngine(store)
    run_id = engine.start("streaming", timeout=30, max_workers=1)
    engine.run(run_id)

    events = engine.status(run_id)["events"]
    started = next(event for event in events if event["event_type"] == "model_tool_started")
    completed = next(event for event in events if event["event_type"] == "model_tool_completed")
    assert started["data"]["tool_name"] == "Read"
    assert started["data"]["activity"]["target"]
    assert completed["data"]["output_summary"] == "42 lines"


def test_successful_candidate_is_not_lost_when_sibling_job_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir()
    (team_module.TEAMS_DIR / "partial.json").write_text(json.dumps({"members": [
        {"name": "reason-ok", "type": "mock", "role": "reason"},
        {"name": "metacog-fails", "type": "mock", "role": "metacog"},
    ]}), encoding="utf-8")

    def partial_run_member(store, member, timeout, dry_run, context_suffix="", cancel_check=None, progress_callback=None):
        if member.name == "metacog-fails":
            raise RuntimeError("synthetic permanent failure")
        return {
            "member": member.name,
            "role": member.role,
            "status": "ok",
            "payload": {
                "kind": "fact",
                "title": "已确认目标资产",
                "category": "asset",
                "assets": ["api.example.com"],
                "evidence": "运行资产检查后返回 api.example.com，并观察到 HTTP 响应。",
                "business_impact": "攻击者可据此扩展已授权攻击面枚举范围。",
                "reproduction_steps": ["请求目标", "记录响应"],
                "evidence_path": "evidence/assets.txt",
                "severity": "unknown",
                "confidence": 0.7,
            },
        }

    monkeypatch.setattr(automation_module, "_run_member", partial_run_member)
    store = ProjectStore("partial-vendor")
    store.init()
    engine = AutomationEngine(store)
    run_id = engine.start("partial", timeout=30, max_workers=2)
    engine.run(run_id)

    assert engine.status(run_id)["run"]["status"] == "failed"
    assert len(store.read_jsonl("facts.jsonl")) == 1
    successful = next(job for job in engine.status(run_id)["jobs"] if job["member_name"] == "reason-ok")
    assert successful["committed_at"]


def test_next_iteration_claims_committed_intent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir()
    intent = {
        "kind": "intent",
        "verb": "verify",
        "target": "ipc://pushUpdate",
        "evidence_sink": "evidence/ipc.txt",
        "success_criteria": "观察到可复核命令执行",
        "scope_check": "所有测试目标已由项目所有者统一授权",
        "scope_refs": ["*"],
        "expected_business_impact": "验证客户端任意命令执行",
        "risk_level": "medium",
    }
    config = {
        "members": [
            {"name": "reason", "type": "mock", "role": "reason", "extra": {"payload": intent}},
            {"name": "executor", "type": "mock", "role": "executor", "extra": {"payload": {"kind": "none", "reason": "执行未满足成功标准"}}},
        ]
    }
    (team_module.TEAMS_DIR / "intent.json").write_text(json.dumps(config), encoding="utf-8")
    store = ProjectStore("vendor")
    store.init()
    engine = AutomationEngine(store)
    first = engine.start("intent", timeout=30, max_workers=1)
    engine.run(first)
    assert engine.db.list_directions()[0]["status"] == "open"

    Scheduler(store).approve("continue", "用户批准下一迭代")
    second = engine.start("intent", timeout=30, max_workers=1)
    jobs = engine.db.list_jobs(second, "swarm")
    executor_job = next(item for item in jobs if item["role"] == "executor")
    reason_job = next(item for item in jobs if item["role"] == "reason")
    assert executor_job["payload"]["direction"]["intent"]["target"] == "ipc://pushUpdate"
    assert "direction" not in reason_job["payload"]
    engine.run(second)
    assert engine.db.list_directions()[0]["status"] == "completed"

    Scheduler(store).approve("continue", "用户批准下一迭代")
    third = engine.start("intent", timeout=30, max_workers=1)
    third_jobs = engine.db.list_jobs(third, "swarm")
    assert not any(item["role"] == "executor" for item in third_jobs)


def test_direction_claim_prioritizes_human_confirmed_high_value_intents(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("priority-vendor")
    store.init()
    engine = AutomationEngine(store)

    engine.db.register_direction({
        "kind": "intent",
        "verb": "inspect",
        "target": "低价值重复子域名枚举",
        "success_criteria": "发现新子域",
        "risk_level": "low",
        "requires_human_confirmation": False,
    })
    engine.db.register_direction({
        "kind": "intent",
        "verb": "inspect",
        "target": "FTP 匿名登录与 banner 信息收集",
        "success_criteria": "确认服务指纹或匿名权限",
        "risk_level": "high",
        "requires_human_confirmation": True,
    })

    claimed = engine.db.claim_direction("worker-1")

    assert claimed is not None
    assert claimed["intent"]["target"] == "FTP 匿名登录与 banner 信息收集"
