from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from .database import ControlDatabase
from .dashboard import render_dashboard
from .lifecycle import project_execution_lock, require_initialized_project
from .schemas import GateStatus
from .scheduler import Scheduler
from .store import ProjectStore
from .team import TeamMember, _run_member, load_team
from .runtime_secrets import RuntimeSecretStore
from .worker import WorkerError, apply_worker_output


LOW_VALUE_CATEGORIES = {"other", "asset", "electron_config", "supply_chain"}
NON_RETRYABLE_MODEL_ERRORS = {
    "no available channel",
    "invalid api key",
    "authentication failed",
    "unauthorized",
    "model not found",
    "unknown model",
    "insufficient balance",
    "payment required",
    "has invalid value",
    "invalid header",
    "缺少环境变量",
    "api_key_env 必须",
}

ROLE_ACTIVITIES = {
    "reason": ("分析黑板并生成审计方向", "产出可执行 Intent 或有证据的 Fact"),
    "metacog": ("检查盲点、反例与高价值路径", "补充或修正当前审计方向"),
    "reviewer": ("审查候选结果与证据质量", "决定接受、驳回或请求人工确认"),
}


def _candidate_review_context(store: ProjectStore, candidates: list[dict[str, Any]]) -> str:
    evidence_dir = store.path / "evidence"
    items: list[dict[str, Any]] = []
    for item in candidates:
        payload = (item.get("result") or {}).get("payload") or {}
        evidence_path = str(payload.get("evidence_path") or payload.get("evidence_sink") or "").strip()
        resolved_evidence = ""
        if evidence_path and not Path(evidence_path).is_absolute():
            resolved_evidence = str((store.path / evidence_path).resolve())
        items.append({
            "member": item["member_name"],
            "role": item["role"],
            "kind": payload.get("kind"),
            "title": payload.get("title") or payload.get("target") or payload.get("reason", "")[:160],
            "evidence_path": evidence_path,
            "resolved_evidence_path": resolved_evidence,
            "candidate": item.get("result"),
        })
    return json.dumps(
        {
            "项目根目录": str(store.path.resolve()),
            "证据目录": str(evidence_dir.resolve()),
            "路径规则": "所有 evidence_path/evidence_sink 都相对项目根目录解析，例如 evidence/x.txt => 项目根目录/evidence/x.txt；不要从仓库根目录读取 evidence/。",
            "候选结果": items,
        },
        ensure_ascii=False,
        indent=2,
    )


def _retry_context(database: ControlDatabase, run_id: str, job: dict[str, Any]) -> str:
    if int(job.get("attempts", 1)) <= 1:
        return ""
    recent: list[dict[str, Any]] = []
    for event in database.events(run_id):
        if event.get("job_id") != job.get("id"):
            continue
        event_type = str(event.get("event_type", ""))
        if event_type not in {
            "model_tool_started",
            "model_tool_completed",
            "model_tool_failed",
            "model_assistant_update",
            "model_call_failed",
            "job_failed",
        }:
            continue
        data = event.get("data") or {}
        summary = (
            data.get("output_summary")
            or data.get("input_summary")
            or data.get("text")
            or data.get("error")
            or data
        )
        recent.append({
            "time": event.get("created_at"),
            "event": event_type,
            "summary": str(summary)[:1200],
        })
    return json.dumps(
        {
            "重试延续要求": "这是同一 Job 的重试，不要从头重复已失败或已完成的工具动作；先读取/复用前一次尝试证据，再从未完成步骤继续。",
            "当前尝试": f"{job.get('attempts')}/{job.get('max_attempts')}",
            "上次错误": job.get("error") or "",
            "最近工具事件": recent[-10:],
        },
        ensure_ascii=False,
        indent=2,
    )


def _model_activity(member: TeamMember, direction: dict[str, Any] | None) -> dict[str, str]:
    intent = (direction or {}).get("intent") or {}
    if intent:
        return {
            "kind": "intent",
            "verb": str(intent.get("verb", "execute"))[:120],
            "target": str(intent.get("target", "未指定目标"))[:1000],
            "success_criteria": str(intent.get("success_criteria", ""))[:1200],
            "evidence_sink": str(intent.get("evidence_sink", ""))[:500],
            "risk_level": str(intent.get("risk_level", "unknown"))[:40],
        }
    target, success = ROLE_ACTIVITIES.get(
        member.role,
        (f"执行 {member.role} 角色任务", "返回结构化候选结果"),
    )
    return {
        "kind": "role",
        "verb": member.role,
        "target": target,
        "success_criteria": success,
        "evidence_sink": "",
        "risk_level": "",
    }


