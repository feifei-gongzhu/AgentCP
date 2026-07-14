from __future__ import annotations

import json
import hashlib
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .dashboard import render_dashboard
from .drivers import DriverConfig, run_driver
from .guardian import Guardian
from .metrics import project_asset_inventory
from .lifecycle import project_execution_lock, require_initialized_project
from .schemas import Decision, Fact, GateStatus, Intent, new_id, now_iso
from .store import ProjectStore


PROMPT_DIR = Path(__file__).resolve().parent / "prompts"
class WorkerError(RuntimeError):
    pass


def build_worker_prompt(store: ProjectStore, role: str) -> str:
    prompt_file = PROMPT_DIR / f"{role}.md"
    if not prompt_file.exists():
        raise WorkerError(f"未知 Worker 角色: {role}")

    state = asdict(store.load_state())
    context = {
        "state": state,
        "target": store.read_json("target.json"),
        "checklist": store.read_json("checklist.json"),
        "recent_facts": store.read_jsonl("facts.jsonl")[-8:],
        "recent_intents": store.read_jsonl("intents.jsonl")[-8:],
        "recent_decisions": store.read_jsonl("decision_log.jsonl")[-5:],
        "open_hints": [item for item in store.read_jsonl("hints.jsonl") if item.get("status") == "open"][-8:],
        "attack_surface_coverage": state.get("attack_surface_coverage", {}),
    }
    return (
        prompt_file.read_text(encoding="utf-8")
        + "\n\n当前项目上下文如下：\n"
        + json.dumps(context, ensure_ascii=False, indent=2)
    )


def apply_worker_output(store: ProjectStore, payload: dict[str, Any]) -> str:
    state = store.load_state()
    if state.gate_status == GateStatus.AWAITING_APPROVAL.value:
        raise WorkerError("强制门禁正在等待用户批准，Worker 输出已拒绝写入。")
    kind = payload.get("kind")
    if kind == "fact":
        fact = Fact(
            title=str(payload.get("title", "")).strip(),
            category=str(payload.get("category", "other")).strip() or "other",
            evidence=str(payload.get("evidence", "")).strip(),
            assets=list(dict.fromkeys(str(item).strip() for item in payload.get("assets", []) if str(item).strip())),
            severity=str(payload.get("severity", "unknown")).strip() or "unknown",
            confidence=float(payload.get("confidence", 0.5)),
            impact_score=float(payload.get("impact_score", 0.0)),
            classification=str(payload.get("classification", "attack_surface")).strip() or "attack_surface",
            business_impact=str(payload.get("business_impact", "")).strip(),
            reproduction_steps=[str(item) for item in payload.get("reproduction_steps", [])],
            evidence_path=str(payload.get("evidence_path", "")).strip(),
            proposed_by=str(payload.get("proposed_by", "worker")).strip() or "worker",
        )
        fact = Guardian().review(fact, store.path)
        store.append_jsonl("facts.jsonl", fact)
        store.append_fact_to_blackboard(fact)
        for evidence_record in _evidence_records(store, fact):
            store.append_jsonl("evidence.jsonl", evidence_record)

        state = store.load_state()
        state.fact_count += 1
        state.asset_count = len(project_asset_inventory(store))
        if fact.status == "vulnerability":
            state.vulnerability_count += 1
        state.last_discovery_at = fact.created_at
        if fact.category in state.attack_surface_coverage:
            state.attack_surface_coverage[fact.category] = (
                "verified" if fact.status == "vulnerability" else "observed"
            )
        store.save_state(state)
        render_dashboard(store)
        return f"已写入 Fact: {fact.id} | 状态: {fact.status}"

    if kind == "intent":
        intent = Intent(
            verb=str(payload.get("verb", "")).strip(),
            target=str(payload.get("target", "")).strip(),
            evidence_sink=str(payload.get("evidence_sink", "")).strip(),
            success_criteria=str(payload.get("success_criteria", "")).strip(),
            scope_check=str(payload.get("scope_check", "")).strip(),
            scope_refs=[str(item) for item in payload.get("scope_refs", [])],
            expected_business_impact=str(payload.get("expected_business_impact", "")).strip(),
            risk_level=str(payload.get("risk_level", "low")).strip(),
            requires_human_confirmation=bool(payload.get("requires_human_confirmation", False)),
            proposed_by=str(payload.get("proposed_by", "worker")).strip() or "worker",
            parent_id=payload.get("parent_id"),
            chain_id=payload.get("chain_id"),
            sequence=int(payload.get("sequence", 0)),
        )
        if not all([intent.verb, intent.target, intent.evidence_sink, intent.success_criteria, intent.scope_check]):
            raise WorkerError("Intent 缺少 verb/target/evidence_sink/success_criteria/scope_check，已拒绝写入。")
        intent = Guardian().review_intent(intent, store.read_json("target.json"))
        if intent.risk_level in {"high", "critical"}:
            intent.requires_human_confirmation = True
        store.append_jsonl("intents.jsonl", intent)
        if intent.requires_human_confirmation:
            state = store.load_state()
            state.gate_status = GateStatus.AWAITING_APPROVAL.value
            state.gate_reason = f"敏感验证 Intent {intent.id} 需要人工确认；这表示动作需审批，不代表已确认高危漏洞。"
            state.current_decision = "request_confirmation"
            store.save_state(state)
        render_dashboard(store)
        return f"已写入 Intent: {intent.id}"

    if kind == "decision":
        state = store.load_state()
        decision = Decision(
            action=str(payload.get("action", "request_confirmation")),
            reason=str(payload.get("reason", "")).strip(),
            phase=state.phase,
            focus_cost=payload.get("focus_cost"),
            counterfactual_hypothesis=payload.get("counterfactual_hypothesis"),
            ignored_evidence=payload.get("ignored_evidence"),
            override_rule=payload.get("override_rule"),
            serendipity_minutes=int(payload.get("serendipity_minutes", 0)),
        )
        if not decision.reason:
            raise WorkerError("Decision 缺少 reason，已拒绝写入。")
        store.append_jsonl("decision_log.jsonl", decision)
        state.current_decision = decision.action
        if decision.action == "request_confirmation":
            state.gate_status = GateStatus.AWAITING_APPROVAL.value
            state.gate_reason = decision.reason
        state.serendipity_used_minutes += decision.serendipity_minutes
        store.save_state(state)
        render_dashboard(store)
        return f"已写入 Decision: {decision.id} | 动作: {decision.action}"

    if kind == "none":
        return f"Worker 无输出: {payload.get('reason', '未提供原因')}"

    raise WorkerError(f"未知 Worker 输出 kind: {kind}")


