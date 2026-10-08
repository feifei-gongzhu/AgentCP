"""计划任务图（依赖图）校验与注册（实施方案 §4.2-4.3、§12-P2）。

planner 的 ``submit_plan`` 在携带 ``tasks`` 时走本模块：Controller（服务端）
入库前校验并拒绝：

- **缺失 ``depends_on`` 字段**：任务必须显式提供；``[]`` 表示无依赖，
  缺字段视为计划无效（不采用隐式“依赖上一项”）。
- **缺失父任务 / 跨项目引用**：``depends_on`` 只允许引用本计划内的
  ``task_key`` 或**同一控制平面数据库中已存在**的方向 ID；其余一律拒绝。
- **循环依赖**：计划内任务图拓扑排序失败即拒绝。
- **能力不满足**：``assigned_role`` 的角色白名单必须包含 ``tool_id``。
- **目标超出授权范围**：复用 ``Guardian.review_intent``（guardian.py:166）。

注册结果仍是 Direction（不建第二套调度系统）：胶囊字段写入 v8 列
（assigned_role/depends_on/tool_ref）与 intent 载荷（供上下文胶囊使用）；
技能在注册时固定版本/内容哈希快照（方案 §5.3）。
"""

from __future__ import annotations

from typing import Any

from .guardian import Guardian, ScopeViolation
from .role_registry import (
    KIND_EXECUTION,
    get_role,
    role_capabilities,
)
from .schemas import now_iso
from .skill_registry import get_skill, snapshot as skill_snapshot
from .store import ProjectStore
from .tool_registry import TOOL_CATALOG


MAX_PLAN_TASKS = 16


class PlanGraphError(ValueError):
    """计划图校验失败（整批拒绝，不部分入库）。"""


def _as_str_list(raw: Any, *, field: str, task_key: str) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        raise PlanGraphError(f"任务 {task_key} 的 {field} 必须是字符串数组")
    return [item.strip() for item in raw if item.strip()]


