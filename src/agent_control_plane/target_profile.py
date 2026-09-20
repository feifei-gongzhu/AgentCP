from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .schemas import RoutineTargetGroup, TargetAssessment, TargetProfileRecord, now_iso
from .store import ProjectStore


PROFILE_STATE_FILE = "profile_state.json"
PROFILE_MAX_BASELINE_PASSES = 3
PROFILE_MAX_NO_PROGRESS_PASSES = 2


SENSITIVE_QUERY_MARKERS = (
    "access_token",
    "auth",
    "code",
    "credential",
    "key",
    "password",
    "secret",
    "session",
    "signature",
    "token",
)


def canonical_target_url(value: str) -> str:
    """Normalize a discovered URL without discarding functional query parameters."""

    raw = str(value or "").strip()
    parsed = urlsplit(raw)
    scheme = parsed.scheme.casefold()
    if scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("目标画像 URL 必须是完整的 HTTP(S) URL")
    host = parsed.hostname.casefold()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("目标画像 URL 端口非法") from exc
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = f"{host}:{port}"
    query: list[tuple[str, str]] = []
    for key, item in parse_qsl(parsed.query, keep_blank_values=True):
        safe = "[REDACTED]" if any(marker in key.casefold() for marker in SENSITIVE_QUERY_MARKERS) else item
        query.append((key, safe))
    return urlunsplit((
        scheme,
        host,
        parsed.path or "/",
        urlencode(sorted(query)),
        "",
    ))


def _technology_stack(value: object) -> list[str]:
    if isinstance(value, str):
        raw = value.replace("；", ";").replace("，", ",")
        items = [part for group in raw.split(";") for part in group.split(",")]
    elif isinstance(value, list):
        items = value
    else:
        items = []
    result: list[str] = []
    seen: set[str] = set()
    for item in items[:30]:
        technology = str(item or "").strip()
        key = technology.casefold()
        if not technology or key in seen:
            continue
        seen.add(key)
        result.append(technology[:160])
    return result


def record_target_profile(
    store: ProjectStore,
    rows: list[dict[str, Any]],
    *,
    proposed_by: str,
) -> list[TargetProfileRecord]:
    existing: set[tuple[str, str, tuple[str, ...]]] = set()
    for row in store.read_jsonl("target_profile_records.jsonl"):
        try:
            url = canonical_target_url(str(row.get("url") or ""))
        except ValueError:
            continue
        function = str(row.get("function") or "").strip()
        if not function:
            continue
        stack_key = tuple(sorted(
            technology.casefold()
            for technology in _technology_stack(row.get("technology_stack"))
        ))
        existing.add((url, function.casefold(), stack_key))

    recorded: list[TargetProfileRecord] = []
    for row in rows[:200]:
        if not isinstance(row, dict):
            continue
        try:
            url = canonical_target_url(str(row.get("url") or ""))
        except ValueError:
            continue
        function = str(row.get("function") or "").strip()
        if not function:
            continue
        technology_stack = _technology_stack(row.get("technology_stack"))
        fingerprint = (
            url,
            function.casefold(),
            tuple(sorted(technology.casefold() for technology in technology_stack)),
        )
        if fingerprint in existing:
            continue
        record = TargetProfileRecord(
            url=url,
            function=function[:500],
            technology_stack=technology_stack,
            proposed_by=str(proposed_by or "profile_mapper").strip() or "profile_mapper",
        )
        store.append_jsonl("target_profile_records.jsonl", record)
        recorded.append(record)
        existing.add(fingerprint)
    return recorded


