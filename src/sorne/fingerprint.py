"""双轨指纹（实施方案 §7.1）。

- **被动轨**：消费已有观察（mrecon 观察的原始 HTTP 证据、画像/技术观察、
  采集层新拿到的响应内容）做规则匹配。
- **主动轨**：只对已分配目标执行规则配置的路径探针；**重定向、统一错误页、
  登录页与 catch-all 都先取随机路径基线对照**；状态码命中不等于技术确认
  ——确认需要内容标记（marker_pattern）匹配且与基线可区分。

每条匹配记录：规则 ID/版本、track（passive/active）、匹配片段、原始证据
引用、时间、状态与置信来源。**主动与被动冲突时保留双方证据**（方案
§7.1/§5.3：不强行二选一，先补验证）；冲突记录同时携带两轨证据引用。

规则来自资源仓库 ``fingerprint_rules`` 类别（来源/许可/版本/哈希/启停可
管理）；没有启用资源时指纹能力如实报缺口，不用硬编码绕过。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from . import resource_repository
from .schemas import now_iso

PASSIVE = "passive"
ACTIVE = "active"


class FingerprintError(RuntimeError):
    pass


def load_rules(store) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    loaded = resource_repository.load_active(store, "fingerprint_rules")
    if loaded is None:
        raise FingerprintError(
            "capability_missing: 没有启用的指纹规则资源；请在资源仓库启用或"
            "导入 fingerprint_rules 后重试，不以硬编码规则冒充。"
        )
    content, entry = loaded
    rules: list[dict[str, Any]] = []
    for rule in content:
        try:
            compiled_passive = [
                {"source": str(item["source"]), "pattern": re.compile(str(item["pattern"]))}
                for item in (rule.get("passive") or [])
            ]
            active = rule.get("active") or None
            compiled_active = None
            if isinstance(active, dict) and active.get("paths"):
                compiled_active = {
                    "paths": [str(p) for p in active["paths"]][:8],
                    "marker": re.compile(str(active.get("marker_pattern") or "."), re.IGNORECASE),
                }
            rules.append({
                "rule_id": str(rule["rule_id"]),
                "technology": str(rule["technology"]),
                "category": str(rule.get("category") or ""),
                "rule_version": str(rule.get("version") or 1),
                "passive": compiled_passive,
                "active": compiled_active,
            })
        except (KeyError, re.error, TypeError):
            continue
    if not rules:
        raise FingerprintError(
            f"capability_missing: 指纹规则资源 {entry.get('id')} 没有有效规则。"
        )
    return rules, {"resource_id": entry.get("id"), "version": entry.get("version")}


def _split_transcript(text: str) -> tuple[str, str, str]:
    """HTTP 证据转写 → (header 块, cookie 行合集, body)。非转写文本归 body。"""
    normalized = text.replace("\r\n", "\n")
    if "\n\n" in normalized and normalized.split("\n", 1)[0].startswith("HTTP/"):
        head, body = normalized.split("\n\n", 1)
    else:
        return "", "", normalized
    cookie_lines = "\n".join(
        line for line in head.split("\n") if line.casefold().startswith("set-cookie")
    )
    return head, cookie_lines, body


def _match_passive(
    rule: dict[str, Any],
    *,
    url: str,
    headers_text: str,
    cookies_text: str,
    body_text: str,
    evidence_ref: str,
    observed_at: str,
    source_kind: str,
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for spec in rule["passive"]:
        haystack = {
            "header": headers_text, "cookie": cookies_text, "body": body_text,
        }.get(spec["source"], "")
        if not haystack:
            continue
        found = spec["pattern"].search(haystack)
        if not found:
            continue
        matches.append({
            "url": url,
            "technology": rule["technology"],
            "category": rule["category"],
            "rule_id": rule["rule_id"],
            "rule_version": rule["rule_version"],
            "track": PASSIVE,
            "matched_fragment": found.group(0)[:200],
            "match_source": f"{source_kind}:{spec['source']}",
            "evidence_ref": evidence_ref,
            "observed_at": observed_at,
            "status": "observed",
            "confidence_source": "passive_pattern",
        })
    return matches


def passive_from_observations(
    rules: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    *,
    evidence_reader: Callable[[str], str] | None = None,
) -> list[dict[str, Any]]:
    """对采集层即时提供的观察跑被动匹配。

    observation: {url, evidence_ref, transcript（可选）, observed_at, source_kind}。
    """
    matches: list[dict[str, Any]] = []
    for observation in observations[:64]:
        transcript = str(observation.get("transcript") or "")
        if not transcript and evidence_reader is not None:
            transcript = evidence_reader(str(observation.get("evidence_ref") or ""))
        if not transcript:
            continue
        headers_text, cookies_text, body_text = _split_transcript(transcript[:120_000])
        for rule in rules:
            matches.extend(_match_passive(
                rule,
                url=str(observation.get("url") or ""),
                headers_text=headers_text,
                cookies_text=cookies_text,
                body_text=body_text,
                evidence_ref=str(observation.get("evidence_ref") or ""),
                observed_at=str(observation.get("observed_at") or now_iso()),
                source_kind=str(observation.get("source_kind") or "collect"),
            ))
    return matches


def passive_track(
    store,
    rules: list[dict[str, Any]],
    targets: list[str],
    *,
    evidence_reader: Callable[[str], str] | None = None,
) -> list[dict[str, Any]]:
    """被动轨：消费 mrecon 已有观察的原始证据（§7.1）。"""
    from .mrecon import compact_mrecon_rows

    def _default_reader(ref: str) -> str:
        path = store.path / str(ref)
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    reader = evidence_reader or _default_reader
    lowered = [str(t).casefold() for t in targets if str(t)]
    observations: list[dict[str, Any]] = []
    for row in compact_mrecon_rows(store):
        url = str(row.get("url") or "").casefold()
        if lowered and not any(url.startswith(t) or t in url for t in lowered):
            continue
        evidence_ref = str(row.get("evidence_ref") or "")
        if not evidence_ref:
            continue
        observations.append({
            "url": row.get("url"),
            "evidence_ref": evidence_ref,
            "observed_at": str(row.get("observed_at") or now_iso()),
            "source_kind": "mrecon",
        })
        if len(observations) >= 24:
            break
    return passive_from_observations(rules, observations, evidence_reader=reader)


def active_track(
    rules: list[dict[str, Any]],
    targets: list[str],
    *,
    fetcher: Callable[..., dict[str, Any]],
    cancel_check: Callable[[], bool] | None = None,
    evidence_writer: Callable[[str, str, dict[str, Any]], str] | None = None,
    max_probes: int = 24,
) -> list[dict[str, Any]]:
    """主动轨：配置化路径检查（基线对照 + 内容标记，§7.1）。

    ``fetcher(url, method=...)`` 复用采集层受控请求；``evidence_writer``
    (url, kind, response) -> 相对证据路径 由调用方提供（网关/采集层把
    探针与基线响应落盘）。
    """
    import secrets

    cancel = cancel_check or (lambda: False)
    matches: list[dict[str, Any]] = []
    probes = 0
    for target in targets[:8]:
        base = str(target).rstrip("/")
        # 基线：随机路径（catch-all/统一错误页/登录跳转对照）
        control = fetcher(f"{base}/sorne-fp-{secrets.token_hex(6)}")
        if not control.get("ok"):
            continue
        for rule in rules:
            active = rule.get("active")
            if not active:
                continue
            if cancel() or probes >= max_probes:
                return matches
            for path in active["paths"]:
                if probes >= max_probes or cancel():
                    return matches
                probes += 1
                response = fetcher(f"{base}{path if path.startswith('/') else '/' + path}")
                if not response.get("ok"):
                    continue
                body = (response.get("body") or b"").decode("utf-8", errors="replace")
                headers_text = "\n".join(
                    f"{key}: {value}" for key, value in (response.get("headers") or {}).items()
                )
                marker_hit = bool(active["marker"].search(body) or active["marker"].search(headers_text))
                baseline_like = response.get("status") == control.get("status") and (
                    (response.get("body") or b"") == (control.get("body") or b"")
                )
                location = next(
                    (v for k, v in (response.get("headers") or {}).items()
                     if k.casefold() == "location"), "",
                )
                # 登录跳转：30x → 登录页（按规则由内容标记判定，不由状态码）
                evidence_ref = ""
                if evidence_writer is not None:
                    evidence_ref = evidence_writer(f"{base}{path}", "probe", response)
                if marker_hit and not baseline_like:
                    status = "confirmed_by_marker"
                elif marker_hit and baseline_like:
                    status = "not_confirmed_baseline_identical"
                elif location:
                    status = "redirected_before_confirm"
                else:
                    status = "no_marker"
                matches.append({
                    "url": f"{base}{path}",
                    "technology": rule["technology"],
                    "category": rule["category"],
                    "rule_id": rule["rule_id"],
                    "rule_version": rule["rule_version"],
                    "track": ACTIVE,
                    "matched_fragment": (
                        (active["marker"].search(body) or active["marker"].search(headers_text)).group(0)[:200]
                        if marker_hit else ""
                    ),
                    "match_source": f"active_probe:{path}",
                    "evidence_ref": evidence_ref,
                    "probe": {
                        "status": response.get("status"),
                        "baseline_status": control.get("status"),
                        "baseline_identical": baseline_like,
                        "location": location[:300],
                    },
                    "observed_at": now_iso(),
                    "status": status,
                    "confidence_source": "active_marker",
                })
    return matches


def evaluate(
    store,
    targets: list[str],
    *,
    fetcher: Callable[..., dict[str, Any]] | None = None,
    evidence_writer: Callable[[str, str, dict[str, Any]], str] | None = None,
    extra_observations: list[dict[str, Any]] | None = None,
    evidence_reader: Callable[[str], str] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """双轨评估：返回两轨匹配与冲突报告（冲突保留双方证据，§7.1）。"""
    rules, rules_meta = load_rules(store)
    passive_matches = passive_track(
        store, rules, targets, evidence_reader=evidence_reader,
    )
    if extra_observations:
        passive_matches += passive_from_observations(
            rules, extra_observations, evidence_reader=evidence_reader,
        )
    active_matches: list[dict[str, Any]] = []
    if fetcher is not None:
        active_matches = active_track(
            rules, targets, fetcher=fetcher,
            cancel_check=cancel_check, evidence_writer=evidence_writer,
        )
    # 冲突检测：同 (url 主机, technology) 一轨给出观察/确认、另一轨无标记
    # → 冲突记录保留双方证据引用。
    def _host(url: str) -> str:
        return str(urlsplit(url if "://" in url else f"http://{url}").netloc).casefold()

    by_key: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = {}
    for match in passive_matches + active_matches:
        by_key.setdefault((_host(str(match["url"])), str(match["technology"])), {}).setdefault(
            match["track"], [],
        ).append(match)
    conflicts: list[dict[str, Any]] = []
    for (host, technology), tracks in by_key.items():
        passive_hits = [m for m in tracks.get(PASSIVE, []) if m["status"] == "observed"]
        active_rows = tracks.get(ACTIVE, [])
        if passive_hits and active_rows and not any(
            m["status"] == "confirmed_by_marker" for m in active_rows
        ):
            conflicts.append({
                "host": host,
                "technology": technology,
                "kind": "passive_observed_active_unconfirmed",
                "both_sides_kept": True,  # 双方证据都保留，不强行裁决
                "passive_evidence_refs": sorted({m["evidence_ref"] for m in passive_hits if m["evidence_ref"]}),
                "active_evidence_refs": sorted({m["evidence_ref"] for m in active_rows if m["evidence_ref"]}),
                "note": (
                    "被动轨观察到指纹而主动探针未确认（可能统一错误页/登录跳转/路径变化）。"
                    "两轨证据均保留，后续验证不得只引用其一（方案 §7.1）。"
                ),
            })
    return {
        "rules": rules_meta,
        "passive_matches": passive_matches,
        "active_matches": active_matches,
        "conflicts": conflicts,
        "captured_at": now_iso(),
    }


def persist_matches(store, evaluation: dict[str, Any], *, targets: list[str]) -> int:
    """把指纹匹配与冲突记录落到 ``fingerprint_matches.jsonl``（机器账本）。

    §7.1 要求记录规则 ID/版本、匹配片段、原始证据、时间、状态与置信来源，
    并在冲突时保留双方证据。这是采集层账本（同 coverage_ledger 模式），
    不是业务事实——影响事实/计划的结论仍经 technology_observations 提交链
    与复核链。
    """
    records: list[dict[str, Any]] = []
    for track_key in ("passive_matches", "active_matches"):
        for match in evaluation.get(track_key) or []:
            records.append({**match, "targets_scope": targets[:8]})
    for conflict in evaluation.get("conflicts") or []:
        records.append({
            "record_kind": "conflict",
            "host": conflict.get("host"),
            "technology": conflict.get("technology"),
            "conflict_kind": conflict.get("kind"),
            "both_sides_kept": True,
            "passive_evidence_refs": conflict.get("passive_evidence_refs") or [],
            "active_evidence_refs": conflict.get("active_evidence_refs") or [],
            "note": conflict.get("note"),
            "observed_at": now_iso(),
        })
    for record in records:
        store.append_jsonl("fingerprint_matches.jsonl", record)
    return len(records)


def to_technology_observations(evaluation: dict[str, Any]) -> list[dict[str, Any]]:
    """指纹匹配 → technology_observe 观察载荷（仍走提交链，不直接确认漏洞）。

    只转换有证据引用的匹配；冲突项附加 conflict 标记（保留双方证据语义）。
    """
    conflict_keys = {
        (item["host"], item["technology"])
        for item in evaluation.get("conflicts") or []
    }

    def _host(url: str) -> str:
        return str(urlsplit(url if "://" in url else f"http://{url}").netloc).casefold()

    rows: list[dict[str, Any]] = []
    for match in evaluation.get("passive_matches") or []:
        if not match.get("evidence_ref"):
            continue
        rows.append({
            "url": match["url"],
            "technology": match["technology"],
            "category": match.get("category") or "fingerprint",
            "evidence_path": match["evidence_ref"],
            "fingerprint_track": PASSIVE,
            "rule_id": match["rule_id"],
            "rule_version": match["rule_version"],
            "matched_fragment": match.get("matched_fragment"),
            "confidence_source": match.get("confidence_source"),
            "conflict_with_active": (_host(str(match["url"])), str(match["technology"])) in conflict_keys or None,
        })
    for match in evaluation.get("active_matches") or []:
        if match.get("status") != "confirmed_by_marker":
            continue  # 未确认的主动探针不进入技术观察（§7.1 状态码≠确认）
        if not match.get("evidence_ref"):
            continue
        rows.append({
            "url": match["url"],
            "technology": match["technology"],
            "category": match.get("category") or "fingerprint",
            "evidence_path": match["evidence_ref"],
            "fingerprint_track": ACTIVE,
            "rule_id": match["rule_id"],
            "rule_version": match["rule_version"],
            "matched_fragment": match.get("matched_fragment"),
            "confidence_source": match.get("confidence_source"),
            "probe_status": (match.get("probe") or {}).get("status"),
        })
    # 去重（同 url+technology+track 保留第一条）
    seen: set[tuple[str, str, str]] = set()
    deduped: list[dict[str, Any]] = []
    for row in rows:
        key = (str(row["url"]), str(row["technology"]), str(row["fingerprint_track"]))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped[:32]
