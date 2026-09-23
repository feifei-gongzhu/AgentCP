from __future__ import annotations

from typing import Any

from .store import ProjectStore


OWNER_AUTHORITY = "project_owner"
OWNER_AUTHORITY_RANK = 1000
MAX_ACTIVE_DIRECTIVES = 8


def authoritative_directives(
    store: ProjectStore,
    active_run_id: str | None = None,
) -> list[dict[str, Any]]:
    """Return the effective project-owner directives for the current Run.

    Human interventions created by the Web console are project-scoped by
    default.  ``applies_to_run_id`` is retained as provenance, not as an
    expiry condition, so a service restart or a new Run cannot silently make
    an unresolved owner instruction disappear.  API clients may opt into the
    narrower ``run`` scope explicitly.
    """

    if active_run_id is None:
        active_run_id = store.load_state().active_run_id
    effective: list[dict[str, Any]] = []
    for raw in store.read_jsonl("hints.jsonl"):
        if raw.get("status", "open") != "open":
            continue
        source = str(raw.get("source") or OWNER_AUTHORITY)
        if source != OWNER_AUTHORITY:
            continue
        scope = str(raw.get("scope") or "project")
        origin_run_id = raw.get("applies_to_run_id")
        if scope == "run" and origin_run_id != active_run_id:
            continue
        item = dict(raw)
        item.update({
            "source": OWNER_AUTHORITY,
            "authority": OWNER_AUTHORITY,
            "authority_rank": OWNER_AUTHORITY_RANK,
            "scope": scope,
            "origin_run_id": origin_run_id,
            "effective_run_id": active_run_id,
            "must_follow": True,
            "supersedes_agent_planning": True,
            "carried_forward": bool(
                scope == "project"
                and origin_run_id
                and active_run_id
                and origin_run_id != active_run_id
            ),
        })
        effective.append(item)
    effective.sort(
        key=lambda item: (
            int(item.get("priority", 0)),
            str(item.get("created_at", "")),
        ),
        reverse=True,
    )
    return effective[:MAX_ACTIVE_DIRECTIVES]


def directive_ids(directives: list[dict[str, Any]]) -> list[str]:
    return [str(item["id"]) for item in directives if item.get("id")]


def missing_directive_ids(
    store: ProjectStore,
    observed_ids: list[str] | None,
    active_run_id: str | None = None,
) -> list[str]:
    current = set(directive_ids(authoritative_directives(store, active_run_id)))
    observed = {str(item) for item in (observed_ids or [])}
    return sorted(current - observed)
