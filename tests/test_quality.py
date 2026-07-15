import json
from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane.quality import QualityLedger
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.worker import apply_worker_output


def _verified_vulnerability(store: ProjectStore, name: str) -> str:
    relative = f"evidence/{name}.txt"
    (store.path / relative).write_text("command=verify\nmarker=owned\nexit=0\n", encoding="utf-8")
    apply_worker_output(store, {
        "kind": "fact",
        "title": f"验证漏洞 {name}",
        "category": "ipc_endpoint",
        "classification": "vulnerability",
        "evidence": "运行验证后观察到未授权命令执行，并在原始日志中写入随机标记。",
        "business_impact": "攻击者可在目标用户权限下执行任意命令并读取业务数据。",
        "reproduction_steps": ["调用入口", "提交随机标记", "检查执行结果"],
        "evidence_path": relative,
        "severity": "high",
        "confidence": 0.9,
        "evidence_metrics": {
            "boundary_crossed": True,
            "unauthorized_capability_obtained": True,
            "reproducible": True,
            "result_reliable": True,
            "proof_refs": {
                "boundary_crossed": [relative],
                "unauthorized_capability_obtained": [relative],
            },
        },
    })
    return store.read_jsonl("facts.jsonl")[-1]["id"]


def test_human_refutation_updates_long_term_false_positive_metrics(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("quality-vendor")
    store.init()
    first = _verified_vulnerability(store, "first")
    second = _verified_vulnerability(store, "second")
    ledger = QualityLedger()

    ledger.review(
        store,
        finding_id=first,
        action="refuted",
        final_classification="risk_lead",
        final_severity="info",
        reason="证据中的标记来自正常授权能力，未证明跨越安全边界。",
        reason_codes=["boundary_not_crossed"],
        applicable_scope="current_project_type",
    )
    ledger.review(
        store,
        finding_id=second,
        action="accepted",
        final_classification="vulnerability",
        final_severity="high",
        reason="已复核原始证据，确认未授权命令执行可稳定复现。",
    )

    metrics = ledger.project_metrics(store)
    assert metrics["reviewed"] == 2
    assert metrics["false_positives"] == 1
    assert metrics["false_positive_rate"] == 0.5
    assert metrics["confirmed"] == 1
    assert ledger.global_metrics(store)["false_positive_rate"] == 0.5
    assert len(store.read_jsonl("refutation_memories.jsonl")) == 1
    global_record = json.loads(
        (store.path.parent / ".quality" / "quality_ledger.jsonl").read_text(encoding="utf-8").splitlines()[0]
    )
    assert "project_hash" in global_record
    assert "quality-vendor" not in json.dumps(global_record)


def test_human_review_requires_reason(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("quality-vendor")
    store.init()
    finding_id = _verified_vulnerability(store, "reason")
    with pytest.raises(ValueError, match="理由"):
        QualityLedger().review(
            store,
            finding_id=finding_id,
            action="refuted",
            final_classification="risk_lead",
            final_severity="info",
            reason="",
        )
