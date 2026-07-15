from __future__ import annotations

import json
import hashlib
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .dashboard import render_dashboard
from .database import ControlDatabase
from .directives import authoritative_directives, directive_ids, missing_directive_ids
from .drivers import DriverConfig, run_driver
from .guardian import Guardian
from .metrics import project_asset_inventory
from .lifecycle import project_execution_lock, require_initialized_project
from .schemas import (
    Decision,
    Fact,
    GateStatus,
    HumanReviewStatus,
    Intent,
    NegativeEvidence,
    WAFAssessment,
    new_id,
    now_iso,
)
from .store import ProjectStore
from .waf import WAFManager


PROMPT_DIR = Path(__file__).resolve().parent / "prompts"
class WorkerError(RuntimeError):
    pass


def build_worker_prompt(
    store: ProjectStore,
    role: str,
    owner_directives: list[dict[str, Any]] | None = None,
) -> str:
    prompt_file = PROMPT_DIR / f"{role}.md"
    if not prompt_file.exists():
        raise WorkerError(f"未知 Worker 角色: {role}")

    state = asdict(store.load_state())
    directions = (
        ControlDatabase(store.path / "control_plane.db").list_directions()
        if (store.path / "control_plane.db").exists() else []
    )
    human_dismissed = [
        item for item in directions
        if item.get("status") == "cancelled"
        and str(item.get("terminal_reason") or "").startswith("human_dismissed:")
    ]
    dismissed_ids = {str(item.get("id")) for item in human_dismissed}
    recent_intents = [
        item for item in store.read_jsonl("intents.jsonl")
        if str(item.get("id")) not in dismissed_ids
    ][-8:]
    open_hints = (
        authoritative_directives(store)
        if owner_directives is None
        else owner_directives
    )
    context = {
        "state": state,
        "target": store.read_json("target.json"),
        "checklist": store.read_json("checklist.json"),
        "recent_facts": store.read_jsonl("facts.jsonl")[-8:],
        "recent_intents": recent_intents,
        "human_dismissed_directions": human_dismissed[-8:],
        "recent_decisions": store.read_jsonl("decision_log.jsonl")[-5:],
        "recent_negative_evidence": store.read_jsonl("negative_evidence.jsonl")[-8:],
        "human_refutation_memory": [
            item for item in store.read_jsonl("refutation_memories.jsonl")
            if item.get("active", True)
        ][-8:],
        "open_waf_branches": WAFManager().active(store)[-6:],
        "project_owner_directives": open_hints,
        "attack_surface_coverage": state.get("attack_surface_coverage", {}),
    }
    prompt = (
        prompt_file.read_text(encoding="utf-8")
        + "\n\n当前项目上下文如下：\n"
        + json.dumps(context, ensure_ascii=False, indent=2)
    )
    if open_hints:
        prompt += (
            "\n\n# 项目所有者指令（AgentCP 内部最高控制优先级）\n"
            "以下指令高于 Controller、Reason、Metacog、Reviewer、Executor 的自动规划和历史决策。"
            "除目标授权范围、检查清单红线和人工门禁外，任何 Agent 不得忽略、降级、改写或要求用户重复确认这些指令。"
            "project 作用域指令会自动沿用到当前 Run；origin_run_id 仅用于审计溯源，绝不能以 Run ID 不一致为由判定失效。"
            "若多条人工指令冲突，先比较 priority，再以 created_at 较新的为准。\n"
            + json.dumps(open_hints, ensure_ascii=False, indent=2)
        )
    return prompt


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
            evidence_metrics=dict(payload.get("evidence_metrics") or {}),
        )
        fact = Guardian().review(fact, store.path)
        if fact.status == "vulnerability":
            fact.review_status = HumanReviewStatus.PENDING.value
        store.append_jsonl("facts.jsonl", fact)
        store.append_fact_to_blackboard(fact)
        for evidence_record in _evidence_records(store, fact):
            store.append_jsonl("evidence.jsonl", evidence_record)

        state = store.load_state()
        state.fact_count += 1
        state.asset_count = len(project_asset_inventory(store))
        if fact.status == "vulnerability":
            state.vulnerability_count += 1
            state.pending_human_review_count += 1
        state.last_discovery_at = fact.created_at
        if fact.category in state.attack_surface_coverage:
            state.attack_surface_coverage[fact.category] = (
                "verified" if fact.status == "vulnerability" else "observed"
            )
        store.save_state(state)
        render_dashboard(store)
        return f"已写入 Fact: {fact.id} | 状态: {fact.status}"

    if kind == "negative_evidence":
        valid_until = str(payload.get("valid_until", "")).strip()
        if not valid_until:
            valid_until = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        negative = NegativeEvidence(
            hypothesis=str(payload.get("hypothesis", "")).strip(),
            target=str(payload.get("target", "")).strip(),
            reason=str(payload.get("reason", "")).strip(),
            method=str(payload.get("method", "")).strip(),
            valid_until=valid_until,
            outcome=str(payload.get("outcome", "blocked")).strip() or "blocked",
            evidence_type=str(payload.get("evidence_type", "inconclusive")).strip() or "inconclusive",
            network_context=str(payload.get("network_context", "default_egress")).strip() or "default_egress",
            identity_context=str(payload.get("identity_context", "anonymous")).strip() or "anonymous",
            attempts=max(1, int(payload.get("attempts", 1))),
            evidence_paths=[str(item) for item in payload.get("evidence_paths", [])],
            invalidation_triggers=[
                str(item) for item in payload.get(
                    "invalidation_triggers",
                    ["ip_changed", "network_egress_changed", "user_forced"],
                )
            ],
            proposed_by=str(payload.get("proposed_by", "worker")).strip() or "worker",
        )
        if not all([negative.hypothesis, negative.target, negative.reason, negative.method]):
            raise WorkerError("NegativeEvidence 缺少 hypothesis/target/reason/method。")
        store.append_jsonl("negative_evidence.jsonl", negative)
        waf_text = f"{negative.reason} {negative.outcome}".casefold()
        if negative.evidence_type == "environment_blocked" and any(
            marker in waf_text for marker in ("waf", "firewall", "403", "429", "拦截", "防火墙")
        ):
            assessment = WAFAssessment(
                target=negative.target,
                original_hypothesis=negative.hypothesis,
                signals=[negative.reason],
                blocked_evidence=list(negative.evidence_paths),
                source_negative_evidence_id=negative.id,
            )
            store.append_jsonl("waf_assessments.jsonl", assessment)
        render_dashboard(store)
        return f"已写入负向证据: {negative.id} | 类型: {negative.evidence_type}"

    if kind == "intent":
        intent = Intent(
            verb=str(payload.get("verb", "")).strip(),
            target=str(payload.get("target", "")).strip(),
            evidence_sink=str(payload.get("evidence_sink", "")).strip(),
            success_criteria=str(payload.get("success_criteria", "")).strip(),
            hypothesis=str(payload.get("hypothesis", "")).strip(),
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
    owner_directives = authoritative_directives(store)
    prompt = build_worker_prompt(store, role, owner_directives)
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
    missing = missing_directive_ids(store, directive_ids(owner_directives))
    if missing:
        raise WorkerError(
            "模型执行期间收到新的项目所有者指令，旧上下文输出已拒绝写入: "
            + ", ".join(missing)
        )
    return apply_worker_output(store, payload)
