import json
from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane.database import ControlDatabase
from src.agent_control_plane.methodology import ensure_methodology
from src.agent_control_plane.planning import intents_for_selected, normalize_plan_batch
from src.agent_control_plane.schemas import GateStatus
from src.agent_control_plane.phase import reconcile_phase
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.worker import apply_worker_output


def _project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str = "v3") -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore(name)
    store.init()
    return store


def test_web_method_pack_generates_checklist_and_ten_seed_hypotheses(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch, "web-pack")
    target = store.read_json("target.json")
    target.update({
        "targets": ["https://app.example.com"],
        "project_type": "Web 渗透",
        "out_of_scope": ["第三方支付生产环境"],
    })
    store.write_json("target.json", target)

    result = ensure_methodology(store, ControlDatabase(store.path / "control_plane.db"))

    pack = store.read_json("method_pack.json")
    checklist = store.read_json("checklist.json")
    assert result["method_pack"] == "agentcp-web-v3"
    assert len(pack["dimensions"]) == 10
    assert {item["id"] for item in pack["dimensions"]} == {
        "api_endpoint", "listening_port_service", "priv_esc_path", "asset_web_directory",
        "framework_config", "parser_target", "supply_chain_third_party", "credential_leak",
        "cloud_entitlement", "business_logic",
    }
    assert checklist["method_pack_id"] == "agentcp-web-v3"
    assert "第三方支付生产环境" in checklist["red_lines"]
    assert len(store.read_jsonl("hypotheses.jsonl")) == 10
    assert len(store.read_jsonl("intents.jsonl")) == 10
    assert len(ControlDatabase(store.path / "control_plane.db").list_directions()) == 10
    assert store.load_state().phase == "phase_0_5_probe"

    second = ensure_methodology(store, ControlDatabase(store.path / "control_plane.db"))
    assert second["seeded"] == 0
    assert len(store.read_jsonl("hypotheses.jsonl")) == 10


def test_plan_batch_scores_and_prefers_orthogonal_hypotheses() -> None:
    def hypothesis(title: str, target: str, dimension: str, impact: float) -> dict:
        return {
            "title": title,
            "statement": f"{target} 的 {dimension} 边界可能存在缺陷",
            "target": target,
            "dimension": dimension,
            "validation_plan": {
                "verb": "inspect",
                "evidence_sink": f"evidence/{title}.txt",
                "success_criteria": "得到可复核结果",
            },
            "expected_business_impact": "可能影响账户或敏感数据边界",
            "potential_impact": impact,
            "boundary_reachability": 0.8,
            "information_gain": 0.8,
            "novelty": 0.8,
            "prerequisite_readiness": 0.8,
            "estimated_cost": 0.2,
            "action_safety_risk": "low",
        }

    batch, candidates = normalize_plan_batch({
        "kind": "plan_batch",
        "hypotheses": [
            hypothesis("A", "a.example", "api_endpoint", 1.0),
            hypothesis("A2", "a.example", "api_endpoint", 0.95),
            hypothesis("B", "b.example", "business_logic", 0.9),
            hypothesis("C", "c.example", "credential_leak", 0.8),
        ],
    }, max_selected=3)

    selected = [item for item in candidates if item.id in batch.selected_hypothesis_ids]
    assert len(selected) == 3
    assert len({item.dimension for item in selected}) == 3
    assert len({item.target for item in selected}) == 3
    assert all(0.0 <= item.score <= 1.0 for item in candidates)
    intents = intents_for_selected(batch, candidates)
    assert {item.hypothesis_id for item in intents} == set(batch.selected_hypothesis_ids)
    assert all(item.priority_score > 0 for item in intents)


def test_potential_impact_does_not_trigger_gate_but_action_safety_risk_does(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch, "gate-separation")
    common = {
        "kind": "intent",
        "verb": "verify",
        "target": "https://app.example.com/account/1",
        "evidence_sink": "evidence/account-boundary.txt",
        "success_criteria": "得到两组身份的可复核对照结果",
        "scope_check": "项目所有测试目标已由所有者统一授权",
        "scope_refs": ["*"],
        "expected_business_impact": "若成立可能未授权读取其他账户数据",
        "potential_impact": 1.0,
        "risk_level": "critical",
    }

    apply_worker_output(store, dict(common, action_safety_risk="low"))
    assert store.load_state().gate_status == GateStatus.RUNNING.value
    first = store.read_jsonl("intents.jsonl")[-1]
    assert first["risk_level"] == "critical"
    assert first["requires_human_confirmation"] is False
    directions = ControlDatabase(store.path / "control_plane.db").list_directions()
    assert [item["intent"]["id"] for item in directions] == [first["id"]]

    apply_worker_output(store, dict(common, target="https://app.example.com/destructive-check", action_safety_risk="high"))
    assert store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value
    second = store.read_jsonl("intents.jsonl")[-1]
    assert second["requires_human_confirmation"] is True
    directions = ControlDatabase(store.path / "control_plane.db").list_directions()
    assert {item["intent"]["id"] for item in directions} == {first["id"], second["id"]}
    assert "动作需审批" in str(store.load_state().gate_reason)


