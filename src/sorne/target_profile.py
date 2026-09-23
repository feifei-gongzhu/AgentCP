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

# ---------------------------------------------------------------------------
# 目标画像调度策略（工程初始值，尚未校准）。
# 这些默认值只决定“画像方向是否入队/何时替代”，与漏洞严重度无关。
# 可在 target.json 的 profile_policy 对象里按项目覆盖。
# ---------------------------------------------------------------------------
ASSESSMENT_POLICY_VERSION = "assessment-policy-v1"
PROFILE_ENQUEUE_MIN_SCORE = 40
PROFILE_SCORE_UPDATE_THRESHOLD = 15
PROFILE_NEEDS_REVIEW_MAX_ATTEMPTS = 2
PROFILE_NEEDS_REVIEW_BATCH_LIMIT = 20
# 与自动化引擎共享的高水位：开放方向达到该数量时暂停播种新的画像方向。
DIRECTION_BACKLOG_HIGH_WATERMARK = 12

PROFILE_POLICY_DEFAULTS = {
    "enqueue_min_score": PROFILE_ENQUEUE_MIN_SCORE,
    "score_update_threshold": PROFILE_SCORE_UPDATE_THRESHOLD,
    "needs_review_max_attempts": PROFILE_NEEDS_REVIEW_MAX_ATTEMPTS,
}


def profile_policy(store: ProjectStore) -> dict[str, int]:
    """Read the per-project profile scheduling policy with safe clamps."""
    policy = dict(PROFILE_POLICY_DEFAULTS)
    raw = store.read_json("target.json").get("profile_policy")
    if isinstance(raw, dict):
        for key in policy:
            try:
                policy[key] = int(raw.get(key, policy[key]))
            except (TypeError, ValueError):
                continue
    policy["enqueue_min_score"] = max(0, min(100, int(policy["enqueue_min_score"])))
    policy["score_update_threshold"] = max(1, min(100, int(policy["score_update_threshold"])))
    policy["needs_review_max_attempts"] = max(0, int(policy["needs_review_max_attempts"]))
    return policy


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
    jev_shadow_by_url: dict[str, Any] | None = None,
) -> list[TargetAssessment]:
    """Append AI target-priority judgments without mutating collection facts.

    Deduplication compares against the URL's CURRENT version only, covering
    the full decision content including ``recommended_tests``: resubmitting
    the current version is an idempotent replay, while any different content
    (including content equal to a HISTORICAL version, e.g. reverting B back
    to A) records a new version that supersedes the current one.

    ``jev_shadow_by_url`` 是提交前由 JEV System One 旁路产出、随载荷冻结
    的影子分类，合入记录的 classification_provenance 供旁路对比评测；
    显式标记 influences_scheduling=False，不参与调度。
    """

    profiles = {str(item["url"]): item for item in target_profile(store)}
    latest_by_url: dict[str, dict[str, Any]] = {}
    for item in store.read_jsonl("target_assessments.jsonl"):
        url = str(item.get("url") or "")
        if url:
            latest_by_url[url] = item
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
        fingerprint = _assessment_fingerprint({
            "url": url,
            "profile_class": profile_class,
            "target_score": score,
            "risk_tags": risk_tags,
            "score_reason": score_reason,
            "recommended_tests": tests,
        })
        previous = latest_by_url.get(url)
        if previous is not None and _assessment_fingerprint(previous) == fingerprint:
            # 与“当前版本”完全一致才视为重放；内容与历史某版本相同但不同于
            # 当前版本时，是新一次判断（例如 B 恢复为 A），必须记录为新版本。
            continue
        provenance: dict[str, Any] = {
            "source": str(proposed_by or "profile_mapper"),
            "policy_version": ASSESSMENT_POLICY_VERSION,
        }
        shadow = (jev_shadow_by_url or {}).get(url)
        if isinstance(shadow, dict):
            # 影子数据只随记录留档；键名即声明其非权威性。
            provenance["jev_shadow"] = shadow
        record = TargetAssessment(
            url=url,
            target_profile_id=str(profiles[url].get("id") or "") or None,
            profile_class=profile_class,
            target_score=score,
            risk_tags=risk_tags,
            score_reason=score_reason,
            recommended_tests=tests,
            proposed_by=proposed_by,
            supersedes=str(previous.get("id")) if previous else None,
            classification_provenance=provenance,
        )
        store.append_jsonl("target_assessments.jsonl", record)
        recorded.append(record)
        latest_by_url[url] = record.__dict__
    return recorded


