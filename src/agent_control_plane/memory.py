from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .store import ProjectStore


PRUNING_NEGATIVE_TYPES = {"target_negative", "environment_blocked"}


def active_negative_evidence(store: ProjectStore) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    result: list[dict[str, Any]] = []
    for item in store.read_jsonl("negative_evidence.jsonl"):
        if item.get("evidence_type") not in PRUNING_NEGATIVE_TYPES:
            continue
        try:
            valid_until = datetime.fromisoformat(str(item.get("valid_until", "")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if valid_until.tzinfo is None:
            valid_until = valid_until.replace(tzinfo=timezone.utc)
        if valid_until > now:
            result.append(item)
    return result


def matching_negative_evidence(
    intent: dict[str, Any],
    negatives: list[dict[str, Any]],
) -> dict[str, Any] | None:
    target = _normal(intent.get("target"))
    method = _normal(intent.get("verb"))
    hypothesis = _normal(intent.get("hypothesis") or intent.get("success_criteria"))
    for item in negatives:
        negative_target = _normal(item.get("target"))
        negative_method = _normal(item.get("method"))
        negative_hypothesis = _normal(item.get("hypothesis"))
        target_matches = bool(target and negative_target and (
            target == negative_target or target in negative_target or negative_target in target
        ))
        method_matches = not negative_method or not method or negative_method == method
        hypothesis_matches = bool(
            hypothesis and negative_hypothesis and (
                hypothesis == negative_hypothesis
                or hypothesis in negative_hypothesis
                or negative_hypothesis in hypothesis
            )
        )
        if target_matches and method_matches and hypothesis_matches:
            return item
    return None


def _normal(value: Any) -> str:
    return " ".join(str(value or "").strip().casefold().split())