def _normalize_task(raw: dict[str, Any], index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PlanGraphError(f"计划任务 #{index + 1} 必须是对象")
    task_key = str(
        raw.get("task_key") or raw.get("id") or f"T{index + 1}"
    ).strip()
    if not task_key:
        raise PlanGraphError(f"计划任务 #{index + 1} 的 task_key 不能为空")
    goal = str(raw.get("goal") or "").strip()
    if not goal:
        raise PlanGraphError(f"任务 {task_key} 缺少 goal")
    if "depends_on" not in raw:
        raise PlanGraphError(
            f"任务 {task_key} 缺少 depends_on 字段：必须显式提供（[] 表示无依赖），"
            "缺字段视为计划无效"
        )
    depends_on = _as_str_list(raw.get("depends_on"), field="depends_on", task_key=task_key)
    targets = _as_str_list(raw.get("targets"), field="targets", task_key=task_key)
    if not targets:
        raise PlanGraphError(f"任务 {task_key} 缺少 targets")
    verb = str(raw.get("verb") or "verify").strip() or "verify"
    success_criteria = str(raw.get("success_criteria") or "").strip()
    if not success_criteria:
        raise PlanGraphError(f"任务 {task_key} 缺少 success_criteria")
    assigned_role = str(raw.get("assigned_role") or "").strip()
    if assigned_role:
        record = get_role(assigned_role)
        if record is None:
            raise PlanGraphError(
                f"任务 {task_key} 的 assigned_role={assigned_role} 不是已注册角色"
            )
        if record.kind != KIND_EXECUTION:
            raise PlanGraphError(
                f"任务 {task_key} 的 assigned_role={assigned_role} 不是执行类角色"
                "（规划/编排/复核角色不执行扫描验证）"
            )
    tool_id = str(raw.get("tool_id") or "").strip() or None
    tool_arguments = raw.get("tool_arguments")
    if tool_arguments is not None and not isinstance(tool_arguments, dict):
        raise PlanGraphError(f"任务 {task_key} 的 tool_arguments 必须是对象")
    if tool_id:
        if tool_id not in TOOL_CATALOG:
            raise PlanGraphError(f"任务 {task_key} 的 tool_id={tool_id} 不在工具目录中")
        if assigned_role and tool_id not in role_capabilities(assigned_role):
            raise PlanGraphError(
                f"任务 {task_key} 的 assigned_role={assigned_role} 角色白名单"
                f"不含 tool_id={tool_id}（能力不满足）"
            )
    skill_ids = _as_str_list(raw.get("skill_ids"), field="skill_ids", task_key=task_key)
    for skill_id in skill_ids:
        if get_skill(skill_id) is None:
            raise PlanGraphError(
                f"任务 {task_key} 引用了不存在的技能卡 {skill_id}；"
                "未覆盖特征应记录为方法缺口，不得伪造技能"
            )
    return {
        "task_key": task_key,
        "goal": goal,
        "verb": verb,
        "targets": targets,
        "depends_on": depends_on,
        "assigned_role": assigned_role or None,
        "tool_id": tool_id,
        "tool_arguments": tool_arguments or {},
        "skill_ids": skill_ids,
        "source_fact_ids": _as_str_list(raw.get("source_fact_ids"), field="source_fact_ids", task_key=task_key),
        "asset_ids": _as_str_list(raw.get("asset_ids"), field="asset_ids", task_key=task_key),
        "success_criteria": success_criteria,
        "preconditions": _as_str_list(raw.get("preconditions"), field="preconditions", task_key=task_key),
        "exclusion_criteria": _as_str_list(raw.get("exclusion_criteria"), field="exclusion_criteria", task_key=task_key),
        "session_ref": str(raw.get("session_ref") or "").strip() or None,
        "evidence_sink": str(raw.get("evidence_sink") or "").strip() or None,
        "requires_parent_hit": bool(raw.get("requires_parent_hit", False)),
        "stop_conditions": _as_str_list(raw.get("stop_conditions"), field="stop_conditions", task_key=task_key),
    }


def _topological_order(tasks: list[dict[str, Any]], known_direction_ids: set[str]) -> list[dict[str, Any]]:
    """校验 + 拓扑排序。计划内引用解析到 task_key；外部引用必须已是本库方向。"""
    by_key = {task["task_key"]: task for task in tasks}
    if len(by_key) != len(tasks):
        raise PlanGraphError("计划内 task_key 重复")
    edges: dict[str, set[str]] = {}
    for task in tasks:
        parents: set[str] = set()
        for ref in task["depends_on"]:
            if ref in by_key:
                parents.add(by_key[ref]["task_key"])
            elif ref in known_direction_ids:
                continue  # 已存在方向：跨计划引用，合法（同一数据库=同一项目）
            else:
                raise PlanGraphError(
                    f"任务 {task['task_key']} 的 depends_on 引用 {ref} 无法解析："
                    "不是本计划 task_key，也不是本项目中已存在的父任务"
                    "（缺失父任务或跨项目引用都被拒绝）"
                )
        edges[task["task_key"]] = parents
    # Kahn 拓扑排序：同时是环检测。
    order: list[str] = []
    remaining = {key: set(parents) for key, parents in edges.items()}
    while remaining:
        ready = sorted(key for key, parents in remaining.items() if not parents)
        if not ready:
            raise PlanGraphError(
                f"计划存在循环依赖: {sorted(remaining)}"
            )
        for key in ready:
            order.append(key)
            del remaining[key]
        for parents in remaining.values():
            parents.difference_update(ready)
    return [by_key[key] for key in order]


def _build_intent(task: dict[str, Any], target: str, direction_id: str) -> dict[str, Any]:
    intent = {
        "id": direction_id,
        "verb": task["verb"],
        "target": target,
        "hypothesis": task["goal"],
        "success_criteria": task["success_criteria"],
        "evidence_sink": task["evidence_sink"] or f"evidence/plans/{task['task_key']}",
        "scope_check": (
            f"目标 {target} 来自项目授权范围内画像/事实；"
            "本任务只执行该目标，不扩大范围。"
        ),
        "goal": task["goal"],
        "assigned_role": task["assigned_role"],
        "tool_id": task["tool_id"],
        "skill_ids": task["skill_ids"],
        "skill_snapshot": skill_snapshot(task["skill_ids"]),
        "source_fact_ids": task["source_fact_ids"],
        "asset_ids": task["asset_ids"],
        "preconditions": task["preconditions"],
        "exclusion_criteria": task["exclusion_criteria"],
        "session_ref": task["session_ref"],
        "requires_parent_hit": task["requires_parent_hit"],
        "stop_conditions": task["stop_conditions"],
        "priority_score": 0.5,
    }
    return intent


def submit_plan_graph(
    store: ProjectStore,
    database,
    payload: dict[str, Any],
    *,
    proposed_by: str,
    run_id: str | None = None,
) -> dict[str, Any]:
    """校验并注册计划任务图；任何校验失败整批拒绝（不部分入库）。"""
    raw_tasks = payload.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise PlanGraphError("计划必须包含非空 tasks 数组")
    if len(raw_tasks) > MAX_PLAN_TASKS:
        raise PlanGraphError(f"计划单次最多 {MAX_PLAN_TASKS} 个任务")
    known_direction_ids = {
        str(item.get("id")) for item in database.list_directions()
    }
    tasks = [_normalize_task(raw, index) for index, raw in enumerate(raw_tasks)]
    ordered = _topological_order(tasks, known_direction_ids)

    guardian = Guardian()
    target_config = store.read_json("target.json")
    registered: list[dict[str, Any]] = []
    key_to_direction: dict[str, str] = {}
    # 先整体做授权范围校验（Guardian 复用；越界整批拒绝）。
    for task in ordered:
        for target in task["targets"]:
            probe = _build_intent(task, target, "I-PENDING")
            try:
                guardian.review_intent(_intent_like(probe, target_config), target_config)
            except ScopeViolation as exc:
                raise PlanGraphError(
                    f"任务 {task['task_key']} 的目标 {target} 未通过授权范围校验: {exc}"
                ) from exc

    from .schemas import new_id

    for task in ordered:
        resolved_parents: list[str] = []
        for ref in task["depends_on"]:
            resolved_parents.append(key_to_direction.get(ref, ref))
        for ordinal, target in enumerate(task["targets"]):
            direction_id = new_id("I")
            intent = _build_intent(task, target, direction_id)
            created_id, created = database.register_direction(
                intent,
                assigned_role=task["assigned_role"],
                depends_on=resolved_parents,
                tool_ref=(
                    {"tool_id": task["tool_id"], "arguments": task["tool_arguments"]}
                    if task["tool_id"] else None
                ),
            )
            if ordinal == 0:
                key_to_direction[task["task_key"]] = created_id
            registered.append({
                "task_key": task["task_key"],
                "target": target,
                "direction_id": created_id,
                "created": created,
                "assigned_role": task["assigned_role"],
                "depends_on": resolved_parents,
                "tool_id": task["tool_id"],
            })

    plan_id = f"PG-{len(store.read_jsonl('plan_graphs.jsonl')) + 1:06d}-{proposed_by[:24]}"
    record = {
        "plan_id": plan_id,
        "version": 1,
        "strategy_summary": str(payload.get("strategy_summary") or "").strip(),
        "proposed_by": proposed_by,
        "run_id": run_id,
        "task_count": len(registered),
        "coverage_claims": payload.get("coverage_claims") or [],
        "counterfactual": payload.get("counterfactual") or {},
        "tasks": registered,
        "created_at": now_iso(),
    }
    store.append_jsonl("plan_graphs.jsonl", record)
    return record


def _intent_like(payload: dict[str, Any], target_config: dict[str, Any]):
    """把任务胶囊包装成 Guardian.review_intent 可校验的对象（scope 复用）。"""
    from .schemas import Intent

    return Intent(
        verb=payload["verb"],
        target=payload["target"],
        evidence_sink=payload["evidence_sink"],
        success_criteria=payload["success_criteria"],
        hypothesis=payload["hypothesis"],
        scope_check=payload["scope_check"],
        scope_refs=_scope_refs_for(payload["target"], target_config),
    )


def _scope_refs_for(target: str, target_config: dict[str, Any]) -> list[str]:
    from urllib.parse import urlsplit

    host = str(urlsplit(target if "://" in target else f"https://{target}").netloc).casefold()
    declared = {
        str(item).strip() for item in (target_config or {}).get("scope", [])
        if str(item).strip()
    }
    if "*" in declared:
        return ["*"]
    host_only = host.split(":", 1)[0]
    for entry in declared:
        entry_host = entry.split(":", 1)[0]
        if host == entry_host or entry_host == host_only:
            return [entry]
    return []


def direction_has_hit(store: ProjectStore, direction_id: str) -> bool:
    """方向是否产生了命中（风险线索/漏洞候选事实）。"""
    for item in store.read_jsonl("facts.jsonl"):
        if str(item.get("intent_id") or "") == str(direction_id):
            if str(item.get("classification") or "") in {"risk_lead", "vulnerability"}:
                return True
    return False


def cascade_cancel_on_no_hit(store: ProjectStore, database, direction_id: str) -> list[str]:
    """父任务无命中时，仅取消“需要该命中作为前置条件”的后续任务。

    判定依据是子任务注册时固定在 intent 载荷里的 ``requires_parent_hit``
    （方案 §4.2：需要命中的后续被取消，仅用于排序的依赖不受影响）。
    父任务已有命中（risk_lead/vulnerability 候选事实）时不取消任何任务。
    传播是传递性的：被取消任务的 requires_parent_hit 子孙同样取消。
    """
    if direction_has_hit(store, direction_id):
        return []
    cancelled: list[str] = []
    stack = [str(direction_id)]
    visited = {str(direction_id)}
    while stack:
        current = stack.pop()
        for candidate in database.list_directions():
            if current not in (candidate.get("depends_on") or []):
                continue
            if candidate.get("id") in visited:
                continue
            visited.add(str(candidate.get("id")))
            intent = candidate.get("intent") or {}
            if not bool(intent.get("requires_parent_hit")):
                continue
            updated = database.set_direction_status(
                str(candidate.get("id")), "cancelled",
                reason=f"cascade_cancelled:dependency_no_hit:{current}",
            )
            if updated:
                cancelled.append(str(candidate.get("id")))
                stack.append(str(candidate.get("id")))
    return cancelled


def dependency_blockers(database, direction_id: str) -> list[dict[str, Any]]:
    """方向的依赖状态（waiting_dependency 解释，供调度与 UI）。"""
    direction = database.get_direction(direction_id)
    if direction is None:
        return []
    blockers = []
    for parent in database.direction_dependencies(direction_id):
        if parent.get("status") != "completed":
            blockers.append(parent)
    return blockers
