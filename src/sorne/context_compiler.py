from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Iterable
from urllib.parse import urlsplit

from .database import ControlDatabase
from .directives import authoritative_directives
from .memory import relevant_lessons
from .schemas import new_id, now_iso
from .store import ProjectStore
from .technologies import technology_profile
from .target_profile import routine_target_groups, target_assessments, target_profile
from .mrecon import compact_mrecon_rows
from .waf import WAFManager


ROLE_CONTEXT_BUDGETS = {
    "executor": 12_000,
    "waf_analyst": 12_000,
    "reason": 18_000,
    "metacog": 18_000,
    "reviewer": 20_000,
    "profile_mapper": 18_000,
}
DEFAULT_CONTEXT_BUDGET = 15_000
RETRY_DELTA_BUDGET = 2_000

_SECRET_PATTERNS = (
    (re.compile(r"(?i)(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s\"']+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,}\]]+"), r"\1[REDACTED]"),
    (re.compile(r"\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b"), "[REDACTED]"),
)


@dataclass
class CompiledWorkerContext:
    context: dict[str, Any]
    manifest: dict[str, Any]

    def render(self) -> str:
        return json.dumps(self.context, ensure_ascii=False, indent=2)


def parse_task_context(raw: str | None) -> tuple[dict[str, Any], str]:
    """Split the immutable task capsule from the bounded retry delta."""

    text = str(raw or "").strip()
    if not text:
        return {}, ""
    marker = "\n\n同一 Job 重试上下文（只读）：\n"
    task_text, separator, retry_text = text.partition(marker)
    try:
        parsed = json.loads(task_text)
        task = parsed if isinstance(parsed, dict) else {"调度任务": parsed}
    except json.JSONDecodeError:
        task = {"调度任务原文": _truncate(task_text, 4_000)}
    retry = _truncate(retry_text, RETRY_DELTA_BUDGET) if separator else ""
    return task, retry