def _assessment_fingerprint(item: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(item.get("url") or ""),
        str(item.get("profile_class") or ""),
        item.get("target_score"),
        tuple(str(tag).casefold() for tag in item.get("risk_tags") or []),
        str(item.get("score_reason") or "").casefold(),
        tuple(str(test).casefold() for test in item.get("recommended_tests") or []),
    )


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
    """Turn scored profile targets into bounded, lifecycle-aware Executor Intents.

    语义约定：``target_score``/``priority_score`` 只表示测试优先级（调度顺序），
    不推导 ``risk_level``（潜在风险）也不推导漏洞严重度；画像方向的
    ``action_safety_risk``/``risk_level`` 为 ``unknown``，因为画像阶段没有评估
    动作风险与潜在影响。生命周期：未入队阈值的低分目标只保留评估记录；
    跨越入队阈值（含跌破）立即生效、先于分数防抖；建议专项或评分显著变化
    会替代（supersede）旧的待执行方向，仅调分数也必须完成替代；目标降级后
    待执行方向取消（降级清理不受背压限制），评估恢复高优先时方向重新入队；
    背压限制开放方向总量，净新增按剩余容量播种；正在执行（claimed）的方向
    不打断，遵循既有租约与过期结果拦截机制。
    """

    policy = profile_policy(store)
    created = 0
    # 降级清理必须先于背压判断执行：背压只限制新增方向，
    # 不能阻止已降级目标的待执行方向被取消。
    _cancel_ineligible_profile_directions(store, database)
    # 高水位限制的是开放方向总量：只按剩余容量播种净新增方向；
    # 替代（supersede 后重建）不增加总量，不消耗容量。
    capacity = DIRECTION_BACKLOG_HIGH_WATERMARK - database.open_direction_count()
    for assessment in target_assessments(store):
        if assessment.get("profile_class") != "priority_target":
            continue
        score = max(0, min(100, int(assessment.get("target_score") or 0)))
        tests = _short_list(assessment.get("recommended_tests"), limit=8, item_limit=100)
        tags = _short_list(assessment.get("risk_tags"), limit=12, item_limit=80)
        target = str(assessment.get("url") or "")
        reason = str(assessment.get("score_reason") or "").strip()
        if not target:
            continue
        existing = _profile_directions_for(database, target)
        cooldown = _active_policy_cooldown(existing, tests)
        claim_valid, claimable, terminal = _split_claimable_directions(existing)
        if claim_valid:
            # 唯一执行中的版本受租约保护；其余可认领版本（含过期认领和
            # 存量重复 open）一律取消，保证同一目标同时最多一个可认领/执行
            # 版本，不会形成两个并行执行。
            _cancel_claimable_directions(
                database, claimable,
                "profile_duplicate_pending:superseded_by_active_claim",
            )
            continue
        if len(claimable) > 1:
            # 可认领版本归并（open、released 与**过期认领**一起参与）：
            # 只保留最新一个（列表按 created_at,id 排序，末位最新），其余取消。
            # 部分取消失败（被抢先重领）说明快照失效：本轮推迟整个目标的归并。
            expected = len(claimable) - 1
            if _cancel_claimable_directions(
                database, claimable[:-1], "profile_duplicate_pending:collapsed",
            ) < expected:
                continue
            claimable = claimable[-1:]
        replacement = False
        if claimable:
            survivor = claimable[0]
            survivor_claimed = survivor["status"] == "claimed"  # 过期认领幸存者
            if score < policy["enqueue_min_score"]:
                # 跨越入队阈值必须立即生效，先于分数防抖判断。
                demote_reason = f"profile_below_enqueue_threshold:{assessment.get('id')}"
                if survivor_claimed:
                    if not database.cancel_expired_claimed_direction(str(survivor["id"]), demote_reason):
                        continue  # 取消失败（被抢先重领）：快照失效，推迟
                elif not _supersede_directions(database, [survivor], demote_reason):
                    continue  # 取消失败（如被抢先认领）：快照失效，推迟
                continue
            current = survivor.get("intent") or {}
            if not _assessment_materially_changed(current, score, tests, policy):
                continue  # 幂等/防抖：内容一致时保留现状（幸存者仍可被认领）。
            # 替代走数据库层单事务：旧版本条件取消 + 新版本注册要么同时
            # 成功，要么同时回滚；取消失败时禁止在事务外创建替代版本。
            payload = _build_profile_direction_payload(
                assessment=assessment, score=score, tests=tests, tags=tags,
                target=target, reason=reason,
            )
            registered, _new_id, event_id, replaced = database.supersede_and_register_direction(
                payload,
                retire_direction_id=str(survivor["id"]),
                retire_reason=f"superseded_by_assessment:{assessment.get('id')}",
                version_suffix=str(assessment.get("id") or ""),
                cooldown_reason=cooldown,
            )
            if not replaced:
                continue  # 快照失效：不注册替代版本，等待下一轮同步
            # intents.jsonl 不再由调用方直写：事务内已记录待投影事件，
            # SQLite 为权威，文件写入失败时由既有 Projector 幂等补写。
            _drain_direction_intent_projection(store, database, event_id)
            created += 1
            continue
        else:
            if score < policy["enqueue_min_score"]:
                continue
            if terminal:
                last_direction = terminal[-1]
                last = last_direction.get("intent") or {}
                last_reason = str(last_direction.get("terminal_reason") or "")
                if last_reason.startswith("human_dismissed:"):
                    # 人工否决只能由显式的人工恢复（restore_direction，重开方向）
                    # 撤销；重新评分、建议专项变化等模型侧重评一律不得绕过。
                    continue
                died_by_demotion = last_reason.startswith((
                    "profile_downgraded:",
                    "profile_below_enqueue_threshold:",
                ))
                if not died_by_demotion and not _assessment_materially_changed(last, score, tests, policy):
                    continue  # 已完成且无实质变化，不重复触发相同测试。
                # 因降级/跌破阈值而终止的方向：评估恢复可入队状态时重新入队。
        if not replacement and capacity <= 0:
            continue
        payload = _build_profile_direction_payload(
            assessment=assessment, score=score, tests=tests, tags=tags,
            target=target, reason=reason,
        )
        registered, _direction_id, event_id, inserted = _register_or_version(
            database, payload, str(assessment.get("id") or ""),
            cooldown_reason=cooldown,
        )
        if inserted:
            # intents.jsonl 由投影事件补写（与替代路径一致），实际注册对象
            # （版本化时 chain_id 带 #评估ID 后缀）由 Projector 落盘，
            # 保证 SQLite 与 intents.jsonl 两个读取来源完全一致。
            _drain_direction_intent_projection(store, database, event_id)
            created += 1
            if not replacement and not cooldown:
                # 继承冷却的方向以 released 注册，不计入开放方向数，
                # 因此也不消耗背压容量。
                capacity -= 1
        # 指纹命中仍开放的方向（并发/重复提交）按既有幂等语义跳过，不占容量。
    return created


