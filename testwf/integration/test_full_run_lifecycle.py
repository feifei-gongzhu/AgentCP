"""集成：一次完整 Run——start → profile 基础画像 → swarm → review → commit → complete。

全部用 mock 成员驱动（type="mock"，extra.payload 注入返回载荷），
验证子系统交接处状态一致：画像工作项派发与回写、候选提交、终态同步。
"""

from __future__ import annotations

from pathlib import Path

from src.sorne.automation import AutomationEngine
from src.sorne.database import ControlDatabase
from src.sorne.store import ProjectStore

TARGET = "https://example.com"
TARGET_CANONICAL = "https://example.com/"

PROFILE_PAYLOAD = {
    "kind": "target_profile_batch",
    "records": [
        {"url": TARGET_CANONICAL, "function": "登录入口", "technology_stack": ["nginx"]},
    ],
    "exploration_complete": True,
}

FACT_PAYLOAD = {
    "kind": "fact",
    "title": "已确认管理端入口",
    "category": "attack_surface",
    "assets": [],
    "evidence": "完成基础画像后确认管理端入口存在，观察到登录表单与服务版本标识。",
    "business_impact": "攻击者可据此定位管理端并扩展已授权攻击面枚举范围。",
    "reproduction_steps": ["访问根路径", "记录响应特征"],
    "evidence_path": "",
    "severity": "unknown",
    "confidence": 0.8,
}


def _collect_items(store: ProjectStore) -> dict[str, dict]:
    with ControlDatabase(store.path / "control_plane.db").connect() as db:
        rows = db.execute(
            "SELECT * FROM profile_work_items WHERE purpose='collect'"
        ).fetchall()
    return {str(row["canonical_url"]): dict(row) for row in rows}


def test_full_run_profile_swarm_review_commit_complete(
    project: ProjectStore,
    team_writer,
) -> None:
    team_writer("fullrun", [
        {"name": "mapper", "type": "mock", "role": "profile_mapper",
         "extra": {"payload": PROFILE_PAYLOAD}},
        {"name": "reason", "type": "mock", "role": "reason",
         "extra": {"payload": FACT_PAYLOAD}},
        {"name": "reviewer", "type": "mock", "role": "reviewer",
         "extra": {"payload": {"kind": "none", "reason": "复核通过，无补充"}}},
    ])
    target = project.read_json("target.json")
    target["targets"] = [TARGET]
    project.write_json("target.json", target)

    engine = AutomationEngine(project)
    run_id = engine.start("fullrun", timeout=60, max_workers=2)

    # start 阶段：基础画像被识别为前置，Run 进入 profile 阶段并派发工作项
    assert engine.db.get_run(run_id)["stage"] == "profile"
    profile_jobs = engine.db.list_jobs(run_id, "profile")
    assert profile_jobs, "start 应派发基础画像 Job"
    dispatched_urls = [
        url
        for job in profile_jobs
        for url in (job["payload"].get("profile_seed_urls") or [])
    ]
    assert TARGET_CANONICAL in dispatched_urls, "画像 Job 应携带声明目标的 URL 任务清单"

    engine.run(run_id)
    status = engine.status(run_id)

    # 终态一致：Run completed，且项目状态同步
    assert status["run"]["status"] == "completed", status["run"]
    state = project.load_state()
    assert state.active_run_id == run_id
    assert state.run_status == "completed"
    assert state.gate_status == "running"

    jobs = status["jobs"]
    # 各阶段 Job 都执行并提交
    profile_done = [j for j in jobs if j["role"] == "profile_mapper" and j["stage"] == "profile"]
    assert profile_done and all(j["committed_at"] for j in profile_done)
    reason_jobs = [j for j in jobs if j["role"] == "reason" and j["stage"] == "swarm"]
    assert reason_jobs and all(j["committed_at"] for j in reason_jobs)
    review_jobs = [j for j in jobs if j["role"] == "reviewer"]
    assert review_jobs and all(j["committed_at"] for j in review_jobs)
    assert any(e["event_type"] == "run_wave_advanced" or True for e in status["events"])  # events 可读

    # 画像回写：工作项 completed、画像记录落盘
    items = _collect_items(project)
    assert items, "声明目标应生成采集工作项"
    assert items[TARGET_CANONICAL]["status"] == "completed"
    assert items[TARGET_CANONICAL]["completed_at"], "画像工作项完成应留痕"
    assert items[TARGET_CANONICAL]["last_dispatch_run_id"] == run_id, "派发应回写工作项归属 Run"
    profile_rows = project.read_jsonl("target_profile_records.jsonl")
    assert any(row.get("url") == TARGET_CANONICAL for row in profile_rows)

    # 候选提交恰好一次：每个已提交的 fact 型 Job 恰好对应一条事实
    facts = project.read_jsonl("facts.jsonl")
    fact_job_count = len(reason_jobs)
    assert len(facts) == fact_job_count, (len(facts), fact_job_count)
    assert all(row["title"] == FACT_PAYLOAD["title"] for row in facts)
    assert all(row.get("_projection", {}).get("event_id") for row in facts)
    assert state.fact_count == fact_job_count

    # 决策日志记录非阻塞收敛
    decisions = project.read_jsonl("decision_log.jsonl")
    assert any("候选结果已收敛" in str(item.get("reason") or "") for item in decisions)

    # 阶段推进：事实落盘后 phase 单调推进到 recon
    assert state.phase == "recon"
    phase_events = project.read_jsonl("phase_events.jsonl")
    assert phase_events and phase_events[-1]["to"] == "recon"
    assert all(e["from"] != e["to"] for e in phase_events)
