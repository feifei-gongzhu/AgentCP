from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.memory import matching_negative_evidence, relevant_lessons
from src.agent_control_plane.worker import apply_worker_output
from src.agent_control_plane.waf import WAFManager


def test_natural_language_method_does_not_resurrect_rejected_direction() -> None:
    intent = {
        "verb": "inspect",
        "target": "AndroidManifest.xml中Service与Receiver的属性",
        "hypothesis": "系统绑定组件可能遗漏对应BIND权限",
    }
    negative = {
        "target": "AndroidManifest.xml中Service与Receiver的属性",
        "hypothesis": "系统绑定组件可能遗漏对应BIND权限",
        "method": "使用ElementTree解析Manifest并逐项核对组件权限和导出状态",
        "evidence_type": "target_negative",
    }

    assert matching_negative_evidence(intent, [negative]) == negative


def test_explicit_negative_evidence_verb_still_scopes_pruning_method() -> None:
    intent = {"verb": "forge", "target": "push handlers", "hypothesis": "unsigned push reaches admin command"}
    negative = {
        "target": "push handlers",
        "hypothesis": "unsigned push reaches admin command",
        "intent_verb": "inspect",
        "method": "long natural-language audit procedure",
    }

    assert matching_negative_evidence(intent, [negative]) is None


def test_waf_block_creates_bounded_adaptive_branch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("waf-vendor")
    store.init()
    evidence = store.path / "evidence" / "waf-block.txt"
    evidence.write_text("HTTP 403\nedge WAF blocked request\n", encoding="utf-8")

    apply_worker_output(store, {
        "kind": "negative_evidence",
        "hypothesis": "接口参数可以到达后端解析器",
        "target": "https://api.example.com/orders",
        "outcome": "blocked",
        "evidence_type": "environment_blocked",
        "reason": "WAF 返回统一 403 拦截页面",
        "method": "verify",
        "attempts": 2,
        "evidence_paths": ["evidence/waf-block.txt"],
    })

    negatives = store.read_jsonl("negative_evidence.jsonl")
    branches = store.read_jsonl("waf_assessments.jsonl")
    assert negatives[0]["evidence_type"] == "environment_blocked"
    assert branches[0]["status"] == "suspected"
    assert branches[0]["budget_minutes"] == 12
    assert branches[0]["source_negative_evidence_id"] == negatives[0]["id"]
    lessons = store.read_jsonl("lessons.jsonl")
    assert len(lessons) == 1
    assert lessons[0]["source_id"] == negatives[0]["id"]
    assert relevant_lessons(store, {"target": "api.example.com/orders"})[0]["id"] == lessons[0]["id"]


def test_waf_branch_budget_is_event_sourced_and_exhausted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("waf-budget")
    store.init()
    apply_worker_output(store, {
        "kind": "negative_evidence",
        "hypothesis": "请求可到达业务处理器",
        "target": "https://api.example.com/orders",
        "outcome": "blocked",
        "evidence_type": "environment_blocked",
        "reason": "边缘 WAF 统一返回 403",
        "method": "verify",
    })
    manager = WAFManager()
    branch = manager.active(store)[0]

    for _ in range(12):
        manager.record_result(store, branch["id"], status="characterizing", used_delta=1)

    current = manager.current(store)[0]
    assert current["used_minutes"] == 12
    assert current["status"] == "exhausted"
    assert manager.active(store) == []