def _active_policy_cooldown(
    directions: list[dict[str, Any]],
    tests: list[str],
) -> str | None:
    """同一目标、同一建议专项集合的未到期策略冷却约束。

    分数变化不得清除冷却；更换建议专项（不同的测试集合）不继承。
    返回可直接作为新方向 terminal_reason 的 ``policy_blocked_until:`` 字符串。
    """
    new_tests = {str(item).casefold() for item in tests}
    current_time = now_iso()
    for item in reversed(directions):
        reason = str(item.get("terminal_reason") or "")
        if not reason.startswith("policy_blocked_until:"):
            continue
        until = reason[len("policy_blocked_until:"):]
        if until <= current_time:
            continue
        old_tests = {
            str(entry).casefold()
            for entry in (item.get("intent") or {}).get("recommended_tests") or []
        }
        if old_tests == new_tests:
            return reason
    return None


def _drain_direction_intent_projection(store: ProjectStore, database: Any, event_id: str | None) -> None:
    """转发到共享实现：磁盘失败静默延迟，非磁盘异常记录排障事件。"""
    from .projector import drain_direction_intent_projection

    drain_direction_intent_projection(store, database, event_id)


def _build_profile_direction_payload(
    *,
    assessment: dict[str, Any],
    score: int,
    tests: list[str],
    tags: list[str],
    target: str,
    reason: str,
) -> dict[str, Any]:
    from .schemas import Intent

    test_label = "、".join(tests) if tests else "目标边界验证"
    intent = Intent(
        verb="verify",
        target=target,
        evidence_sink=f"evidence/profile-targets/{assessment['id']}.txt",
        success_criteria=(
            f"按画像建议专项验证并形成可复核证据：{test_label}。"
            "确认或否定该目标是否存在真实安全边界突破。"
        ),
        hypothesis=reason or f"{target} 被目标画像标记为高价值攻击面",
        scope_check="项目所有测试目标已统一授权",
        scope_refs=["*"],
        expected_business_impact=f"画像标签：{'、'.join(tags)}" if tags else "待专项验证",
        prerequisite_readiness=0.8,
        information_gain=0.8,
        estimated_cost=max(0.1, min(0.8, 1.0 - score / 125.0)),
        priority_score=round(score / 100.0, 4),
        risk_level="unknown",
        action_safety_risk="unknown",
        evidence_maturity="hypothesis",
        target_profile_id=str(assessment.get("target_profile_id") or "") or None,
        target_score=score,
        risk_tags=tags,
        recommended_tests=tests,
        proposed_by=str(assessment.get("proposed_by") or "profile_mapper"),
        chain_id=f"profile:{target}",
    )
    return asdict(intent)


