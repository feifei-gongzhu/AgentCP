from __future__ import annotations

import json
import hashlib
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .dashboard import render_dashboard
from .database import ControlDatabase
from .directives import authoritative_directives, missing_directive_ids
from .guardian import Guardian
from .metrics import project_asset_inventory
from .planning import intents_for_selected, normalize_plan_batch
from .methodology import derive_bounded_follow_up
from .memory import record_negative_lesson
from .phase import reconcile_phase
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
    normalize_role,
)
from .store import ProjectStore
from .technologies import record_technology_observations
from .target_profile import (
    project_target_priority_blackboard,
    record_routine_target_groups,
    record_target_assessments,
    record_target_profile,
)
from .context_compiler import compile_worker_context


PROMPT_DIR = Path(__file__).resolve().parent / "prompts"
class WorkerError(RuntimeError):
    pass


def build_worker_prompt(
    store: ProjectStore,
    role: str,
    owner_directives: list[dict[str, Any]] | None = None,
    *,
    custom_prompt: str | None = None,
    member_name: str | None = None,
    task_context: dict[str, Any] | None = None,
    retry_delta: str = "",
) -> str:
    prompt, _ = compile_worker_prompt(
        store,
        role,
        owner_directives,
        custom_prompt=custom_prompt,
        member_name=member_name,
        task_context=task_context,
        retry_delta=retry_delta,
    )
    return prompt


def compile_worker_prompt(
    store: ProjectStore,
    role: str,
    owner_directives: list[dict[str, Any]] | None = None,
    *,
    custom_prompt: str | None = None,
    member_name: str | None = None,
    task_context: dict[str, Any] | None = None,
    retry_delta: str = "",
) -> tuple[str, dict[str, Any]]:
    role = normalize_role(role)
    prompt_file = PROMPT_DIR / f"{role}.md"
    if not prompt_file.exists():
        raise WorkerError(f"未知 Worker 角色: {role}")
    open_hints = (
        authoritative_directives(store)
        if owner_directives is None
        else owner_directives
    )
    compiled = compile_worker_context(
        store,
        role,
        task_context=task_context,
        retry_delta=retry_delta,
        owner_directives=open_hints,
    )
    prompt = ""
    if custom_prompt and custom_prompt.strip():
        prompt = (
            "# 项目所有者为当前 Agent 配置的专属提示词（每次调用必传）\n"
            f"适用执行单元：{member_name or role}\n"
            "以下内容是本次模型调用最先接收的项目级持久指令，必须在当前角色职责内执行。"
            "自动重试、恢复执行和后续波次不得删除、替换或省略本节。"
            "若它与项目所有者之后提交的实时指令冲突，以实时指令为准。\n"
            + custom_prompt.strip()
            + "\n\n"
        )
    prompt += (
        "# Sorne 内置角色规则与输出协议\n"
        + prompt_file.read_text(encoding="utf-8")
        + "\n\n# 当前任务所需的编译上下文\n"
        + compiled.render()
    )
    if open_hints:
        prompt += (
            "\n\n# 项目所有者指令（Sorne 内部最高控制优先级）\n"
            "以下指令高于 Controller、Reason、Metacog、Reviewer、Executor 的自动规划和历史决策。"
            "除目标授权范围、检查清单红线和人工门禁外，任何 Agent 不得忽略、降级、改写或要求用户重复确认这些指令。"
            "project 作用域指令会自动沿用到当前 Run；origin_run_id 仅用于审计溯源，绝不能以 Run ID 不一致为由判定失效。"
            "若多条人工指令冲突，先比较 priority，再以 created_at 较新的为准。\n"
            + json.dumps(open_hints, ensure_ascii=False, indent=2)
        )
    manifest = dict(compiled.manifest)
    manifest.update({
        "custom_prompt_chars": len(custom_prompt.strip()) if custom_prompt and custom_prompt.strip() else 0,
        "owner_directive_count": len(open_hints),
        "role_prompt_chars": len(prompt_file.read_text(encoding="utf-8")),
        "final_prompt_chars_before_runtime": len(prompt),
    })
    return prompt, manifest


