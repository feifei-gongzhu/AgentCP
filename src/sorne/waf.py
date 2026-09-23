from __future__ import annotations

from typing import Any

from .schemas import new_id, now_iso
from .store import ProjectStore


ACTIVE_WAF_STATES = {"suspected", "confirmed", "characterizing", "differential_found"}


class WAFManager:
    def current(self, store: ProjectStore) -> list[dict[str, Any]]:
        branches = {str(item.get("id")): dict(item) for item in store.read_jsonl("waf_assessments.jsonl")}
        for event in store.read_jsonl("waf_events.jsonl"):
            branch = branches.get(str(event.get("assessment_id")))
            if not branch:
                continue
            branch["status"] = event.get("status", branch.get("status"))
            branch["used_minutes"] = event.get("used_minutes", branch.get("used_minutes", 0))
            if event.get("tested_mutation_family"):
                tested = list(branch.get("tested_mutation_families") or [])
                if event["tested_mutation_family"] not in tested:
                    tested.append(event["tested_mutation_family"])
                branch["tested_mutation_families"] = tested
            if event.get("differential_found") is not None:
                branch["differential_found"] = bool(event["differential_found"])
            if event.get("semantic_preserved") is not None:
                branch["semantic_preserved"] = event["semantic_preserved"]
        return list(branches.values())

    def active(self, store: ProjectStore) -> list[dict[str, Any]]:
        return [
            item for item in self.current(store)
            if item.get("status") in ACTIVE_WAF_STATES
            and int(item.get("used_minutes", 0)) < int(item.get("budget_minutes", 12))
        ]

    def record_result(
        self,
        store: ProjectStore,
        assessment_id: str,
        *,
        status: str,
        used_delta: int = 1,
        tested_mutation_family: str | None = None,
        differential_found: bool | None = None,
        semantic_preserved: bool | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        from .commits import CommitCoordinator, CommitPlanner, new_source_id

        source_id = idempotency_key or new_source_id("WAF")
        payload = {
            "assessment_id": assessment_id,
            "status": status,
            "used_delta": used_delta,
            "tested_mutation_family": tested_mutation_family,
            "differential_found": differential_found,
            "semantic_preserved": semantic_preserved,
        }
        plan = CommitPlanner().freeze_action(
            kind="waf_result",
            payload=payload,
            source_type="waf_result",
            source_id=source_id,
            idempotency_key=idempotency_key or f"waf_result:{source_id}",
            aggregate_type="waf_assessment",
            aggregate_id=assessment_id,
        )
        result = CommitCoordinator(store).submit(plan)
        if not isinstance(result, dict):
            result = next(
                (
                    item
                    for item in reversed(store.read_jsonl("waf_events.jsonl"))
                    if (item.get("_projection") or {}).get("event_id")
                    == plan.event.event_id
                ),
                None,
            )
        if not isinstance(result, dict):
            raise RuntimeError("WAF 投影已提交但无法读取对应事件")
        return result

    def _record_result_legacy(
        self,
        store: ProjectStore,
        assessment_id: str,
        *,
        status: str,
        used_delta: int = 1,
        tested_mutation_family: str | None = None,
        differential_found: bool | None = None,
        semantic_preserved: bool | None = None,
    ) -> dict[str, Any]:
        current = next((item for item in self.current(store) if item.get("id") == assessment_id), None)
        if current is None:
            raise ValueError(f"WAF 分支不存在: {assessment_id}")
        used = min(
            int(current.get("budget_minutes", 12)),
            int(current.get("used_minutes", 0)) + max(0, used_delta),
        )
        if used >= int(current.get("budget_minutes", 12)) and status in ACTIVE_WAF_STATES:
            status = "exhausted"
        event = {
            "id": new_id("WE"),
            "assessment_id": assessment_id,
            "status": status,
            "used_minutes": used,
            "tested_mutation_family": tested_mutation_family,
            "differential_found": differential_found,
            "semantic_preserved": semantic_preserved,
            "created_at": now_iso(),
        }
        store.append_jsonl("waf_events.jsonl", event)
        return event