def compile_worker_context(
    store: ProjectStore,
    role: str,
    *,
    task_context: dict[str, Any] | None = None,
    retry_delta: str = "",
    owner_directives: list[dict[str, Any]] | None = None,
    budget_chars: int | None = None,
) -> CompiledWorkerContext:
    """Compile role-specific, task-scoped blackboard memory.

    The blackboard remains complete on disk.  This function creates a bounded
    model input and never truncates the current task or owner directives.
    """
    from .schemas import normalize_role

    role = normalize_role(role)
    raw_task = task_context or {}
    task = (
        raw_task
        if role in {"executor", "waf_analyst"}
        else _compact(raw_task, max_string=4_000, max_items=30, depth=6)
    )
    budget = max(4_000, int(budget_chars or ROLE_CONTEXT_BUDGETS.get(role, DEFAULT_CONTEXT_BUDGET)))
    state = asdict(store.load_state())
    target = _compact_target(store.read_json("target.json"))
    checklist = _compact(store.read_json("checklist.json"), max_string=1_000, max_items=30, depth=4)
    directives = authoritative_directives(store) if owner_directives is None else owner_directives
    facts = store.read_jsonl("facts.jsonl")
    intents = store.read_jsonl("intents.jsonl")
    negative = store.read_jsonl("negative_evidence.jsonl")
    verdicts = store.read_jsonl("human_verdicts.jsonl")
    dismissed, active_intents = _direction_views(store, intents)
    identity = _task_identity(task)
    selected_ids: dict[str, list[str]] = {}
    omitted: dict[str, int] = {}
    mrecon_assigned: int | None = None
    mrecon_unassessed: int | None = None

    context: dict[str, Any] = {
        "state": _compact_state(state),
        "target": target,
        "checklist": checklist,
    }
    if task:
        context["current_task_capsule"] = task
    if retry_delta:
        context["retry_delta"] = retry_delta

    def add_records(
        key: str,
        rows: Iterable[dict[str, Any]],
        *,
        limit: int,
        newest_first: bool = True,
    ) -> None:
        values = list(rows)
        if newest_first:
            values.reverse()
        accepted: list[dict[str, Any]] = []
        for row in values[:limit]:
            candidate = _compact(row, max_string=1_200, max_items=24, depth=5)
            probe = dict(context)
            probe[key] = accepted + [candidate]
            if _json_chars(probe) > budget:
                continue
            accepted.append(candidate)
        if newest_first:
            accepted.reverse()
        context[key] = accepted
        selected_ids[key] = [str(item.get("id")) for item in accepted if item.get("id")]
        omitted[key] = max(0, len(values) - len(accepted))

    if role == "profile_mapper":
        relevant_profile = _profile_rows_for_task(
            target_profile(store),
            task,
        )
        # 待评估记录是本轮的实际工作，先于既有画像/技术画像占用预算；
        # 未评估 URL 排在最前，避免每轮都重复处理已评估的头部记录而
        # 永远截掉尾部（分片自愈）。覆盖情况写入 manifest 供审计。
        # 注意“已评估”来自评估记录（target_assessments），不是采集记录。
        assessed_urls = {
            str(item.get("url") or "").casefold()
            for item in _profile_rows_for_task(target_assessments(store), task)
        }
        mrecon_rows = _unassessed_first(
            _profile_rows_for_task(compact_mrecon_rows(store), task),
            assessed_urls,
        )
        mrecon_assigned = len(mrecon_rows)
        mrecon_unassessed = sum(
            1
            for row in mrecon_rows
            if str(row.get("url") or "").casefold() not in assessed_urls
        )
        add_records(
            "mrecon_observations",
            mrecon_rows,
            limit=120,
            newest_first=False,
        )
        context["existing_target_profile"] = _fit_profile_records(
            context,
            "existing_target_profile",
            relevant_profile,
            budget,
        )
        omitted["existing_target_profile"] = max(
            0,
            len(relevant_profile) - len(context["existing_target_profile"]),
        )
        context["technology_asset_profile"] = _fit_value(
            context, "technology_asset_profile", technology_profile(store), budget,
        )
        add_records("recent_facts", facts, limit=6)
        add_records("recent_negative_evidence", negative, limit=4)
    elif role == "executor":
        add_records("related_facts", _related(facts, identity), limit=8)
        add_records("related_negative_evidence", _related(negative, identity), limit=6)
        add_records(
            "related_technology_observations",
            _related(store.read_jsonl("technology_observations.jsonl"), identity),
            limit=8,
        )
        add_records(
            "related_human_verdicts",
            _related_verdicts(verdicts, facts, identity),
            limit=6,
        )
    elif role == "reviewer":
        add_records("related_system_vulnerabilities", _related_vulnerabilities(facts, identity), limit=12)
        add_records("related_human_verdicts", _related_verdicts(verdicts, facts, identity), limit=10)
        add_records(
            "human_refutation_memory",
            [item for item in store.read_jsonl("refutation_memories.jsonl") if item.get("active", True)],
            limit=8,
        )
        add_records("related_negative_evidence", _related(negative, identity), limit=8)
    elif role == "waf_analyst":
        add_records("open_waf_branches", WAFManager().active(store), limit=6)
        add_records("related_negative_evidence", _related(negative, identity), limit=8)
        add_records("related_facts", _related(facts, identity), limit=6)
    else:
        # Planning agents need breadth, but only summaries and recent bounded
        # records—not the complete vulnerability and evidence corpus.
        add_records("recent_facts", facts, limit=8)
        add_records("system_vulnerabilities", [item for item in facts if item.get("classification") == "vulnerability"], limit=8)
        add_records("human_finding_verdicts", verdicts, limit=8)
        add_records("recent_intents", active_intents, limit=8)
        add_records("human_dismissed_directions", dismissed, limit=8)
        add_records("recent_negative_evidence", negative, limit=8)
        if role == "reason":
            priority_targets = [
                item for item in target_assessments(store)
                if item.get("profile_class") == "priority_target"
            ]
            add_records("priority_target_profile", priority_targets, limit=40, newest_first=False)
            context["routine_network_summary"] = _fit_value(
                context,
                "routine_network_summary",
                [
                    {
                        "label": item.get("label"),
                        "hostname": item.get("hostname"),
                        "member_count": item.get("member_count"),
                        "url_pattern": item.get("url_pattern"),
                    }
                    for item in routine_target_groups(store)[:20]
                ],
                budget,
            )
            context["technology_asset_profile"] = _fit_value(
                context, "technology_asset_profile", technology_profile(store), budget,
            )
        add_records("recent_decisions", store.read_jsonl("decision_log.jsonl"), limit=5)
        add_records("active_hypotheses", [
            item for item in store.read_jsonl("hypotheses.jsonl")
            if item.get("status") in {"proposed", "selected", "testing", "supported", "blocked"}
        ], limit=12)
        add_records("recent_plan_batches", store.read_jsonl("plan_batches.jsonl"), limit=3)
        if role == "metacog":
            add_records("active_counterfactuals", [
                item for item in store.read_jsonl("counterfactuals.jsonl")
                if item.get("status", "proposed") in {"proposed", "testing"}
            ], limit=8)
        query = {
            "target": " ".join(str(item) for item in target.get("targets", [])),
            "hypothesis": " ".join(str(item.get("hypothesis", "")) for item in active_intents[-8:]),
        }
        add_records("retrieved_lessons", relevant_lessons(store, query), limit=6)
        method_pack = store.read_json("method_pack.json") if (store.path / "method_pack.json").exists() else {}
        context["method_pack"] = _fit_value(context, "method_pack", method_pack, budget)

    # Owner directives are transmitted in their own non-truncatable section.
    # Only their IDs are repeated here for provenance.
    context["owner_directive_ids"] = [str(item.get("id")) for item in directives if item.get("id")]
    _enforce_budget(context, budget, selected_ids, omitted)
    rendered_chars = _json_chars(context)
    manifest = {
        "compiler_version": "context-compiler-v1",
        "role": role,
        "budget_chars": budget,
        "rendered_context_chars": rendered_chars,
        "within_budget": rendered_chars <= budget,
        "task_identity": identity,
        "selected_ids": selected_ids,
        "omitted_counts": omitted,
        "owner_directive_ids": context["owner_directive_ids"],
        "retry_delta_chars": len(retry_delta),
    }
    if mrecon_assigned is not None:
        # 覆盖率在预算裁剪之后计算，确保 included/omitted 与最终上下文一致。
        manifest["mrecon_coverage"] = {
            "assigned_rows": mrecon_assigned,
            "unassessed_rows": mrecon_unassessed or 0,
            "included_rows": len(context.get("mrecon_observations") or []),
            "omitted_rows": omitted.get("mrecon_observations", 0),
        }
    return CompiledWorkerContext(context=context, manifest=manifest)


