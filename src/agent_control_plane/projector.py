from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable
from uuid import uuid4

from .database import ControlDatabase
from .lifecycle import project_execution_lock, require_initialized_project
from .schemas import deterministic_generation, now_iso
from .store import ProjectStore


FaultHook = Callable[[str], None]


@dataclass
class ProjectorStatus:
    alive: bool = False
    recovery_complete: bool = False
    last_success_at: str | None = None
    last_error: str | None = None
    fatal_error: str | None = None


class Projector:
    def __init__(
        self,
        store: ProjectStore,
        database: ControlDatabase | None = None,
        *,
        worker_id: str | None = None,
        fault_hook: FaultHook | None = None,
    ):
        self.store = store
        self.database = database or ControlDatabase(store.path / "control_plane.db")
        self.worker_id = worker_id or f"projector-{uuid4().hex[:12]}"
        self.fault_hook = fault_hook

    def _fault(self, point: str) -> None:
        if self.fault_hook:
            self.fault_hook(point)

    def _event(self, event_id: str) -> dict[str, Any] | None:
        with self.database.connect() as db:
            row = db.execute(
                "SELECT * FROM commit_events WHERE event_id=?", (event_id,)
            ).fetchone()
            return dict(row) if row else None

    def drain_until(self, event_id: str, timeout: float = 30.0) -> str | None:
        deadline = time.monotonic() + timeout
        last_result: str | None = None
        while time.monotonic() < deadline:
            target = self._event(event_id)
            if target is None:
                raise RuntimeError(f"提交事件不存在: {event_id}")
            if target["status"] == "committed":
                return last_result
            if target["status"] in {"blocked", "discarded"}:
                raise RuntimeError(str(target.get("last_error") or f"提交事件 {target['status']}"))
            result = self.project_next()
            if result is not None:
                last_result = result
                continue
            time.sleep(0.02)
        raise TimeoutError(f"等待提交事件投影超时: {event_id}")

    def project_next(self) -> str | None:
        self.database.recover_commit_leases()
        row = self.database.claim_next_commit(self.worker_id)
        if row is None:
            return None
        event_id = str(row["event_id"])
        project_lock = self.store.locked()
        project_lock.__enter__()
        try:
            self._fault("after_projector_claim")
            rejection = self.database.commit_projection_rejection_reason(event_id, self.worker_id)
            if rejection:
                self.database.discard_claimed_commit_event(event_id, self.worker_id, rejection)
                return f"提交事件已丢弃: {event_id} ({rejection})"
            plan_json = str(row["plan_json"])
            if hashlib.sha256(plan_json.encode("utf-8")).hexdigest() != str(row["plan_sha256"]):
                raise RuntimeError("CommitPlan SHA-256 校验失败")
            plan = json.loads(plan_json)
            actions = list(plan.get("actions") or [])
            if len(actions) != int(row["action_count"]):
                raise RuntimeError("CommitPlan action_count 不一致")
            message: Any = None
            for action in actions:
                action_key = str(action.get("action_key") or "")
                kind = str(action.get("kind") or "")
                if not action_key or self.database.projection_receipt_exists(event_id, action_key):
                    continue
                self._fault("before_projection_action")
                rejection = self.database.commit_projection_rejection_reason(event_id, self.worker_id)
                if rejection:
                    self.database.discard_claimed_commit_event(event_id, self.worker_id, rejection)
                    return f"提交事件已丢弃: {event_id} ({rejection})"
                if kind == "apply_worker_output":
                    from .worker import _apply_worker_output_legacy

                    occurred_at = str(row["occurred_at"])
                    with deterministic_generation(event_id, occurred_at):
                        with self.store.projection_context(event_id, self.fault_hook):
                            message = _apply_worker_output_legacy(
                                self.store,
                                dict(action.get("payload") or {}),
                            )
                elif kind == "quality_review":
                    from .quality import QualityLedger

                    occurred_at = str(row["occurred_at"])
                    with deterministic_generation(event_id, occurred_at):
                        with self.store.projection_context(event_id, self.fault_hook):
                            message = QualityLedger()._review_legacy(
                                self.store,
                                **dict(action.get("payload") or {}),
                            )
                elif kind == "waf_result":
                    from .waf import WAFManager

                    occurred_at = str(row["occurred_at"])
                    with deterministic_generation(event_id, occurred_at):
                        with self.store.projection_context(event_id, self.fault_hook):
                            payload = dict(action.get("payload") or {})
                            assessment_id = str(payload.pop("assessment_id"))
                            message = WAFManager()._record_result_legacy(
                                self.store,
                                assessment_id,
                                **payload,
                            )
                elif kind == "waf_branch_stop":
                    from .schemas import new_id, now_iso
                    from .waf import WAFManager

                    payload = dict(action.get("payload") or {})
                    assessment_id = str(payload["assessment_id"])
                    occurred_at = str(row["occurred_at"])
                    with deterministic_generation(event_id, occurred_at):
                        with self.store.projection_context(event_id, self.fault_hook):
                            WAFManager()._record_result_legacy(
                                self.store,
                                assessment_id,
                                status="exhausted",
                                used_delta=1,
                            )
                            decision = {
                                "id": new_id("D"),
                                "action": "stop_loss",
                                "reason": str(payload.get("reason") or "WAF 分支止损"),
                                "scope": "waf_branch",
                                "waf_assessment_id": assessment_id,
                                "created_at": now_iso(),
                            }
                            self.store.append_jsonl("decision_log.jsonl", decision)
                            message = decision
                elif kind == "scheduler_decision":
                    from .schemas import ProjectState

                    payload = dict(action.get("payload") or {})
                    occurred_at = str(row["occurred_at"])
                    with deterministic_generation(event_id, occurred_at):
                        with self.store.projection_context(event_id, self.fault_hook):
                            decision = dict(payload["decision"])
                            self.store.append_jsonl("decision_log.jsonl", decision)
                            self.store.save_state(ProjectState(**dict(payload["state"])))
                            message = decision
                else:
                    raise RuntimeError(f"不支持的投影动作: {kind}")
                self._fault("before_projection_receipt")
                material = json.dumps(action, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                self.database.record_projection_receipt(
                    event_id=event_id,
                    action_key=action_key,
                    idempotency_key=f"{event_id}:{action_key}",
                    sink_type=kind,
                    sink_path="project",
                    content_sha256=hashlib.sha256(material.encode("utf-8")).hexdigest(),
                    byte_count=len(material.encode("utf-8")),
                )
                self._fault("after_projection_receipt")
            self._fault("before_event_commit")
            self.database.complete_commit_event(event_id, self.worker_id)
            return message if message is not None else f"提交事件已投影: {event_id}"
        except Exception as exc:
            self.database.fail_commit_event(event_id, self.worker_id, str(exc))
            raise
        finally:
            project_lock.__exit__(None, None, None)

    def recover(self) -> int:
        self.database.recover_commit_leases()
        projected = 0
        failures = 0
        while True:
            try:
                result = self.project_next()
            except Exception:
                failures += 1
                if failures >= 100:
                    raise RuntimeError("投影恢复连续失败次数超过安全上限")
                continue
            if result is None:
                break
            projected += 1
        self.database.mark_projection_recovery_complete()
        return projected


class ProjectorManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._statuses: dict[str, ProjectorStatus] = {}
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._alive = False
        self._recovery_complete = False
        self._last_error: str | None = None

    def recover_store(self, store: ProjectStore) -> ProjectorStatus:
        status = ProjectorStatus(alive=True)
        with self._lock:
            self._statuses[store.vendor] = status
        try:
            with project_execution_lock(store):
                require_initialized_project(store)
                Projector(store).recover()
            status.recovery_complete = True
            status.last_success_at = now_iso()
        except Exception as exc:
            status.last_error = str(exc)
            status.fatal_error = str(exc)
        return status

    def recover_all(self) -> None:
        from . import store as store_module
        from .maintenance import maintenance_status

        root = store_module.PROJECTS
        root.mkdir(parents=True, exist_ok=True)
        maintenance_projects = set(maintenance_status())
        vendors = {
            path.name
            for path in root.iterdir()
            if (
                path.is_dir()
                and not path.name.startswith(".")
                and path.name not in maintenance_projects
                and (path / "target.json").is_file()
            )
        }
        for vendor in sorted(vendors):
            self.recover_store(ProjectStore(vendor))
        with self._lock:
            for stale in set(self._statuses) - vendors:
                self._statuses.pop(stale, None)
            self._recovery_complete = True

    def start(self, poll_interval: float = 1.0) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._recovery_complete = False
            self._alive = True
            self._last_error = None

        def loop() -> None:
            try:
                self.recover_all()
                while not self._stop.wait(poll_interval):
                    self.recover_all()
            except Exception as exc:
                with self._lock:
                    self._last_error = str(exc)
            finally:
                with self._lock:
                    self._alive = False

        self._thread = threading.Thread(target=loop, name="agentcp-projector", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread:
            thread.join(timeout)
        with self._lock:
            self._alive = False

    def readiness(self) -> tuple[bool, dict[str, Any]]:
        from . import store as store_module
        from .maintenance import maintenance_status

        root = store_module.PROJECTS
        maintenance_projects = maintenance_status()
        with self._lock:
            statuses = dict(self._statuses)
            alive = self._alive and bool(self._thread and self._thread.is_alive())
            recovery_complete = self._recovery_complete
            manager_error = self._last_error
        pending = 0
        failed = 0
        schema_versions: set[int] = set()
        project_errors: dict[str, str] = {}
        for vendor, status in statuses.items():
            if status.fatal_error:
                project_errors[vendor] = status.fatal_error
            store = ProjectStore(vendor)
            try:
                database = ControlDatabase(store.path / "control_plane.db")
                counts = database.commit_event_counts()
                pending += sum(counts.get(key, 0) for key in ("pending", "projecting", "retry_wait"))
                failed += counts.get("blocked", 0)
                with database.connect() as db:
                    schema_versions.add(int(db.execute("SELECT version FROM schema_meta").fetchone()[0]))
            except Exception as exc:
                project_errors[vendor] = str(exc)
        writable = root.is_dir() and os.access(root, os.R_OK | os.W_OK)
        ready = (
            writable and alive and recovery_complete and not manager_error
            and not project_errors and failed == 0 and not maintenance_projects
        )
        return ready, {
            "ok": ready,
            "status": "ready" if ready else "not_ready",
            "schema_version": max(schema_versions) if schema_versions else 6,
            "project_count": len(statuses),
            "outbox_pending": pending,
            "outbox_failed": failed,
            "projector_alive": alive,
            "recovery_complete": recovery_complete,
            "maintenance_projects": maintenance_projects,
            "errors": project_errors,
            "dependencies": {},
        }

    def status(self) -> dict[str, ProjectorStatus]:
        with self._lock:
            return dict(self._statuses)


PROJECTOR_MANAGER = ProjectorManager()
