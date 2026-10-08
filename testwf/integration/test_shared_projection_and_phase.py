"""集成：
1) CLI add-fact 与自动化提交共用同一投影路径（apply_worker_output 动作），写入不双计；
2) phase 推进与决策日志投影（scheduler_decision）一致。
"""

from __future__ import annotations

import argparse
from pathlib import Path

from src.sorne.automation import AutomationEngine
from src.sorne.database import ControlDatabase
from src.sorne.scheduler import Scheduler
from src.sorne.store import ProjectStore
from src.sorne.worker import apply_worker_output

CLI_FACT_TITLE = "管理端命令注入"
AUTO_FACT = {
    "kind": "fact",
    "title": "自动化确认的暴露接口",
    "category": "attack_surface",
    "assets": [],
    "evidence": "自动化运行完成探测后确认调试接口暴露，观察到可复核的响应标记。",
    "business_impact": "攻击者可读取内部配置并扩展已授权攻击面枚举范围。",
    "reproduction_steps": ["请求调试接口", "记录响应"],
    "evidence_path": "",
    "severity": "unknown",
    "confidence": 0.8,
}


def _cli_args(vendor: str) -> argparse.Namespace:
    return argparse.Namespace(
        vendor=vendor,
        title=CLI_FACT_TITLE,
        category="command_execution",
        evidence="运行 PoC 后观察到回显，服务端日志返回可复核的命令执行标记。",
        business_impact="攻击者可控制服务端进程并读取高价值业务数据。",
        reproduction_step=["发送受控请求", "核对服务端日志标记"],
        evidence_path="",
    )


def _rows(store: ProjectStore, sql: str, params: tuple = ()) -> list[dict]:
    with ControlDatabase(store.path / "control_plane.db").connect() as db:
        return [dict(row) for row in db.execute(sql, params).fetchall()]


def test_cli_add_fact_and_automation_share_projection_path_no_double_count(
    project: ProjectStore,
    team_writer,
) -> None:
    from src.sorne.cli import cmd_add_fact

    # 人工入口：CLI add-fact
    cmd_add_fact(_cli_args(project.vendor))

    # 自动化入口：mock 团队提交事实候选
    team_writer("shared", [
        {"name": "reason", "type": "mock", "role": "reason",
         "extra": {"payload": AUTO_FACT}},
    ])
    engine = AutomationEngine(project)
    run_id = engine.start("shared", timeout=60, max_workers=1)
    engine.run(run_id)
    status = engine.status(run_id)
    assert status["run"]["status"] == "completed", status["run"]

    facts = project.read_jsonl("facts.jsonl")
    cli_rows = [r for r in facts if r["title"] == CLI_FACT_TITLE]
    auto_rows = [r for r in facts if r["title"] == AUTO_FACT["title"]]
    fact_jobs = [
        j for j in status["jobs"]
        if j["role"] == "reason" and j["stage"] == "swarm" and j["committed_at"]
    ]
    assert len(cli_rows) == 1
    assert len(auto_rows) == len(fact_jobs) >= 1

    # 两个入口共用同一投影动作：每条事实一个事件 + 一张回执
    events = _rows(
        project,
        "SELECT event_id,source_type,event_type,status FROM commit_events WHERE event_type='worker_output.fact'",
    )
    receipts = {
        (row["event_id"], row["action_key"])
        for row in _rows(project, "SELECT event_id,action_key FROM projection_receipts")
    }
    event_ids = {row["event_id"] for row in events}
    assert {row["source_type"] for row in events} == {"manual_cli_fact", "automation_job"}
    assert all(row["status"] == "committed" for row in events)
    assert len(events) == len(facts)
    for row in facts:
        assert row["_projection"]["event_id"] in event_ids
        assert (row["_projection"]["event_id"], "apply_worker_output:0") in receipts
    assert project.load_state().fact_count == len(facts)

    # 重放不双计：以同一幂等键、与冻结事件完全一致的载荷再次提交（等价于
    # Worker 超时后携带相同输出重试）
    a_fact_job = next(
        j for j in status["jobs"]
        if j["role"] == "reason" and j["stage"] == "swarm" and j["committed_at"]
    )
    event_row = _rows(
        project,
        "SELECT payload_json FROM commit_events WHERE source_type='automation_job' AND source_id=?",
        (str(a_fact_job["id"]),),
    )[0]
    import json as _json
    frozen_payload = _json.loads(event_row["payload_json"])["worker_payload"]
    apply_worker_output(
        project,
        frozen_payload,
        source_type="automation_job",
        source_id=str(a_fact_job["id"]),
        idempotency_key=f"job:{a_fact_job['id']}:fact",
        run_id=run_id,
        job_id=str(a_fact_job["id"]),
        control_version=int(a_fact_job["control_version"]),
    )
    assert len(project.read_jsonl("facts.jsonl")) == len(facts)
    assert project.load_state().fact_count == len(facts)
    assert len(_rows(
        project,
        "SELECT event_id FROM commit_events WHERE event_type='worker_output.fact'",
    )) == len(facts)


def test_phase_advance_and_scheduler_decision_projection_consistency(
    project: ProjectStore,
    team_writer,
) -> None:
    """Run 完成后：phase 单调推进，决策日志与 scheduler_decision 投影一一对应。"""
    team_writer("phased", [
        {"name": "reason", "type": "mock", "role": "reason",
         "extra": {"payload": AUTO_FACT}},
    ])
    target = project.read_json("target.json")
    target["targets"] = ["https://example.com"]
    project.write_json("target.json", target)

    engine = AutomationEngine(project)
    run_id = engine.start("phased", timeout=60, max_workers=1)
    engine.run(run_id)
    status = engine.status(run_id)
    assert status["run"]["status"] == "completed", status["run"]

    scheduler_events = _rows(
        project,
        "SELECT event_id,status,source_type FROM commit_events WHERE event_type='scheduler_decision'",
    )
    decisions = project.read_jsonl("decision_log.jsonl")
    scheduler_decisions = [
        d for d in decisions
        if (d.get("_projection") or {}).get("event_id") in {e["event_id"] for e in scheduler_events}
    ]

    # 一一对应：每条 scheduler_decision 事件恰好投影一条决策日志
    assert scheduler_events, "Run 收敛必须落确定性调度决策"
    assert all(e["status"] == "committed" for e in scheduler_events)
    assert len(scheduler_decisions) == len(scheduler_events)
    receipts = {
        (row["event_id"], row["action_key"])
        for row in _rows(project, "SELECT event_id,action_key FROM projection_receipts")
    }
    for event in scheduler_events:
        assert (event["event_id"], "scheduler_decision:0") in receipts

    # phase 推进：事实落盘后 intake → recon，事件记录无往返
    phase_events = project.read_jsonl("phase_events.jsonl")
    state = project.load_state()
    assert state.phase == "recon"
    assert phase_events, "阶段推进必须留下 phase_events 记录"
    assert all(e["from"] != e["to"] for e in phase_events)
    assert phase_events[-1]["to"] == "recon"

    # 决策日志中的 phase 与投影后的项目状态一致（投影 save_state 与 append 同事务）
    final_decision = scheduler_decisions[-1]
    assert final_decision["phase"] == state.phase == "recon"
    assert final_decision["action"] == "continue"
    # 非阻塞收敛：门禁不因人工复核暂停
    assert state.gate_status == "running"
    # 阶段推进先于决策提交：决策携带的 phase 已是推进后的值
    assert "recon" in str(final_decision.get("reason") or "") or final_decision["phase"] == "recon"
