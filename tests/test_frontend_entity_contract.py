"""前端实体拆分的数据契约（实施规格 5.1-5.3）。

前端无 JS 测试设施（用户决定"后端契约测试 + 手工验证"）：本测试固定
/api/project/state 暴露的数据形状，确保线索/方向/漏洞/负向证据能各自保
留身份并按 intent_id → hypothesis_id → 链路 → 候选（同 target）关联。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.database import ControlDatabase
from src.sorne.schemas import Fact, NegativeEvidence
from src.sorne.store import ProjectStore
from src.sorne.worker import apply_worker_output


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    return store


def _directions_payload(intent_id: str, target: str) -> dict:
    return {
        "kind": "intent",
        "verb": "verify",
        "target": target,
        "evidence_sink": f"evidence/{intent_id}.txt",
        "success_criteria": "确认或否定该目标是否存在真实安全边界突破",
        "hypothesis": f"{target} 登录接口存在认证绕过",
        "scope_check": "项目所有测试目标已统一授权",
        "intent_id": intent_id,
        "action_safety_risk": "low",
    }


def test_entity_split_sample_data_contract(project: ProjectStore) -> None:
    target = "https://example.com/login"
    # 1 条 risk_lead Fact（线索身份）。
    apply_worker_output(project, {
        "kind": "fact", "title": "登录接口疑似认证绕过", "category": "priv_esc_path",
        "classification": "risk_lead", "evidence": "观察到越权样式的响应差异。",
        "business_impact": "可能导致越权访问。", "evidence_path": "",
    })
    # 2 个同 target Direction（方向 ID 由提交链生成）。
    database = ControlDatabase(project.path / "control_plane.db")
    from src.sorne.worker import submit_payload

    for index in range(2):
        payload = _directions_payload("ignored", target)
        payload["hypothesis"] = (
            f"{target} 登录接口存在认证绕过（假设 {index + 1}）"
        )
        submit_payload(
            project, payload,
            source_type="test", gate_required=False,
        )
    direction_ids = [
        str(d["id"]) for d in database.list_directions()
        if str((d.get("intent") or {}).get("target") or "") == target
    ]
    assert len(direction_ids) == 2
    proven_direction = direction_ids[0]
    # 其中一个方向产出漏洞（intent_id 关联）：经完整提交链 + Guardian 认证
    # （非 HTTP 类别，携带真实证据文件与 proof_refs）。
    evidence_file = project.path / "evidence" / "login-bypass.txt"
    request_file = project.path / "evidence" / "login-bypass-request.txt"
    response_file = project.path / "evidence" / "login-bypass-response.txt"
    evidence_file.parent.mkdir(parents=True, exist_ok=True)
    evidence_file.write_text(
        "control=anonymous\nobserved=other-account-data\nexit=0\n", encoding="utf-8",
    )
    request_file.write_text(
        "POST /login HTTP/1.1\r\nHost: example.com\r\n\r\nuser=anonymous\n", encoding="utf-8",
    )
    response_file.write_text(
        "HTTP/1.1 200 OK\r\n\r\n{\"account\": \"other-user\"}\n", encoding="utf-8",
    )
    apply_worker_output(project, {
        "kind": "fact", "title": "登录接口认证绕过", "category": "priv_esc_path",
        "classification": "vulnerability",
        "evidence": "运行对照请求后观察到匿名身份返回了其他账户的业务数据，写入证据文件。",
        "business_impact": "攻击者可读取其他账户的高价值业务数据。",
        "reproduction_steps": ["匿名请求登录接口", "核对返回数据归属"],
        "evidence_path": "evidence/login-bypass.txt",
        "intent_id": proven_direction,
        "evidence_metrics": {
            "boundary_crossed": True,
            "unauthorized_capability_obtained": True,
            "reproducible": True,
            "result_reliable": True,
            "has_raw_request_response": True,
            "proof_refs": {
                "boundary_crossed": ["evidence/login-bypass.txt"],
                "unauthorized_capability_obtained": ["evidence/login-bypass.txt"],
                "raw_request": ["evidence/login-bypass-request.txt"],
                "raw_response": ["evidence/login-bypass-response.txt"],
            },
        },
    })
    # 另一个方向对应负向证据（同 target）。
    from datetime import datetime, timedelta, timezone

    negative = NegativeEvidence(
        hypothesis=f"{target} 登录接口存在认证绕过（假设 2）",
        target=target, reason="对照请求返回 403，未观察到绕过", method="双身份对照",
        valid_until=(
            datetime.now(timezone.utc) + timedelta(hours=24)
        ).isoformat(),
    )
    project.append_jsonl("negative_evidence.jsonl", negative)

    facts = project.read_jsonl("facts.jsonl")
    risk_leads = [f for f in facts if f.get("classification") == "risk_lead"]
    vulnerabilities = [f for f in facts if f.get("classification") == "vulnerability"]
    directions = database.list_directions()
    negatives = project.read_jsonl("negative_evidence.jsonl")

    # 实体数量：线索 1、方向 2、漏洞 1、负向 1（互不虚增）。
    assert len(risk_leads) == 1
    assert len(directions) == 2
    assert len(vulnerabilities) == 1
    assert len(negatives) == 1

    # 关联优先级的数据可用性：
    # 漏洞 → 方向（明确 intent_id）。
    assert vulnerabilities[0]["intent_id"] == proven_direction
    # 方向 → 来源线索/假设：intent 携带 hypothesis_id/source_fact_ids 供链路回溯。
    for direction in directions:
        intent = direction["intent"]
        assert "hypothesis_id" in intent and "source_fact_ids" in intent
        assert direction.get("claimed_by") in (None, "", "worker-1")
    # 负向证据无 intent_id/hypothesis_id 字段 → 前端只能按 target 候选关联，
    # 契约上必须保留 target+hypothesis 文本供候选匹配。
    assert "intent_id" not in negatives[0]
    assert negatives[0]["target"] == target
