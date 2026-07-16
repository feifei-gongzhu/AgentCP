from __future__ import annotations

from dataclasses import asdict
from typing import Any

from .methodology import intent_from_hypothesis, score_hypothesis
from .schemas import AttackHypothesis, PlanBatch, new_id, now_iso


class PlanningError(ValueError):
    pass


def normalize_plan_batch(
    payload: dict[str, Any],
    *,
    proposed_by: str = "worker",
    run_id: str | None = None,
    wave: int = 0,
    max_selected: int = 5,
) -> tuple[PlanBatch, list[AttackHypothesis]]:
    candidates = payload.get("hypotheses")
    if not isinstance(candidates, list) or not candidates:
        raise PlanningError("PlanBatch 必须包含非空 hypotheses 数组")
    if len(candidates) > 12:
        raise PlanningError("PlanBatch 单次最多提交 12 个假设")
    normalized: list[AttackHypothesis] = []
    for raw in candidates:
        if not isinstance(raw, dict):
            raise PlanningError("PlanBatch 假设必须是对象")
        validation = raw.get("validation_plan") or {}
        required = (
            str(raw.get("title") or "").strip(),
            str(raw.get("statement") or "").strip(),
            str(raw.get("target") or "").strip(),
            str(raw.get("dimension") or "").strip(),
            str(validation.get("verb") or "").strip(),
            str(validation.get("evidence_sink") or "").strip(),
            str(validation.get("success_criteria") or "").strip(),
        )
        if not all(required):
            raise PlanningError("PlanBatch 假设缺少标题、陈述、目标、维度或验证计划")
        hypothesis = AttackHypothesis(
            title=required[0],
            statement=required[1],
            target=required[2],
            dimension=required[3],
            validation_plan={
                "verb": required[4],
                "evidence_sink": required[5],
                "success_criteria": required[6],
                "method": str(validation.get("method") or "").strip(),
            },
            expected_business_impact=str(raw.get("expected_business_impact") or "").strip(),
            potential_impact=_number(raw, "potential_impact"),
            boundary_reachability=_number(raw, "boundary_reachability"),
            information_gain=_number(raw, "information_gain"),
            novelty=_number(raw, "novelty"),
            prerequisite_readiness=_number(raw, "prerequisite_readiness"),
            estimated_cost=_number(raw, "estimated_cost"),
            action_safety_risk=str(raw.get("action_safety_risk") or "low").lower(),
            evidence_maturity=str(raw.get("evidence_maturity") or "hypothesis"),
            source=proposed_by,
            run_id=run_id,
            wave=wave,
            parent_fact_ids=[str(item) for item in raw.get("parent_fact_ids", [])],
        )
        if hypothesis.action_safety_risk not in {"low", "medium", "high", "critical"}:
            raise PlanningError("非法 action_safety_risk")
        hypothesis.score = score_hypothesis(asdict(hypothesis))
        normalized.append(hypothesis)

    selected = _select_orthogonal(normalized, max_selected)
    selected_ids = {item.id for item in selected}
    for item in normalized:
        item.status = "selected" if item.id in selected_ids else "proposed"
    counterfactual = _normalize_counterfactual(payload.get("counterfactual"), normalized)
    batch = PlanBatch(
        hypotheses=[asdict(item) for item in normalized],
        selected_hypothesis_ids=[item.id for item in selected],
        strategy_summary=str(payload.get("strategy_summary") or "").strip(),
        counterfactual=counterfactual,
        proposed_by=proposed_by,
        run_id=run_id,
        wave=wave,
    )
    return batch, normalized


def intents_for_selected(batch: PlanBatch, hypotheses: list[AttackHypothesis]):
    selected = set(batch.selected_hypothesis_ids)
    return [intent_from_hypothesis(item) for item in hypotheses if item.id in selected]


def _select_orthogonal(items: list[AttackHypothesis], limit: int) -> list[AttackHypothesis]:
    ordered = sorted(items, key=lambda item: (-item.score, item.estimated_cost, item.id))
    selected: list[AttackHypothesis] = []
    used_dimensions: set[str] = set()
    used_targets: set[str] = set()
    for item in ordered:
        if len(selected) >= limit:
            break
        if item.dimension in used_dimensions or item.target in used_targets:
            continue
        selected.append(item)
        used_dimensions.add(item.dimension)
        used_targets.add(item.target)
    for item in ordered:
        if len(selected) >= limit:
            break
        if item not in selected and item.dimension not in used_dimensions:
            selected.append(item)
            used_dimensions.add(item.dimension)
    for item in ordered:
        if len(selected) >= limit:
            break
        if item not in selected:
            selected.append(item)
    return selected


def _number(item: dict[str, Any], name: str) -> float:
    try:
        return max(0.0, min(1.0, float(item.get(name, 0.5))))
    except (TypeError, ValueError):
        return 0.5


def _normalize_counterfactual(
    raw: Any,
    hypotheses: list[AttackHypothesis],
) -> dict[str, Any]:
    if raw in (None, {}):
        return {}
    if not isinstance(raw, dict):
        raise PlanningError("PlanBatch counterfactual 必须是对象")
    claim = str(raw.get("claim") or "").strip()
    falsification = str(raw.get("falsification_criteria") or "").strip()
    if not claim or not falsification:
        raise PlanningError("反事实必须包含 claim 和 falsification_criteria")
    return {
        "id": str(raw.get("id") or new_id("CF")),
        "claim": claim,
        "falsification_criteria": falsification,
        "target": str(raw.get("target") or (hypotheses[0].target if hypotheses else "")).strip(),
        "source": str(raw.get("source") or "metacog").strip(),
        "status": "proposed",
        "linked_hypothesis_ids": [item.id for item in hypotheses],
        "created_at": now_iso(),
    }