def persist_prompt_snapshot(
    store: ProjectStore,
    prompt: str,
    manifest: dict[str, Any],
    *,
    member_name: str,
    role: str,
    runtime_mode: str,
) -> dict[str, Any]:
    snapshot_id = new_id("P")
    redacted = redact_prompt(prompt)
    relative_path = f"prompt_snapshots/{snapshot_id}.txt"
    store.write_text(relative_path, redacted)
    record = {
        "id": snapshot_id,
        "created_at": now_iso(),
        "member": member_name,
        "role": role,
        "runtime_mode": runtime_mode,
        "prompt_path": relative_path,
        "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "prompt_chars": len(prompt),
        "redacted_prompt_chars": len(redacted),
        "context_manifest": manifest,
    }
    store.append_jsonl("prompt_snapshots.jsonl", record)
    return record


def redact_prompt(prompt: str) -> str:
    redacted = prompt
    for pattern, replacement in _SECRET_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def _direction_views(
    store: ProjectStore,
    intents: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not (store.path / "control_plane.db").exists():
        return [], intents
    directions = ControlDatabase(store.path / "control_plane.db").list_directions()
    dismissed = [
        item for item in directions
        if item.get("status") == "cancelled"
        and str(item.get("terminal_reason") or "").startswith("human_dismissed:")
    ]
    dismissed_ids = {str(item.get("id")) for item in dismissed}
    return dismissed[-8:], [item for item in intents if str(item.get("id")) not in dismissed_ids]


def _related(rows: Iterable[dict[str, Any]], identity: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in rows if _relevance_score(item, identity) > 0]


def _related_vulnerabilities(
    facts: Iterable[dict[str, Any]],
    identity: dict[str, Any],
) -> list[dict[str, Any]]:
    return [
        item for item in facts
        if item.get("classification") == "vulnerability" and _relevance_score(item, identity) > 0
    ]


def _related_verdicts(
    verdicts: Iterable[dict[str, Any]],
    facts: Iterable[dict[str, Any]],
    identity: dict[str, Any],
) -> list[dict[str, Any]]:
    related_fact_ids = {str(item.get("id")) for item in _related(facts, identity) if item.get("id")}
    return [item for item in verdicts if str(item.get("finding_id")) in related_fact_ids]


def _task_identity(task: dict[str, Any]) -> dict[str, Any]:
    blob = json.dumps(task, ensure_ascii=False).casefold()
    ids = set(re.findall(r"\b(?:F|I|AH|NE|WAF|H)-[a-z0-9]+\b", blob, flags=re.I))
    terms: set[str] = set()
    for match in re.findall(r"https?://[^\s\"'<>]+|(?:[a-z0-9-]+\.)+[a-z]{2,}|[\w.-]+\.(?:js|apk|ipa|exe|dmg)", blob, flags=re.I):
        clean = match.rstrip(".,);]}>").casefold()
        if len(clean) >= 5:
            terms.add(clean)
            if "://" in clean:
                host = re.sub(r"^https?://", "", clean).split("/", 1)[0]
                if host:
                    terms.add(host)
    return {
        "ids": sorted(ids),
        "terms": sorted(terms, key=len, reverse=True)[:20],
    }


def _relevance_score(row: dict[str, Any], identity: dict[str, Any]) -> int:
    blob = json.dumps(row, ensure_ascii=False).casefold()
    score = sum(100 for item in identity.get("ids", []) if item.casefold() in blob)
    score += sum(20 for term in identity.get("terms", []) if term in blob)
    return score


def _compact_target(target: dict[str, Any]) -> dict[str, Any]:
    allowed = (
        "vendor", "targets", "target_path", "uploaded_artifact", "project_type",
        "goal", "out_of_scope", "success_criteria", "notes", "authorization",
        "authorization_mode", "scope",
    )
    return {
        key: _compact(target[key], max_string=1_500, max_items=40, depth=4)
        for key in allowed if key in target
    }


def _compact_state(state: dict[str, Any]) -> dict[str, Any]:
    allowed = (
        "vendor", "phase", "elapsed_minutes", "current_task", "asset_count",
        "fact_count", "vulnerability_count", "pending_human_review_count",
        "current_decision", "gate_status", "run_status", "active_run_id",
        "attack_surface_coverage", "serendipity_used_minutes",
    )
    return {key: state.get(key) for key in allowed if key in state}


def _fit_value(
    context: dict[str, Any],
    key: str,
    value: Any,
    budget: int,
) -> Any:
    compact = _compact(value, max_string=800, max_items=20, depth=4)
    probe = dict(context)
    probe[key] = compact
    return compact if _json_chars(probe) <= budget else {"省略": "超过当前角色上下文预算"}


def _profile_rows_for_task(
    rows: list[dict[str, Any]],
    task: dict[str, Any],
) -> list[dict[str, Any]]:
    assigned = (
        task.get("本分片唯一目标")
        or task.get("assigned_targets")
        or task.get("本分片唯一新增 URL")
        or []
    )
    values = assigned if isinstance(assigned, list) else [assigned]
    hostnames: set[str] = set()
    for value in values:
        raw = str(value or "").strip()
        if not raw:
            continue
        parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
        if parsed.hostname:
            hostnames.add(parsed.hostname.casefold())
    if not hostnames:
        return rows
    return [
        row for row in rows
        if str(urlsplit(str(row.get("url") or "")).hostname or "").casefold()
        in hostnames
    ]


def _unassessed_first(
    rows: list[dict[str, Any]],
    assessed_urls: set[str],
) -> list[dict[str, Any]]:
    """Stable partition: URLs without an existing assessment come first.

    Keeps URL ordering deterministic inside each partition, so repeated passes
    make forward progress instead of always re-including the same head rows.
    """
    def sort_key(row: dict[str, Any]) -> tuple[int, str]:
        url = str(row.get("url") or "").casefold()
        return (0 if url not in assessed_urls else 1, url)

    return sorted(rows, key=sort_key)


def _fit_profile_records(
    context: dict[str, Any],
    key: str,
    rows: list[dict[str, Any]],
    budget: int,
) -> list[dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    for row in rows:
        candidate = {
            "id": row.get("id"),
            "url": _truncate(str(row.get("url") or ""), 1_000),
            "function": _truncate(str(row.get("function") or ""), 500),
            "technology_stack": [
                _truncate(str(item), 160)
                for item in list(row.get("technology_stack") or [])[:20]
            ],
        }
        probe = dict(context)
        probe[key] = accepted + [candidate]
        if _json_chars(probe) > budget:
            break
        accepted.append(candidate)
    return accepted


def _enforce_budget(
    context: dict[str, Any],
    budget: int,
    selected_ids: dict[str, list[str]],
    omitted: dict[str, int],
) -> None:
    """Prune optional memory records without touching task or owner input."""

    prune_order = (
        "method_pack",
        "routine_network_summary",
        "technology_asset_profile",
        "retrieved_lessons",
        "recent_plan_batches",
        "recent_decisions",
        "active_counterfactuals",
        "human_refutation_memory",
        "human_finding_verdicts",
        "system_vulnerabilities",
        "recent_facts",
        "human_dismissed_directions",
        "recent_negative_evidence",
        "active_hypotheses",
        "recent_intents",
        "related_human_verdicts",
        "related_technology_observations",
        "related_system_vulnerabilities",
        "related_facts",
        "related_negative_evidence",
        "open_waf_branches",
        # mrecon observations are the profile task's core work input; prune
        # them only after every auxiliary section has already given way.
        "mrecon_observations",
    )
    for key in prune_order:
        if _json_chars(context) <= budget:
            break
        value = context.get(key)
        if isinstance(value, list):
            while value and _json_chars(context) > budget:
                # 常规列表最旧在前，从头部裁剪；mrecon 观察是“最重要在前”
                # （未评估优先），从尾部裁剪以保住头部待评估记录。
                removed = value.pop() if key == "mrecon_observations" else value.pop(0)
                omitted[key] = omitted.get(key, 0) + 1
                removed_id = str(removed.get("id")) if isinstance(removed, dict) and removed.get("id") else None
                if removed_id and key in selected_ids:
                    selected_ids[key] = [item for item in selected_ids[key] if item != removed_id]
        elif isinstance(value, dict) and value != {"省略": "超过当前角色上下文预算"}:
            context[key] = {"省略": "超过当前角色上下文预算"}
            omitted[key] = omitted.get(key, 0) + 1


def _compact(value: Any, *, max_string: int, max_items: int, depth: int) -> Any:
    if depth <= 0:
        return "[DEPTH_LIMIT]"
    if isinstance(value, str):
        return _truncate(value, max_string)
    if isinstance(value, dict):
        items = list(value.items())[:max_items]
        return {
            str(key): _compact(item, max_string=max_string, max_items=max_items, depth=depth - 1)
            for key, item in items
        }
    if isinstance(value, (list, tuple)):
        return [
            _compact(item, max_string=max_string, max_items=max_items, depth=depth - 1)
            for item in list(value)[:max_items]
        ]
    return value


def _truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 24)] + "…[已按上下文预算截断]"


def _json_chars(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, indent=2))
