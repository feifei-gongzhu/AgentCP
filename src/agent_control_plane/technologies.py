from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .schemas import TechnologyObservation
from .store import ProjectStore


TECHNOLOGY_CATEGORIES = {
    "frontend",
    "frontend_architecture",
    "frontend_framework",
    "ui_library",
    "build_tool",
    "backend",
    "backend_framework",
    "web_server",
    "gateway",
    "cdn_waf",
    "api",
    "api_protocol",
    "authentication",
    "data_store",
    "analytics",
    "third_party",
    "tls",
    "other",
}

CATEGORY_ALIASES = {
    "frontend": "frontend_framework",
    "backend": "backend_framework",
    "api": "api_protocol",
}

EVIDENCE_TYPES = {
    "response_header",
    "cookie",
    "html",
    "javascript_bundle",
    "tls_certificate",
    "favicon_hash",
    "public_endpoint",
    "tool_output",
    "other",
}

DEPLOYMENT_ROUTE_PREFIXES = (
    "master-",
    "sub-",
    "primary-",
    "secondary-",
    "replica-",
)


def canonical_url(value: str) -> str:
    from .target_profile import canonical_target_url

    try:
        return canonical_target_url(value)
    except ValueError as exc:
        raise ValueError("技术观察的 url 必须是完整的 HTTP(S) URL") from exc


