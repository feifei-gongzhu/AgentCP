from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from .database import ControlDatabase
from .lifecycle import project_execution_lock, require_initialized_project
from .quality import QualityLedger
from .store import ProjectStore


DOMAIN_PATTERN = re.compile(r"(?<![A-Za-z0-9_-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![A-Za-z0-9_-])")


def _canonical_asset(value: object) -> str | None:
    text = str(value or "").strip().rstrip("/.,;:)")
    if not text:
        return None
    parsed = urlparse(text if "://" in text else f"//{text}")
    if parsed.hostname:
        host = parsed.hostname.casefold().rstrip(".")
        return f"{host}:{parsed.port}" if parsed.port else host
    return text.casefold()


def project_asset_inventory(store: ProjectStore, facts: list[dict] | None = None) -> list[str]:
    """Return a deduplicated inventory from declared targets and asset Facts."""
    target = store.read_json("target.json")
    assets = {
        canonical
        for value in target.get("targets", [])
        if (canonical := _canonical_asset(value))
    }
    for fact in facts if facts is not None else store.read_jsonl("facts.jsonl"):
        for value in fact.get("assets", []) or []:
            canonical = _canonical_asset(value)
            if canonical:
                assets.add(canonical)
        if fact.get("category") == "asset":
            text = f"{fact.get('title', '')} {fact.get('evidence', '')}"
            for value in DOMAIN_PATTERN.findall(text):
                canonical = _canonical_asset(value)
                if canonical:
                    assets.add(canonical)
    return sorted(assets)


def refresh_asset_count(store: ProjectStore) -> int:
    count = len(project_asset_inventory(store))
    state = store.load_state()
    if state.asset_count != count:
        state.asset_count = count
        store.save_state(state)
    return count


def collect_metrics(store: ProjectStore) -> dict[str, Any]:
    with project_execution_lock(store):
        require_initialized_project(store)
        return _collect_metrics_locked(store)


def _collect_metrics_locked(store: ProjectStore) -> dict[str, Any]:
    state = store.load_state()
    facts = store.read_jsonl("facts.jsonl")
    intents = store.read_jsonl("intents.jsonl")
    coverage = state.attack_surface_coverage
    covered = sum(status != "unverified" for status in coverage.values())
    verified = sum(status == "verified" for status in coverage.values())
    vulnerabilities = sum(item.get("status") == "vulnerability" for item in facts)
    phenomena = sum(item.get("status") == "phenomenon" for item in facts)
    assets = project_asset_inventory(store, facts)
    declared_assets = {
        canonical
        for value in store.read_json("target.json").get("targets", [])
        if (canonical := _canonical_asset(value))
    }

    database_path = store.path / "control_plane.db"
    runs: list[dict] = []
    jobs: list[dict] = []
    duplicate_directions = 0
    directions: list[dict] = []
    if database_path.exists():
        database = ControlDatabase(database_path)
        runs = database.list_runs()
        jobs = database.list_all_jobs()
        directions = database.list_directions()
        duplicate_directions = database.event_count("direction_duplicate")

    completed_jobs = sum(item.get("status") == "completed" for item in jobs)
    failed_jobs = sum(item.get("status") == "failed" for item in jobs)
    retry_count = sum(max(0, int(item.get("attempts", 0)) - 1) for item in jobs)
    direction_total = len(directions) + duplicate_directions
    current_run = runs[-1] if runs else None
    current_jobs = [item for item in jobs if current_run and item.get("run_id") == current_run.get("id")]
    terminal_statuses = {"completed", "failed", "cancelled", "cancelling"}
    terminal_jobs = [item for item in current_jobs if item.get("status") in terminal_statuses]
    current_completed = sum(item.get("status") == "completed" for item in current_jobs)
    current_failed = sum(item.get("status") in {"failed", "cancelled", "cancelling"} for item in current_jobs)
    pending_facts = sum(
        item.get("status") == "completed"
        and not item.get("committed_at")
        and ((item.get("result") or {}).get("payload") or {}).get("kind") == "fact"
        for item in current_jobs
    )

    human_quality = QualityLedger().project_metrics(store)
    return {
        "project": store.vendor,
        "assets": {
            "total": len(assets),
            "declared": len(declared_assets),
            "discovered": len(set(assets) - declared_assets),
            "items": assets,
        },
        "coverage": {
            "dimensions": len(coverage),
            "covered": covered,
            "verified": verified,
            "coverage_rate": covered / len(coverage) if coverage else 0.0,
            "verification_coverage_rate": verified / len(coverage) if coverage else 0.0,
        },
        "quality": {
            "facts": len(facts),
            "pending_facts": pending_facts,
            "phenomena": phenomena,
            "vulnerabilities": vulnerabilities,
            "validation_rate": vulnerabilities / len(facts) if facts else 0.0,
            "human_review": human_quality,
        },
        "directions": {
            "intents": len(intents),
            "unique": len(directions),
            "duplicates_blocked": duplicate_directions,
            "duplicate_rate": duplicate_directions / direction_total if direction_total else 0.0,
            "open": sum(item.get("status") == "open" for item in directions),
            "claimed": sum(item.get("status") == "claimed" for item in directions),
            "completed": sum(item.get("status") == "completed" for item in directions),
        },
        "automation": {
            "runs": len(runs),
            "completed_runs": sum(item.get("status") == "completed" for item in runs),
            "jobs": len(jobs),
            "completed_jobs": completed_jobs,
            "failed_jobs": failed_jobs,
            "retry_count": retry_count,
            "job_success_rate": completed_jobs / len(jobs) if jobs else 0.0,
            "current_run": {
                "id": current_run.get("id") if current_run else None,
                "status": current_run.get("status") if current_run else "idle",
                "jobs": len(current_jobs),
                "finished_jobs": len(terminal_jobs),
                "completed_jobs": current_completed,
                "failed_jobs": current_failed,
                "progress_rate": len(terminal_jobs) / len(current_jobs) if current_jobs else 0.0,
                "success_rate": current_completed / len(terminal_jobs) if terminal_jobs else 0.0,
            },
        },
    }