def target_profile(store: ProjectStore) -> list[dict[str, Any]]:
    """Return one row per canonical in-scope URL with merged functions and technology."""

    from .asset_inventory import asset_value_in_scope

    merged: dict[str, dict[str, Any]] = {}
    for row in store.read_jsonl("target_profile_records.jsonl"):
        try:
            url = canonical_target_url(str(row.get("url") or ""))
        except ValueError:
            continue
        if not asset_value_in_scope(store, url):
            continue
        function = str(row.get("function") or "").strip()
        if not function:
            continue
        current = merged.get(url)
        if current is None:
            current = {
                "id": row.get("id"),
                "url": url,
                "function": function,
                "technology_stack": _technology_stack(row.get("technology_stack")),
                "proposed_by": str(row.get("proposed_by") or "profile_mapper"),
                "observed_at": row.get("observed_at"),
                "observation_count": 1,
                "_functions": [function],
                "_function_keys": {function.casefold()},
            }
            merged[url] = current
            continue
        current["observation_count"] += 1
        function_key = function.casefold()
        if function_key not in current["_function_keys"]:
            current["_function_keys"].add(function_key)
            current["_functions"].append(function)
        known = {item.casefold() for item in current["technology_stack"]}
        for technology in _technology_stack(row.get("technology_stack")):
            if technology.casefold() not in known:
                known.add(technology.casefold())
                current["technology_stack"].append(technology)
        if str(row.get("observed_at") or "") > str(current.get("observed_at") or ""):
            current["observed_at"] = row.get("observed_at")
            current["proposed_by"] = row.get("proposed_by") or current["proposed_by"]
    result: list[dict[str, Any]] = []
    for current in merged.values():
        current["function"] = "；".join(current.pop("_functions"))
        current.pop("_function_keys")
        result.append(current)
    return sorted(result, key=lambda item: str(item["url"]).casefold())


PROFILE_CLASSES = {"priority_target", "routine_network_info", "needs_review"}


def _short_list(value: object, *, limit: int, item_limit: int = 160) -> list[str]:
    values = value if isinstance(value, list) else []
    result: list[str] = []
    seen: set[str] = set()
    for raw in values[:limit]:
        item = str(raw or "").strip()[:item_limit]
        key = item.casefold()
        if item and key not in seen:
            seen.add(key)
            result.append(item)
    return result


def record_target_assessments(
    store: ProjectStore,
    rows: list[dict[str, Any]],
    *,
    proposed_by: str,
) -> list[TargetAssessment]:
    """Append AI target-priority judgments without mutating collection facts."""

    profiles = {str(item["url"]): item for item in target_profile(store)}
    existing = {
        (
            str(item.get("url") or ""),
            str(item.get("profile_class") or ""),
            item.get("target_score"),
            tuple(str(tag).casefold() for tag in item.get("risk_tags") or []),
            str(item.get("score_reason") or "").casefold(),
        )
        for item in store.read_jsonl("target_assessments.jsonl")
    }
    recorded: list[TargetAssessment] = []
    for raw in rows[:200]:
        if not isinstance(raw, dict):
            continue
        try:
            url = canonical_target_url(str(raw.get("url") or ""))
        except ValueError:
            continue
        profile_class = str(raw.get("profile_class") or "").strip()
        if profile_class not in PROFILE_CLASSES or url not in profiles:
            continue
        score: int | None = None
        if profile_class == "priority_target":
            try:
                score = max(0, min(100, int(raw.get("target_score"))))
            except (TypeError, ValueError):
                continue
        risk_tags = _short_list(raw.get("risk_tags"), limit=12, item_limit=80)
        score_reason = str(raw.get("score_reason") or "").strip()[:600]
        tests = _short_list(raw.get("recommended_tests"), limit=8, item_limit=100)
        fingerprint = (
            url, profile_class, score, tuple(item.casefold() for item in risk_tags),
            score_reason.casefold(),
        )
        if fingerprint in existing:
            continue
        record = TargetAssessment(
            url=url,
            target_profile_id=str(profiles[url].get("id") or "") or None,
            profile_class=profile_class,
            target_score=score,
            risk_tags=risk_tags,
            score_reason=score_reason,
            recommended_tests=tests,
            proposed_by=proposed_by,
        )
        store.append_jsonl("target_assessments.jsonl", record)
        recorded.append(record)
        existing.add(fingerprint)
    return recorded


def target_assessments(store: ProjectStore) -> list[dict[str, Any]]:
    """Return the latest in-scope assessment per canonical URL."""

    from .asset_inventory import asset_value_in_scope

    latest: dict[str, dict[str, Any]] = {}
    for row in store.read_jsonl("target_assessments.jsonl"):
        try:
            url = canonical_target_url(str(row.get("url") or ""))
        except ValueError:
            continue
        if asset_value_in_scope(store, url):
            latest[url] = {**row, "url": url}
    return sorted(
        latest.values(),
        key=lambda item: (
            item.get("profile_class") != "priority_target",
            -int(item.get("target_score") or -1),
            str(item.get("url") or ""),
        ),
    )


