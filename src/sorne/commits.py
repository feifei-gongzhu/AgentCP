from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from .database import ControlDatabase
from .schemas import VALID_WORKER_KINDS
from .store import ProjectStore


PLAN_VERSION = 1
FaultHook = Callable[[str], None]


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CommitAction:
    action_key: str
    kind: str
    payload: dict[str, Any]


@dataclass(frozen=True)
class CommitEvent:
    event_id: str
    idempotency_key: str
    event_type: str
    aggregate_type: str
    aggregate_id: str
    source_type: str
    source_id: str
    occurred_at: str
    run_id: str | None
    job_id: str | None
    control_version: int | None
    payload_json: str
    payload_sha256: str


@dataclass(frozen=True)
class CommitPlan:
    plan_id: str
    plan_version: int
    event: CommitEvent
    actions: tuple[CommitAction, ...]
    plan_json: str
    plan_sha256: str

    def database_event(self) -> dict[str, Any]:
        return asdict(self.event)

    def database_plan(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "plan_version": self.plan_version,
            "plan_json": self.plan_json,
            "plan_sha256": self.plan_sha256,
            "action_count": len(self.actions),
        }


class CommitPlanner:
    def __init__(
        self,
        *,
        clock: Callable[[], str] | None = None,
    ):
        self.clock = clock or (lambda: datetime.now(timezone.utc).isoformat())

    def freeze_action(
        self,
        *,
        kind: str,
        payload: dict[str, Any],
        source_type: str,
        source_id: str,
        idempotency_key: str,
        aggregate_type: str | None = None,
        aggregate_id: str | None = None,
        run_id: str | None = None,
        job_id: str | None = None,
        control_version: int | None = None,
    ) -> CommitPlan:
        frozen_payload = json.loads(_canonical_json(payload))
        occurred_at = self.clock()
        identity = _digest(idempotency_key)[:24]
        event_id = f"EV-{identity}"
        plan_id = f"CP-{identity}"
        actions = (CommitAction(action_key=f"{kind}:0", kind=kind, payload=frozen_payload),)
        event_payload_json = _canonical_json({
            "kind": kind, "source_type": source_type, "source_id": source_id,
            "payload": frozen_payload,
        })
        plan_json = _canonical_json({
            "version": PLAN_VERSION,
            "plan_id": plan_id,
            "event_id": event_id,
            "actions": [asdict(action) for action in actions],
        })
        event = CommitEvent(
            event_id=event_id,
            idempotency_key=idempotency_key,
            event_type=kind,
            aggregate_type=aggregate_type or kind,
            aggregate_id=aggregate_id or source_id,
            source_type=source_type,
            source_id=source_id,
            occurred_at=occurred_at,
            run_id=run_id,
            job_id=job_id,
            control_version=control_version,
            payload_json=event_payload_json,
            payload_sha256=_digest(event_payload_json),
        )
        return CommitPlan(
            plan_id=plan_id,
            plan_version=PLAN_VERSION,
            event=event,
            actions=actions,
            plan_json=plan_json,
            plan_sha256=_digest(plan_json),
        )

    def freeze_worker_output(
        self,
        payload: dict[str, Any],
        *,
        source_type: str,
        source_id: str,
        idempotency_key: str,
        run_id: str | None = None,
        job_id: str | None = None,
        control_version: int | None = None,
    ) -> CommitPlan:
        if not isinstance(payload, dict):
            raise ValueError("Worker 输出必须是对象")
        kind = str(payload.get("kind") or "")
        if kind not in VALID_WORKER_KINDS:
            raise ValueError(f"未知 Worker 输出 kind: {kind}")
        frozen_payload = json.loads(_canonical_json(payload))
        occurred_at = self.clock()
        identity = _digest(idempotency_key)[:24]
        event_id = f"EV-{identity}"
        plan_id = f"CP-{identity}"
        actions = (
            CommitAction(
                action_key="apply_worker_output:0",
                kind="apply_worker_output",
                payload=frozen_payload,
            ),
        )
        event_payload = {
            "kind": kind,
            "source_type": source_type,
            "source_id": source_id,
            "worker_payload": frozen_payload,
        }
        event_payload_json = _canonical_json(event_payload)
        plan_material = {
            "version": PLAN_VERSION,
            "plan_id": plan_id,
            "event_id": event_id,
            "actions": [asdict(action) for action in actions],
        }
        plan_json = _canonical_json(plan_material)
        event = CommitEvent(
            event_id=event_id,
            idempotency_key=idempotency_key,
            event_type=f"worker_output.{kind}",
            aggregate_type=kind,
            aggregate_id=str(payload.get("id") or source_id),
            source_type=source_type,
            source_id=source_id,
            occurred_at=occurred_at,
            run_id=run_id,
            job_id=job_id,
            control_version=control_version,
            payload_json=event_payload_json,
            payload_sha256=_digest(event_payload_json),
        )
        return CommitPlan(
            plan_id=plan_id,
            plan_version=PLAN_VERSION,
            event=event,
            actions=actions,
            plan_json=plan_json,
            plan_sha256=_digest(plan_json),
        )


class CommitCoordinator:
    def __init__(
        self,
        store: ProjectStore,
        database: ControlDatabase | None = None,
        *,
        fault_hook: FaultHook | None = None,
    ):
        self.store = store
        self.database = database or ControlDatabase(store.path / "control_plane.db")
        self.fault_hook = fault_hook

    def _fault(self, point: str) -> None:
        if self.fault_hook:
            self.fault_hook(point)

    def submit(
        self,
        plan: CommitPlan,
        *,
        wait: bool = True,
    ) -> str:
        self._fault("before_commit_transaction")
        self.database.accept_commit_plan(
            event=plan.database_event(),
            plan=plan.database_plan(),
            job_id=plan.event.job_id,
            control_version=plan.event.control_version,
        )
        self._fault("after_database_commit")
        if not wait:
            return f"提交计划已入队: {plan.event.event_id}"
        from .projector import Projector

        projector = Projector(
            self.store,
            self.database,
            fault_hook=self.fault_hook,
        )
        result = projector.drain_until(plan.event.event_id)
        return result or f"提交计划已投影: {plan.event.event_id}"


def new_source_id(prefix: str = "SRC") -> str:
    return f"{prefix}-{uuid4().hex[:16]}"
