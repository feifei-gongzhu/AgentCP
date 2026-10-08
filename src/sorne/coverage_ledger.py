"""覆盖账本（实施方案 §4.1-1/§4.1-8、§12-P2）。

记录“方法 × 目标 × 环境版本”的已执行覆盖与结果类别，供规划器决定
“只对新增信息、未覆盖方法或已失效负向证据继续规划”（方案 §4.1-7）。

定位：这是**采集执行的账本**（执行了什么、结果类别是什么），不是第二套
业务权威——事实/负向证据仍走提交链；覆盖记录由服务端在方向终态时写入，
条目幂等（同一 direction 只记一条）。
"""

from __future__ import annotations

import hashlib
from typing import Any

from .schemas import now_iso
from .store import ProjectStore


LEDGER_NAME = "coverage_ledger.jsonl"

RESULT_CATEGORIES = ("covered_with_hits", "covered_no_hit", "blocked", "failed", "cancelled")


def record_coverage(
    store: ProjectStore,
    *,
    direction_id: str,
    dimension: str,
    targets: list[str],
    method: str,
    outcome: str,
    run_id: str | None = None,
    role: str | None = None,
    tool_id: str | None = None,
    skill_ids: list[str] | None = None,
    evidence_refs: list[str] | None = None,
    environment_version: str | None = None,
) -> dict[str, Any] | None:
    """方向终态时记录覆盖条目（按 direction 幂等：重复调用返回既有条目）。"""
    if outcome not in RESULT_CATEGORIES:
        raise ValueError(f"非法覆盖结果类别: {outcome}（合法: {RESULT_CATEGORIES}）")
    dimension = str(dimension or "").strip()
    method = str(method or "").strip()
    if not dimension:
        dimension = "unclassified"
    for item in store.read_jsonl(LEDGER_NAME):
        if item.get("direction_id") == str(direction_id):
            return item
    entry = {
        "id": f"CV-{hashlib.sha256(str(direction_id).encode('utf-8')).hexdigest()[:12]}",
        "direction_id": str(direction_id),
        "dimension": dimension,
        "targets": [str(t) for t in (targets or [])][:32],
        "method": method or "unspecified",
        "outcome": outcome,
        "run_id": run_id,
        "role": role,
        "tool_id": tool_id,
        "skill_ids": [str(s) for s in (skill_ids or [])],
        "evidence_refs": [str(e) for e in (evidence_refs or [])][:16],
        "environment_version": environment_version,
        "created_at": now_iso(),
    }
    store.append_jsonl(LEDGER_NAME, entry)
    return entry


def _dimension_of(intent: dict[str, Any]) -> str:
    for key in ("dimension", "skill_ids", "verb"):
        value = intent.get(key)
        if isinstance(value, list) and value:
            return str(value[0])
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "unclassified"


def _outcome_of(status: str) -> str:
    if status == "completed":
        # “无命中”由调用方结合事实判定；默认按无命中记录（completed+负向证据
        # 语义，方案 §4.4），有命中时调用方传 outcome=covered_with_hits。
        return "covered_no_hit"
    if status == "blocked":
        return "blocked"
    if status == "cancelled":
        return "cancelled"
    if status in {"rejected", "exhausted", "released"}:
        return "failed"
    return "failed"


def record_direction_coverage(
    store: ProjectStore,
    direction: dict[str, Any],
    *,
    has_hit: bool | None = None,
) -> dict[str, Any] | None:
    """方向终态后的服务端覆盖记录入口（幂等）。"""
    intent = direction.get("intent") or {}
    status = str(direction.get("status") or "")
    if status in {"open", "released", "claimed"}:
        return None
    outcome = _outcome_of(status)
    if status == "completed" and has_hit:
        outcome = "covered_with_hits"
    return record_coverage(
        store,
        direction_id=str(direction.get("id") or ""),
        dimension=_dimension_of(intent),
        targets=[
            str(intent.get("target") or ""),
            *(str(t) for t in (intent.get("targets") or [])),
        ][:32],
        method=str(intent.get("tool_id") or intent.get("verb") or ""),
        outcome=outcome,
        run_id=str(direction.get("claimed_by") or "").split(":", 1)[0] or None,
        role=str(intent.get("assigned_role") or "") or None,
        tool_id=str(intent.get("tool_id") or "") or None,
        skill_ids=[str(s) for s in (intent.get("skill_ids") or [])],
        environment_version=str(intent.get("environment_version") or "") or None,
    )


def coverage_summary(store: ProjectStore) -> dict[str, Any]:
    """覆盖摘要（规划上下文用：按维度的目标计数与最近条目）。"""
    rows = store.read_jsonl(LEDGER_NAME)
    by_dimension: dict[str, dict[str, int]] = {}
    for row in rows:
        dimension = str(row.get("dimension") or "unclassified")
        bucket = by_dimension.setdefault(
            dimension, {"entries": 0, "with_hits": 0, "no_hit": 0, "blocked": 0},
        )
        bucket["entries"] += 1
        outcome = str(row.get("outcome") or "")
        if outcome == "covered_with_hits":
            bucket["with_hits"] += 1
        elif outcome == "covered_no_hit":
            bucket["no_hit"] += 1
        elif outcome in {"blocked", "failed", "cancelled"}:
            bucket["blocked"] += 1
    return {
        "entry_count": len(rows),
        "dimensions": by_dimension,
        "recent": [
            {
                key: row.get(key)
                for key in ("dimension", "targets", "method", "outcome", "direction_id")
            }
            for row in rows[-12:]
        ],
        "note": (
            "覆盖账本是执行记录摘要：已覆盖且无变化的方法×目标不应原样重试；"
            "负向证据失效条件命中时可重新验证（方案 §4.4 工作指纹语义）。"
        ),
    }


def covered_target_methods(
    store: ProjectStore,
    *,
    dimension: str | None = None,
) -> dict[str, set[str]]:
    """target → 已覆盖 method 集合（规划去重判定用）。"""
    result: dict[str, set[str]] = {}
    for row in store.read_jsonl(LEDGER_NAME):
        if dimension and str(row.get("dimension") or "") != dimension:
            continue
        for target in row.get("targets") or []:
            if str(row.get("outcome") or "") in {"covered_with_hits", "covered_no_hit"}:
                result.setdefault(str(target), set()).add(str(row.get("method") or "unspecified"))
    return result
