from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import re
from typing import Any

from .schemas import Lesson
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


def record_negative_lesson(store: ProjectStore, negative: dict[str, Any]) -> dict[str, Any] | None:
    """Convert a reusable failed path into durable, scoped planning memory."""
    evidence_type = str(negative.get("evidence_type") or "inconclusive")
    if evidence_type not in {"target_negative", "environment_blocked"}:
        return None
    source_id = str(negative.get("id") or "").strip() or None
    identity = "\x1f".join(_normal(negative.get(key)) for key in (
        "target", "hypothesis", "method", "reason",
    ))
    fingerprint = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    for item in store.read_jsonl("lessons.jsonl"):
        if source_id and item.get("source_id") == source_id:
            return item
        existing = "\x1f".join(_normal(item.get(key)) for key in (
            "target", "hypothesis", "method", "outcome",
        ))
        if hashlib.sha256(existing.encode("utf-8")).hexdigest() == fingerprint:
            return item
    lesson = Lesson(
        pattern=(
            f"在 {negative.get('target')} 上使用 {negative.get('method')} 验证「"
            f"{negative.get('hypothesis')}」时，结果为 {negative.get('reason')}。"
            "在作用域或环境发生实质变化前不得原样重试。"
        ),
        expiry_conditions=[str(item) for item in negative.get("invalidation_triggers", [])],
        target=str(negative.get("target") or ""),
        hypothesis=str(negative.get("hypothesis") or ""),
        method=str(negative.get("method") or ""),
        outcome=str(negative.get("reason") or negative.get("outcome") or ""),
        evidence_paths=[str(item) for item in negative.get("evidence_paths", [])],
        source_id=source_id,
        valid_until=str(negative.get("valid_until") or "") or None,
        confidence=0.9 if evidence_type == "target_negative" else 0.7,
    )
    store.append_jsonl("lessons.jsonl", lesson)
    return lesson.__dict__


def relevant_lessons(
    store: ProjectStore,
    query: dict[str, Any] | None = None,
    limit: int = 12,
) -> list[dict[str, Any]]:
    """Retrieve active lessons by deterministic lexical overlap, newest on ties."""
    now = datetime.now(timezone.utc)
    query_text = " ".join(str(value or "") for value in (query or {}).values())
    query_tokens = _tokens(query_text)
    ranked: list[tuple[float, str, dict[str, Any]]] = []
    for item in store.read_jsonl("lessons.jsonl"):
        valid_until = str(item.get("valid_until") or "").strip()
        if valid_until:
            try:
                expiry = datetime.fromisoformat(valid_until.replace("Z", "+00:00"))
                if expiry.tzinfo is None:
                    expiry = expiry.replace(tzinfo=timezone.utc)
                if expiry <= now:
                    continue
            except ValueError:
                continue
        lesson_tokens = _tokens(" ".join(str(item.get(key) or "") for key in (
            "target", "hypothesis", "method", "pattern", "outcome",
        )))
        overlap = len(query_tokens & lesson_tokens)
        target_bonus = 3 if _normal(item.get("target")) and _normal(item.get("target")) in _normal(query_text) else 0
        score = overlap + target_bonus + float(item.get("confidence", 0.5))
        if query_tokens and score <= 0.5:
            continue
        ranked.append((score, str(item.get("created_at") or ""), item))
    ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return [item for _, _, item in ranked[:max(1, limit)]]


def _normal(value: Any) -> str:
    return " ".join(str(value or "").strip().casefold().split())


def _tokens(value: Any) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9_.:/-]{3,}|[\u4e00-\u9fff]{2,}", _normal(value))
        if token
    }
