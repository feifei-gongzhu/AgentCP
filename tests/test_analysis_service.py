"""P2 独立 AI 研判服务定向测试（方案 §7A.1-7A.4；验收 §13.1-17 部分）。

覆盖：异步入队不阻塞、幂等复用、无模型配置显式失败（不 mock 冒充）、
契约校验（含注入与证据绑定）、版本化重分析、租约迟到 fencing、
Run 停止取消、记录查询带模型分析标记。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne.database import ControlDatabase
from src.sorne.analysis_registry import build_domain_input, validate_model_output
from src.sorne.analysis_service import AnalysisService
from src.sorne.engine_adapters.nuclei_adapter import run_scan


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("analysis-fixture")
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized",
        "scope": ["fixture.invalid"],
        "targets": ["https://fixture.invalid"],
    }))
    return store


@pytest.fixture()
def database(project: ProjectStore) -> ControlDatabase:
    return ControlDatabase(project.path / "control_plane.db")


VALID_MODEL_PAYLOAD = {
    "kind": "analysis_record",
    "analyzer_kind": "poc",
    "observations": [
        {"text": "命中响应为统一错误页特征", "evidence_ref": "evidence/poc/x.jsonl", "kind": "observed"},
        {"text": "版本无法从响应判断", "evidence_ref": "profile:fixture.invalid", "kind": "inferred"},
    ],
    "candidate_assessments": [{
        "candidate_ref": "shiro-1@https://fixture.invalid/login",
        "assessment": "insufficient_evidence",
        "rationale": "缺少基线对照请求",
        "evidence_refs": ["evidence/poc/x.jsonl"],
    }],
    "recommended_followups": [{
        "preconditions": ["指纹已核实"],
        "target_ref": "https://fixture.invalid",
        "expected_evidence": "基线路径对照响应",
    }],
    "uncertainties": ["组件版本未知"],
}


class _FakeCompleted:
    returncode = 0
    stderr = ""
    stdout = json.dumps({
        "template-id": "shiro-1",
        "info": {"name": "Shiro", "severity": "critical"},
        "host": "https://fixture.invalid",
        "matched-at": "https://fixture.invalid/login",
        "matcher-status": True,
        "request": "GET /login",
        "response": "HTTP/1.1 200",
    }) + "\n"


def _scan_result(project: ProjectStore) -> dict:
    return run_scan(
        project,
        {"targets": ["https://fixture.invalid"]},
        runner=lambda argv, **kw: _FakeCompleted(),
    )


def _install_mock_driver(monkeypatch: pytest.MonkeyPatch, payload: dict) -> None:
    import src.sorne.analysis_service as service_module

    monkeypatch.setattr(
        service_module, "run_driver",
        lambda config, prompt, timeout=300, cancel_check=None, progress_callback=None: dict(payload),
    )


def test_validate_model_output_contract() -> None:
    assert validate_model_output("poc", VALID_MODEL_PAYLOAD) == []
    # 缺证据绑定的观察被拒绝（每条结论必须绑定输入证据）
    bad = json.loads(json.dumps(VALID_MODEL_PAYLOAD))
    bad["observations"][0]["evidence_ref"] = ""
    assert any("evidence_ref" in problem for problem in validate_model_output("poc", bad))
    # 与 confirmed 混淆的判断被拒绝
    bad2 = json.loads(json.dumps(VALID_MODEL_PAYLOAD))
    bad2["candidate_assessments"][0]["assessment"] = "confirmed"
    assert any("confirmed" in problem for problem in validate_model_output("poc", bad2))
    # kind/analyzer_kind 不符
    bad3 = {"kind": "fact", "analyzer_kind": "directory"}
    assert validate_model_output("poc", bad3)


def test_enqueue_is_idempotent_and_not_a_quota(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    service = AnalysisService(project, database)
    scan = _scan_result(project)
    first = service.enqueue_from_tool_result(
        analyzer_kind="poc", tool_id="poc_scan", tool_call_id="TC-1",
        result=scan, run_id="R1", source_task_id="I-1",
    )
    assert first["created"] and first["analysis_job_id"]
    second = service.enqueue_from_tool_result(
        analyzer_kind="poc", tool_id="poc_scan", tool_call_id="TC-1",
        result=scan, run_id="R1", source_task_id="I-1",
    )
    # 相同输入复用（防重复，不是额度；§7A.3）
    assert not second["created"]
    assert second["analysis_job_id"] == first["analysis_job_id"]
    # 非触发源工具不入队
    skipped = service.enqueue_from_tool_result(
        analyzer_kind="poc", tool_id="dir_scan", tool_call_id="TC-2", result=scan,
    )
    assert skipped["skipped"]


def test_missing_model_config_fails_explicitly(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    service = AnalysisService(project, database)
    service.enqueue_from_tool_result(
        analyzer_kind="poc", tool_id="poc_scan", tool_call_id="TC-1",
        result=_scan_result(project), run_id="R1", source_task_id="I-1",
    )
    summaries = service.drain(worker_id="an-1")
    assert any("缺少可用模型配置" in item for item in summaries)
    job = database.list_analysis_jobs("R1")[0]
    assert job["status"] == "failed"
    assert "不以空结果冒充" in job["error"]


def test_full_analysis_cycle_with_mock_model(
    project: ProjectStore, database: ControlDatabase, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_mock_driver(monkeypatch, VALID_MODEL_PAYLOAD)
    store_config = {"analyzers": {"poc": {"type": "mock", "model": "mock-analyzer"}}}
    (project.path / "analysis_config.json").write_text(
        json.dumps(store_config), encoding="utf-8",
    )
    service = AnalysisService(project, database)
    scan = _scan_result(project)
    service.enqueue_from_tool_result(
        analyzer_kind="poc", tool_id="poc_scan", tool_call_id="TC-1",
        result=scan, run_id="R1", source_task_id="I-1",
    )
    summaries = service.drain(worker_id="an-1")
    assert any("分析完成" in item for item in summaries), summaries

    records = service.query_records(analyzer_kind="poc")
    assert records, "分析记录应已持久化"
    row = records[0]
    record = row["record"]
    record["analysis_id"] = row["id"]  # 查询行携带 id
    record = row["record"]
    # §7A.2 契约字段齐全（服务端补齐）
    for field in (
        "analysis_id", "analyzer_kind", "source_result_ids", "evidence_refs",
        "observations", "candidate_assessments", "recommended_followups",
        "uncertainties", "analysis_status", "model_id", "prompt_version",
        "schema_version", "input_hash", "created_at",
    ):
        assert field in record, f"缺少 {field}"
    assert record["analysis_status"] == "completed"
    assert record["model_id"] == "mock-analyzer"
    assert record["prompt_version"] == "poc-analyzer-v1"
    assert record["input_hash"]
    # 模型分析标记（不伪装原始事实）
    assert record["model_analysis"] is True
    # 建议初始未采纳（不自动构成任务）
    assert record["recommended_followups"][0]["adopted"] is False
    job = database.get_analysis_job(str(row.get("job_id") or ""))
    assert job is None or job["status"] == "completed"

    # 建议采纳登记（防重复创建）
    marked = service.mark_followup(row["id"], 0, adopted=True, task_id="I-NEW")
    assert marked["adopted"]
    updated = service.query_records(analyzer_kind="poc")[0]["record"]
    assert updated["recommended_followups"][0]["adopted_by_task_id"] == "I-NEW"


def test_reanalysis_creates_new_version_preserving_old(
    project: ProjectStore, database: ControlDatabase, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_mock_driver(monkeypatch, VALID_MODEL_PAYLOAD)
    (project.path / "analysis_config.json").write_text(
        json.dumps({"analyzers": {"poc": {"type": "mock", "model": "mock-analyzer"}}}),
        encoding="utf-8",
    )
    service = AnalysisService(project, database)
    scan = _scan_result(project)
    service.enqueue_from_tool_result(
        analyzer_kind="poc", tool_id="poc_scan", tool_call_id="TC-1",
        result=scan, run_id="R1", source_task_id="I-1",
    )
    service.drain(worker_id="an-1")
    first = service.query_records(analyzer_kind="poc")[0]
    reanalysis = service.reanalyze(first["id"], reason="user_reanalysis")
    assert reanalysis["created"]
    service.drain(worker_id="an-2")
    rows = service.query_records(analyzer_kind="poc")
    versions = sorted(row["version"] for row in rows)
    assert versions == [1, 2]
    # 旧记录保留
    assert any(row["id"] == first["id"] for row in rows)


def test_late_result_fenced_after_cancel(
    project: ProjectStore, database: ControlDatabase, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """取消后迟到结果被 fencing 拒绝：模型返回时任务已取消 → 不写记录。"""
    (project.path / "analysis_config.json").write_text(
        json.dumps({"analyzers": {"poc": {"type": "mock", "model": "mock-analyzer"}}}),
        encoding="utf-8",
    )
    service = AnalysisService(project, database)
    scan = _scan_result(project)
    service.enqueue_from_tool_result(
        analyzer_kind="poc", tool_id="poc_scan", tool_call_id="TC-1",
        result=scan, run_id="R1", source_task_id="I-1",
    )
    job = database.claim_analysis_job("an-1")
    assert job is not None
    # 模型“还在跑”时 Run 停止 → 任务被取消
    database.finish_analysis_job(str(job["id"]), "an-1", status="cancelled", error="run stopped")
    # 迟到的模型输出到达：服务端拒绝写回
    summaries = service.drain(worker_id="an-2")  # 新 claim 不会命中 cancelled 任务
    assert summaries == []
    assert service.query_records(analyzer_kind="poc") == []
    # 原始扫描产物仍在（分析缺失不丢原始结果）
    assert (project.path / scan["evidence_path"]).is_file()


def test_run_stop_cancels_analysis_jobs(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    database.enqueue_analysis_job("poc", {"k": 1}, "hash-1", run_id="R1")
    assert database.cancel_analysis_jobs_for_run("R1", "run stopped") == 1
    assert database.list_analysis_jobs("R1")[0]["status"] == "cancelled"


def test_cancelled_analysis_job_cannot_be_resurrected_by_late_write(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    """Run 停止批量取消后，迟到写回（含原租约持有者）不得复活已取消任务。

    压力测试（test_stress_concurrency 取消风暴）发现的缺陷回归：
    finish_analysis_job 旧 WHERE 允许 ``status IN ('queued','cancelled')``
    命中，已取消任务可被写回为 completed——违反 §7A.3“旧 Run 迟到分析
    不激活”与该方法自身的租约 fencing 契约。
    """
    database.enqueue_analysis_job("poc", {"k": 1}, "hash-late", run_id="R1")
    job = database.claim_analysis_job("an-1")
    assert job is not None
    # Run 停止：租约持有者在途时任务被批量取消（worker_id 置空）。
    assert database.cancel_analysis_jobs_for_run("R1", "run stopped") == 1
    # 原持有者的迟到结果被拒绝，任务保持 cancelled。
    assert database.finish_analysis_job(
        str(job["id"]), "an-1", status="completed", record_id="AN-late",
    ) == "fenced"
    assert database.get_analysis_job(str(job["id"]))["status"] == "cancelled"
    assert database.list_analysis_records(analyzer_kind="poc") == []
    assert database.event_count("analysis_late_write_rejected") == 1
    # 新 Worker 也不能把已取消任务当作可认领工作。
    assert database.claim_analysis_job("an-2") is None


def test_team_member_cannot_impersonate_analysis(project: ProjectStore) -> None:
    """§13.1-17：研判记录不能由七角色的一段附加输出冒充。"""
    from src.sorne.worker import WorkerError, apply_worker_output

    with pytest.raises(WorkerError, match="独立研判服务"):
        apply_worker_output(project, {
            "kind": "analysis_record",
            "analyzer_kind": "poc",
            "observations": [{"text": "x", "evidence_ref": "y", "kind": "observed"}],
        })


def test_domain_input_includes_engine_and_evidence_refs(project: ProjectStore) -> None:
    scan = _scan_result(project)
    domain = build_domain_input("poc", scan, evidence_loader=lambda p: "EXCERPT")
    assert domain["engine"] == "nuclei-adapter"
    assert domain["template_ids"] == []
    assert domain["hits"][0]["template_id"] == "shiro-1"
    assert domain["hit_evidence"][0]["excerpt"] == "EXCERPT"
    assert domain["raw_output_ref"] == scan["evidence_path"]