def _verified_evidence_path(store: ProjectStore, value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    relative = Path(raw)
    if relative.is_absolute() or ".." in relative.parts:
        return ""
    resolved = (store.path / relative).resolve()
    allowed = (store.path / "evidence").resolve()
    try:
        resolved.relative_to(allowed)
    except ValueError:
        return ""
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        return ""
    return resolved.relative_to(store.path).as_posix()


def application_route_identity(value: str) -> tuple[str, str, str]:
    """Return an origin, deployment-neutral route and application family."""

    url = canonical_url(value)
    parsed = urlsplit(url)
    segments = [item for item in parsed.path.split("/") if item]
    if not segments:
        return f"{parsed.scheme}://{parsed.netloc}", "/", parsed.hostname or parsed.netloc
    first = segments[0]
    family = first
    for prefix in DEPLOYMENT_ROUTE_PREFIXES:
        if first.casefold().startswith(prefix) and len(first) > len(prefix):
            family = first[len(prefix):]
            break
    neutral_path = "/" + "/".join([family, *segments[1:]])
    return f"{parsed.scheme}://{parsed.netloc}", neutral_path, family


def _merge_asset_technologies(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[tuple[str, str, str], dict[str, Any]] = {}
    status_rank = {"suspected": 0, "confirmed": 1, "conflict": 2}
    for item in items:
        key = (
            str(item.get("category") or "other"),
            str(item.get("technology") or "").casefold(),
            str(item.get("version") or "").casefold(),
        )
        current = merged.get(key)
        if current is None:
            current = dict(item)
            current["evidence_paths"] = list(dict.fromkeys(item.get("evidence_paths") or []))
            current["source_fact_ids"] = [item["source_fact_id"]] if item.get("source_fact_id") else []
            merged[key] = current
            continue
        current["confidence"] = max(float(current.get("confidence", 0)), float(item.get("confidence", 0)))
        current["observation_count"] = int(current.get("observation_count", 1)) + int(item.get("observation_count", 1))
        current["first_observed_at"] = min(
            str(current.get("first_observed_at") or current.get("observed_at") or ""),
            str(item.get("first_observed_at") or item.get("observed_at") or ""),
        )
        current["last_verified_at"] = max(
            str(current.get("last_verified_at") or ""),
            str(item.get("last_verified_at") or ""),
        )
        for path in item.get("evidence_paths") or []:
            if path not in current["evidence_paths"]:
                current["evidence_paths"].append(path)
        source_fact_id = item.get("source_fact_id")
        if source_fact_id and source_fact_id not in current["source_fact_ids"]:
            current["source_fact_ids"].append(source_fact_id)
        if status_rank.get(str(item.get("verification_status")), 0) > status_rank.get(
            str(current.get("verification_status")), 0
        ):
            current["verification_status"] = item.get("verification_status")
    return sorted(
        merged.values(),
        key=lambda item: (
            item.get("verification_status") != "confirmed",
            str(item.get("category") or ""),
            str(item.get("technology") or "").casefold(),
        ),
    )


def record_technology_observations(
    store: ProjectStore,
    rows: list[dict[str, Any]],
    *,
    proposed_by: str,
    source_fact_id: str | None = None,
    hypothesis_id: str | None = None,
    intent_id: str | None = None,
) -> list[TechnologyObservation]:
    recorded: list[TechnologyObservation] = []
    for row in rows[:50]:
        if not isinstance(row, dict):
            continue
        try:
            url = canonical_url(str(row.get("url") or ""))
        except (TypeError, ValueError):
            continue
        technology = str(row.get("technology") or "").strip()
        if not technology:
            continue
        category = str(row.get("category") or "other").strip().lower()
        if category not in TECHNOLOGY_CATEGORIES:
            category = "other"
        category = CATEGORY_ALIASES.get(category, category)
        evidence_type = str(row.get("evidence_type") or "other").strip().lower()
        if evidence_type not in EVIDENCE_TYPES:
            evidence_type = "other"
        evidence_path = _verified_evidence_path(store, str(row.get("evidence_path") or ""))
        requested_confidence = max(0.0, min(1.0, float(row.get("confidence", 0.5))))
        status = "confirmed" if evidence_path else "suspected"
        observation = TechnologyObservation(
            url=url,
            technology=technology,
            category=category,
            version=str(row.get("version") or "").strip(),
            confidence=requested_confidence if evidence_path else min(requested_confidence, 0.69),
            evidence_type=evidence_type,
            evidence_path=evidence_path,
            verification_status=status,
            source_fact_id=str(row.get("source_fact_id") or source_fact_id or "").strip() or None,
            hypothesis_id=str(row.get("hypothesis_id") or hypothesis_id or "").strip() or None,
            intent_id=str(row.get("intent_id") or intent_id or "").strip() or None,
            proposed_by=proposed_by,
        )
        store.append_jsonl("technology_observations.jsonl", observation)
        recorded.append(observation)
    return recorded


def technology_profile(store: ProjectStore) -> list[dict[str, Any]]:
    """Return a compact in-scope URL-first profile while preserving conflicting versions."""

    from .asset_inventory import asset_value_in_scope

    exact: dict[tuple[str, str, str], dict[str, Any]] = {}
    versions: dict[tuple[str, str], set[str]] = defaultdict(set)
    for row in store.read_jsonl("technology_observations.jsonl"):
        try:
            url = canonical_url(str(row.get("url") or ""))
        except (TypeError, ValueError):
            continue
        if not asset_value_in_scope(store, url):
            continue
        technology = str(row.get("technology") or "").strip()
        if not technology:
            continue
        version = str(row.get("version") or "").strip()
        identity = (url, technology.casefold(), version.casefold())
        technology_identity = (url, technology.casefold())
        if version:
            versions[technology_identity].add(version.casefold())
        current = exact.get(identity)
        evidence_path = str(row.get("evidence_path") or "").strip()
        if current is None:
            current = dict(row)
            current["url"] = url
            current["evidence_paths"] = [evidence_path] if evidence_path else []
            current["observation_count"] = 1
            current["first_observed_at"] = row.get("observed_at")
            exact[identity] = current
            continue
        current["observation_count"] += 1
        if evidence_path and evidence_path not in current["evidence_paths"]:
            current["evidence_paths"].append(evidence_path)
        current["confidence"] = max(float(current.get("confidence", 0)), float(row.get("confidence", 0)))
        current["last_verified_at"] = max(
            str(current.get("last_verified_at") or ""),
            str(row.get("last_verified_at") or row.get("observed_at") or ""),
        )
        if row.get("verification_status") == "confirmed":
            current["verification_status"] = "confirmed"

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for (url, technology_key, _version), item in exact.items():
        if len(versions[(url, technology_key)]) > 1:
            item["verification_status"] = "conflict"
        grouped[url].append(item)
    assets: dict[tuple[str, str], dict[str, Any]] = {}
    for url, items in sorted(grouped.items()):
        origin, neutral_path, family = application_route_identity(url)
        key = (origin, neutral_path)
        asset = assets.setdefault(key, {
            "url": url,
            "urls": [],
            "route_aliases": [],
            "origin": origin,
            "application_family": family,
            "application_label": f"{family} 应用" if family else origin,
            "technologies": [],
        })
        asset["urls"].append(url)
        asset["technologies"].extend(items)
    result: list[dict[str, Any]] = []
    for asset in assets.values():
        asset["urls"] = sorted(dict.fromkeys(asset["urls"]))
        asset["url"] = asset["urls"][0]
        asset["route_aliases"] = asset["urls"][1:]
        asset["technologies"] = _merge_asset_technologies(asset["technologies"])
        result.append(asset)
    return sorted(result, key=lambda item: (str(item["origin"]), str(item["url"])))


def enriched_target_profile(store: ProjectStore) -> list[dict[str, Any]]:
    """Merge model-reported functions with evidence-aware technology observations."""

    from .target_profile import target_assessments, target_profile

    profile_rows = target_profile(store)
    assessments_by_url = {
        str(item.get("url") or ""): item
        for item in target_assessments(store)
    }
    observed_by_route: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    observed_urls_by_route: dict[tuple[str, str], set[str]] = defaultdict(set)
    for asset in technology_profile(store):
        routes: set[tuple[str, str]] = set()
        for url in asset.get("urls") or [asset.get("url")]:
            if url:
                route = application_route_identity(str(url))[:2]
                observed_urls_by_route[route].add(str(url))
                routes.add(route)
        for route in routes:
            observed_by_route[route].extend(asset.get("technologies") or [])
    by_url = {str(item["url"]): dict(item) for item in profile_rows}
    represented_routes = {
        application_route_identity(url)[:2]
        for url in by_url
    }
    for route, urls in observed_urls_by_route.items():
        if route in represented_routes:
            continue
        for url in urls:
            by_url.setdefault(url, {
                "url": url,
                "function": "未说明",
                "technology_stack": [],
                "observation_count": 0,
            })
    enriched: list[dict[str, Any]] = []
    for url, row in by_url.items():
        route = application_route_identity(url)[:2]
        technologies = _merge_asset_technologies(observed_by_route.get(route, []))
        observed_names = {
            str(item.get("technology") or "").casefold()
            for item in technologies
        }
        for reported in row.get("technology_stack") or []:
            name = str(reported or "").strip()
            if not name or name.casefold() in observed_names:
                continue
            technologies.append({
                "technology": name,
                "version": "",
                "category": "other",
                "confidence": None,
                "verification_status": "reported",
                "evidence_paths": [],
                "observation_count": 0,
            })
        assessment = assessments_by_url.get(url) or {}
        enriched.append({
            **row,
            "technologies": technologies,
            "profile_class": assessment.get("profile_class") or "needs_review",
            "target_score": assessment.get("target_score"),
            "risk_tags": list(assessment.get("risk_tags") or []),
            "score_reason": str(assessment.get("score_reason") or ""),
            "recommended_tests": list(assessment.get("recommended_tests") or []),
            "assessment_id": assessment.get("id"),
            "assessed_at": assessment.get("assessed_at"),
        })
    return sorted(
        enriched,
        key=lambda item: (
            item.get("profile_class") != "priority_target",
            -int(item.get("target_score") or -1),
            str(item.get("url") or "").casefold(),
        ),
    )