def record_routine_target_groups(
    store: ProjectStore,
    rows: list[dict[str, Any]],
    *,
    proposed_by: str,
) -> list[RoutineTargetGroup]:
    existing = {
        str(item.get("group_key") or "").casefold()
        for item in store.read_jsonl("routine_target_groups.jsonl")
        if str(item.get("group_key") or "").strip()
    }
    recorded: list[RoutineTargetGroup] = []
    for raw in rows[:100]:
        if not isinstance(raw, dict):
            continue
        label = str(raw.get("label") or "").strip()[:200]
        hostname = str(raw.get("hostname") or "").strip().casefold()[:255]
        pattern = str(raw.get("url_pattern") or "").strip()[:500]
        try:
            count = max(1, int(raw.get("member_count") or 1))
        except (TypeError, ValueError):
            continue
        if not label or not hostname or not pattern:
            continue
        representatives: list[str] = []
        for value in list(raw.get("representative_urls") or [])[:5]:
            try:
                representatives.append(canonical_target_url(str(value)))
            except ValueError:
                continue
        supplied_key = str(raw.get("group_key") or "").strip()
        material = f"{hostname}\x1f{label.casefold()}\x1f{pattern.casefold()}"
        group_key = supplied_key[:160] or hashlib.sha256(material.encode()).hexdigest()[:24]
        if group_key.casefold() in existing:
            continue
        record = RoutineTargetGroup(
            group_key=group_key,
            label=label,
            hostname=hostname,
            url_pattern=pattern,
            member_count=count,
            representative_urls=representatives,
            classification_reason=str(raw.get("classification_reason") or "").strip()[:600],
            proposed_by=proposed_by,
        )
        store.append_jsonl("routine_target_groups.jsonl", record)
        recorded.append(record)
        existing.add(group_key.casefold())
    return recorded


def routine_target_groups(store: ProjectStore) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in store.read_jsonl("routine_target_groups.jsonl"):
        key = str(row.get("group_key") or row.get("id") or "")
        if key:
            latest[key] = row
    return sorted(latest.values(), key=lambda item: (-int(item.get("member_count") or 0), str(item.get("label") or "")))


def project_target_priority_blackboard(store: ProjectStore) -> None:
    """Project a bounded summary; raw HTTP bodies remain in evidence storage."""

    heading = "## 目标画像与渗透优先级"
    assessments = target_assessments(store)
    priorities = [
        item for item in assessments
        if item.get("profile_class") == "priority_target"
    ][:30]
    reviews = sum(item.get("profile_class") == "needs_review" for item in assessments)
    groups = routine_target_groups(store)[:20]
    lines = [
        heading,
        "",
        "> 本区只保留可调度结论和证据引用；HTTP 报文正文保存在 `evidence/mrecon/`，不写入 Worker 上下文。",
        "",
        f"- 优先渗透目标：{len(priorities)}（黑板最多展示 30 条）",
        f"- 待复核：{reviews}（不评分）",
        f"- 常规网络信息分组：{len(groups)}（不评分）",
        "",
    ]
    if priorities:
        lines.extend(["| 评分 | URL | 风险标签 | 评分依据 |", "|---:|---|---|---|"])
        for item in priorities:
            tags = "、".join(_short_list(item.get("risk_tags"), limit=5, item_limit=40)) or "-"
            reason = str(item.get("score_reason") or "-").replace("|", "\\|").replace("\n", " ")[:180]
            url = str(item.get("url") or "").replace("|", "%7C")
            lines.append(f"| {int(item.get('target_score') or 0)} | `{url}` | {tags} | {reason} |")
        lines.append("")
    if groups:
        lines.extend([
            "### 常规网络信息（合并展示，不评分）", "",
            "| 分类 | 数量 | 主机 | URL 模式 |", "|---|---:|---|---|",
        ])
        for item in groups:
            label = str(item.get("label") or "常规网络信息").replace("|", "\\|")[:80]
            host = str(item.get("hostname") or "-").replace("|", "\\|")
            pattern = str(item.get("url_pattern") or "-").replace("|", "\\|")[:160]
            lines.append(f"| {label} | {int(item.get('member_count') or 0)} | `{host}` | `{pattern}` |")
        lines.append("")
    replacement = "\n".join(lines).rstrip() + "\n\n"

    with store.locked():
        filename = "项目黑板_知识库.md"
        body = store.read_text(filename)
        start = body.find(heading)
        if start >= 0:
            next_heading = body.find("\n## ", start + len(heading))
            body = body[:start] + replacement + (body[next_heading + 1:] if next_heading >= 0 else "")
        else:
            insert_before = "## 高价值发现"
            position = body.find(insert_before)
            body = body[:position] + replacement + body[position:] if position >= 0 else body.rstrip() + "\n\n" + replacement
        store.write_text(filename, body)
        store.write_text("blackboard.md", body)


