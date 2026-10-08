"""CLI 功能路径：init 结构、add-fact Guardian 语义、approve-gate、
complete-subtask、config-gate。全部在隔离的 tmp projects 目录中执行。"""
from __future__ import annotations

import json

import pytest

from src.sorne import cli
from src.sorne.cli import build_parser
from src.sorne.scheduler import Scheduler
from src.sorne.store import ProjectStore

EXPECTED_JSONL = {
    "facts.jsonl", "intents.jsonl", "hints.jsonl", "hint_events.jsonl",
    "evidence.jsonl", "negative_evidence.jsonl", "technology_observations.jsonl",
    "human_verdicts.jsonl", "refutation_memories.jsonl", "waf_assessments.jsonl",
    "waf_events.jsonl", "decision_log.jsonl", "lessons.jsonl", "team_runs.jsonl",
    "hypotheses.jsonl", "plan_batches.jsonl", "counterfactuals.jsonl",
    "phase_events.jsonl", "prompt_snapshots.jsonl",
}


def run_cli(argv: list[str]):
    args = build_parser().parse_args(argv)
    args.func(args)
    return args


def test_init_creates_complete_project_structure(projects_dir) -> None:
    run_cli(["init", "fn-init"])

    root = projects_dir / "fn-init"
    assert root.is_dir()
    jsonl_files = {p.name for p in root.glob("*.jsonl")}
    assert jsonl_files == EXPECTED_JSONL, jsonl_files ^ EXPECTED_JSONL
    assert len(jsonl_files) == 19
    for extra in ("项目黑板_知识库.md", "目标信息.md", "检查清单.yaml", "决策日志.md",
                  "blackboard.md", "target.json", "state.json", "checklist.json"):
        assert (root / extra).is_file(), extra
    for subdir in ("findings", "evidence", "reports"):
        assert (root / subdir).is_dir(), subdir

    target = json.loads((root / "target.json").read_text(encoding="utf-8"))
    assert target["vendor"] == "fn-init"
    assert target["authorization"] == "authorized"
    assert target["authorization_mode"] == "owner_asserted_all_targets"
    assert target["scope"] == ["*"]

    state = json.loads((root / "state.json").read_text(encoding="utf-8"))
    assert state["gate_status"] == "running"
    assert state["gate_interval_minutes"] == 15
    assert state["gate_interval_minutes"] > 0

    blackboard = (root / "项目黑板_知识库.md").read_text(encoding="utf-8")
    assert "# 项目黑板" in blackboard
    assert (root / "目标信息.md").read_text(encoding="utf-8").startswith("# fn-init")


def test_add_fact_manual_entry_stays_phenomenon_without_evidence_file(projects_dir) -> None:
    run_cli(["init", "fn-fact"])
    run_cli([
        "add-fact", "fn-fact",
        "--title", "订单查询接口在无授权时也返回了完整数据",
        "--category", "auth",
        "--evidence",
        "我实际运行了 curl https://target.example/orders 并观察到接口返回了 200 与完整订单列表，"
        "截图已留存，日志显示未校验会话。",
        "--business-impact", "攻击者可批量读取任意用户的订单与收货地址，造成核心业务数据泄露。",
        "--reproduction-step", "1. 未登录调用 /orders",
        "--evidence-path", "evidence/manual-fact-1.txt",
    ])

    store = ProjectStore("fn-fact")
    facts = store.read_jsonl("facts.jsonl")
    assert len(facts) == 1
    fact = facts[0]
    assert fact["proposed_by"] == "project_owner"
    # 无可审计证据落盘：Guardian 只降不升，人工录入不能直接升级为漏洞。
    assert fact["status"] == "phenomenon"
    assert fact["classification"] != "vulnerability"
    notes = " ".join(fact.get("quality_notes") or [])
    assert "证据" in notes
    state = store.load_state()
    assert state.vulnerability_count == 0
    assert state.fact_count == 1


def test_complete_subtask_forces_awaiting_approval(projects_dir) -> None:
    run_cli(["init", "fn-subtask"])

    run_cli(["complete-subtask", "fn-subtask", "--summary", "初步资产盘点完成"])

    store = ProjectStore("fn-subtask")
    state = store.load_state()
    assert state.gate_status == "awaiting_approval"
    assert state.current_decision == "request_confirmation"
    assert "子任务已完成：初步资产盘点完成" in (state.gate_reason or "")
    decisions = store.read_jsonl("decision_log.jsonl")
    assert any(d.get("action") == "request_confirmation" for d in decisions)
    # 门禁未解除时再推进时间应被拒绝。
    with pytest.raises(RuntimeError, match="强制门禁正在等待用户批准"):
        Scheduler(store).tick(15)


def test_approve_gate_supports_four_actions(projects_dir) -> None:
    run_cli(["init", "fn-approve"])
    store = ProjectStore("fn-approve")

    for action in ("continue", "switch_target", "switch_phase", "stop_loss"):
        run_cli(["complete-subtask", "fn-approve", "--summary", f"阶段收敛-{action}"])
        assert store.load_state().gate_status == "awaiting_approval"
        run_cli(["approve-gate", "fn-approve", "--action", action, "--reason", "人工确认"])
        state = store.load_state()
        assert state.gate_status == "running", action
        assert state.current_decision == action
        assert state.gate_reason is None

    decisions = store.read_jsonl("decision_log.jsonl")
    assert {d.get("action") for d in decisions} >= {
        "continue", "switch_target", "switch_phase", "stop_loss",
    }


def test_approve_gate_rejects_invalid_action(projects_dir) -> None:
    run_cli(["init", "fn-approve-bad"])

    # argparse choices 直接拒绝非法动作。
    with pytest.raises(SystemExit):
        build_parser().parse_args(["approve-gate", "fn-approve-bad", "--action", "hack", "--reason", "x"])

    run_cli(["complete-subtask", "fn-approve-bad", "--summary", "等待批准"])
    store = ProjectStore("fn-approve-bad")
    with pytest.raises(ValueError, match="非法批准动作"):
        Scheduler(store).approve("hack", "非法动作")

    # 没有待批准门禁时批准被拒绝。
    Scheduler(store).approve("continue", "先解除门禁")
    with pytest.raises(RuntimeError, match="当前没有待批准的强制门禁"):
        Scheduler(store).approve("continue", "重复批准")


def test_config_gate_rejects_zero_interval(projects_dir) -> None:
    run_cli(["init", "fn-gate"])
    store = ProjectStore("fn-gate")

    run_cli(["config-gate", "fn-gate", "--interval", "30"])
    assert store.load_state().gate_interval_minutes == 30

    with pytest.raises(ValueError, match="间隔必须大于 0"):
        run_cli(["config-gate", "fn-gate", "--interval", "0"])
    with pytest.raises(ValueError, match="间隔必须大于 0"):
        run_cli(["config-gate", "fn-gate", "--interval", "-5"])
    # 拒绝后原间隔保持不变。
    assert store.load_state().gate_interval_minutes == 30

    run_cli(["config-gate", "fn-gate", "--reset"])
    state = store.load_state()
    assert state.last_gate_elapsed_minutes == state.elapsed_minutes
