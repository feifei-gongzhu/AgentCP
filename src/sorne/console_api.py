"""P4 控制台聚合 API（实施方案 §11 前端与配置体验）。

把分散在 role_registry / plan_graph / skill_router / analysis_* /
resource_repository / engine_adapters 的服务端能力聚合成前端可直接渲染的
载荷。所有状态区分都来自真实数据（团队配置、方向/依赖、任务、引擎可用性、
分析记录），不做任何“看起来可用”的推断。

健康状态枚举（§11）：
ready / running / waiting_dependency / no_matching_task /
capability_missing / blocked / disabled
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import role_registry
from . import tool_registry
from .analysis_registry import ANALYSIS_SCHEMA_VERSION, analyzer_enabled, analyzer_status
from .skill_registry import skill_cards, skill_ids_for_role, skill_status

HEALTH_STATES = (
    "ready", "running", "waiting_dependency", "no_matching_task",
    "capability_missing", "blocked", "disabled",
)

# 角色 → 引擎类核心能力（capability_missing 判定；查询/提交类能力不算）
ROLE_ENGINE_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "recon": ("url_scan", "ip_scan", "subdomain_scan", "dir_scan", "js_scan"),
    "crack": ("pwd_crack",),
    "poc": ("poc_scan",),
}


def _database_of(store):
    from .database import ControlDatabase

    return ControlDatabase(store.path / "control_plane.db")


def _engine_status() -> dict[str, dict[str, Any]]:
    from .engine_adapters import engine_adapter_status

    return engine_adapter_status()


def _load_members(store) -> list[dict[str, Any]]:
    from .schemas import normalize_role
    from .store import ROOT

    path = store.path / "team_config.json"
    if not path.is_file():
        path = ROOT / "teams" / "default.json"
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    members = []
    for raw in config.get("members", []) if isinstance(config, dict) else []:
        if not isinstance(raw, dict):
            continue
        try:
            role = normalize_role(raw.get("role"))
        except ValueError:
            continue
        members.append({**raw, "role": role})
    return members


def _task_summary(job: dict[str, Any]) -> dict[str, Any]:
    payload = {}
    try:
        payload = json.loads(job.get("payload_json") or "{}")
    except (TypeError, json.JSONDecodeError):
        payload = {}
    intent = payload.get("intent") if isinstance(payload.get("intent"), dict) else payload
    return {
        "job_id": job.get("id"),
        "status": job.get("status"),
        "stage": job.get("stage"),
        "verb": str(intent.get("verb") or ""),
        "target": str(intent.get("target") or ""),
        "hypothesis": str(intent.get("hypothesis") or ""),
        "task_id": str(intent.get("id") or "") or None,
        "error": job.get("error"),
        "attempts": job.get("attempts"),
        "updated_at": job.get("updated_at"),
    }


def _open_directions(database) -> list[dict[str, Any]]:
    return [
        direction for direction in database.list_directions()
        if str(direction.get("status")) in {"open", "queued", "claimed", "waiting"}
    ]


def _auth_service_signal(store) -> bool:
    """是否存在口令/认证服务候选（crack 的“等待匹配服务”判定）。"""
    for row in store.read_jsonl("technology_observations.jsonl"):
        category = str(row.get("category") or "").casefold()
        if category == "authentication":
            return True
    for fact in store.read_jsonl("facts.jsonl"):
        text = f"{fact.get('title', '')} {fact.get('evidence', '')}".casefold()
        if any(word in text for word in ("登录口令", "口令服务", "密码服务", "credential service")):
            return True
    return False


def role_health(store) -> dict[str, Any]:
    """七张角色卡数据（§11：职责/模型/运行时/能力/技能/当前任务/健康状态）。"""
    database = _database_of(store)
    members = _load_members(store)
    engines = _engine_status()
    implemented = tool_registry.implemented_capabilities()
    run = database.latest_resumable_run() or database.latest_run()
    jobs = database.list_jobs(run["id"]) if run else []
    open_directions = _open_directions(database)
    auth_signal = _auth_service_signal(store)
    cards: list[dict[str, Any]] = []
    for role_id in role_registry.SEVEN_ROLES:
        record = role_registry.get_role(role_id)
        assert record is not None
        member = next((item for item in members if item["role"] == role_id), None)
        role_jobs = [job for job in jobs if str(job.get("role")) == role_id]
        active_jobs = [
            job for job in role_jobs
            if str(job.get("status")) in {"running", "queued", "cancelling"}
        ]
        failed_jobs = [
            job for job in role_jobs
            if str(job.get("status")) == "failed"
        ]
        engine_caps = ROLE_ENGINE_CAPABILITIES.get(role_id, ())
        engine_states = {
            capability: engines.get(capability, {})
            for capability in engine_caps
        }
        missing_engines = [
            capability for capability, state in engine_states.items()
            if not bool(state.get("available"))
        ]
        unimplemented = sorted(set(engine_caps) - implemented)

        claimable = []
        dependency_waiting = []
        for direction in open_directions:
            intent = direction.get("intent") or {}
            if not role_registry.member_can_claim(role_id, intent):
                continue
            blockers = [
                parent for parent in database.direction_dependencies(str(direction.get("id")))
                if str(parent.get("status")) != "completed"
            ]
            if blockers:
                dependency_waiting.append({
                    "direction_id": direction.get("id"),
                    "blocked_by": [
                        str(item.get("direction_id")) for item in blockers
                    ],
                })
            else:
                claimable.append(str(direction.get("id")))

        if member is None:
            health, reason = "disabled", "团队未配置该角色成员（新项目默认七角色；旧项目可在迁移工具中补齐）"
        elif missing_engines or unimplemented:
            health = "capability_missing"
            reasons = []
            for capability in missing_engines:
                state = engine_states[capability]
                reasons.append(
                    f"{capability} 引擎不可用：{state.get('reason') or '适配器报告不可用'}"
                )
            for capability in unimplemented:
                reasons.append(f"{capability} 能力未接入引擎适配器")
            reason = "；".join(reasons)
        elif active_jobs:
            health, reason = "running", f"{len(active_jobs)} 个任务执行中/排队"
        elif failed_jobs:
            latest = failed_jobs[-1]
            health = "blocked"
            reason = f"最近任务失败：{(latest.get('error') or '未知错误')[:200]}"
        elif dependency_waiting:
            health = "waiting_dependency"
            reason = "可认领方向的依赖未满足："
            reason += "；".join(
                f"{item['direction_id']} 等待 {', '.join(item['blocked_by'])}"
                for item in dependency_waiting[:3]
            )
        elif role_id == "crack" and not auth_signal and not claimable:
            health, reason = "waiting_dependency", "尚未发现口令/认证服务候选（等待匹配服务；不会用伪造调用证明上场）"
        elif claimable:
            health, reason = "ready", f"{len(claimable)} 个开放方向可认领"
        else:
            health = "no_matching_task"
            reason = "当前没有匹配该角色能力的开放任务"
        cards.append({
            "role": role_id,
            "display_name": record.display_name,
            "kind": record.kind,
            "duty": record.activity[0],
            "deliverable": record.activity[1],
            "member": (
                {
                    "name": member.get("name"),
                    "type": member.get("type") or member.get("backend"),
                    "model": member.get("model"),
                    "runtime_mode": member.get("runtime_mode"),
                    "sandbox": member.get("sandbox"),
                    "api_key_env": member.get("api_key_env"),
                }
                if member else None
            ),
            "capabilities": {
                "all": sorted(record.capabilities),
                "effective": sorted(record.effective_capabilities()),
                "missing": sorted(set(record.capabilities) - implemented),
            },
            "skills": [
                {**skill_status(card), "title": card.title}
                for card_id in skill_ids_for_role(role_id)
                if (card := skill_cards().get(card_id)) is not None
            ],
            "current_tasks": [_task_summary(job) for job in role_jobs[-8:]],
            "health": health,
            "health_reason": reason,
            "engine_states": {
                capability: {
                    "adapter": state.get("adapter"),
                    "available": bool(state.get("available")),
                    "reason": state.get("reason", ""),
                }
                for capability, state in engine_states.items()
            },
        })
    return {
        "roles": cards,
        "states": list(HEALTH_STATES),
        "run": {"id": run.get("id"), "status": run.get("status")} if run else None,
    }


def plan_view(store, *, limit_plans: int = 20) -> dict[str, Any]:
    """计划视图数据（§11：任务依赖、委派角色、方法卡、结果、工具调用与证据）。"""
    database = _database_of(store)
    plans = [
        {
            "plan_id": item.get("plan_id"),
            "strategy_summary": item.get("strategy_summary"),
            "proposed_by": item.get("proposed_by"),
            "run_id": item.get("run_id"),
            "task_count": item.get("task_count"),
            "coverage_claims": item.get("coverage_claims") or [],
            "counterfactual": item.get("counterfactual") or {},
            "created_at": item.get("created_at"),
            "tasks": item.get("tasks") or [],
        }
        for item in store.read_jsonl("plan_graphs.jsonl")[-limit_plans:]
    ]
    directions = []
    tool_calls_by_task: dict[str, list[dict[str, Any]]] = {}
    for call in store.read_jsonl("tool_calls.jsonl")[-500:]:
        task_id = str(call.get("task_id") or "")
        if task_id:
            tool_calls_by_task.setdefault(task_id, []).append({
                "tool_call_id": call.get("tool_call_id"),
                "tool_id": call.get("tool_id"),
                "status": call.get("status"),
                "error_kind": call.get("error_kind"),
                "duration_ms": call.get("duration_ms"),
                "started_at": call.get("started_at"),
                "output_summary": call.get("output_summary"),
            })
    facts_by_intent: dict[str, list[dict[str, Any]]] = {}
    for fact in store.read_jsonl("facts.jsonl"):
        intent_id = str(fact.get("intent_id") or "")
        if intent_id:
            facts_by_intent.setdefault(intent_id, []).append({
                "fact_id": fact.get("id"),
                "title": fact.get("title"),
                "classification": fact.get("classification"),
                "severity": fact.get("severity"),
                "evidence_path": fact.get("evidence_path"),
            })
    for direction in database.list_directions():
        intent = direction.get("intent") or {}
        direction_id = str(direction.get("id"))
        directions.append({
            "id": direction_id,
            "status": direction.get("status"),
            "claimed_by": direction.get("claimed_by"),
            "assigned_role": direction.get("assigned_role") or intent.get("assigned_role"),
            "verb": intent.get("verb"),
            "target": intent.get("target"),
            "hypothesis": intent.get("hypothesis"),
            "goal": intent.get("goal"),
            "tool_ref": direction.get("tool_ref") or (
                {"tool_id": intent.get("tool_id"), "arguments": None}
                if intent.get("tool_id") else None
            ),
            "skill_ids": intent.get("skill_ids") or [],
            "skill_snapshot": intent.get("skill_snapshot") or {},
            "depends_on": [
                {
                    "id": str(parent.get("direction_id")),
                    "status": parent.get("status"),
                    "terminal_reason": parent.get("terminal_reason"),
                }
                for parent in database.direction_dependencies(direction_id)
            ],
            "tool_calls": tool_calls_by_task.get(direction_id, []),
            "results": facts_by_intent.get(direction_id, []),
            "terminal_reason": direction.get("terminal_reason"),
            "created_at": direction.get("created_at"),
        })
    return {
        "plans": list(reversed(plans)),
        "directions": directions,
        "skill_cards": {
            card_id: {**skill_status(card), "title": card.title, "description": card.description}
            for card_id, card in skill_cards().items()
        },
    }


def tools_health(store) -> dict[str, Any]:
    """工具健康检查数据（§11：不把失败统一显示成“AI 出错”）。"""
    engines = _engine_status()
    tools = []
    for capability_id, spec in tool_registry.TOOL_CATALOG.items():
        engine = engines.get(capability_id)
        tools.append({
            "id": capability_id,
            "category": spec.category,
            "description": spec.description,
            "implemented": capability_id in tool_registry.implemented_capabilities(),
            "available": bool(engine["available"]) if engine else spec.available,
            "engine_gap": spec.engine_gap,
            "visible_to_model": spec.visible_to_model,
            "engine": (
                {
                    "adapter": engine.get("adapter"),
                    "reason": engine.get("reason", ""),
                }
                if engine else None
            ),
            "roles": sorted(
                role_id for role_id in role_registry.role_ids()
                if capability_id in role_registry.role_capabilities(role_id)
            ),
        })
    skills = [
        {**skill_status(card), "title": card.title, "description": card.description}
        for card in skill_cards().values()
    ]
    return {"engines": engines, "tools": tools, "skills": skills}


def skill_routing_explanation_for(features: list[str], *, role: str | None = None) -> dict[str, Any]:
    """技能路由解释（§11：为什么命中/为什么缺口）。"""
    from .skill_router import skill_routing_explanation

    cleaned = [str(item).strip() for item in features if str(item).strip()][:20]
    if not cleaned:
        raise ValueError("features 不能为空")
    return skill_routing_explanation(cleaned, role=role or None)


def analysis_panel(store, *, record_limit: int = 30) -> dict[str, Any]:
    """独立研判配置与结果面板（§11 倒数第二条全部要素）。"""
    from .analysis_service import AnalysisService

    service = AnalysisService(store)
    analyzers = []
    for meta in analyzer_status():
        kind = str(meta.get("analyzer_kind"))
        enabled, disabled_reason = analyzer_enabled(store, kind)
        model_config, config_version = service.resolve_model_config(kind)
        safe_model = None
        if model_config:
            safe_model = {
                "type": model_config.get("type"),
                "model": model_config.get("model"),
                "base_url": model_config.get("base_url"),
                "api_key_env": model_config.get("api_key_env"),
                "timeout_seconds": model_config.get("timeout_seconds"),
                "source": model_config.get("source"),
            }
        analyzers.append({
            **meta,
            "enabled_effective": enabled,
            "disabled_reason": disabled_reason,
            "model": safe_model,
            "model_config_version": config_version,
            "configured": model_config is not None,
        })
    jobs = service.database.list_analysis_jobs()
    queued = [
        job for job in jobs
        if str(job.get("status")) in {"pending", "running"}
    ]
    return {
        "schema_version": ANALYSIS_SCHEMA_VERSION,
        "analyzers": analyzers,
        "records": [
            {
                "analysis_id": row.get("id"),
                "analyzer_kind": row.get("analyzer_kind"),
                "version": row.get("version"),
                "analysis_status": row.get("analysis_status"),
                "model_id": row.get("model_id"),
                "prompt_version": row.get("prompt_version"),
                "input_hash": str(row.get("input_hash"))[:16],
                "source_task_id": row.get("source_task_id"),
                "source_tool_call_id": row.get("source_tool_call_id"),
                "created_at": row.get("created_at"),
                "record": row.get("record"),
            }
            for row in service.query_records(limit=record_limit)
        ],
        "queued_jobs": [
            {
                "job_id": job.get("id"),
                "analyzer_kind": job.get("analyzer_kind"),
                "status": job.get("status"),
                "created_at": job.get("created_at"),
            }
            for job in queued
        ],
        "note": (
            "以上为独立 AI 研判层（model_analysis=true）的模型分析，不是原始事实；"
            "研判不能直接确认漏洞或派发扫描。"
        ),
    }


def save_analysis_config(
    store,
    analyzers: dict[str, Any],
) -> dict[str, Any]:
    """分析器启停与模型覆盖写入 analysis_config.json（§7A.4 功能开关）。"""
    if not isinstance(analyzers, dict) or not analyzers:
        raise ValueError("analyzers 必须是非空对象")
    from .analysis_registry import ANALYZERS

    config_path = store.path / "analysis_config.json"
    config: dict[str, Any] = {}
    if config_path.is_file():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            config = {}
    if not isinstance(config, dict):
        config = {}
    merged: dict[str, Any] = dict(config.get("analyzers") or {})
    changed: list[dict[str, Any]] = []
    for kind, raw in analyzers.items():
        kind = str(kind).strip()
        if kind not in ANALYZERS:
            raise ValueError(f"未知分析器: {kind}")
        if not isinstance(raw, dict):
            raise ValueError(f"分析器 {kind} 配置必须是对象")
        entry = dict(merged.get(kind) or {})
        if "enabled" in raw:
            entry["enabled"] = bool(raw["enabled"])
        model_override = raw.get("model_override")
        if model_override is not None:
            if not isinstance(model_override, dict):
                raise ValueError(f"分析器 {kind} 的 model_override 必须是对象")
            if not str(model_override.get("model") or "").strip():
                raise ValueError(f"分析器 {kind} 的 model_override.model 必填")
            cleaned = {
                "model": str(model_override["model"]).strip(),
                "type": str(model_override.get("type") or "openai-compatible"),
                "base_url": model_override.get("base_url"),
                "api_key_env": model_override.get("api_key_env"),
                "timeout_seconds": int(model_override.get("timeout_seconds") or 120),
            }
            if cleaned["type"] == "openai-compatible" and not str(cleaned["base_url"] or "").strip():
                raise ValueError(f"分析器 {kind} 使用 openai-compatible 时必须提供 base_url")
            entry.update(cleaned)
        if raw.get("clear_model_override"):
            for key in ("model", "type", "base_url", "api_key_env", "timeout_seconds"):
                entry.pop(key, None)
        merged[kind] = entry
        changed.append({"analyzer_kind": kind, "entry": entry})
    config["analyzers"] = merged
    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {"saved": [item["analyzer_kind"] for item in changed], "config": config}


def resources_panel(store, *, category: str | None = None) -> dict[str, Any]:
    """资源仓库面板数据（§7.2 五类分类管理）。"""
    from . import resource_repository as repo

    repo.ensure_defaults(store)
    return {
        "status": repo.status(store),
        "resources": repo.list_resources(store, category=category),
        "categories": list(repo.CATEGORIES),
    }


def run_tool_progress(store) -> dict[str, Any]:
    """运行视图的工具进度（§11：每个工具的调用/成功/失败统计）。"""
    database = _database_of(store)
    run = database.latest_resumable_run() or database.latest_run()
    if run is None:
        return {"run": None, "tools": []}
    run_id = str(run.get("id"))
    calls = [
        call for call in store.read_jsonl("tool_calls.jsonl")[-2000:]
        if str(call.get("run_id")) == run_id
    ]
    by_tool: dict[str, dict[str, Any]] = {}
    for call in calls:
        tool_id = str(call.get("tool_id") or "unknown")
        entry = by_tool.setdefault(tool_id, {
            "tool_id": tool_id, "calls": 0, "ok": 0, "failed": 0,
            "rejected": 0, "last_at": "", "roles": set(),
        })
        entry["calls"] += 1
        status = str(call.get("status"))
        if status == "ok":
            entry["ok"] += 1
        elif status == "rejected":
            entry["rejected"] += 1
        else:
            entry["failed"] += 1
        if call.get("role"):
            entry["roles"].add(str(call["role"]))
        if str(call.get("started_at") or "") > entry["last_at"]:
            entry["last_at"] = str(call.get("started_at"))
    return {
        "run": {"id": run_id, "status": run.get("status")},
        "tools": [
            {**entry, "roles": sorted(entry["roles"])}
            for entry in sorted(by_tool.values(), key=lambda item: -item["calls"])
        ],
    }


def finding_chain(store, finding_id: str) -> dict[str, Any]:
    """发现详情证据链：请求/响应→引擎原始命中→独立研判→review→Guardian→人工结论。"""
    finding_id = str(finding_id or "").strip()
    fact = next(
        (item for item in store.read_jsonl("facts.jsonl") if str(item.get("id")) == finding_id),
        None,
    )
    if fact is None:
        raise ValueError(f"发现不存在: {finding_id}")
    database = _database_of(store)
    chain: list[dict[str, Any]] = []

    # 1. 请求/响应与证据文件（含 proof_refs）
    proof_refs = ((fact.get("evidence_metrics") or {}).get("proof_refs") or {})
    chain.append({
        "stage": "request_response",
        "title": "请求 / 响应",
        "available": bool(proof_refs.get("raw_request") or proof_refs.get("raw_response") or fact.get("evidence_path")),
        "detail": {
            "evidence_path": fact.get("evidence_path"),
            "proof_refs": proof_refs,
        },
    })
    # 2. 引擎/工具原始命中（方向 → 工具调用审计）
    intent_id = str(fact.get("intent_id") or "")
    direction = database.get_direction(intent_id) if intent_id else None
    tool_calls = [
        call for call in store.read_jsonl("tool_calls.jsonl")
        if intent_id and str(call.get("task_id")) == intent_id
    ]
    chain.append({
        "stage": "engine_hits",
        "title": "引擎 / 工具原始命中",
        "available": bool(tool_calls),
        "detail": {
            "direction_id": intent_id or None,
            "direction_status": direction.get("status") if direction else None,
            "tool_calls": [
                {
                    "tool_call_id": call.get("tool_call_id"),
                    "tool_id": call.get("tool_id"),
                    "status": call.get("status"),
                    "started_at": call.get("started_at"),
                    "output_summary": call.get("output_summary"),
                }
                for call in tool_calls[-10:]
            ],
        },
    })
    # 3. 独立 AI 研判（analysis_records.source_task_id == intent_id）
    analysis_rows = []
    if intent_id:
        analysis_rows = database.list_analysis_records(source_task_id=intent_id, limit=20)
    chain.append({
        "stage": "independent_analysis",
        "title": "独立 AI 研判",
        "available": bool(analysis_rows),
        "detail": {
            "records": [
                {
                    "analysis_id": row.get("id"),
                    "analyzer_kind": row.get("analyzer_kind"),
                    "version": row.get("version"),
                    "analysis_status": row.get("analysis_status"),
                    "model_id": row.get("model_id"),
                    "prompt_version": row.get("prompt_version"),
                    "created_at": row.get("created_at"),
                    "conclusion": (row.get("record") or {}).get("conclusion"),
                    "recommended_followups": (row.get("record") or {}).get("recommended_followups") or [],
                }
                for row in analysis_rows
            ],
        },
    })
    # 4. reviewer 复核（review_flags + finding_review 记录）
    review_flags = [
        flag for flag in store.read_jsonl("review_flags.jsonl")
        if finding_id in [str(item) for item in (flag.get("fact_ids") or [])]
    ]
    review_records = database.list_review_records(mode="finding_review", limit=200)
    related_reviews = []
    for record in review_records:
        payload = record.get("payload") or {}
        if finding_id in [str(item) for item in (payload.get("candidate_ids") or [])]:
            related_reviews.append({
                "review_id": record.get("id"),
                "reviewer_member": record.get("reviewer_member"),
                "evidence_sufficiency": payload.get("evidence_sufficiency"),
                "recommendation": payload.get("recommendation"),
                "missing_items": payload.get("missing_items") or [],
                "created_at": record.get("created_at"),
            })
    chain.append({
        "stage": "reviewer",
        "title": "reviewer 复核",
        "available": bool(review_flags or related_reviews),
        "detail": {"flags": review_flags, "reviews": related_reviews},
    })
    # 5. Guardian 判定（validator_result + quality_notes，只降不升）
    validator_result = fact.get("validator_result") or {}
    chain.append({
        "stage": "guardian",
        "title": "Guardian 判定",
        "available": bool(validator_result or fact.get("quality_notes")),
        "detail": {
            "certified": validator_result.get("certified"),
            "factors": validator_result.get("factors") or {},
            "reasons": validator_result.get("reasons") or [],
            "quality_notes": fact.get("quality_notes") or [],
            "status_after": fact.get("status"),
            "classification_after": fact.get("classification"),
        },
    })
    # 6. 人工结论（human_verdicts）
    verdict = next(
        (
            item for item in store.read_jsonl("human_verdicts.jsonl")
            if str(item.get("finding_id")) == finding_id
        ),
        None,
    )
    chain.append({
        "stage": "human_verdict",
        "title": "人工结论",
        "available": verdict is not None,
        "detail": verdict,
    })
    return {
        "finding_id": finding_id,
        "title": fact.get("title"),
        "chain": chain,
    }
