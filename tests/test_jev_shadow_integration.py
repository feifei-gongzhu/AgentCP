from __future__ import annotations

from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane.asset_inventory import AssetInventory
from src.agent_control_plane.database import ControlDatabase
from src.agent_control_plane.jev_classifier import JEV_QUESTION_SET_VERSION, classify_targets
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.target_profile import record_target_profile, target_assessments
from src.agent_control_plane.worker import apply_worker_output


def _project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vendor: str = "jev-shadow") -> ProjectStore:
    monkeypatch.delenv("AGENTCP_JEV_ENDPOINT", raising=False)
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore(vendor)
    store.init()
    target = store.read_json("target.json")
    target["targets"] = ["https://example.com"]
    store.write_json("target.json", target)
    AssetInventory(store).sync_declared_targets()
    return store


def _payload(url: str = "https://example.com/admin/upload") -> dict:
    return {
        "kind": "target_profile_batch",
        "records": [{
            "url": url, "function": "后台文件上传接口", "technology_stack": ["Spring Boot"],
            "observation_kind": "requested", "status": 200,
            "parameter_names": ["file"],
        }],
        "assessments": [{
            "url": url, "profile_class": "priority_target", "target_score": 85,
            "risk_tags": ["upload"], "score_reason": "后台高影响入口",
            "recommended_tests": ["upload_validation"],
        }],
        "routine_groups": [],
        "exploration_complete": True,
    }


def test_shadow_attaches_in_commit_path_and_freezes_into_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """影子数据在提交冻结前生成、随载荷冻结；调度行为零变化。"""
    from src.agent_control_plane.automation import AutomationEngine

    store = _project(tmp_path, monkeypatch)
    engine = AutomationEngine(store)
    run_id = engine.db.create_run(store.vendor, "default", 600, 3)
    job_id = engine.db.enqueue_job(run_id, "swarm", "profile-mapper", "profile_mapper", {"member": {}})
    assert engine.db.claim_job(run_id, "swarm", "w-1", wave=1) is not None
    engine.db.complete_job(job_id, "w-1", {"payload": _payload()})
    calls: list[dict] = []

    def transport(state, questions):
        calls.append(state)
        answers = {}
        for index in range(len(state["targets"])):
            answers[f"t{index}_entry_type"] = {"choice": "file_upload", "confidence": 0.88}
            answers[f"t{index}_has_privilege_boundary"] = {"noul": 0.93}
            answers[f"t{index}_information_sufficient"] = {"noul": 0.85}
            answers[f"t{index}_needs_more_evidence"] = {"noul": 0.05}
        return {"answers": answers, "model": "jev-1.13"}

    monkeypatch.setattr(
        "src.agent_control_plane.jev_classifier.jev_configured", lambda: True,
    )
    monkeypatch.setattr(
        "src.agent_control_plane.jev_classifier.default_transport", transport,
    )
    summaries = engine._commit_candidates(run_id)

    assert calls, "JEV transport 应被调用一次（影子）"
    assert len(calls) == 1
    record = next(
        item for item in store.read_jsonl("target_assessments.jsonl")
        if item["url"] == "https://example.com/admin/upload"
    )
    shadow = record["classification_provenance"]["jev_shadow"]
    assert shadow["model"] == "jev-1.13"
    assert shadow["question_set_version"] == JEV_QUESTION_SET_VERSION
    assert shadow["influences_scheduling"] is False
    assert shadow["answers"]["entry_type"]["choice"] == "file_upload"
    assert shadow["state_fingerprint"].startswith("sha256:")
    assert any(
        event["event_type"] == "jev_shadow_recorded" for event in engine.db.events(run_id)
    )
    assert summaries  # 候选正常收敛，影子不阻断


def test_projection_replay_never_reinvokes_transport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """核心时序保证：投影重放只读冻结载荷，零模型调用。"""
    from src.agent_control_plane.automation import AutomationEngine
    from src.agent_control_plane.jev_classifier import classify_targets as real_classify
    from src.agent_control_plane.projector import Projector

    store = _project(tmp_path, monkeypatch)
    engine = AutomationEngine(store)
    run_id = engine.db.create_run(store.vendor, "default", 600, 3)
    job_id = engine.db.enqueue_job(run_id, "swarm", "profile-mapper", "profile_mapper", {"member": {}})
    assert engine.db.claim_job(run_id, "swarm", "w-1", wave=1) is not None
    engine.db.complete_job(job_id, "w-1", {"payload": _payload()})

    call_count = {"n": 0}

    def counting_transport(state, questions):
        call_count["n"] += 1
        return {"answers": {
            "t0_entry_type": {"choice": "admin_console", "confidence": 0.7},
        }, "model": "jev-1.13"}

    monkeypatch.setattr(
        "src.agent_control_plane.jev_classifier.jev_configured", lambda: True,
    )
    monkeypatch.setattr(
        "src.agent_control_plane.jev_classifier.default_transport", counting_transport,
    )
    # 补一条画像记录使评估可入账
    record_target_profile(store, [{
        "url": "https://example.com/admin/upload", "function": "后台文件上传接口",
        "technology_stack": [],
    }], proposed_by="test")
    engine._commit_candidates(run_id)
    assert call_count["n"] == 1, "提交路径恰好调用一次"
    before_replay = call_count["n"]

    # 丢弃 intents/target_assessments 投影痕迹后强制重放：
    # 直接再次运行提交收敛不会重调（事件已 committed）；这里验证 Projector
    # 层面重放同样零调用——清空 receipts 会走幂等重投影，但不触发 transport。
    with engine.db.connect() as db:
        db.execute("DELETE FROM projection_receipts")
    Projector(store, engine.db).recover()
    assert call_count["n"] == before_replay, "投影重放不得重新调用 JEV"

    # 直接调用 classify_targets 的真实实现未受 monkeypatch 影响的健全性检查。
    assert real_classify([{"url": "https://x"}], transport=counting_transport) is not None