def _register_or_version(
    database: Any,
    payload: dict[str, Any],
    assessment_id: str,
    *,
    cooldown_reason: str | None = None,
) -> tuple[dict[str, Any], str, str | None, bool]:
    """Register a profile direction; version the chain when the fingerprint
    only collides with terminal history.

    方向指纹不含分数。仅调分数的实质重评会与刚被 supersede 的旧方向同指纹，
    历史内容恢复（B→A）也会与更早的终结方向同指纹。此时在 chain_id 上追加
    评估版本号重新注册，保证替代与复活可靠发生；指纹命中的是仍开放的
    方向时按既有幂等语义跳过。返回**实际注册成功**的载荷，调用方必须
    持久化该对象而非原始 Intent，避免双源记录漂移。
    """
    from .database import direction_intent_projection_event_id

    payload = dict(payload)
    direction_id, inserted = database.register_direction(
        payload,
        record_intent_projection=True,
        initial_status="released" if cooldown_reason else "open",
        initial_terminal_reason=cooldown_reason,
    )
    if inserted:
        return payload, str(direction_id), direction_intent_projection_event_id(str(direction_id)), True
    existing = database.get_direction(str(direction_id))
    if existing and str(existing.get("status")) in {
        "cancelled", "completed", "rejected", "exhausted", "blocked",
    }:
        versioned = dict(payload)
        versioned["chain_id"] = f"{payload['chain_id']}#{assessment_id}"
        version_id, version_inserted = database.register_direction(
            versioned,
            record_intent_projection=True,
            initial_status="released" if cooldown_reason else "open",
            initial_terminal_reason=cooldown_reason,
        )
        return (
            versioned, str(version_id),
            direction_intent_projection_event_id(str(version_id)), version_inserted,
        )
    return payload, str(direction_id), None, False


