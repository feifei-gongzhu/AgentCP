from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from .database import ControlDatabase
from .dashboard import render_dashboard
from .directives import authoritative_directives, missing_directive_ids
from .lifecycle import project_execution_lock, require_initialized_project
from .memory import active_negative_evidence, matching_negative_evidence
from .methodology import ensure_methodology
from .schemas import GateStatus
from .scheduler import Scheduler
from .store import ProjectStore
from .team import TeamMember, _run_member, load_team
from .runtime_secrets import RuntimeSecretStore
from .worker import WorkerError, apply_worker_output
from .waf import WAFManager


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
    "waf_analyst": ("刻画已确认的 WAF 干扰分支", "产出受预算约束的等价差异验证 Intent"),
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
        # Starting a new Run is an explicit human action and is the only way to
        # clear a previous Run-level stop-loss latch.
        if state.current_decision == "stop_loss":
            state.current_decision = "continue"
            self.store.save_state(state)
        methodology = ensure_methodology(self.store, self.db)
        run_id = self.db.create_run(
            self.store.vendor,
            team_name,
            timeout,
            max_workers,
            execution_lease_seconds=max(60, int(state.gate_interval_minutes) * 60),
            max_waves=4,
        )
        self.db.add_event(run_id, None, "method_pack_loaded", {
            "method_pack": methodology["method_pack"],
            "seeded_hypotheses": methodology["seeded"],
        })
        self._sync_run_state(run_id)
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
            self._sync_run_state(run["id"])
            return run["id"]
        self.db.set_run_status(run["id"], "running")
        self._sync_run_state(run["id"])
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
        if not run or run["status"] in {"completed", "failed", "stopped", "cancelled"}:
            return f"运行 {run_id} 已结束"
        if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
            self.db.set_run_status(run_id, "paused", "awaiting_user_approval")
            self._sync_run_state(run_id)
            return "已暂停：等待用户批准"
        self.db.set_run_status(run_id, "running")
        summaries = self._continue_run(run_id)
        self._sync_run_state(run_id)
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
        # Cancellation must not wait for the long-running project execution
        # lock; the fencing token is the transactional authority boundary.
        require_initialized_project(self.store)
        self.db.stop_run(run_id, reason)
        self._sync_run_state(run_id)

    def _schedule_iteration(self, run_id: str) -> None:
        run = self.db.get_run(run_id)
        if not run:
            raise WorkerError(f"运行不存在: {run_id}")
        self._synchronize_negative_evidence()
        members = load_team(run["team"], self.store)
        reason_members = [item for item in members if item.role == "reason"]
        metacog_members = [item for item in members if item.role == "metacog"]
        reviewer_members = [item for item in members if item.role == "reviewer"]
        waf_members = [item for item in members if item.role == "waf_analyst"]
        executor_members = [item for item in members if item.role in {"executor", "pentester"}]
        other_members = [
            item for item in members
            if item.role not in {"reason", "metacog", "reviewer", "executor", "pentester", "waf_analyst"}
        ]

        active_waf_branches = WAFManager().active(self.store)
        selected = reason_members + executor_members + other_members
        if active_waf_branches:
            selected += waf_members
        if self._should_trigger_metacog(run):
            selected += metacog_members
        if not selected:
            selected = metacog_members or reviewer_members
        for member in selected:
            for slot in range(max(1, member.max_running)):
                job_member_name = member.name if member.max_running == 1 else f"{member.name}#{slot + 1}"
                payload: dict[str, Any] = {"member": asdict(member)}
                if member.role == "waf_analyst" and active_waf_branches:
                    branch = active_waf_branches[slot % len(active_waf_branches)]
                    payload["waf_assessment_id"] = branch["id"]
                    payload["context_suffix"] = json.dumps(
                        {
                            "本轮唯一 WAF 分支": branch,
                            "执行约束": "只刻画该分支；每轮只改变一个抽象变量族；不得仅凭状态码声明漏洞。",
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
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
            and (
                item.get("intervention_type") == "metacog_review"
                or "metacog" in str(item.get("content", "")).casefold()
            )
            for item in hints
        )
        if metacog_hint:
            for item in hints:
                if item.get("id") not in consumed and (
                    item.get("intervention_type") == "metacog_review"
                    or "metacog" in str(item.get("content", "")).casefold()
                ):
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
        summaries: list[str] = []
        while True:
            run = self.db.get_run(run_id)
            if not run:
                raise WorkerError(f"运行不存在: {run_id}")
            if run["status"] in {"failed", "stopping", "stopped", "cancelled", "completed"}:
                return summaries
            wave = int(run.get("wave", 1))
            if run["stage"] == "swarm":
                summaries.extend(self._execute_swarm(run))
                continue
            if run["stage"] == "review":
                summaries.extend(self._execute_stage(run, "review"))
                if any(
                    item["status"] == "failed"
                    for item in self.db.list_jobs(run_id, "review", wave=wave)
                ):
                    self.db.finish_run(run_id, "failed", "review_job_failed")
                    Scheduler(self.store).complete_subtask(f"自动化运行 {run_id} 审查任务失败")
                    return summaries
                self.db.set_run_stage(run_id, "commit")
                continue
            if run["stage"] != "commit":
                return summaries

            summaries.extend(self._commit_candidates(run_id))
            latest_run = self.db.get_run(run_id)
            if not latest_run or latest_run["status"] in {"stopping", "stopped", "cancelled"}:
                return summaries
            pending = [
                item for item in self.db.list_jobs(run_id)
                if item["status"] == "completed" and not item.get("committed_at")
            ]
            if pending:
                self.db.set_run_status(run_id, "paused", "candidate_commit_waiting_for_approval")
                summaries.append(f"还有 {len(pending)} 个候选结果待门禁解除后提交")
                return summaries
            if self._can_advance_wave(latest_run):
                next_wave = self.db.advance_run_wave(run_id)
                self._schedule_iteration(run_id)
                summaries.append(
                    f"V3 同一 Run 继续第 {next_wave} 波："
                    f"当前有 {self.db.open_direction_count()} 个可执行方向"
                )
                continue
            self._finalize_run(run_id)
            summaries.append(
                Scheduler(self.store).complete_subtask(
                    f"V3 运行 {run_id} 完成 {wave} 波探索，候选结果已收敛"
                )
            )
            return summaries

    def _execute_swarm(self, run: dict[str, Any]) -> list[str]:
        run_id = run["id"]
        summaries = self._execute_stage(run, "swarm")
        latest_run = self.db.get_run(run_id)
        if not latest_run or latest_run["status"] in {"stopping", "stopped", "cancelled"}:
            return summaries
        wave = int(run.get("wave", 1))
        jobs = self.db.list_jobs(run_id, "swarm", wave=wave)
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
        existing_review = self.db.list_jobs(run_id, "review", wave=wave)
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
                        wave=wave,
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
            if not latest or latest["status"] in {"stopping", "stopped", "cancelled", "completed", "failed"}:
                return outputs
            job = self.db.claim_job(
                run["id"], stage, worker_id, lease_seconds=30,
                wave=int(run.get("wave", 1)),
            )
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
                    int(job["control_version"]),
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
                    cancel_check=lambda: (
                        (self.db.get_run(run["id"]) or {}).get("status") in {
                            "stopping", "stopped", "cancelled",
                        }
                        or self.db.job_status(job["id"]) in {"cancelling", "cancelled"}
                    ),
                    progress_callback=persist_model_progress,
                )
                self.db.complete_job(
                    job["id"], worker_id, result,
                    control_version=int(job["control_version"]),
                )
                self.db.add_event(run["id"], job["id"], "model_call_completed", {
                    "member": member.name,
                    "duration_seconds": round(time.monotonic() - call_started, 1),
                    "activity": activity,
                })
                if direction:
                    kind = (result.get("payload") or {}).get("kind")
                    negative_type = (result.get("payload") or {}).get("evidence_type")
                    outcome = (
                        "completed" if kind == "fact"
                        else "rejected" if kind == "negative_evidence" and negative_type == "target_negative"
                        else "blocked" if kind == "negative_evidence" and negative_type in {
                            "environment_blocked", "tooling_failed", "policy_blocked",
                        }
                        else "exhausted"
                    )
                    self.db.finish_direction(
                        direction["id"],
                        direction["claimed_by"],
                        outcome=outcome,
                        reason=(
                            "negative_evidence:"
                            f"{negative_type}:"
                            f"{(result.get('payload') or {}).get('valid_until', '')}"
                            if kind == "negative_evidence"
                            else str((result.get("payload") or {}).get("reason", ""))[:1000] or None
                        ),
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
                    control_version=int(job["control_version"]),
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
                if direction and status != "queued":
                    self.db.finish_direction(
                        direction["id"], direction["claimed_by"],
                        outcome="cancelled" if status == "cancelled" else "released",
                        reason=error[:1000],
                    )
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
        control_version: int = -1,
    ) -> None:
        heartbeat_count = 0
        while not stop.wait(10):
            if not self.db.heartbeat(
                job_id, worker_id, lease_seconds=30, control_version=control_version,
            ):
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
        run = self.db.get_run(run_id)
        if not run or run["status"] not in {"running", "paused"}:
            return summaries
        control_version = int(run["control_version"])
        jobs = self.db.list_jobs(run_id)
        ordered = sorted(jobs, key=lambda item: (item["role"] == "reviewer", item["created_at"]))
        for job in ordered:
            if job.get("committed_at") or job["status"] != "completed" or not job.get("result"):
                continue
            observed_directives = (
                (job.get("result") or {}).get("control_context") or {}
            ).get("human_directive_ids")
            missing_directives = missing_directive_ids(
                self.store,
                observed_directives,
                active_run_id=run_id,
            )
            if missing_directives:
                self.db.add_event(run_id, job["id"], "human_directive_fence_rejected", {
                    "missing_directive_ids": missing_directives,
                    "reason": "candidate_used_older_human_instruction_context",
                })
                self.db.mark_job_committed(job["id"])
                bound = (job.get("payload") or {}).get("direction") or {}
                if bound.get("id"):
                    self.db.set_direction_status(
                        str(bound["id"]),
                        "released",
                        "superseded_by_human_directive:" + ",".join(missing_directives),
                    )
                summaries.append(
                    f"[{job['member_name']}] 结果已丢弃：未包含最新项目所有者指令 "
                    + ", ".join(missing_directives)
                )
                continue
            bound_direction = (job.get("payload") or {}).get("direction") or {}
            if bound_direction.get("id"):
                current_direction = self.db.get_direction(str(bound_direction["id"]))
                if current_direction and current_direction.get("status") == "cancelled" and str(
                    current_direction.get("terminal_reason") or ""
                ).startswith("human_dismissed:"):
                    self.db.add_event(run_id, job["id"], "human_dismissed_candidate_rejected", {
                        "direction_id": bound_direction["id"],
                    })
                    self.db.mark_job_committed(job["id"])
                    summaries.append(
                        f"[{job['member_name']}] 结果已丢弃：方向 {bound_direction['id']} 已被人工否决"
                    )
                    continue
            latest = self.db.get_run(run_id)
            if (
                not latest
                or latest["status"] not in {"running", "paused"}
                or int(latest["control_version"]) != control_version
                or int(job.get("control_version", -1)) != control_version
            ):
                self.db.add_event(run_id, job["id"], "stale_candidate_rejected", {
                    "job_control_version": job.get("control_version"),
                    "run_control_version": (latest or {}).get("control_version"),
                })
                continue
            payload = job["result"].get("payload")
            if not payload:
                self.db.mark_job_committed(job["id"])
                continue
            payload = dict(payload)
            payload.setdefault("proposed_by", job["member_name"])
            if payload.get("kind") == "plan_batch":
                payload.setdefault("run_id", run_id)
                payload.setdefault("wave", int(job.get("wave", 1)))
            bound_for_graph = (job.get("payload") or {}).get("direction") or {}
            bound_intent = bound_for_graph.get("intent") or {}
            if payload.get("kind") in {"fact", "negative_evidence"} and bound_intent:
                payload.setdefault("hypothesis_id", bound_intent.get("hypothesis_id"))
                payload.setdefault("intent_id", bound_for_graph.get("id") or bound_intent.get("id"))
            owner_directives = authoritative_directives(self.store, active_run_id=run_id)
            if (
                payload.get("kind") == "decision"
                and payload.get("action") == "request_confirmation"
                and owner_directives
                and str(payload.get("override_rule") or "") not in {
                    "authorization_scope",
                    "checklist_red_line",
                    "hard_gate",
                    "immutable_boundary",
                }
            ):
                self.db.add_event(run_id, job["id"], "agent_confirmation_overridden_by_owner", {
                    "directive_ids": [item["id"] for item in owner_directives],
                    "reason": str(payload.get("reason") or "")[:1000],
                })
                self.db.mark_job_committed(job["id"])
                summaries.append(
                    f"[{job['member_name']}] 重复确认请求已忽略：项目所有者指令具有更高优先级"
                )
                continue
            try:
                message = apply_worker_output(self.store, payload)
                if job["role"] == "waf_analyst" and job["payload"].get("waf_assessment_id"):
                    waf_status = (
                        "exhausted"
                        if payload.get("kind") == "decision" and payload.get("action") == "stop_loss"
                        else "ruled_out"
                        if payload.get("kind") == "negative_evidence"
                        and payload.get("evidence_type") == "target_negative"
                        else "differential_found"
                        if payload.get("kind") == "fact"
                        else "characterizing"
                    )
                    WAFManager().record_result(
                        self.store,
                        str(job["payload"]["waf_assessment_id"]),
                        status=waf_status,
                        used_delta=1,
                        differential_found=True if waf_status == "differential_found" else None,
                    )
                if payload.get("kind") == "intent":
                    latest_intents = self.store.read_jsonl("intents.jsonl")
                    if latest_intents:
                        self.db.register_direction(latest_intents[-1])
                self.db.mark_job_committed(job["id"])
                summaries.append(f"[{job['member_name']}] {message}")
                if payload.get("kind") == "decision" and payload.get("action") == "stop_loss":
                    self.db.stop_run(run_id, str(payload.get("reason") or "controller_stop_loss"))
                    self._sync_run_state(run_id)
                    summaries.append("控制器 stop_loss 已终结当前 Run，后续候选写回已封锁")
                    break
            except Exception as exc:
                self.db.mark_job_committed(job["id"], str(exc))
                summaries.append(f"[{job['member_name']}] 候选结果延迟提交: {exc}")
                if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
                    break
        return summaries

    def _can_advance_wave(self, run: dict[str, Any]) -> bool:
        if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
            return False
        if int(run.get("wave", 1)) >= int(run.get("max_waves", 4)):
            return False
        deadline = str(run.get("execution_deadline") or "").strip()
        if deadline:
            try:
                if datetime.fromisoformat(deadline).astimezone(timezone.utc) <= datetime.now(timezone.utc):
                    return False
            except ValueError:
                return False
        return self.db.open_direction_count() > 0

    def _synchronize_negative_evidence(self) -> None:
        negatives = active_negative_evidence(self.store)
        for direction in self.db.list_directions():
            status = str(direction.get("status", ""))
            match = matching_negative_evidence(direction.get("intent") or {}, negatives)
            reason = str(direction.get("terminal_reason") or "")
            if match and status in {"open", "released"}:
                next_status = (
                    "rejected" if match.get("evidence_type") == "target_negative" else "blocked"
                )
                self.db.set_direction_status(
                    direction["id"],
                    next_status,
                    f"negative_evidence:{match.get('id')}:{match.get('valid_until')}",
                )
            elif not match and status in {"blocked", "rejected"} and reason.startswith("negative_evidence:"):
                self.db.set_direction_status(direction["id"], "open", "negative_evidence_expired")

    def _sync_run_state(self, run_id: str) -> None:
        run = self.db.get_run(run_id)
        if not run:
            return
        state = self.store.load_state()
        state.active_run_id = run_id
        state.run_status = str(run.get("status", "idle"))
        state.control_version = int(run.get("control_version", 0))
        self.store.save_state(state)