def _evidence_records(store: ProjectStore, fact: Fact) -> list[dict[str, Any]]:
    if not fact.evidence_path:
        return []
    relative = Path(fact.evidence_path)
    if relative.is_absolute():
        return []
    resolved = (store.path / relative).resolve()
    allowed = (store.path / "evidence").resolve()
    try:
        resolved.relative_to(allowed)
    except ValueError:
        return []
    files = [resolved] if resolved.is_file() else sorted(item for item in resolved.rglob("*") if item.is_file())
    records: list[dict[str, Any]] = []
    for file in files:
        if file.stat().st_size == 0:
            continue
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        records.append({
            "id": new_id("E"),
            "fact_id": fact.id,
            "path": file.relative_to(store.path).as_posix(),
            "sha256": digest,
            "size_bytes": file.stat().st_size,
            "created_at": now_iso(),
        })
    return records


def run_worker(
    store: ProjectStore,
    role: str,
    backend: str,
    model: str | None = None,
    profile: str | None = None,
    timeout: int = 300,
    sandbox: str = "read-only",
    dangerously_bypass_sandbox: bool = False,
    base_url: str | None = None,
    api_key_env: str | None = None,
    auth_mode: str = "auto",
    env: dict[str, str] | None = None,
    dry_run: bool = False,
    apply_output: Path | None = None,
) -> str:
    with project_execution_lock(store):
        require_initialized_project(store)
        return _run_worker_locked(
            store=store,
            role=role,
            backend=backend,
            model=model,
            profile=profile,
            timeout=timeout,
            sandbox=sandbox,
            dangerously_bypass_sandbox=dangerously_bypass_sandbox,
            base_url=base_url,
            api_key_env=api_key_env,
            auth_mode=auth_mode,
            env=env,
            dry_run=dry_run,
            apply_output=apply_output,
        )


def _run_worker_locked(
    store: ProjectStore,
    role: str,
    backend: str,
    model: str | None = None,
    profile: str | None = None,
    timeout: int = 300,
    sandbox: str = "read-only",
    dangerously_bypass_sandbox: bool = False,
    base_url: str | None = None,
    api_key_env: str | None = None,
    auth_mode: str = "auto",
    env: dict[str, str] | None = None,
    dry_run: bool = False,
    apply_output: Path | None = None,
) -> str:
    prompt = build_worker_prompt(store, role)
    if dry_run:
        return prompt

    if apply_output:
        payload = json.loads(apply_output.read_text(encoding="utf-8"))
        return apply_worker_output(store, payload)

    target = store.read_json("target.json")
    if target.get("authorization") != "authorized" or not target.get("scope"):
        raise WorkerError("项目尚未确认授权范围，禁止启动真实 Worker。")

    payload = run_driver(DriverConfig(
        type=backend,
        model=model,
        profile=profile,
        sandbox=sandbox,
        base_url=base_url,
        api_key_env=api_key_env,
        auth_mode=auth_mode,
        env=env or {},
        dangerously_bypass_sandbox=dangerously_bypass_sandbox,
    ), prompt, timeout=timeout)
    return apply_worker_output(store, payload)