def ensure_profile_direction_restorable(store: ProjectStore, database: Any, direction_id: str) -> None:
    """恢复画像方向前的校验：同一逻辑方向已有有效后继时拒绝恢复过期版本。

    非画像方向不做该检查（没有“后继”概念），走通用恢复语义。
    """
    direction = database.get_direction(direction_id)
    if direction is None:
        raise ValueError(f"方向不存在: {direction_id}")
    intent = direction.get("intent") or {}
    if not _is_profile_direction(intent):
        return
    url = str(intent.get("target") or "").casefold()
    if not url:
        return
    successors = [
        item for item in database.list_directions()
        if item["id"] != direction_id
        and _is_profile_direction(item.get("intent") or {})
        and str((item.get("intent") or {}).get("target") or "").casefold() == url
        and item.get("status") in {"open", "released", "claimed"}
    ]
    if successors:
        successor_ids = ", ".join(sorted(str(item["id"]) for item in successors))
        raise ValueError(
            f"该目标已有更新的有效方向（{successor_ids}），不能恢复过期版本；请直接使用现有方向。"
        )


def _latest_intent(directions: list[dict[str, Any]]) -> dict[str, Any]:
    return (directions[-1] or {}).get("intent") or {}


def _assessment_materially_changed(
    intent: dict[str, Any],
    score: int,
    tests: list[str],
    policy: dict[str, int],
) -> bool:
    old_tests = {str(item).casefold() for item in intent.get("recommended_tests") or []}
    new_tests = {str(item).casefold() for item in tests}
    if old_tests != new_tests:
        return True
    try:
        old_score = int(intent.get("target_score") or 0)
    except (TypeError, ValueError):
        old_score = 0
    return abs(score - old_score) >= policy["score_update_threshold"]


def _is_profile_direction(intent: dict[str, Any]) -> bool:
    chain_id = str(intent.get("chain_id") or "")
    return chain_id.startswith("profile:") or bool(intent.get("target_profile_id"))


def _profile_directions_for(database: Any, target: str) -> list[dict[str, Any]]:
    wanted = str(target).casefold()
    result = []
    for direction in database.list_directions():
        intent = direction.get("intent") or {}
        if not _is_profile_direction(intent):
            continue
        if str(intent.get("target") or "").casefold() == wanted:
            result.append(direction)
    return result