def seed_priority_target_directions(store: ProjectStore, database: Any) -> int:
    """Turn scored profile targets into compact, deduplicated Executor Intents."""

    from .schemas import Intent

    created = 0
    for assessment in target_assessments(store):
        if assessment.get("profile_class") != "priority_target":
            continue
        score = max(0, min(100, int(assessment.get("target_score") or 0)))
        tests = _short_list(assessment.get("recommended_tests"), limit=8, item_limit=100)
        tags = _short_list(assessment.get("risk_tags"), limit=12, item_limit=80)
        target = str(assessment.get("url") or "")
        reason = str(assessment.get("score_reason") or "").strip()
        test_label = "、".join(tests) if tests else "目标边界验证"
        intent = Intent(
            verb=f"按画像优先级执行 {test_label}",
            target=target,
            evidence_sink=f"evidence/profile-targets/{assessment['id']}.txt",
            success_criteria="形成可复核证据，确认或否定该目标是否存在真实安全边界突破。",
            hypothesis=reason or f"{target} 被目标画像标记为高价值攻击面",
            scope_check="项目所有测试目标已统一授权",
            scope_refs=["*"],
            expected_business_impact=f"画像标签：{'、'.join(tags)}" if tags else "待专项验证",
            prerequisite_readiness=0.8,
            information_gain=0.8,
            estimated_cost=max(0.1, min(0.8, 1.0 - score / 125.0)),
            priority_score=round(score / 100.0, 4),
            risk_level=("critical" if score >= 95 else "high" if score >= 80 else "medium" if score >= 50 else "low"),
            action_safety_risk="low",
            evidence_maturity="hypothesis",
            target_profile_id=str(assessment.get("target_profile_id") or "") or None,
            target_score=score,
            risk_tags=tags,
            recommended_tests=tests,
            proposed_by=str(assessment.get("proposed_by") or "profile_mapper"),
            chain_id=str(assessment.get("id") or ""),
        )
        _direction_id, inserted = database.register_direction(asdict(intent))
        if inserted:
            store.append_jsonl("intents.jsonl", intent)
            created += 1
    return created


def target_profile_fingerprint(store: ProjectStore) -> str:
    target = store.read_json("target.json")
    material = {
        "targets": sorted(str(item).strip() for item in target.get("targets", []) if str(item).strip()),
        "target_path": str(target.get("target_path") or "").strip(),
        "project_type": str(target.get("project_type") or "").strip(),
        "scope": sorted(str(item).strip() for item in target.get("scope", []) if str(item).strip()),
        "out_of_scope": sorted(
            str(item).strip() for item in target.get("out_of_scope", []) if str(item).strip()
        ),
    }
    encoded = json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _target_requirement(value: object) -> dict[str, str | None] | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    explicit_url = "://" in raw
    candidate = raw if explicit_url else f"https://{raw}"
    parsed = urlsplit(candidate)
    if not parsed.hostname:
        return None
    canonical_url: str | None = None
    if explicit_url:
        try:
            canonical_url = canonical_target_url(raw)
        except ValueError:
            return None
    return {
        "raw": raw,
        "hostname": parsed.hostname.casefold(),
        "canonical_url": canonical_url,
    }


def configured_target_requirements(store: ProjectStore) -> list[dict[str, str | None]]:
    requirements: list[dict[str, str | None]] = []
    seen: set[tuple[str, str | None]] = set()
    for value in store.read_json("target.json").get("targets", []):
        requirement = _target_requirement(value)
        if requirement is None:
            continue
        key = (
            str(requirement["hostname"]),
            requirement["canonical_url"],
        )
        if key in seen:
            continue
        seen.add(key)
        requirements.append(requirement)
    return requirements