def test_transport_failure_does_not_block_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.agent_control_plane.automation import AutomationEngine

    store = _project(tmp_path, monkeypatch)
    engine = AutomationEngine(store)
    run_id = engine.db.create_run(store.vendor, "default", 600, 3)
    job_id = engine.db.enqueue_job(run_id, "swarm", "profile-mapper", "profile_mapper", {"member": {}})
    assert engine.db.claim_job(run_id, "swarm", "w-1", wave=1) is not None
    engine.db.complete_job(job_id, "w-1", {"payload": _payload()})
    record_target_profile(store, [{
        "url": "https://example.com/admin/upload", "function": "后台文件上传接口",
        "technology_stack": [],
    }], proposed_by="test")

    monkeypatch.setattr(
        "src.agent_control_plane.jev_classifier.jev_configured", lambda: True,
    )

    def broken_transport(state, questions):
        raise RuntimeError("jev endpoint 500")

    monkeypatch.setattr(
        "src.agent_control_plane.jev_classifier.default_transport", broken_transport,
    )
    summaries = engine._commit_candidates(run_id)

    assert summaries, "JEV 失败不得阻断候选收敛"
    assert any(
        event["event_type"] == "jev_shadow_failed" for event in engine.db.events(run_id)
    )
    record = next(
        item for item in store.read_jsonl("target_assessments.jsonl")
        if item["url"] == "https://example.com/admin/upload"
    )
    assert "jev_shadow" not in record["classification_provenance"]


def test_disabled_leaves_zero_footprint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.agent_control_plane.automation import AutomationEngine

    store = _project(tmp_path, monkeypatch)  # fixture 里已删除端点环境变量
    engine = AutomationEngine(store)
    run_id = engine.db.create_run(store.vendor, "default", 600, 3)
    job_id = engine.db.enqueue_job(run_id, "swarm", "profile-mapper", "profile_mapper", {"member": {}})
    assert engine.db.claim_job(run_id, "swarm", "w-1", wave=1) is not None
    engine.db.complete_job(job_id, "w-1", {"payload": _payload()})
    record_target_profile(store, [{
        "url": "https://example.com/admin/upload", "function": "后台文件上传接口",
        "technology_stack": [],
    }], proposed_by="test")

    summaries = engine._commit_candidates(run_id)

    assert summaries
    record = next(
        item for item in store.read_jsonl("target_assessments.jsonl")
        if item["url"] == "https://example.com/admin/upload"
    )
    assert "jev_shadow" not in record["classification_provenance"]
    assert not any(
        event["event_type"].startswith("jev_") for event in engine.db.events(run_id)
    ), "禁用时零事件、零足迹"


def test_provenance_merges_through_record_target_assessments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.agent_control_plane.target_profile import record_target_assessments

    store = _project(tmp_path, monkeypatch)
    record_target_profile(store, [{
        "url": "https://example.com/admin/upload", "function": "后台文件上传接口",
        "technology_stack": [],
    }], proposed_by="test")
    shadow = {
        "https://example.com/admin/upload": {
            "model": "jev-1.13",
            "question_set_version": JEV_QUESTION_SET_VERSION,
            "state_fingerprint": "sha256:abc",
            "answers": {"entry_type": {"choice": "file_upload", "confidence": 0.9}},
            "influences_scheduling": False,
        },
    }

    recorded = record_target_assessments(store, [{
        "url": "https://example.com/admin/upload", "profile_class": "priority_target",
        "target_score": 80, "risk_tags": [], "score_reason": "x",
        "recommended_tests": ["upload_validation"],
    }], proposed_by="profile_mapper", jev_shadow_by_url=shadow)

    assert len(recorded) == 1
    provenance = recorded[0].classification_provenance
    assert provenance["source"] == "profile_mapper"
    assert provenance["policy_version"]
    assert provenance["jev_shadow"]["influences_scheduling"] is False
    # 最新视图同样带影子数据。
    latest = target_assessments(store)
    assert latest[0]["classification_provenance"]["jev_shadow"]["model"] == "jev-1.13"