def submit_payload(
    store: ProjectStore,
    payload: dict[str, Any],
    *,
    source_type: str,
    source_id: str | None = None,
    idempotency_key: str | None = None,
    run_id: str | None = None,
    job_id: str | None = None,
    control_version: int | None = None,
    gate_required: bool = True,
    fault_hook=None,
) -> str:
    """Shared V6 submission service for every writer entry point.

    入口权限（允许不允许提交）由调用方决定：自动 Worker 走
    ``apply_worker_output`` 的门禁；人工入口（CLI）以 ``gate_required=False``
    保留“门禁等待期间仍可人工录入”的原有语义。本函数只负责
    “怎样提交和投影”：CommitPlanner 冻结 → CommitCoordinator 持久化 →
    Projector 应用，全部复用既有投影实现，不新增第二份业务落盘逻辑。
    ``source_type`` 由服务端调用路径赋予，绝不取自模型 Payload。
    """
    from .commits import CommitCoordinator, CommitPlanner, new_source_id

    stable_source = source_id or new_source_id()
    stable_key = idempotency_key or f"{source_type}:{stable_source}:{payload.get('kind', 'unknown')}"
    plan = CommitPlanner().freeze_worker_output(
        payload,
        source_type=source_type,
        source_id=stable_source,
        idempotency_key=stable_key,
        run_id=run_id,
        job_id=job_id,
        control_version=control_version,
    )
    with store.locked():
        if gate_required:
            state = store.load_state()
            if state.gate_status == GateStatus.AWAITING_APPROVAL.value:
                raise WorkerError("强制门禁正在等待用户批准，Worker 输出已拒绝写入。")
        return CommitCoordinator(store, fault_hook=fault_hook).submit(plan)


def apply_worker_output(
    store: ProjectStore,
    payload: dict[str, Any],
    *,
    source_type: str = "direct_worker",
    source_id: str | None = None,
    idempotency_key: str | None = None,
    run_id: str | None = None,
    job_id: str | None = None,
    control_version: int | None = None,
    fault_hook=None,
) -> str:
    return submit_payload(
        store,
        payload,
        source_type=source_type,
        source_id=source_id,
        idempotency_key=idempotency_key,
        run_id=run_id,
        job_id=job_id,
        control_version=control_version,
        gate_required=True,
        fault_hook=fault_hook,
    )