def pending_baseline_profile_targets(store: ProjectStore) -> list[str]:
    """Return only configured targets not represented by the current profile.

    Bare host targets are covered by any profiled URL on that hostname. Explicit
    HTTP(S) URL targets retain the stricter historical behavior and require the
    exact canonical URL.
    """

    rows = target_profile(store)
    profiled_urls = {str(item.get("url") or "") for item in rows}
    profiled_hosts = {
        str(urlsplit(url).hostname or "").casefold()
        for url in profiled_urls
    }
    missing: list[str] = []
    for requirement in configured_target_requirements(store):
        canonical_url = requirement["canonical_url"]
        covered = (
            canonical_url in profiled_urls
            if canonical_url
            else str(requirement["hostname"]) in profiled_hosts
        )
        if not covered:
            missing.append(str(requirement["raw"]))
    return missing


def load_profile_state(store: ProjectStore) -> dict[str, Any]:
    fingerprint = target_profile_fingerprint(store)
    path = store.path / PROFILE_STATE_FILE
    saved = store.read_json(PROFILE_STATE_FILE) if path.exists() else {}
    if saved.get("target_fingerprint") != fingerprint:
        record_count = len(target_profile(store))
        return {
            "target_fingerprint": fingerprint,
            "baseline_status": "partial" if record_count else "not_started",
            "baseline_passes": 0,
            "baseline_started_at": None,
            "baseline_completed_at": saved.get("baseline_completed_at") if record_count else None,
            "record_count": record_count,
            "last_record_count": record_count,
            "no_progress_count": 0,
            "pending_seed_urls": list(saved.get("pending_seed_urls", [])),
            "completed_seed_urls": list(saved.get("completed_seed_urls", [])),
            "incremental_attempted_run_id": None,
            "last_error": None,
            "target_change_detected": True,
            "updated_at": now_iso(),
        }
    saved.setdefault("baseline_status", "not_started")
    saved.setdefault("baseline_passes", 0)
    saved.setdefault("record_count", len(target_profile(store)))
    saved.setdefault("last_record_count", saved["record_count"])
    saved.setdefault("no_progress_count", 0)
    saved.setdefault("pending_seed_urls", [])
    saved.setdefault("completed_seed_urls", [])
    saved.setdefault("incremental_attempted_run_id", None)
    saved.setdefault("last_error", None)
    return saved


def save_profile_state(store: ProjectStore, state: dict[str, Any]) -> dict[str, Any]:
    clean = dict(state)
    clean["target_fingerprint"] = target_profile_fingerprint(store)
    clean["record_count"] = len(target_profile(store))
    clean["updated_at"] = now_iso()
    clean["pending_seed_urls"] = list(dict.fromkeys(
        str(item).strip() for item in clean.get("pending_seed_urls", []) if str(item).strip()
    ))
    clean["completed_seed_urls"] = list(dict.fromkeys(
        str(item).strip() for item in clean.get("completed_seed_urls", []) if str(item).strip()
    ))
    store.write_json(PROFILE_STATE_FILE, clean)
    return clean


def baseline_profile_required(store: ProjectStore) -> bool:
    state = load_profile_state(store)
    requirements = configured_target_requirements(store)
    missing = pending_baseline_profile_targets(store)
    state["pending_baseline_targets"] = missing
    state["configured_target_count"] = len(requirements)
    if not requirements:
        state["baseline_status"] = "not_applicable"
        state["baseline_completed_at"] = state.get("baseline_completed_at") or now_iso()
        state["last_error"] = None
        save_profile_state(store, state)
        return False
    # A baseline is deliberately bounded. Once it has produced usable records
    # and exhausted either pass budget, remaining endpoints belong to the
    # incremental lane; otherwise every explicit Run would restart a formal
    # preflight that can never converge.
    if (
        int(state.get("record_count", 0)) > 0
        and (
            int(state.get("baseline_passes", 0)) >= PROFILE_MAX_BASELINE_PASSES
            or int(state.get("no_progress_count", 0)) >= PROFILE_MAX_NO_PROGRESS_PASSES
        )
    ):
        state["baseline_status"] = "partial"
        state["baseline_completed_at"] = state.get("baseline_completed_at") or now_iso()
        save_profile_state(store, state)
        return False
    if not missing and int(state.get("record_count", 0)) > 0:
        if state.get("baseline_status") not in {"complete", "partial"}:
            state["baseline_status"] = "partial"
        state["baseline_completed_at"] = state.get("baseline_completed_at") or now_iso()
        state["last_error"] = None
        state["migration_source"] = "existing_target_profile"
        save_profile_state(store, state)
        return False
    save_profile_state(store, state)
    return True