def _model_endpoint(base_url: str | None) -> str:
    if not base_url:
        return "claude-managed"
    parsed = urlparse(base_url)
    return parsed.hostname or parsed.path.split("/", 1)[0]


def _model_error_is_retryable(error: str) -> bool:
    lowered = error.casefold()
    if any(marker in lowered for marker in NON_RETRYABLE_MODEL_ERRORS):
        return False
    status_match = re.search(r"\b(?:http\s*|api error:\s*)(\d{3})\b", lowered)
    if status_match:
        status = int(status_match.group(1))
        return status in {408, 409, 425, 429} or status >= 500
    if "returncode=1" in lowered and (" 401 " in lowered or " 403 " in lowered):
        return False
    return True


class AutomationEngine:
    """Stigmergy 自动化循环。

    Worker 不直接写黑板。所有输出先持久化为候选结果，再由调度器统一调用
    Guardian/Store 提交。
    """

    def __init__(self, store: ProjectStore):
        self.store = store
        self._db: ControlDatabase | None = None

    @property
    def db(self) -> ControlDatabase:
        require_initialized_project(self.store)
        if self._db is None:
            self._db = ControlDatabase(self.store.path / "control_plane.db")
        return self._db

    def start(self, team_name: str = "default", timeout: int = 300, max_workers: int = 4) -> str:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            return self._start_locked(team_name, timeout, max_workers)

    def _start_locked(self, team_name: str, timeout: int, max_workers: int) -> str:
        state = self.store.load_state()
        if state.gate_status == GateStatus.AWAITING_APPROVAL.value:
            raise WorkerError("强制门禁正在等待批准，无法启动自动化运行。")
        if max_workers < 1:
            raise WorkerError("max_workers 必须大于 0")
        run_id = self.db.create_run(self.store.vendor, team_name, timeout, max_workers)
        self._schedule_iteration(run_id)
        return run_id

    def resume(self, run_id: str | None = None) -> str:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            return self._resume_locked(run_id)

    def _resume_locked(self, run_id: str | None = None) -> str:
        run = self.db.get_run(run_id) if run_id else self.db.latest_resumable_run()
        if not run:
            raise WorkerError("没有可恢复的自动化运行。")
        if run["status"] != "paused":
            raise WorkerError(f"运行 {run['id']} 当前状态为 {run['status']}，不能恢复。")
        if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
            self.db.set_run_status(run["id"], "paused", "awaiting_user_approval")
            return run["id"]
        self.db.set_run_status(run["id"], "running")
        return run["id"]

    def run(self, run_id: str | None = None, max_iterations: int = 1) -> str:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            return self._run_locked(run_id, max_iterations)

    def _run_locked(self, run_id: str | None = None, max_iterations: int = 1) -> str:
        if run_id is None:
            active = self.db.latest_resumable_run()
            if not active:
                raise WorkerError("请先启动自动化运行。")
            run_id = active["id"]
        run = self.db.get_run(run_id)
        if not run or run["status"] in {"completed", "failed"}:
            return f"运行 {run_id} 已结束"
        if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
            self.db.set_run_status(run_id, "paused", "awaiting_user_approval")
            return "已暂停：等待用户批准"
        self.db.set_run_status(run_id, "running")
        summaries = self._continue_run(run_id)
        render_dashboard(self.store)
        return "\n".join(summaries)

    def status(self, run_id: str | None = None) -> dict[str, Any]:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            return self._status_locked(run_id)

    def _status_locked(self, run_id: str | None = None) -> dict[str, Any]:
        run = self.db.get_run(run_id) if run_id else (self.db.latest_resumable_run() or self.db.latest_run())
        if not run:
            return {"run": None, "jobs": []}
        return {
            "run": run,
            "jobs": self.db.list_jobs(run["id"]),
            "directions": self.db.list_directions(),
            "events": self.db.events(run["id"])[-50:],
        }

    def cancel(self, run_id: str, reason: str = "cancelled_by_user") -> None:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            self.db.cancel_run(run_id, reason)

    def _schedule_iteration(self, run_id: str) -> None:
        run = self.db.get_run(run_id)
        if not run:
            raise WorkerError(f"运行不存在: {run_id}")
        members = load_team(run["team"], self.store)
        reason_members = [item for item in members if item.role == "reason"]
        metacog_members = [item for item in members if item.role == "metacog"]
        reviewer_members = [item for item in members if item.role == "reviewer"]
        executor_members = [item for item in members if item.role in {"executor", "pentester"}]
        other_members = [
            item for item in members
            if item.role not in {"reason", "metacog", "reviewer", "executor", "pentester"}
        ]

        selected = reason_members + executor_members + other_members
        if self._should_trigger_metacog(run):
            selected += metacog_members
        if not selected:
            selected = metacog_members or reviewer_members
        for member in selected:
            for slot in range(max(1, member.max_running)):
                job_member_name = member.name if member.max_running == 1 else f"{member.name}#{slot + 1}"
                payload: dict[str, Any] = {"member": asdict(member)}
                if member.role in {"executor", "pentester"}:
                    direction_worker = f"{run_id}:{job_member_name}"
                    direction = self.db.claim_direction(
                        direction_worker,
                        lease_seconds=int(run["timeout_seconds"]) + 30,
                    )
                    if not direction:
                        continue
                    payload["direction"] = direction
                    payload["context_suffix"] = json.dumps(
                        {
                            "已认领 Intent": direction["intent"],
                            "证据目录": str(self.store.path / "evidence"),
                            "执行约束": "只执行该 Intent；原始证据必须写入 evidence_sink。",
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                self.db.enqueue_job(run_id, "swarm", job_member_name, member.role, payload)
        self.db.set_run_stage(run_id, "swarm")

    def _should_trigger_metacog(self, run: dict[str, Any]) -> bool:
        hints = self.store.read_jsonl("hints.jsonl")
        consumed = {item.get("hint_id") for item in self.store.read_jsonl("hint_events.jsonl")}
        metacog_hint = any(
            item.get("status") == "open"
            and item.get("id") not in consumed
            and "metacog" in str(item.get("content", "")).casefold()
            for item in hints
        )
        if metacog_hint:
            for item in hints:
                if item.get("id") not in consumed and "metacog" in str(item.get("content", "")).casefold():
                    self.store.append_jsonl("hint_events.jsonl", {"hint_id": item.get("id"), "event": "metacog_triggered"})
        completed = int(run.get("completed_task_count", 0))
        return (
            completed == 0
            or (completed > 0 and completed % 3 == 0)
            or int(run.get("low_value_streak", 0)) >= 2
            or int(run.get("no_direction_streak", 0)) >= 2
            or metacog_hint
        )

    def _continue_run(self, run_id: str) -> list[str]:
        run = self.db.get_run(run_id)
        if not run:
            raise WorkerError(f"运行不存在: {run_id}")
        summaries: list[str] = []
        if run["stage"] == "swarm":
            summaries.extend(self._execute_swarm(run))
            run = self.db.get_run(run_id)
            if not run or run["status"] == "failed":
                return summaries
        if run["stage"] == "review":
            summaries.extend(self._execute_stage(run, "review"))
            if any(item["status"] == "failed" for item in self.db.list_jobs(run_id, "review")):
                self.db.finish_run(run_id, "failed", "review_job_failed")
                Scheduler(self.store).complete_subtask(f"自动化运行 {run_id} 审查任务失败")
                return summaries
            self.db.set_run_stage(run_id, "commit")
            run = self.db.get_run(run_id)
        if run and run["stage"] == "commit":
            summaries.extend(self._commit_candidates(run_id))
            pending = [
                item for item in self.db.list_jobs(run_id)
                if item["status"] == "completed" and not item.get("committed_at")
            ]
            if pending:
                self.db.set_run_status(run_id, "paused", "candidate_commit_waiting_for_approval")
                summaries.append(f"还有 {len(pending)} 个候选结果待门禁解除后提交")
                return summaries
            self._finalize_run(run_id)
            summaries.append(
                Scheduler(self.store).complete_subtask(
                    f"Stigmergy 迭代 {run_id} 完成，所有候选结果已收敛"
                )
            )
        return summaries

    def _execute_swarm(self, run: dict[str, Any]) -> list[str]:
        run_id = run["id"]
        summaries = self._execute_stage(run, "swarm")
        jobs = self.db.list_jobs(run_id, "swarm")
        if any(item["status"] == "failed" for item in jobs):
            # A failed sibling must not discard valid results already returned
            # by other concurrent workers. Converge those candidates first,
            # then mark the overall run as partially failed.
            summaries.extend(self._commit_candidates(run_id))
            self.db.finish_run(run_id, "failed", "one_or_more_jobs_failed")
            Scheduler(self.store).complete_subtask(f"自动化运行 {run_id} 存在失败任务")
            return summaries

        candidates = [item for item in jobs if item["status"] == "completed" and item.get("result")]
        reviewer_members = [item for item in load_team(run["team"], self.store) if item.role == "reviewer"]
        existing_review = self.db.list_jobs(run_id, "review")
        if reviewer_members and not existing_review:
            context = _candidate_review_context(self.store, candidates)
            for member in reviewer_members:
                for slot in range(max(1, member.max_running)):
                    job_member_name = member.name if member.max_running == 1 else f"{member.name}#{slot + 1}"
                    self.db.enqueue_job(
                        run_id,
                        "review",
                        job_member_name,
                        member.role,
                        {"member": asdict(member), "context_suffix": context},
                    )
            self.db.set_run_stage(run_id, "review")
        else:
            self.db.set_run_stage(run_id, "review" if existing_review else "commit")
        return summaries

    def _finalize_run(self, run_id: str) -> None:
        all_jobs = self.db.list_jobs(run_id)
        completed_count = sum(1 for item in all_jobs if item["status"] == "completed")
        no_direction = all(
            (item.get("result") or {}).get("payload", {}).get("kind") == "none"
            for item in all_jobs
            if item["role"] in {"reason", "metacog"}
        )
        low_value = any(
            (item.get("result") or {}).get("payload", {}).get("category") in LOW_VALUE_CATEGORIES
            for item in all_jobs
        )
        self.db.update_run_counters(
            run_id,
            completed_delta=completed_count,
            low_value=low_value,
            no_direction=no_direction,
        )
        self.db.finish_run(run_id, "completed")

    def _execute_stage(self, run: dict[str, Any], stage: str) -> list[str]:
        concurrency = int(run["max_workers"])
        outputs: list[str] = []
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(self._worker_loop, run, stage, index) for index in range(concurrency)]
            for future in as_completed(futures):
                outputs.extend(future.result())
        return outputs

    def _worker_loop(self, run: dict[str, Any], stage: str, index: int) -> list[str]:
        worker_id = f"local-{index}-{uuid4().hex[:6]}"
        outputs: list[str] = []
        while True:
            latest = self.db.get_run(run["id"])
            if not latest or latest["status"] == "cancelled":
                return outputs
            job = self.db.claim_job(run["id"], stage, worker_id, lease_seconds=30)
            if job is None:
                return outputs
            payload = job["payload"]
            direction = payload.get("direction")
            member = TeamMember(**payload["member"])
            activity = _model_activity(member, direction)
            call_timeout = min(
                int(run["timeout_seconds"]),
                self.store.load_state().gate_interval_minutes * 60,
            )
            call_started = time.monotonic()
            self.db.add_event(run["id"], job["id"], "model_call_started", {
                "member": member.name,
                "driver": member.type or member.backend,
                "model": member.model,
                "endpoint": _model_endpoint(member.base_url),
                "auth_mode": member.auth_mode,
                "attempt": job["attempts"],
                "max_attempts": job["max_attempts"],
                "timeout_seconds": call_timeout,
                "activity": activity,
            })
            stop_heartbeat = threading.Event()
            heartbeat = threading.Thread(
                target=self._heartbeat_loop,
                args=(
                    job["id"], worker_id, stop_heartbeat, direction,
                    run["id"], member.name, call_started, activity, call_timeout,
                ),
                daemon=True,
            )
            heartbeat.start()
            try:
                def persist_model_progress(progress: dict[str, Any]) -> None:
                    event = str(progress.get("event", "progress"))
                    data = {key: value for key, value in progress.items() if key != "event"}
                    data.update({"member": member.name, "activity": activity})
                    self.db.add_event(
                        run["id"], job["id"], f"model_{event}", data,
                    )

                context_suffix = str(payload.get("context_suffix", ""))
                retry_context = _retry_context(self.db, run["id"], job)
                if retry_context:
                    context_suffix += "\n\n同一 Job 重试上下文（只读）：\n" + retry_context
                result = _run_member(
                    self.store,
                    member,
                    timeout=call_timeout,
                    dry_run=False,
                    context_suffix=context_suffix,
                    cancel_check=lambda: (self.db.get_run(run["id"]) or {}).get("status") == "cancelled",
                    progress_callback=persist_model_progress,
                )
                self.db.complete_job(job["id"], worker_id, result)
                self.db.add_event(run["id"], job["id"], "model_call_completed", {
                    "member": member.name,
                    "duration_seconds": round(time.monotonic() - call_started, 1),
                    "activity": activity,
                })
                if direction:
                    kind = (result.get("payload") or {}).get("kind")
                    self.db.finish_direction(
                        direction["id"],
                        direction["claimed_by"],
                        success=kind in {"fact", "none"},
                    )
                outputs.append(f"[{member.name}] 候选结果已持久化")
            except Exception as exc:
                error = str(exc)
                runtime_secret = RuntimeSecretStore.get(self.store.vendor, member.name)
                if runtime_secret:
                    error = error.replace(runtime_secret, "[REDACTED]")
                error = error[:4000]
                retryable = _model_error_is_retryable(error)
                status = self.db.fail_job(
                    job["id"], worker_id, error, retryable=retryable,
                )
                self.db.add_event(run["id"], job["id"], "model_call_failed", {
                    "member": member.name,
                    "duration_seconds": round(time.monotonic() - call_started, 1),
                    "status": status,
                    "retryable": retryable,
                    "error": error,
                    "activity": activity,
                })
                if status == "queued":
                    self.db.add_event(run["id"], job["id"], "model_retry_scheduled", {
                        "member": member.name,
                        "next_attempt": int(job["attempts"]) + 1,
                        "max_attempts": job["max_attempts"],
                        "activity": activity,
                    })
                if direction:
                    self.db.finish_direction(direction["id"], direction["claimed_by"], success=False)
                outputs.append(f"[{job['member_name']}] 执行失败，状态={status}: {error}")
            finally:
                stop_heartbeat.set()
                heartbeat.join(timeout=2)

    def _heartbeat_loop(
        self,
        job_id: str,
        worker_id: str,
        stop: threading.Event,
        direction: dict[str, Any] | None = None,
        run_id: str | None = None,
        member_name: str | None = None,
        call_started: float | None = None,
        activity: dict[str, str] | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        heartbeat_count = 0
        while not stop.wait(10):
            if not self.db.heartbeat(job_id, worker_id, lease_seconds=30):
                return
            heartbeat_count += 1
            if run_id and member_name and call_started is not None and heartbeat_count % 3 == 0:
                self.db.add_event(run_id, job_id, "model_call_waiting", {
                    "member": member_name,
                    "elapsed_seconds": round(time.monotonic() - call_started, 1),
                    "timeout_seconds": timeout_seconds,
                    "activity": activity or {},
                    "visibility": "scheduler_heartbeat_only",
                })
            if direction:
                self.db.heartbeat_direction(
                    direction["id"], direction["claimed_by"], lease_seconds=30
                )

    def _commit_candidates(self, run_id: str) -> list[str]:
        summaries: list[str] = []
        jobs = self.db.list_jobs(run_id)
        ordered = sorted(jobs, key=lambda item: (item["role"] == "reviewer", item["created_at"]))
        for job in ordered:
            if job.get("committed_at") or job["status"] != "completed" or not job.get("result"):
                continue
            payload = job["result"].get("payload")
            if not payload:
                self.db.mark_job_committed(job["id"])
                continue
            payload = dict(payload)
            payload.setdefault("proposed_by", job["member_name"])
            try:
                message = apply_worker_output(self.store, payload)
                if payload.get("kind") == "intent":
                    latest_intents = self.store.read_jsonl("intents.jsonl")
                    if latest_intents:
                        self.db.register_direction(latest_intents[-1])
                self.db.mark_job_committed(job["id"])
                summaries.append(f"[{job['member_name']}] {message}")
            except Exception as exc:
                self.db.mark_job_committed(job["id"], str(exc))
                summaries.append(f"[{job['member_name']}] 候选结果延迟提交: {exc}")
                if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
                    break
        return summaries