def _split_claimable_directions(
    directions: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """按租约有效性分组：有效认领 / 可认领（open、released、过期认领）/ 终态。

    保持 created_at 顺序。租约缺失的 claimed 保守视为有效（与
    claim_direction 的重领条件一致：NULL 租约不可被重领）。过期认领
    属于"可认领"：claim_direction 的过期重领通道使它与新 open 等价，
    必须一起参与版本归并，不能一概跳过。
    """
    current_time = now_iso()
    claim_valid: list[dict[str, Any]] = []
    claimable: list[dict[str, Any]] = []
    terminal: list[dict[str, Any]] = []
    for item in directions:
        status = str(item.get("status") or "")
        if status in {"open", "released"}:
            claimable.append(item)
        elif status == "claimed":
            lease = str(item.get("lease_expires_at") or "")
            if not lease or lease > current_time:
                claim_valid.append(item)
            else:
                claimable.append(item)
        else:
            terminal.append(item)
    return claim_valid, claimable, terminal


def _cancel_claimable_directions(database: Any, directions: list[dict[str, Any]], reason: str) -> int:
    """Cancel open/released directly; claimed only through the expired-lease path."""
    cancelled = 0
    for item in directions:
        status = str(item.get("status") or "")
        if status in {"open", "released"}:
            if database.set_direction_status(str(item["id"]), "cancelled", reason[:1000]):
                cancelled += 1
        elif status == "claimed":
            if database.cancel_expired_claimed_direction(str(item["id"]), reason[:1000]):
                cancelled += 1
    return cancelled


def _supersede_directions(database: Any, directions: list[dict[str, Any]], reason: str) -> int:
    superseded = 0
    for direction in directions:
        if direction.get("status") not in {"open", "released"}:
            continue
        if database.set_direction_status(str(direction["id"]), "cancelled", reason[:1000]):
            superseded += 1
    return superseded


def _cancel_ineligible_profile_directions(store: ProjectStore, database: Any) -> int:
    """Cancel profile directions whose target is no longer eligible for enqueue.

    可入队的统一判定：最新评估存在、仍为 priority_target、且分数不低于
    当前入队阈值（含策略上调后的阈值）。open/released 的不合格方向取消
    （跌破阈值的 open 方向由主循环以带评估 ID 的精确理由取消）；claimed
    且租约已过期的方向若不合格也必须取消——否则 claim_direction 的
    “过期租约可重领”通道会让降级或跌破阈值的方向被新 Worker 重新执行。
    持有有效租约的 claimed 方向保留（执行中任务尊重租约）；已完成方向
    与历史证据保留。
    """
    policy = profile_policy(store)
    latest_by_url: dict[str, dict[str, Any]] = {
        str(item.get("url") or "").casefold(): item
        for item in target_assessments(store)
    }
    cancelled = 0
    for direction in database.list_directions():
        intent = direction.get("intent") or {}
        if not _is_profile_direction(intent):
            continue
        status = str(direction.get("status") or "")
        if status not in {"open", "released", "claimed"}:
            continue
        url = str(intent.get("target") or "").casefold()
        if not url:
            continue
        assessment = latest_by_url.get(url)
        eligible = (
            assessment is not None
            and str(assessment.get("profile_class")) == "priority_target"
            and max(0, min(100, int(assessment.get("target_score") or 0)))
            >= policy["enqueue_min_score"]
        )
        if eligible:
            continue
        if assessment is None:
            reason = "profile_no_current_assessment"
        elif str(assessment.get("profile_class")) != "priority_target":
            reason = "profile_downgraded:not_priority_target"
        else:
            reason = f"profile_below_enqueue_threshold:{assessment.get('id')}"
        if status in {"open", "released"}:
            if assessment is not None and str(assessment.get("profile_class")) == "priority_target":
                # 跌破阈值的 open/released 由主循环 pending 分支取消（理由带评估 ID）。
                continue
            if database.set_direction_status(str(direction["id"]), "cancelled", reason):
                cancelled += 1
        elif status == "claimed":
            # 条件更新只在租约确实已过期时生效；有效租约保留。
            if database.cancel_expired_claimed_direction(str(direction["id"]), reason):
                cancelled += 1
    return cancelled


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
    """旧 JSON 入队入口 → 委托 SQLite URL 工作项（单一写路径）。

    迁移完成后本函数不再写 profile_state.json 的 pending 队列；completed 的
    同身份条目跳过（与旧“已知 URL 不重复排队”一致），consumed 可重新激活。
    """
    from .asset_inventory import AssetInventory

    return AssetInventory(store).add_work_items(
        values, purpose="collect", source_reason="incremental",
    )


def pending_incremental_profile_urls(
    store: ProjectStore,
    *,
    run_id: str | None = None,
) -> list[str]:
    from .asset_inventory import AssetInventory

    return [
        str(item["canonical_url"])
        for item in AssetInventory(store).pending_collect_work_items(
            run_id=run_id, limit=10_000,
        )
    ]


def mark_incremental_profile_started(
    store: ProjectStore,
    run_id: str,
) -> list[str]:
    """停用：Run 栅栏由派发事务写入的 last_dispatch_run_id 承担。

    保留签名以兼容旧调用；返回按新数据源计算的当前待办。
    """
    return pending_incremental_profile_urls(store, run_id=run_id)


def finish_incremental_profile(
    store: ProjectStore,
    seed_urls: list[str],
    *,
    error: str | None = None,
) -> dict[str, Any]:
    """停用：结果回写走 AssetInventory.record_job_profile_result（按 Job 幂等）。

    保留签名以兼容旧调用；仅返回阶段统计，不再消费任何队列。
    """
    return load_profile_state(store)


# ---------------------------------------------------------------------------
# needs_review 有界复核（与“尚未评估”严格区分）。
# 复核不新增常驻 Agent：needs_review URL 合并进已有的增量画像通道，
# 每个方向 Run 至多复核一批（工作项 last_dispatch_run_id 限流），
# 达到上限后进入 exhausted 终态，不再重复消耗模型调用。
# 以下三个函数自 V7 起委托 SQLite 工作项；profile_state.json 中的
# needs_review_attempts / *attempted_run_id 字段成为迁移前的归档数据。
# ---------------------------------------------------------------------------

def pending_needs_review_urls(
    store: ProjectStore,
    *,
    limit: int = PROFILE_NEEDS_REVIEW_BATCH_LIMIT,
    exclude_run_id: str | None = None,
) -> list[str]:
    """needs_review 且复核次数未耗尽的 URL，有界返回。

    ``exclude_run_id`` 是每 Run 一批的围栏：本 Run 已派发过复核的 URL
    不再重复返回，避免同一 Run 多波反复消耗复核次数。
    """
    from .asset_inventory import AssetInventory

    inventory = AssetInventory(store)
    inventory.sync_needs_review_work_items()
    cap = profile_policy(store)["needs_review_max_attempts"]
    return [
        str(item["canonical_url"])
        for item in inventory.pending_review_work_items(
            run_id=exclude_run_id, limit=limit, cap=cap,
        )
    ]


def mark_needs_review_queued(
    store: ProjectStore,
    urls: list[str],
    *,
    run_id: str | None = None,
) -> list[str]:
    """Record one review attempt per URL at queue time (not at model time).

    委托 SQLite（record_review_queue_count）。正常调度路径的计数发生在
    派发事务；本入口只服务兼容调用与测试的“排队即计数”语义。
    """
    from .asset_inventory import AssetInventory

    return AssetInventory(store).record_review_queue_count(urls, run_id=run_id)


def needs_review_exhausted_urls(store: ProjectStore) -> list[str]:
    from .asset_inventory import AssetInventory

    inventory = AssetInventory(store)
    inventory.sync_needs_review_work_items()
    return inventory.exhausted_review_urls()


def assessment_coverage(store: ProjectStore) -> dict[str, Any]:
    """采集 / 评估 / 待复核三维度覆盖，避免把“有 URL 记录”当成“已评级”。"""
    profiled_urls = {str(item.get("url") or "") for item in target_profile(store)}
    latest = target_assessments(store)
    by_class = {"priority_target": 0, "routine_network_info": 0, "needs_review": 0}
    assessed_urls: set[str] = set()
    for assessment in latest:
        profile_class = str(assessment.get("profile_class") or "")
        if profile_class in by_class:
            by_class[profile_class] += 1
        url = str(assessment.get("url") or "")
        if url:
            assessed_urls.add(url)
    exhausted = {url for url in needs_review_exhausted_urls(store) if url}
    policy = profile_policy(store)
    return {
        "profiled_urls": len(profiled_urls),
        "assessed": len(assessed_urls & profiled_urls),
        "unassessed": len(profiled_urls - assessed_urls),
        "by_class": by_class,
        "needs_review_pending_recheck": max(0, by_class["needs_review"] - len(exhausted)),
        "needs_review_exhausted": len(exhausted),
        "enqueue_min_score": policy["enqueue_min_score"],
        "assessment_policy_version": ASSESSMENT_POLICY_VERSION,
    }