def begin_baseline_profile_pass(store: ProjectStore) -> dict[str, Any]:
    state = load_profile_state(store)
    if state.get("baseline_status") == "failed":
        state["baseline_passes"] = 0
        state["no_progress_count"] = 0
        state["baseline_started_at"] = None
    if not state.get("baseline_started_at"):
        state["baseline_started_at"] = now_iso()
    state["baseline_status"] = "running"
    state["baseline_passes"] = int(state.get("baseline_passes", 0)) + 1
    state["last_record_count"] = len(target_profile(store))
    state["last_error"] = None
    return save_profile_state(store, state)


def finish_baseline_profile_pass(
    store: ProjectStore,
    *,
    exploration_complete: bool,
    error: str | None = None,
) -> dict[str, Any]:
    state = load_profile_state(store)
    before = int(state.get("last_record_count", 0))
    after = len(target_profile(store))
    if after > before:
        state["no_progress_count"] = 0
    else:
        state["no_progress_count"] = int(state.get("no_progress_count", 0)) + 1
    state["record_count"] = after
    state["last_error"] = str(error or "").strip() or None
    if error:
        state["baseline_status"] = "partial" if after > 0 else "failed"
        if after > 0:
            state["baseline_completed_at"] = state.get("baseline_completed_at") or now_iso()
    elif exploration_complete and after > 0:
        state["baseline_status"] = "complete"
        state["baseline_completed_at"] = now_iso()
    elif (
        after == 0
        and (
            exploration_complete
            or int(state.get("baseline_passes", 0)) >= PROFILE_MAX_BASELINE_PASSES
            or int(state.get("no_progress_count", 0)) >= PROFILE_MAX_NO_PROGRESS_PASSES
        )
    ):
        state["baseline_status"] = "failed"
        state["last_error"] = "基础画像没有形成任何有效 URL"
    elif (
        after > 0
        and (
            int(state.get("baseline_passes", 0)) >= PROFILE_MAX_BASELINE_PASSES
            or int(state.get("no_progress_count", 0)) >= PROFILE_MAX_NO_PROGRESS_PASSES
        )
    ):
        state["baseline_status"] = "partial"
        state["baseline_completed_at"] = now_iso()
    else:
        state["baseline_status"] = "pending"
    return save_profile_state(store, state)


def queue_incremental_profile_urls(
    store: ProjectStore,
    values: list[object],
) -> list[str]:
    state = load_profile_state(store)
    known = {str(item["url"]) for item in target_profile(store)}
    pending = set(str(item) for item in state.get("pending_seed_urls", []))
    completed = set(str(item) for item in state.get("completed_seed_urls", []))
    added: list[str] = []
    for value in values:
        try:
            url = canonical_target_url(str(value or ""))
        except ValueError:
            continue
        if url in known or url in pending or url in completed:
            continue
        pending.add(url)
        added.append(url)
    if added:
        state["pending_seed_urls"] = sorted(pending)
        save_profile_state(store, state)
    return added


def pending_incremental_profile_urls(
    store: ProjectStore,
    *,
    run_id: str | None = None,
) -> list[str]:
    state = load_profile_state(store)
    if run_id and state.get("incremental_attempted_run_id") == run_id:
        return []
    return [str(item) for item in state.get("pending_seed_urls", []) if str(item).strip()]


def mark_incremental_profile_started(
    store: ProjectStore,
    run_id: str,
) -> list[str]:
    state = load_profile_state(store)
    state["incremental_attempted_run_id"] = run_id
    state["last_error"] = None
    save_profile_state(store, state)
    return [str(item) for item in state.get("pending_seed_urls", []) if str(item).strip()]


def finish_incremental_profile(
    store: ProjectStore,
    seed_urls: list[str],
    *,
    error: str | None = None,
) -> dict[str, Any]:
    state = load_profile_state(store)
    state["last_error"] = str(error or "").strip() or None
    if not error:
        consumed = set(seed_urls)
        state["pending_seed_urls"] = [
            str(item) for item in state.get("pending_seed_urls", [])
            if str(item) not in consumed
        ]
        state["completed_seed_urls"] = list(dict.fromkeys([
            *[str(item) for item in state.get("completed_seed_urls", [])],
            *seed_urls,
        ]))
    return save_profile_state(store, state)