def _apply_worker_output_legacy(store: ProjectStore, payload: dict[str, Any]) -> str:
    state = store.load_state()
    kind = payload.get("kind")
    technology_rows = payload.get("technology_observations") or []
    if isinstance(technology_rows, list):
        from .asset_inventory import AssetInventory

        technology_rows, _discovered, _rejected = AssetInventory(store).filter_profile_records(
            [], technology_rows,
        )
    technology_suffix = ""
    if kind != "fact" and isinstance(technology_rows, list):
        observations = record_technology_observations(
            store,
            technology_rows,
            proposed_by=str(payload.get("proposed_by", "worker")).strip() or "worker",
            hypothesis_id=str(payload.get("hypothesis_id") or "").strip() or None,
            intent_id=str(payload.get("intent_id") or "").strip() or None,
        )
        if observations:
            technology_suffix = f" | 技术观察: {len(observations)} 条"
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
            hypothesis_id=str(payload.get("hypothesis_id") or "").strip() or None,
            intent_id=str(payload.get("intent_id") or "").strip() or None,
            evidence_metrics=dict(payload.get("evidence_metrics") or {}),
        )
        fact = Guardian().review(fact, store.path)
        if fact.status == "vulnerability":
            fact.review_status = HumanReviewStatus.PENDING.value
        store.append_jsonl("facts.jsonl", fact)
        store.append_fact_to_blackboard(fact)
        for evidence_record in _evidence_records(store, fact):
            store.append_jsonl("evidence.jsonl", evidence_record)
        observations = record_technology_observations(
            store,
            technology_rows if isinstance(technology_rows, list) else [],
            proposed_by=fact.proposed_by,
            source_fact_id=fact.id,
            hypothesis_id=fact.hypothesis_id,
            intent_id=fact.intent_id,
        )

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
        derived = derive_bounded_follow_up(
            store,
            fact,
            ControlDatabase(store.path / "control_plane.db"),
        )
        reconcile_phase(store, f"fact_committed:{fact.classification}")
        render_dashboard(store)
        suffix = f" | 派生边界假设: {derived.id}" if derived else ""
        technology_suffix = f" | 技术观察: {len(observations)} 条" if observations else ""
        return f"已写入 Fact: {fact.id} | 状态: {fact.status}{suffix}{technology_suffix}"

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
        record_negative_lesson(store, asdict(negative))
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
        reconcile_phase(store, f"negative_evidence:{negative.evidence_type}")
        render_dashboard(store)
        return f"已写入负向证据: {negative.id} | 类型: {negative.evidence_type}{technology_suffix}"

    if kind == "target_profile_batch":
        rows = payload.get("records") or []
        if not isinstance(rows, list):
            raise WorkerError("目标画像 records 必须是数组。")
        from .asset_inventory import AssetInventory

        rows, _discovered, _rejected = AssetInventory(store).filter_profile_records([], rows)
        proposed_by = str(payload.get("proposed_by") or "profile_mapper").strip() or "profile_mapper"
        recorded = record_target_profile(store, rows, proposed_by=proposed_by)
        assessment_rows = payload.get("assessments") or []
        if not isinstance(assessment_rows, list):
            raise WorkerError("目标画像 assessments 必须是数组。")
        # JEV 影子数据由 commit 路径在冻结前调用模型并写入载荷；此处（含
        # 投影重放）只读取字典，绝不触发新的模型调用。
        jev_shadow = payload.get("jev_shadow")
        assessments = record_target_assessments(
            store, assessment_rows, proposed_by=proposed_by,
            jev_shadow_by_url=jev_shadow if isinstance(jev_shadow, dict) else None,
        )
        routine_rows = payload.get("routine_groups") or []
        if not isinstance(routine_rows, list):
            raise WorkerError("目标画像 routine_groups 必须是数组。")
        routine_groups = record_routine_target_groups(
            store, routine_rows, proposed_by=proposed_by,
        )
        project_target_priority_blackboard(store)
        store.append_jsonl("target_profile_runs.jsonl", {
            "proposed_by": proposed_by,
            "record_count": len(recorded),
            "exploration_complete": bool(payload.get("exploration_complete", False)),
            "reason": str(payload.get("reason") or "").strip()[:1000],
            "created_at": now_iso(),
        })
        render_dashboard(store)
        status = "探索完成" if payload.get("exploration_complete") else "等待后续波次继续探索"
        return (
            f"已写入目标画像: {len(recorded)} 条，评估 {len(assessments)} 条，"
            f"常规信息组 {len(routine_groups)} 条 | {status}{technology_suffix}"
        )

    if kind == "plan_batch":
        proposed_by = str(payload.get("proposed_by") or "worker").strip() or "worker"
        run_id = str(payload.get("run_id") or "").strip() or state.active_run_id
        wave = max(0, int(payload.get("wave", 0)))
        batch, hypotheses = normalize_plan_batch(
            payload,
            proposed_by=proposed_by,
            run_id=run_id,
            wave=wave,
        )
        intents = intents_for_selected(batch, hypotheses)
        by_hypothesis = {str(item.hypothesis_id): item for item in intents}
        for hypothesis in hypotheses:
            linked = by_hypothesis.get(hypothesis.id)
            if linked:
                hypothesis.intent_ids.append(linked.id)
        batch.hypotheses = [asdict(item) for item in hypotheses]
        store.append_jsonl("plan_batches.jsonl", batch)
        if batch.counterfactual:
            store.append_jsonl("counterfactuals.jsonl", batch.counterfactual)
        database = ControlDatabase(store.path / "control_plane.db")
        for hypothesis in hypotheses:
            store.append_jsonl("hypotheses.jsonl", hypothesis)
        for intent in intents:
            reviewed = Guardian().review_intent(intent, store.read_json("target.json"))
            store.append_jsonl("intents.jsonl", reviewed)
            database.register_direction(asdict(reviewed))
        if any(item.action_safety_risk in {"high", "critical"} for item in intents):
            state = store.load_state()
            state.gate_status = GateStatus.AWAITING_APPROVAL.value
            state.gate_reason = (
                f"PlanBatch {batch.id} 含高操作安全风险动作，已暂停等待人工批准。"
            )
            state.current_decision = "request_confirmation"
            store.save_state(state)
        reconcile_phase(store, "plan_batch_committed")
        render_dashboard(store)
        return f"已写入 PlanBatch: {batch.id} | 选中 {len(intents)}/{len(hypotheses)} 个假设{technology_suffix}"

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
            hypothesis_id=str(payload.get("hypothesis_id") or "").strip() or None,
            source_fact_ids=[str(item) for item in payload.get("source_fact_ids", []) if str(item).strip()],
            target_profile_id=str(payload.get("target_profile_id") or "").strip() or None,
            target_score=(
                max(0, min(100, int(payload["target_score"])))
                if payload.get("target_score") is not None else None
            ),
            risk_tags=[str(item)[:80] for item in payload.get("risk_tags", [])[:12]],
            recommended_tests=[str(item)[:100] for item in payload.get("recommended_tests", [])[:8]],
            potential_impact=float(payload.get("potential_impact", 0.0)),
            boundary_reachability=float(payload.get("boundary_reachability", 0.0)),
            information_gain=float(payload.get("information_gain", 0.0)),
            novelty=float(payload.get("novelty", 0.0)),
            prerequisite_readiness=float(payload.get("prerequisite_readiness", 0.0)),
            estimated_cost=float(payload.get("estimated_cost", 0.5)),
            action_safety_risk=str(payload.get("action_safety_risk", "low")).strip().lower() or "low",
            evidence_maturity=str(payload.get("evidence_maturity", "hypothesis")).strip() or "hypothesis",
            priority_score=float(payload.get("priority_score", 0.0)),
            risk_level=str(payload.get("risk_level", "low")).strip(),
            requires_human_confirmation=False,
            proposed_by=str(payload.get("proposed_by", "worker")).strip() or "worker",
            parent_id=payload.get("parent_id"),
            chain_id=payload.get("chain_id"),
            sequence=int(payload.get("sequence", 0)),
        )
        if not all([intent.verb, intent.target, intent.evidence_sink, intent.success_criteria, intent.scope_check]):
            raise WorkerError("Intent 缺少 verb/target/evidence_sink/success_criteria/scope_check，已拒绝写入。")
        intent = Guardian().review_intent(intent, store.read_json("target.json"))
        if intent.action_safety_risk not in {"low", "medium", "high", "critical", "unknown"}:
            raise WorkerError("Intent action_safety_risk 非法。")
        intent.requires_human_confirmation = intent.action_safety_risk in {"high", "critical"}
        store.append_jsonl("intents.jsonl", intent)
        ControlDatabase(store.path / "control_plane.db").register_direction(asdict(intent))
        if intent.requires_human_confirmation:
            state = store.load_state()
            state.gate_status = GateStatus.AWAITING_APPROVAL.value
            state.gate_reason = f"敏感验证 Intent {intent.id} 需要人工确认；这表示动作需审批，不代表已确认高危漏洞。"
            state.current_decision = "request_confirmation"
            store.save_state(state)
        render_dashboard(store)
        return f"已写入 Intent: {intent.id}{technology_suffix}"

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
        return f"已写入 Decision: {decision.id} | 动作: {decision.action}{technology_suffix}"

    if kind == "none":
        return f"Worker 无输出: {payload.get('reason', '未提供原因')}{technology_suffix}"

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
    files = (
        [resolved]
        if resolved.is_file()
        else sorted(
            item
            for item in resolved.rglob("*")
            if item.is_file() and not item.name.endswith(".sha256")
        )
    )
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
    task: str | None = None,
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
            task=task,
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
    task: str | None = None,
) -> str:
    role = normalize_role(role)
    task_text = str(task or "").strip()
    task_context = {"调度任务": task_text} if task_text else None
    owner_directives = authoritative_directives(store)
    prompt = build_worker_prompt(store, role, owner_directives, task_context=task_context)
    if dry_run:
        return prompt

    if apply_output:
        payload = json.loads(apply_output.read_text(encoding="utf-8"))
        return apply_worker_output(store, payload)

    if role == "executor" and not task_context:
        # executor 要求明确任务：单次入口必须由 --task 提供（或改用 automate
        # 由调度器认领 Direction），不得让模型自行补选目标。
        raise WorkerError(
            "executor 角色需要明确任务：请用 --task 提供本次执行的任务说明"
            "（目标、动作与成功标准），或改用 automate 由调度器分配已认领 Intent。"
        )

    target = store.read_json("target.json")
    if target.get("authorization") != "authorized" or not target.get("scope"):
        raise WorkerError("项目尚未确认授权范围，禁止启动真实 Worker。")

    # 走共享执行服务（execution.run_member）：CLI 通道由此获得与 run-team/
    # 自动化一致的脱敏 Prompt 快照、RuntimeSecret 注入与运行目录约定。
    # CLI 默认 runtime 显式固定为 local-docker（与原 run_driver 兜底一致，
    # 不因复用 TeamMember 而改变默认执行环境）。
    from .execution import run_member
    from .team import TeamMember

    context_suffix = (
        json.dumps(task_context, ensure_ascii=False, indent=2)
        if task_context else ""
    )
    member = TeamMember(
        name=role,
        type=backend,
        backend=backend,
        role=role,
        runtime_mode="local-docker",
        model=model,
        base_url=base_url,
        api_key_env=api_key_env,
        auth_mode=auth_mode,
        profile=profile,
        sandbox=sandbox,
        dangerously_bypass_sandbox=dangerously_bypass_sandbox,
        env=env or {},
    )
    result = run_member(store, member, timeout=timeout, dry_run=False,
                        context_suffix=context_suffix)
    payload = result["payload"]
    missing = missing_directive_ids(
        store, result["control_context"]["human_directive_ids"],
    )
    if missing:
        raise WorkerError(
            "模型执行期间收到新的项目所有者指令，旧上下文输出已拒绝写入: "
            + ", ".join(missing)
        )
    return apply_worker_output(store, payload)
