from __future__ import annotations

from typing import Any

from .schemas import Phase, now_iso
from .store import ProjectStore


PHASE_ORDER = {
    Phase.INTAKE.value: 0,
    Phase.PROBE.value: 1,
    Phase.RECON.value: 2,
    Phase.HUNT.value: 3,
    Phase.VERIFY.value: 4,
    Phase.REPORT.value: 5,
}


def reconcile_phase(store: ProjectStore, reason: str = "state_reconciled") -> str:
    """Advance the visible phase from durable evidence, never from model prose."""
    state = store.load_state()
    target = store.read_json("target.json")
    has_target = bool(target.get("targets") or str(target.get("target_path") or "").strip())
    if not has_target:
        desired = Phase.INTAKE.value
    elif state.human_confirmed_count > 0 and state.pending_human_review_count == 0:
        desired = Phase.REPORT.value
    elif state.vulnerability_count > 0 or state.pending_human_review_count > 0:
        desired = Phase.VERIFY.value
    elif store.read_jsonl("plan_batches.jsonl"):
        desired = Phase.HUNT.value
    elif state.fact_count > 0 or state.asset_count > 0:
        desired = Phase.RECON.value
    else:
        desired = Phase.PROBE.value

    current_rank = PHASE_ORDER.get(state.phase, 0)
    desired_rank = PHASE_ORDER[desired]
    # A cleared target may return to intake. Otherwise phase advancement is
    # monotonic so delayed workers cannot make the UI jump backwards.
    if desired == Phase.INTAKE.value:
        next_phase = desired
    else:
        next_phase = desired if desired_rank >= current_rank else state.phase
    if next_phase == state.phase:
        return state.phase
    previous = state.phase
    state.phase = next_phase
    store.save_state(state)
    store.append_jsonl("phase_events.jsonl", {
        "from": previous,
        "to": next_phase,
        "reason": reason,
        "metrics": {
            "assets": state.asset_count,
            "facts": state.fact_count,
            "vulnerabilities": state.vulnerability_count,
            "pending_human_review": state.pending_human_review_count,
            "human_confirmed": state.human_confirmed_count,
        },
        "created_at": now_iso(),
    })
    return next_phase