def test_applied_plan_batch_persists_hypothesis_intent_graph(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch, "plan-graph")
    payload = {
        "kind": "plan_batch",
        "run_id": "R-v3",
        "wave": 2,
        "strategy_summary": "用两条正交路径检验边界",
        "counterfactual": {
            "claim": "对象标识实际由服务端强绑定当前身份",
            "falsification_criteria": "替换标识后返回其他账户的差异化数据",
            "target": "https://api.example.com/profile/1",
            "source": "metacog",
        },
        "hypotheses": [{
            "title": "对象越权假设",
            "statement": "不同账户的对象标识可能缺少所有权校验",
            "target": "https://api.example.com/profile/1",
            "dimension": "priv_esc_path",
            "validation_plan": {
                "verb": "verify",
                "evidence_sink": "evidence/idor.txt",
                "success_criteria": "得到两个身份的请求响应对照",
            },
            "expected_business_impact": "可能未授权读取账户资料",
            "potential_impact": 0.9,
            "boundary_reachability": 0.7,
            "information_gain": 0.9,
            "novelty": 0.8,
            "prerequisite_readiness": 0.8,
            "estimated_cost": 0.2,
            "action_safety_risk": "low",
        }],
    }

    apply_worker_output(store, payload)

    batch = store.read_jsonl("plan_batches.jsonl")[-1]
    hypothesis = store.read_jsonl("hypotheses.jsonl")[-1]
    intent = store.read_jsonl("intents.jsonl")[-1]
    assert batch["run_id"] == "R-v3" and batch["wave"] == 2
    counterfactual = store.read_jsonl("counterfactuals.jsonl")[-1]
    assert counterfactual["id"] == batch["counterfactual"]["id"]
    assert counterfactual["linked_hypothesis_ids"] == [hypothesis["id"]]
    assert hypothesis["intent_ids"] == [intent["id"]]
    assert intent["hypothesis_id"] == hypothesis["id"]
    assert intent["chain_id"] == hypothesis["id"]
    registered = ControlDatabase(store.path / "control_plane.db").list_directions()[0]
    assert registered["intent"]["hypothesis_id"] == hypothesis["id"]


def test_observed_attack_surface_creates_only_one_adjacent_boundary_follow_up(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch, "bounded-follow-up")
    target = store.read_json("target.json")
    target.update({"targets": ["https://api.example.com"], "project_type": "Web 渗透"})
    store.write_json("target.json", target)
    ensure_methodology(store, ControlDatabase(store.path / "control_plane.db"))
    baseline_hypotheses = len(store.read_jsonl("hypotheses.jsonl"))
    evidence = store.path / "evidence" / "api-observed.txt"
    evidence.write_text("GET /api/profile/1 returned HTTP 401 with a stable JSON response\n", encoding="utf-8")
    fact = {
        "kind": "fact",
        "title": "已观察到资料 API",
        "category": "api_endpoint",
        "classification": "attack_surface",
        "assets": ["https://api.example.com/api/profile/1"],
        "evidence": "运行匿名 GET 请求，观察到 HTTP 401 和稳定 JSON 响应结构。",
        "business_impact": "当前只确认 API 攻击面，尚未形成未授权读取的漏洞闭环。",
        "reproduction_steps": ["请求路径", "记录状态与响应结构"],
        "evidence_path": "evidence/api-observed.txt",
        "severity": "unknown",
        "confidence": 0.8,
        "impact_score": 0.1,
    }

    first_message = apply_worker_output(store, fact)
    apply_worker_output(store, fact)

    follow_ups = [
        item for item in store.read_jsonl("hypotheses.jsonl")
        if item.get("source") == "fact_follow_up"
    ]
    assert len(store.read_jsonl("hypotheses.jsonl")) == baseline_hypotheses + 1
    assert len(follow_ups) == 1
    assert follow_ups[0]["dimension"] == "priv_esc_path"
    assert len(follow_ups[0]["parent_fact_ids"]) == 1
    assert "派生边界假设" in first_message
    assert store.load_state().phase == "recon"


def test_phase_progression_is_evidence_driven_and_monotonic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch, "phase-machine")
    target = store.read_json("target.json")
    target.update({"targets": ["https://example.com"], "project_type": "Web 渗透"})
    store.write_json("target.json", target)
    ensure_methodology(store, ControlDatabase(store.path / "control_plane.db"))
    assert store.load_state().phase == "phase_0_5_probe"

    state = store.load_state()
    state.fact_count = 1
    store.save_state(state)
    assert reconcile_phase(store, "test_fact") == "recon"

    store.append_jsonl("plan_batches.jsonl", {"id": "PB-test", "hypotheses": []})
    assert reconcile_phase(store, "test_plan") == "hunt"

    state = store.load_state()
    state.vulnerability_count = 1
    state.pending_human_review_count = 1
    store.save_state(state)
    assert reconcile_phase(store, "test_candidate") == "verify"

    state = store.load_state()
    state.pending_human_review_count = 0
    state.human_confirmed_count = 1
    store.save_state(state)
    assert reconcile_phase(store, "test_confirmed") == "report"

    state = store.load_state()
    state.fact_count = 0
    state.vulnerability_count = 0
    state.human_confirmed_count = 0
    store.save_state(state)
    assert reconcile_phase(store, "delayed_old_write") == "report"
    assert [item["to"] for item in store.read_jsonl("phase_events.jsonl")] == [
        "phase_0_5_probe", "recon", "hunt", "verify", "report",
    ]
