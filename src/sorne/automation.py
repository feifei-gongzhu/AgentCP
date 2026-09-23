from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Collection
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from .database import ControlDatabase
from .dashboard import render_dashboard
from .evidence import freeze_worker_result_evidence
from .directives import authoritative_directives, missing_directive_ids
from .lifecycle import project_execution_lock, require_executable_target, require_initialized_project
from .memory import active_negative_evidence, matching_negative_evidence
from .methodology import ensure_methodology, seed_methodology_portfolio
from .schemas import GateStatus, normalize_role
from .scheduler import Scheduler
from .store import ProjectStore
from .team import TeamMember, _run_member, load_team
from .runtime_secrets import RuntimeSecretStore
from .worker import WorkerError, apply_worker_output
from .waf import WAFManager
from .target_profile import (
    begin_baseline_profile_pass,
    finish_baseline_profile_pass,
    baseline_profile_required,
    load_profile_state,
    pending_baseline_profile_targets,
    seed_priority_target_directions,
    DIRECTION_BACKLOG_HIGH_WATERMARK,
)
from .asset_inventory import AssetInventory
from .projector import PROJECTOR_MANAGER


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
    "no such file or directory",
    "command not found",
    "未找到本机 docker cli",
    "未找到本地可执行文件",
    "无法启动本地可执行文件",
    "不支持的运行模式",
    "仅返回叙述文本，未执行工具且未输出 sorne worker json",
    "run execution deadline exceeded",
}

EXECUTION_BUDGET_EXHAUSTED = "execution_budget_exhausted"
MAX_MODEL_ATTEMPTS_PER_STAGE = 3
IMMEDIATE_CANDIDATE_KINDS = {"fact", "negative_evidence", "target_profile_batch"}

_CANDIDATE_LOCKS_GUARD = threading.Lock()
_CANDIDATE_LOCKS: dict[str, threading.RLock] = {}


def _project_candidate_lock(store: ProjectStore) -> threading.RLock:
    key = str(store.path.resolve())
    with _CANDIDATE_LOCKS_GUARD:
        return _CANDIDATE_LOCKS.setdefault(key, threading.RLock())

ROLE_ACTIVITIES = {
    "reason": ("分析黑板并生成审计方向", "产出可执行 Intent 或有证据的 Fact"),
    "metacog": ("检查盲点、反例与高价值路径", "补充或修正当前审计方向"),
    "reviewer": ("审查候选结果与证据质量", "决定接受、驳回或请求人工确认"),
    "waf_analyst": ("刻画已确认的 WAF 干扰分支", "产出受预算约束的等价差异验证 Intent"),
    "profile_mapper": ("遍历目标可点击功能并识别技术栈", "产出 URL、功能、技术栈画像"),
}


def _run_elapsed_seconds(run: dict[str, Any], now: datetime | None = None) -> int | None:
    try:
        started = datetime.fromisoformat(str(run.get("created_at") or "")).astimezone(timezone.utc)
        if str(run.get("status") or "") in {"completed", "failed", "stopped", "cancelled"}:
            ended = datetime.fromisoformat(str(run.get("updated_at") or "")).astimezone(timezone.utc)
        else:
            ended = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None
    return max(0, int((ended - started).total_seconds()))


def _remaining_execution_seconds(
    run: dict[str, Any],
    now: datetime | None = None,
) -> int | None:
    deadline = str(run.get("execution_deadline") or "").strip()
    if not deadline:
        return None
    try:
        end = datetime.fromisoformat(deadline).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return 0
    remaining = (end - (now or datetime.now(timezone.utc))).total_seconds()
    return max(0, int(remaining))


def _run_execution_budget_seconds(
    timeout_seconds: int,
    gate_interval_minutes: int,
    *,
    includes_baseline_profile: bool,
    max_waves: int = 4,
) -> int:
    """Reserve the worst-case sequential stages of a bounded multi-wave Run.

    Jobs within one stage run concurrently, but swarm, review and incremental
    profiling are sequential. Treating a whole Run as one model call plus a
    fixed grace period made large Runs deterministically expire before their
    final stages.
    """

    waves = max(1, int(max_waves))
    stages = waves * 3 + (1 if includes_baseline_profile else 0)
    stage_budget = (
        max(30, int(timeout_seconds))
        * stages
        * MAX_MODEL_ATTEMPTS_PER_STAGE
    )
    return max(60, int(gate_interval_minutes) * 60, stage_budget + 300)


def _stage_call_budget_seconds(run: dict[str, Any], gate_interval_minutes: int) -> int:
    """Return the complete call window required before starting a new stage."""

    return min(
        max(30, int(run.get("timeout_seconds", 300))),
        max(30, int(gate_interval_minutes) * 60),
    )


def _compact_error(error: str, limit: int = 4000) -> str:
    """Bound persisted errors without discarding the actionable final cause."""
    if len(error) <= limit:
        return error
    marker = f"\n... [省略 {len(error) - limit} 个诊断字符] ...\n"
    head_size = min(900, max(0, limit - len(marker)))
    tail_size = max(0, limit - len(marker) - head_size)
    return error[:head_size] + marker + error[-tail_size:]


def _compact_status_job(job: dict[str, Any]) -> dict[str, Any]:
    """Keep only fields required by the live diagnostics view."""

    payload = job.get("payload") or {}
    member = payload.get("member") or {}
    compact_payload: dict[str, Any] = {
        "member": {
            key: member.get(key)
            for key in ("name", "type", "backend", "model", "runtime_mode")
            if member.get(key) is not None
        },
    }
    if payload.get("direction"):
        compact_payload["direction"] = payload["direction"]
    for key in (
        "profile_mode", "profile_seed_urls", "profile_shard_index",
        "profile_shard_count",
    ):
        if payload.get(key) is not None:
            compact_payload[key] = payload[key]
    return {
        key: job.get(key)
        for key in (
            "id", "run_id", "stage", "member_name", "role", "status",
            "attempts", "max_attempts", "worker_id", "last_heartbeat_at",
            "error", "committed_at", "commit_error", "commit_state",
            "control_version", "wave", "created_at", "updated_at",
        )
    } | {"payload": compact_payload}


def _profile_seed_urls_from_payload(payload: dict[str, Any]) -> list[object]:
    values: list[object] = []
    if payload.get("kind") == "target_profile_batch":
        for record in payload.get("records") or []:
            if isinstance(record, dict):
                values.append(record.get("url"))
    if payload.get("kind") == "fact":
        values.extend(payload.get("assets") or [])
    if payload.get("kind") == "intent":
        values.append(payload.get("target"))
    if payload.get("kind") == "plan_batch":
        for hypothesis in payload.get("hypotheses") or []:
            if isinstance(hypothesis, dict):
                values.append(hypothesis.get("target"))
    for observation in payload.get("technology_observations") or []:
        if isinstance(observation, dict):
            values.append(observation.get("url"))
    return values


def _direction_outcome(payload: dict[str, Any]) -> tuple[str, str | None]:
    kind = payload.get("kind")
    negative_type = payload.get("evidence_type")
    outcome = (
        "completed" if kind == "fact"
        else "rejected" if kind == "negative_evidence" and negative_type == "target_negative"
        else "blocked" if kind == "negative_evidence" and negative_type in {
            "environment_blocked", "tooling_failed", "policy_blocked",
        }
        else "exhausted"
    )
    reason = (
        f"negative_evidence:{negative_type}:{payload.get('valid_until', '')}"
        if kind == "negative_evidence"
        else str(payload.get("reason") or "")[:1000] or None
    )
    return outcome, reason


def _candidate_review_context(store: ProjectStore, candidates: list[dict[str, Any]]) -> str:
    evidence_dir = store.path / "evidence"
    items: list[dict[str, Any]] = []
    for item in candidates:
        payload = (item.get("result") or {}).get("payload") or {}
        evidence_path = str(payload.get("evidence_path") or payload.get("evidence_sink") or "").strip()
        resolved_evidence = ""
        if evidence_path:
            relative = Path(evidence_path)
            if not relative.is_absolute() and ".." not in relative.parts:
                candidate = (store.path / relative).resolve()
                try:
                    candidate.relative_to(evidence_dir.resolve())
                except ValueError:
                    pass
                else:
                    resolved_evidence = str(candidate)
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
            "summary": str(summary)[:500],
        })
    payload = {
        "重试延续要求": "这是同一 Job 的重试，不要从头重复已失败或已完成的工具动作；先读取/复用前一次尝试证据，再从未完成步骤继续。",
        "当前尝试": f"{job.get('attempts')}/{job.get('max_attempts')}",
        "上次错误": str(job.get("error") or "")[:700],
        "最近工具事件": recent[-4:],
    }
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if len(rendered) <= 2000:
        return rendered
    payload["最近工具事件"] = recent[-2:]
    payload["上次错误"] = str(payload["上次错误"])[:350]
    return json.dumps(payload, ensure_ascii=False, indent=2)


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
    if _model_error_is_policy_refusal(error):
        return False
    if "本地 guest image 构建失败" in lowered:
        # Image construction happens before the provider request, so retrying a
        # transient registry failure does not spend model tokens. Keep genuine
        # Dockerfile/configuration failures terminal.
        return any(marker in lowered for marker in {
            "timeout",
            "timed out",
            "deadline exceeded",
            "deadlineexceeded",
            "failed to fetch anonymous token",
            "i/o timeout",
            "tls handshake timeout",
            "connection reset",
            "temporary failure",
        })
    # Some relays incorrectly wrap an upstream timeout/empty body in HTTP 200.
    # The transport succeeded, but no model response exists; treat it like a
    # transient gateway failure rather than a successful/non-retryable 2xx.
    if any(marker in lowered for marker in {
        "empty or malformed response",
        "empty response body",
        "gateway intercepting the request",
        "invalid json response",
        "unexpected end of json input",
    }):
        return True
    if any(marker in lowered for marker in NON_RETRYABLE_MODEL_ERRORS):
        return False
    status_match = re.search(r"\b(?:http\s*|api error:\s*)(\d{3})\b", lowered)
    if status_match:
        status = int(status_match.group(1))
        return status in {408, 409, 425, 429} or status >= 500
    if "returncode=1" in lowered and (" 401 " in lowered or " 403 " in lowered):
        return False
    return True


def _model_error_is_policy_refusal(error: str) -> bool:
    lowered = error.casefold()
    return any(marker in lowered for marker in {
        "flagged for possible cybersecurity risk",
        "trusted access for cyber",
        "content policy",
        "safety policy refusal",
    })


def _can_complete_with_policy_restrictions(jobs: list[dict[str, Any]]) -> bool:
    restricted = [item for item in jobs if item.get("status") == "restricted"]
    completed = [item for item in jobs if item.get("status") == "completed"]
    return bool(restricted and completed)


def _is_transient_provider_transport_failure(error: str) -> bool:
    lowered = error.casefold()
    return (
        "falling back from websockets" in lowered
        and "invalid url (get /v1/responses)" in lowered
    ) or any(marker in lowered for marker in {
        "connection reset", "connection refused", "connection timed out",
        "unexpected eof", "upstream timeout", "bad gateway", "service unavailable",
    })


def _can_complete_with_partial_transport_failures(jobs: list[dict[str, Any]]) -> bool:
    failed = [item for item in jobs if item.get("status") == "failed"]
    completed = [item for item in jobs if item.get("status") == "completed"]
    return bool(failed and completed) and all(
        _is_transient_provider_transport_failure(str(item.get("error") or ""))
        for item in failed
    )


class AutomationEngine:
    """Stigmergy 自动化循环。

    Worker 不直接写黑板。所有输出先持久化为候选结果，再由调度器统一调用
    Guardian/Store 提交。
    """

    def __init__(self, store: ProjectStore):
        self.store = store
        self._db: ControlDatabase | None = None
        self._candidate_lock = _project_candidate_lock(store)

    @property
    def db(self) -> ControlDatabase:
        require_initialized_project(self.store)
        if self._db is None:
            self._db = ControlDatabase(self.store.path / "control_plane.db")
        return self._db

    def start(self, team_name: str = "default", timeout: int = 3600, max_workers: int = 5) -> str:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            return self._start_locked(team_name, timeout, max_workers)

    def _start_locked(self, team_name: str, timeout: int, max_workers: int) -> str:
        require_executable_target(self.store)
        recovery = PROJECTOR_MANAGER.recover_store(self.store)
        if recovery.fatal_error:
            raise WorkerError(f"提交投影恢复失败: {recovery.fatal_error}")
        state = self.store.load_state()
        if state.gate_status == GateStatus.AWAITING_APPROVAL.value:
            raise WorkerError("强制门禁正在等待批准，无法启动自动化运行。")
        if max_workers < 1:
            raise WorkerError("max_workers 必须大于 0")
        if not 30 <= timeout <= 3600:
            raise WorkerError("timeout 必须在 30 到 3600 秒之间")
        active = self.db.latest_resumable_run()
        if active:
            raise WorkerError(
                f"项目已有未结束运行 {active['id']} ({active['status']})，"
                "请先恢复、批准或取消该运行。"
            )
        members = load_team(team_name, self.store)
        profile_member = next((item for item in members if item.role == "profile_mapper"), None)
        inventory = AssetInventory(self.store)
        inventory.sync_declared_targets()
        inventory.prepare_run()
        # 补齐“业务结果已投影、画像任务后处理未落账”的中断窗口。
        inventory.recover_profile_postprocess(self.db)
        baseline_work_items = inventory.pending_collect_work_items()
        needs_baseline_profile = bool(
            profile_member
            and baseline_work_items
            and baseline_profile_required(self.store)
        )
        methodology = ensure_methodology(
            self.store,
            self.db,
            seed=not needs_baseline_profile,
        )
        try:
            run_id = self.db.create_run(
                self.store.vendor,
                team_name,
                timeout,
                max_workers,
                execution_lease_seconds=_run_execution_budget_seconds(
                    timeout,
                    int(state.gate_interval_minutes),
                    includes_baseline_profile=needs_baseline_profile,
                    max_waves=4,
                ),
                max_waves=4,
                initial_stage="mrecon" if needs_baseline_profile else "swarm",
            )
        except RuntimeError as exc:
            raise WorkerError(str(exc)) from exc
        # Starting a new Run is an explicit human action and is the only way to
        # clear a previous Run-level stop-loss latch. Do this only after the
        # transaction has successfully created the new Run.
        if state.current_decision == "stop_loss":
            state.current_decision = "continue"
            self.store.save_state(state)
        self.db.add_event(run_id, None, "method_pack_loaded", {
            "method_pack": methodology["method_pack"],
            "seeded_hypotheses": methodology["seeded"],
        })
        self._sync_run_state(run_id)
        if needs_baseline_profile and profile_member is not None:
            self._collect_mrecon_assignments(
                run_id, AssetInventory.work_item_assignments(baseline_work_items),
            )
            self._schedule_profile_job(
                run_id, profile_member, mode="baseline", work_items=baseline_work_items,
            )
            self.db.set_run_stage(run_id, "profile")
        else:
            self._schedule_iteration(run_id)
        return run_id

    def resume(self, run_id: str | None = None) -> str:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            return self._resume_locked(run_id)

    def _resume_locked(self, run_id: str | None = None) -> str:
        recovery = PROJECTOR_MANAGER.recover_store(self.store)
        if recovery.fatal_error:
            raise WorkerError(f"提交投影恢复失败: {recovery.fatal_error}")
        run = self.db.get_run(run_id) if run_id else self.db.latest_resumable_run()
        if not run:
            raise WorkerError("没有可恢复的自动化运行。")
        if run["status"] != "paused":
            raise WorkerError(f"运行 {run['id']} 当前状态为 {run['status']}，不能恢复。")
        if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
            self.db.set_run_status(run["id"], "paused", "awaiting_user_approval")
            self._sync_run_state(run["id"])
            return run["id"]
        if run.get("error") == EXECUTION_BUDGET_EXHAUSTED:
            remaining_waves = max(
                1,
                int(run.get("max_waves", 4)) - int(run.get("wave", 1)) + 1,
            )
            state = self.store.load_state()
            renewed_seconds = _run_execution_budget_seconds(
                int(run["timeout_seconds"]),
                int(state.gate_interval_minutes),
                includes_baseline_profile=run.get("stage") == "profile",
                max_waves=remaining_waves,
            )
            self.db.renew_run_execution_deadline(run["id"], renewed_seconds)
        self.db.set_run_status(run["id"], "running")
        self._sync_run_state(run["id"])
        return run["id"]

    def run(self, run_id: str | None = None, max_iterations: int = 1) -> str:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            return self._run_locked(run_id, max_iterations)

    def _run_locked(self, run_id: str | None = None, max_iterations: int = 1) -> str:
        recovery = PROJECTOR_MANAGER.recover_store(self.store)
        if recovery.fatal_error:
            raise WorkerError(f"提交投影恢复失败: {recovery.fatal_error}")
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

    def status(
        self,
        run_id: str | None = None,
        *,
        compact: bool = False,
    ) -> dict[str, Any]:
        with project_execution_lock(self.store):
            require_initialized_project(self.store)
            return self._status_locked(run_id, compact=compact)

    def _status_locked(
        self,
        run_id: str | None = None,
        *,
        compact: bool = False,
    ) -> dict[str, Any]:
        run = self.db.get_run(run_id) if run_id else (self.db.latest_resumable_run() or self.db.latest_run())
        if not run:
            return {"run": None, "jobs": [], "profile_state": load_profile_state(self.store)}
        run["elapsed_seconds"] = _run_elapsed_seconds(run)
        run["elapsed_minutes"] = (
            round(run["elapsed_seconds"] / 60, 1)
            if run["elapsed_seconds"] is not None else None
        )
        jobs = self.db.list_jobs(run["id"])
        return {
            "run": run,
            "jobs": (
                [_compact_status_job(job) for job in jobs]
                if compact else jobs
            ),
            "directions": [] if compact else self.db.list_directions(),
            "events": self.db.events(run["id"])[-50:],
            "profile_state": load_profile_state(self.store),
        }

    def cancel(self, run_id: str, reason: str = "cancelled_by_user") -> None:
        # Cancellation must not wait for the long-running project execution
        # lock. Serialize candidate convergence first so stop_run cannot advance
        # the fencing token ahead of a completed result.
        require_initialized_project(self.store)
        with self._candidate_lock:
            run = self.db.get_run(run_id)
            if run is None:
                raise WorkerError(f"运行不存在: {run_id}")
            if run["status"] in {"running", "paused"}:
                self._commit_candidates(run_id)
                pending = [
                    job
                    for job in self.db.list_jobs(run_id)
                    if job["status"] == "completed" and not job.get("committed_at")
                ]
                if pending:
                    pending_ids = [str(job["id"]) for job in pending]
                    self.db.add_event(run_id, None, "cancel_flush_blocked", {
                        "reason": reason,
                        "pending_job_ids": pending_ids,
                    })
                    raise WorkerError(
                        "停止前候选结果尚未安全提交: " + ", ".join(pending_ids)
                    )
            self.db.stop_run(run_id, reason)
            with self.store.locked():
                self._sync_run_state(run_id)
                project_state = self.store.load_state()
                project_state.current_task = "运行已停止"
                self.store.save_state(project_state)

    def _profile_member(self, run: dict[str, Any]) -> TeamMember | None:
        return next(
            (item for item in load_team(run["team"], self.store) if item.role == "profile_mapper"),
            None,
        )

    def _schedule_profile_job(
        self,
        run_id: str,
        member: TeamMember,
        *,
        mode: str,
        work_items: list[dict[str, Any]] | None = None,
    ) -> bool:
        """Shard URL work items and dispatch them atomically with their jobs.

        工作项置 dispatched、尝试计数与 Job 创建在 enqueue_profile_job_atomic
        的同一事务内完成；payload 保留 profile_assignments/profile_seed_urls
        兼容字段（由工作项派生）供过滤与结果回写使用。
        """
        if not work_items:
            return False
        requested_workers = max(1, int(member.max_running))
        if mode == "baseline":
            state = begin_baseline_profile_pass(self.store)
            stage = "profile"
        else:
            state = None
            stage = "profile_incremental"
        worker_count = min(requested_workers, len(work_items))
        item_shards = [
            work_items[index::worker_count]
            for index in range(worker_count)
        ]
        for index, item_shard in enumerate(item_shards):
            seed_shard = [str(item["canonical_url"]) for item in item_shard]
            assignments = AssetInventory.work_item_assignments(item_shard)
            if mode == "baseline":
                # 基础画像的种子优先用项目所有者声明的原始目标（同主机时），
                # 与配置目标保持一致的可点击入口。
                configured = pending_baseline_profile_targets(self.store)
                configured_by_host = {
                    str(urlparse(value if "://" in value else f"https://{value}").hostname or "").casefold(): value
                    for value in configured
                }
                assignments = [
                    {
                        **item,
                        "seed_url": configured_by_host.get(
                            str(item.get("hostname") or item.get("ip_address") or "").casefold(),
                            item["seed_url"],
                        ),
                    }
                    for item in assignments
                ]
                # mrecon 完成度按派发种子判定，同步替换 mrecon 去重用的种子串。
                seed_shard = [str(item["seed_url"]) for item in assignments]
            job_member_name = (
                member.name
                if worker_count == 1
                else f"{member.name}#{index + 1}"
            )
            if mode == "baseline":
                context = {
                    "画像模式": "基础画像",
                    "当前轮次": state["baseline_passes"],
                    "最大轮次": 3,
                    "并发分片": f"{index + 1}/{worker_count}",
                    "本分片唯一目标": seed_shard,
                    "执行要求": (
                        "这是漏洞规划前置阶段。优先分析本分片的 mrecon 紧凑记录，"
                        "完成目标分类、优先级评分和常规信息合并；禁止重做全站大规模抓取，"
                        "不得处理其他分片。只有本分片已完成时才返回 exploration_complete=true。"
                    ),
                }
            else:
                context = {
                    "画像模式": "增量画像",
                    "并发分片": f"{index + 1}/{worker_count}",
                    "本分片唯一新增 URL": seed_shard,
                    "执行要求": (
                        "只分析本分片新增 URL 的 mrecon 记录；仅对信息不足的高价值候选做定点补充。"
                        "不得重新遍历已有完整画像，也不得处理其他并发分片。"
                    ),
                }
            self.db.enqueue_profile_job_atomic(
                run_id,
                stage,
                job_member_name,
                member.role,
                {
                    "member": asdict(member),
                    "profile_mode": mode,
                    "profile_pass": (
                        int(state["baseline_passes"])
                        if mode == "baseline"
                        else None
                    ),
                    "profile_assignments": assignments,
                    "profile_seed_urls": seed_shard,
                    "profile_seed_targets": seed_shard if mode == "baseline" else [],
                    "profile_shard_index": index,
                    "profile_shard_count": worker_count,
                    "profile_work_item_ids": [str(item["id"]) for item in item_shard],
                    "context_suffix": json.dumps(context, ensure_ascii=False, indent=2),
                },
                [str(item["id"]) for item in item_shard],
            )
        self.db.set_run_stage(run_id, stage)
        project_state = self.store.load_state()
        project_state.current_task = (
            "前置目标画像采集"
            if mode == "baseline"
            else "新增 URL 增量画像补充"
        )
        self.store.save_state(project_state)
        return True

    def _collect_mrecon_assignments(
        self,
        run_id: str,
        assignments: list[dict[str, Any]],
    ) -> None:
        """Run the deterministic collector before spending a profile model call."""

        config = self.store.read_json("target.json").get("mrecon") or {}
        if not isinstance(config, dict):
            config = {}
        from .mrecon import MReconPolicy, collect_mrecon, normalize_mrecon_seed

        def normalized_seed(value: object) -> str:
            raw = str(value or "")
            try:
                return normalize_mrecon_seed(raw)
            except ValueError:
                return raw

        completed = {
            normalized_seed(item.get("seed_url"))
            for item in self.store.read_jsonl("mrecon_runs.jsonl")
            if item.get("completed_at")
        }
        pending = [
            item for item in assignments
            if normalized_seed(item.get("seed_url")) not in completed
        ]
        if not pending:
            return
        policy = MReconPolicy(
            max_pages=max(1, min(3000, int(config.get("max_pages", 300)))),
            timeout_seconds=max(3, min(60, int(config.get("timeout_seconds", 20)))),
            delay_seconds=max(0.0, min(5.0, float(config.get("delay_seconds", 0.1)))),
            max_js_files=max(1, min(100, int(config.get("max_js_files", 30)))),
            max_js_bytes=max(1, min(32 * 1024 * 1024, int(config.get("max_js_bytes", 8 * 1024 * 1024)))),
            browser_pages=max(0, min(30, int(config.get("browser_pages", 8)))),
            browser_clicks=max(0, min(30, int(config.get("browser_clicks", 10)))),
        )
        scope = list(self.store.read_json("target.json").get("scope") or [])
        errors: list[dict[str, str]] = []

        def run_one(item: dict[str, Any]) -> int:
            seed = normalized_seed(item.get("seed_url"))
            try:
                return len(collect_mrecon(self.store, seed, scope=scope, policy=policy))
            except Exception as exc:
                errors.append({"seed_url": seed, "error": f"{type(exc).__name__}: {exc}"[:1000]})
                return 0

        worker_count = min(4, len(pending))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            counts = list(executor.map(run_one, pending))
        self.db.add_event(run_id, None, "mrecon_collection_completed", {
            "assignment_count": len(pending),
            "observation_count": sum(counts),
            "errors": errors[:20],
        })

    def _activate_hunt(self, run_id: str) -> int:
        seeded = seed_methodology_portfolio(self.store, self.db)
        self.db.add_event(run_id, None, "profile_baseline_released_hunt", {
            "seeded_hypotheses": seeded,
            "profile_state": load_profile_state(self.store),
        })
        self._schedule_iteration(run_id)
        return seeded

    def _schedule_iteration(self, run_id: str) -> None:
        run = self.db.get_run(run_id)
        if not run:
            raise WorkerError(f"运行不存在: {run_id}")
        project_state = self.store.load_state()
        project_state.current_task = "漏洞方向规划与验证"
        self.store.save_state(project_state)
        self._synchronize_negative_evidence()
        seeded_profile_targets = seed_priority_target_directions(self.store, self.db)
        if seeded_profile_targets:
            self.db.add_event(run_id, None, "profile_priority_directions_seeded", {
                "count": seeded_profile_targets,
            })
        members = load_team(run["team"], self.store)
        reason_members = [item for item in members if item.role == "reason"]
        metacog_members = [item for item in members if item.role == "metacog"]
        reviewer_members = [item for item in members if item.role == "reviewer"]
        waf_members = [item for item in members if item.role == "waf_analyst"]
        executor_members = [item for item in members if item.role == "executor"]
        other_members = [
            item for item in members
            if item.role not in {
                "reason", "metacog", "reviewer", "executor",
                "waf_analyst", "profile_mapper",
            }
        ]

        active_waf_branches = WAFManager().active(self.store)
        direction_backlog = self.db.open_direction_count()
        backlog_mode = direction_backlog >= DIRECTION_BACKLOG_HIGH_WATERMARK
        # Planning must not outrun validation.  Once the actionable queue reaches
        # the high-water mark, spend the whole wave on existing directions and
        # suspend Reason/Metacog direction generation until the queue drains.
        selected = executor_members + other_members
        if not backlog_mode:
            selected = reason_members + selected
        if active_waf_branches:
            selected += waf_members
        if not backlog_mode and self._should_trigger_metacog(run):
            selected += metacog_members
        if backlog_mode:
            self.db.add_event(run_id, None, "direction_backpressure_activated", {
                "open_directions": direction_backlog,
                "high_watermark": DIRECTION_BACKLOG_HIGH_WATERMARK,
                "action": "suspend_reason_and_metacog_prioritize_executors",
            })
        if not selected:
            selected = reviewer_members if backlog_mode else (metacog_members or reviewer_members)
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
                if member.role == "executor":
                    direction_worker = f"{run_id}:{job_member_name}"
                    direction = self.db.claim_direction(
                        direction_worker,
                        lease_seconds=int(run["timeout_seconds"]) + 30,
                    )
                    if not direction:
                        continue
                    persistent_work_dir = self.store.path / ".sorne-work"
                    persistent_work_dir.mkdir(parents=True, exist_ok=True)
                    payload["direction"] = direction
                    payload["context_suffix"] = json.dumps(
                        {
                            "已认领 Intent": direction["intent"],
                            "证据目录": str(self.store.path / "evidence"),
                            "容器内持久工作目录": "/workspace/.sorne-work",
                            "执行约束": (
                                "只执行该 Intent；原始证据必须写入 evidence_sink。"
                                "需要被后续 Job 复用的解压目录、中间索引和分析缓存必须写入 "
                                "/workspace/.sorne-work，禁止写入容器临时目录 /tmp。"
                            ),
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

    def _execute_baseline_profile(self, run: dict[str, Any]) -> list[str]:
        run_id = run["id"]
        summaries = self._execute_stage(run, "profile")
        jobs = self.db.list_jobs(run_id, "profile", wave=int(run.get("wave", 1)))
        current_pass = max(
            (
                int((item.get("payload") or {}).get("profile_pass") or 0)
                for item in jobs
            ),
            default=0,
        )
        jobs = [
            item for item in jobs
            if int((item.get("payload") or {}).get("profile_pass") or 0)
            == current_pass
        ]
        completed = [
            item for item in jobs
            if item["status"] == "completed" and item.get("result")
        ]
        payloads = [
            (item.get("result") or {}).get("payload") or {}
            for item in completed
        ]
        # Commit every successful shard before evaluating failed siblings. This
        # mirrors swarm convergence and prevents one timeout from discarding
        # valid profile records returned by other workers.
        summaries.extend(self._commit_candidates(run_id))
        inventory = AssetInventory(self.store)
        for item in completed:
            payload = (item.get("result") or {}).get("payload") or {}
            if payload.get("kind") == "none":
                inventory.record_job_profile_result(
                    item, [], complete=False,
                )
        failed = next(
            (item for item in jobs if item["status"] in {"failed", "restricted", "cancelled"}),
            None,
        )
        invalid_output = not payloads or any(
            payload.get("kind") not in {"target_profile_batch", "none"}
            for payload in payloads
        )
        if failed or invalid_output:
            error = (
                str(failed.get("error") or "基础画像 Worker 未成功完成")
                if failed
                else "基础画像必须返回 target_profile_batch"
            )
            profile_state = finish_baseline_profile_pass(
                self.store,
                exploration_complete=False,
                error=error,
            )
            if failed:
                inventory.record_job_profile_result(
                    failed, [], complete=False, error=error,
                )
            if profile_state["baseline_status"] == "partial":
                self.db.add_event(run_id, (failed or {}).get("id"), "profile_baseline_partial", {
                    "error": error,
                    "successful_shards": len(completed),
                    "failed_shards": sum(
                        item["status"] in {"failed", "restricted", "cancelled"}
                        for item in jobs
                    ),
                    "pending_targets": pending_baseline_profile_targets(self.store),
                })
                seeded = self._activate_hunt(run_id)
                summaries.append(
                    f"基础画像已保留成功分片并以 partial 继续；"
                    f"未完成目标留待后续增量，已播种 {seeded} 个漏洞方向"
                )
                return summaries
            self.db.finish_run(
                run_id,
                "failed",
                "profile_baseline_failed" if failed else "profile_baseline_invalid_output",
            )
            Scheduler(self.store).complete_subtask(
                f"自动化运行 {run_id} 的前置基础画像失败",
                require_approval=False,
            )
            summaries.append(f"前置基础画像失败，漏洞规划未启动：{error}")
            return summaries

        profile_state = finish_baseline_profile_pass(
            self.store,
            exploration_complete=all(
                payload.get("kind") == "none"
                or bool(payload.get("exploration_complete", False))
                for payload in payloads
            ),
        )
        pending_work_items = inventory.pending_collect_work_items()
        if profile_state["baseline_status"] == "failed":
            error = str(profile_state.get("last_error") or "基础画像没有形成有效 URL")
            self.db.finish_run(run_id, "failed", "profile_baseline_empty")
            Scheduler(self.store).complete_subtask(
                f"自动化运行 {run_id} 的前置基础画像没有形成有效 URL",
                require_approval=False,
            )
            summaries.append(f"前置基础画像失败，漏洞规划未启动：{error}")
            return summaries
        if profile_state["baseline_status"] == "complete" and pending_work_items:
            member = self._profile_member(run)
            if member is None:
                self.db.finish_run(run_id, "failed", "profile_mapper_missing")
                summaries.append("团队中缺少可继续执行的 profile_mapper")
                return summaries
            self._schedule_profile_job(
                run_id,
                member,
                mode="baseline",
                work_items=pending_work_items,
            )
            summaries.append("发现新的待画像资产，继续有界基础画像")
            return summaries
        if profile_state["baseline_status"] == "pending":
            member = self._profile_member(run)
            if member is None:
                error = "团队中缺少可继续执行的 profile_mapper"
                finish_baseline_profile_pass(self.store, exploration_complete=False, error=error)
                self.db.finish_run(run_id, "failed", "profile_mapper_missing")
                summaries.append(error)
                return summaries
            assigned_ids = list(dict.fromkeys(
                str(item)
                for job in jobs
                for item in (job.get("payload") or {}).get("profile_work_item_ids", [])
            ))
            assigned_items = AssetInventory(self.store).work_items_by_ids(assigned_ids)
            scheduled = self._schedule_profile_job(
                run_id,
                member,
                mode="baseline",
                work_items=pending_work_items or assigned_items,
            )
            if not scheduled:
                seeded = self._activate_hunt(run_id)
                summaries.append(f"没有可继续画像的资产，已释放漏洞规划并播种 {seeded} 个方向")
                return summaries
            summaries.append(
                "基础画像尚未完成，继续第 "
                f"{int(profile_state['baseline_passes']) + 1} 次有界补充"
            )
            return summaries

        seeded = self._activate_hunt(run_id)
        summaries.append(
            f"基础画像{profile_state['baseline_status']}，"
            f"已释放漏洞规划并播种 {seeded} 个新方向"
        )
        return summaries

    def _execute_incremental_profile(self, run: dict[str, Any]) -> list[str]:
        run_id = run["id"]
        summaries = self._execute_stage(run, "profile_incremental")
        jobs = self.db.list_jobs(run_id, "profile_incremental", wave=int(run.get("wave", 1)))
        seed_urls = list(dict.fromkeys(
            str(seed)
            for job in jobs
            for seed in (job.get("payload") or {}).get("profile_seed_urls", [])
        ))
        error: str | None = None
        failed = next(
            (
                job for job in jobs
                if job["status"] in {"failed", "restricted", "cancelled"}
            ),
            None,
        )
        if not jobs or failed:
            error = str((failed or {}).get("error") or "增量画像 Worker 未成功完成")
        elif any(
            ((job.get("result") or {}).get("payload") or {}).get("kind")
            not in {"target_profile_batch", "none"}
            for job in jobs
        ):
            error = "增量画像必须返回 target_profile_batch 或 none"
        summaries.extend(self._commit_candidates(run_id))
        inventory = AssetInventory(self.store)
        for job in jobs:
            payload = (job.get("result") or {}).get("payload") or {}
            if job.get("status") == "completed" and payload.get("kind") == "none":
                inventory.record_job_profile_result(
                    job, [], complete=False,
                )
        if failed:
            inventory.record_job_profile_result(
                failed, [], complete=False, error=error,
            )
        if error:
            event_job = failed or (jobs[-1] if jobs else {})
            self.db.add_event(run_id, event_job.get("id"), "profile_incremental_deferred", {
                "seed_urls": seed_urls,
                "error": error,
            })
            summaries.append(f"增量画像失败但不影响漏洞 Run；URL 已保留待后续重试：{error}")
        else:
            summaries.append(f"增量画像已完成：处理 {len(seed_urls)} 个新增 URL")
        self.db.set_run_stage(run_id, "commit")
        return summaries

    def _schedule_pending_incremental_profile(self, run: dict[str, Any]) -> bool:
        if not self._ensure_stage_budget(run, "profile_incremental"):
            return False
        member = self._profile_member(run)
        if member is None:
            return False
        inventory = AssetInventory(self.store)
        inventory.ensure_profile_migration()
        # needs_review 复核不新增常驻 Agent：并入既有增量画像通道。
        # 增量与复核的 Run 限流由工作项 last_dispatch_run_id 承担（派发事务
        # 写入）；复核次数在派发时计数，超出分片容量或调度失败都不消耗。
        inventory.sync_needs_review_work_items()
        from .target_profile import profile_policy

        review_cap = int(profile_policy(self.store)["needs_review_max_attempts"])
        collect_limit = 100
        collect_pending = inventory.pending_collect_work_items(
            run_id=str(run["id"]), limit=collect_limit,
        )
        # 复核与采集共享本批容量上限：采集占满时不并入复核（与旧合并截断
        # 语义一致），未进入 Job 的复核 URL 不消耗复核次数。
        review_capacity = max(0, collect_limit - len(collect_pending))
        review_pending = (
            inventory.pending_review_work_items(
                run_id=str(run["id"]),
                limit=review_capacity,
                cap=review_cap,
            )
            if review_capacity
            else []
        )
        seen: set[str] = set()
        pending: list[dict[str, Any]] = []
        for item in [*collect_pending, *review_pending]:
            if str(item["id"]) in seen:
                continue
            seen.add(str(item["id"]))
            pending.append(item)
        if not pending:
            return False
        scheduled = self._schedule_profile_job(
            run["id"],
            member,
            mode="incremental",
            work_items=pending,
        )
        if not scheduled:
            return False
        self.db.add_event(run["id"], None, "profile_incremental_scheduled", {
            "work_item_urls": [str(item["canonical_url"]) for item in pending],
            "needs_review_recheck_urls": [
                str(item["canonical_url"]) for item in review_pending
            ],
        })
        return True

    def _advance_or_finalize(self, run_id: str, summaries: list[str]) -> bool:
        latest_run = self.db.get_run(run_id)
        if not latest_run or latest_run["status"] != "running":
            return False
        wave = int(latest_run.get("wave", 1))
        if self._can_advance_wave(latest_run):
            if not self._ensure_stage_budget(latest_run, "swarm"):
                summaries.append("本轮预算不足以启动下一波，已安全暂停并保留全部待办")
                return False
            next_wave = self.db.advance_run_wave(run_id)
            self._schedule_iteration(run_id)
            summaries.append(
                f"V3 同一 Run 继续第 {next_wave} 波："
                f"当前有 {self.db.open_direction_count()} 个可执行方向"
            )
            return True
        self._finalize_run(run_id)
        summaries.append(
            Scheduler(self.store).complete_subtask(
                f"V3 运行 {run_id} 完成 {wave} 波探索，候选结果已收敛",
                require_approval=False,
            )
        )
        return False

    def _continue_run(self, run_id: str) -> list[str]:
        summaries: list[str] = []
        while True:
            run = self.db.get_run(run_id)
            if not run:
                raise WorkerError(f"运行不存在: {run_id}")
            if run["status"] in {"failed", "stopping", "stopped", "cancelled", "completed"}:
                return summaries
            if _remaining_execution_seconds(run) == 0:
                self._pause_for_execution_budget(run, run.get("stage", "unknown"), 0)
                summaries.append("Run 执行预算已耗尽，已安全暂停；未创建新的模型任务")
                return summaries
            wave = int(run.get("wave", 1))
            if run["stage"] == "profile":
                summaries.extend(self._execute_baseline_profile(run))
                continue
            if run["stage"] == "profile_incremental":
                summaries.extend(self._execute_incremental_profile(run))
                continue
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
                    Scheduler(self.store).complete_subtask(f"自动化运行 {run_id} 审查任务失败", require_approval=False)
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
                durable_pending = [
                    item for item in pending
                    if item.get("commit_state") in {"enqueued", "projected"}
                ]
                if durable_pending:
                    self.db.set_run_status(run_id, "paused", "candidate_projection_deferred")
                    summaries.append(
                        f"还有 {len(durable_pending)} 个 durable commit "
                        "等待投影或后置收敛；恢复时将以相同幂等键继续"
                    )
                else:
                    self.db.set_run_status(run_id, "paused", "candidate_commit_waiting_for_approval")
                    summaries.append(f"还有 {len(pending)} 个候选结果待门禁解除后提交")
                return summaries
            if self._schedule_pending_incremental_profile(latest_run):
                summaries.append("检测到新增 URL，下一波前先执行增量画像")
                continue
            latest_after_profile = self.db.get_run(run_id)
            if not latest_after_profile or latest_after_profile["status"] != "running":
                return summaries
            if self._advance_or_finalize(run_id, summaries):
                continue
            return summaries

    def _execute_swarm(self, run: dict[str, Any]) -> list[str]:
        run_id = run["id"]
        summaries = self._execute_stage(run, "swarm")
        latest_run = self.db.get_run(run_id)
        if not latest_run or latest_run["status"] in {"stopping", "stopped", "cancelled"}:
            return summaries
        wave = int(run.get("wave", 1))
        jobs = self.db.list_jobs(run_id, "swarm", wave=wave)
        if (
            any(item["status"] == "restricted" for item in jobs)
            and not any(item["status"] == "failed" for item in jobs)
        ):
            summaries.extend(self._commit_candidates(run_id))
            restricted = [
                item["member_name"] for item in jobs
                if item["status"] == "restricted"
            ]
            completed_count = sum(item["status"] == "completed" for item in jobs)
            self.db.add_event(run_id, None, "run_completed_with_policy_restrictions", {
                "restricted_members": restricted,
                "completed_jobs": completed_count,
            })
            if _can_complete_with_policy_restrictions(jobs):
                self.db.finish_run(
                    run_id,
                    "completed",
                    "completed_with_model_policy_restrictions",
                )
                Scheduler(self.store).complete_subtask(
                    f"自动化运行 {run_id} 已收敛有效结果；"
                    f"{len(restricted)} 个执行单元受模型内容策略限制",
                    require_approval=False,
                )
            else:
                self.db.finish_run(
                    run_id,
                    "failed",
                    "all_jobs_model_policy_restricted",
                )
                Scheduler(self.store).complete_subtask(
                    f"自动化运行 {run_id} 未产生候选结果；"
                    "所有执行单元均受上游模型策略限制",
                    require_approval=False,
                )
            return summaries
        if any(item["status"] == "failed" for item in jobs):
            # A failed sibling must not discard valid results already returned
            # by other concurrent workers. Converge those candidates first,
            # then distinguish a provider policy restriction from an actual
            # runtime/infrastructure failure.
            summaries.extend(self._commit_candidates(run_id))
            if _can_complete_with_partial_transport_failures(jobs):
                failed_members = [
                    item["member_name"] for item in jobs
                    if item["status"] == "failed"
                ]
                self.db.add_event(run_id, None, "run_completed_with_transport_warnings", {
                    "failed_members": failed_members,
                    "completed_jobs": sum(item["status"] == "completed" for item in jobs),
                    "released_directions": len(failed_members),
                })
                self.db.finish_run(
                    run_id,
                    "completed",
                    "completed_with_provider_transport_warnings",
                )
                Scheduler(self.store).complete_subtask(
                    f"自动化运行 {run_id} 已提交有效结果；"
                    f"{len(failed_members)} 个执行单元发生中转传输故障，方向已释放重排",
                    require_approval=False,
                )
                return summaries
            self.db.finish_run(run_id, "failed", "one_or_more_jobs_failed")
            Scheduler(self.store).complete_subtask(f"自动化运行 {run_id} 存在失败任务", require_approval=False)
            return summaries

        candidates = [item for item in jobs if item["status"] == "completed" and item.get("result")]
        reviewer_members = [item for item in load_team(run["team"], self.store) if item.role == "reviewer"]
        existing_review = self.db.list_jobs(run_id, "review", wave=wave)
        if reviewer_members and not existing_review:
            if not self._ensure_stage_budget(latest_run, "review"):
                summaries.append("本轮预算不足以启动结果复核，已安全暂停并保留执行结果")
                return summaries
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

    def _pause_for_execution_budget(
        self,
        run: dict[str, Any],
        next_stage: str,
        remaining_seconds: int,
    ) -> None:
        changed = self.db.set_run_status(
            run["id"],
            "paused",
            EXECUTION_BUDGET_EXHAUSTED,
        )
        if changed:
            self.db.add_event(run["id"], None, "run_execution_budget_paused", {
                "next_stage": next_stage,
                "remaining_seconds": max(0, int(remaining_seconds)),
                "required_seconds": _stage_call_budget_seconds(
                    run,
                    self.store.load_state().gate_interval_minutes,
                ),
                "execution_deadline": run.get("execution_deadline"),
            })

    def _ensure_stage_budget(self, run: dict[str, Any], next_stage: str) -> bool:
        latest = self.db.get_run(run["id"]) or run
        if latest.get("status") != "running":
            return False
        remaining = _remaining_execution_seconds(latest)
        if remaining is None:
            return True
        required = _stage_call_budget_seconds(
            latest,
            self.store.load_state().gate_interval_minutes,
        )
        if remaining >= required:
            return True
        self._pause_for_execution_budget(latest, next_stage, remaining)
        return False

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
            # 旧 Job 恢复：历史 payload 可能仍写 pentester，执行前规范化；
            # 磁盘上的历史 Payload 与 CommitPlan 保持原样不改写。
            member.role = normalize_role(member.role)
            activity = _model_activity(member, direction)
            timeout_limits = [
                int(run["timeout_seconds"]),
                self.store.load_state().gate_interval_minutes * 60,
            ]
            remaining = _remaining_execution_seconds(latest)
            if remaining is not None:
                timeout_limits.append(remaining)
            call_timeout = min(timeout_limits)
            if call_timeout <= 0:
                error = "run execution deadline exceeded"
                status = self.db.fail_job(
                    job["id"],
                    worker_id,
                    error,
                    retryable=False,
                    control_version=int(job["control_version"]),
                )
                self.db.add_event(run["id"], job["id"], "run_deadline_exceeded", {
                    "member": member.name,
                    "status": status,
                    "execution_deadline": latest.get("execution_deadline"),
                })
                outputs.append(f"[{member.name}] Run 绝对截止时间已到，未再调用模型")
                return outputs
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
            job_completed = False
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
                cancel_check = lambda: (
                    (self.db.get_run(run["id"]) or {}).get("status") in {
                        "stopping", "stopped", "cancelled",
                    }
                    or self.db.job_status(job["id"]) in {"cancelling", "cancelled"}
                )
                result = _run_member(
                    self.store,
                    member,
                    timeout=call_timeout,
                    dry_run=False,
                    context_suffix=context_suffix,
                    cancel_check=cancel_check,
                    progress_callback=persist_model_progress,
                )
                result = freeze_worker_result_evidence(
                    self.store.path,
                    result,
                    run_id=str(run["id"]),
                    job_id=str(job["id"]),
                    attempt=int(job["attempts"]),
                )
                with self._candidate_lock:
                    self.db.complete_job(
                        job["id"], worker_id, result,
                        control_version=int(job["control_version"]),
                    )
                    job_completed = True
                    self.db.add_event(run["id"], job["id"], "model_call_completed", {
                        "member": member.name,
                        "duration_seconds": round(time.monotonic() - call_started, 1),
                        "activity": activity,
                    })
                    outputs.append(f"[{member.name}] 候选结果已持久化")
                    candidate = result.get("payload") if isinstance(result, dict) else None
                    kind = candidate.get("kind") if isinstance(candidate, dict) else None
                    if kind in IMMEDIATE_CANDIDATE_KINDS:
                        outputs.extend(
                            self._commit_candidates(run["id"], job_ids={str(job["id"])})
                        )
            except Exception as exc:
                error = str(exc)
                runtime_secret = RuntimeSecretStore.get(self.store.vendor, member.name)
                if runtime_secret:
                    error = error.replace(runtime_secret, "[REDACTED]")
                error = _compact_error(error)
                if job_completed:
                    self.db.add_event(run["id"], job["id"], "candidate_commit_deferred", {
                        "member": member.name,
                        "error": error,
                    })
                    outputs.append(
                        f"[{member.name}] Job 已完成，候选提交延迟重放: {error}"
                    )
                    continue
                policy_restricted = _model_error_is_policy_refusal(error)
                retryable = _model_error_is_retryable(error)
                if (
                    member.role == "profile_mapper"
                    and "模型执行超时" in error
                ):
                    # A profile timeout means the assigned exploration unit was
                    # too large. Replaying the identical model task three times
                    # only repeats navigation and spends tokens; preserve any
                    # successful sibling shards and leave this target pending.
                    retryable = False
                visible_error = (
                    "上游模型内容策略限制：当前执行单元未产生候选结果；"
                    "已停止重试，其他并发结果继续收敛。"
                    if policy_restricted else error
                )
                status = (
                    self.db.restrict_job(
                        job["id"], worker_id, visible_error,
                        control_version=int(job["control_version"]),
                    )
                    if policy_restricted else
                    self.db.fail_job(
                        job["id"], worker_id, visible_error, retryable=retryable,
                        control_version=int(job["control_version"]),
                    )
                )
                event_type = "model_policy_restricted" if policy_restricted else "model_call_failed"
                self.db.add_event(run["id"], job["id"], event_type, {
                    "member": member.name,
                    "duration_seconds": round(time.monotonic() - call_started, 1),
                    "status": status,
                    "retryable": retryable,
                    "error": visible_error,
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
                    policy_cooldown = (
                        datetime.now(timezone.utc) + timedelta(hours=6)
                    ).isoformat()
                    direction_authorized, direction_version = (
                        self._bound_direction_claim_version(self.db, direction)
                    )
                    if direction_authorized:
                        self.db.finish_direction(
                            direction["id"], direction["claimed_by"],
                            outcome="cancelled" if status == "cancelled" else "released",
                            reason=(
                                f"policy_blocked_until:{policy_cooldown}"
                                if policy_restricted else visible_error[:1000]
                            ),
                            claim_version=direction_version,
                        )
                outputs.append(
                    f"[{job['member_name']}] "
                    f"{'模型策略受限' if policy_restricted else '执行失败'}，"
                    f"状态={status}: {visible_error}"
                )
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
                direction_authorized, direction_version = (
                    self._bound_direction_claim_version(self.db, direction)
                )
                if not direction_authorized:
                    return
                self.db.heartbeat_direction(
                    direction["id"], direction["claimed_by"], lease_seconds=30,
                    claim_version=direction_version,
                )

    def _attach_jev_shadow(
        self,
        run_id: str,
        job: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        """JEV 影子分类：在提交计划冻结前完成模型调用并写入载荷。

        时序保证：此处是 commit 路径（apply_worker_output 冻结之前），
        投影重放只读取冻结后的 ``jev_shadow`` 字典，绝不重新调用模型。
        失败只记事件、载荷保持无 jev 键，绝不阻断候选提交。
        """
        if payload.get("kind") != "target_profile_batch":
            return
        assessments = payload.get("assessments") or []
        if not isinstance(assessments, list) or not assessments:
            return
        from .jev_classifier import classify_targets, merge_collection_context

        try:
            shadow_rows = merge_collection_context(
                assessments, list(payload.get("records") or []),
            )
            classification = classify_targets(shadow_rows)
        except Exception as exc:
            self.db.add_event(run_id, job["id"], "jev_shadow_failed", {
                "member": job.get("member_name"),
                "error": str(exc)[:500],
            })
            return
        if classification is None:
            return  # JEV 未配置：零足迹
        shadow_by_url: dict[str, Any] = {}
        for url in sorted(classification.answers_by_url):
            provenance = classification.provenance_for(url)
            if provenance:
                shadow_by_url[url] = provenance
        if shadow_by_url:
            payload["jev_shadow"] = shadow_by_url
        if classification.skipped:
            payload["jev_shadow_skipped"] = classification.skipped
        self.db.add_event(run_id, job["id"], "jev_shadow_recorded", {
            "member": job.get("member_name"),
            "targets": len(shadow_by_url),
            "skipped": classification.skipped,
            "parse_failures": len(classification.parse_failures),
        })

    @staticmethod
    def _bound_direction_claim_version(
        database: ControlDatabase,
        bound: dict[str, Any],
    ) -> tuple[bool, int]:
        """Resolve the claim version a job may use against its bound direction.

        升级前持久化的任务没有 claim_version：迁移前的认领固定对应版本 0。
        始终以 0 作为预期版本交给数据库做**原子**条件校验——方向此后被
        新代码认领（版本 >= 1）时条件写回自动失败。不读取当前状态做
        预判断（读取与写回之间存在状态变化窗口），也不返回 None 放弃
        校验，更不允许用当前版本号"补齐"旧任务。
        """
        del database  # 不做任何读侧预判断，原子性完全由 SQL 条件保证
        bound_version = bound.get("claim_version")
        if bound_version is not None:
            return True, int(bound_version)
        return True, 0

    def _finish_bound_direction(
        self,
        bound: dict[str, Any],
        *,
        payload: dict[str, Any] | None = None,
        outcome: str | None = None,
        reason: str | None = None,
    ) -> None:
        direction_id = str(bound.get("id") or "")
        if not direction_id:
            return
        current = self.db.get_direction(direction_id)
        if not current or current.get("status") != "claimed" or not current.get("claimed_by"):
            return
        if payload is not None:
            outcome, reason = _direction_outcome(payload)
        # 使用任务绑定时的认领者与认领版本：方向在执行期间被否决+恢复并
        # 重新认领后（同 run:member 名称会复用），旧结果不得终结新认领。
        authorized, claim_version = self._bound_direction_claim_version(self.db, bound)
        if not authorized:
            return
        self.db.finish_direction(
            direction_id,
            str(bound.get("claimed_by") or current["claimed_by"]),
            outcome=outcome or "released",
            reason=reason,
            claim_version=claim_version,
        )

    def _commit_candidates(
        self,
        run_id: str,
        *,
        job_ids: Collection[str] | None = None,
    ) -> list[str]:
        with self._candidate_lock:
            return self._commit_candidates_locked(run_id, job_ids=job_ids)

    def _commit_candidates_locked(
        self,
        run_id: str,
        *,
        job_ids: Collection[str] | None = None,
    ) -> list[str]:
        summaries: list[str] = []
        run = self.db.get_run(run_id)
        if not run or run["status"] not in {"running", "paused"}:
            return summaries
        control_version = int(run["control_version"])
        jobs = self.db.list_jobs(run_id)
        run_profile_assignments = [
            assignment
            for candidate_job in jobs
            for assignment in (candidate_job.get("payload") or {}).get("profile_assignments", [])
        ]
        ordered = sorted(jobs, key=lambda item: (item["role"] == "reviewer", item["created_at"]))
        if job_ids is not None:
            selected = {str(job_id) for job_id in job_ids}
            ordered = [job for job in ordered if str(job["id"]) in selected]
        for job in ordered:
            if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
                break
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
                self._finish_bound_direction(
                    bound_direction,
                    outcome="released",
                    reason="empty_candidate",
                )
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
                waf_assessment_id = str(
                    (job.get("payload") or {}).get("waf_assessment_id") or ""
                ).strip()
                waf_branch_stop = (
                    job["role"] == "waf_analyst"
                    and bool(waf_assessment_id)
                    and payload.get("kind") == "decision"
                    and payload.get("action") == "stop_loss"
                )
                if waf_branch_stop:
                    from .commits import CommitCoordinator, CommitPlanner

                    plan = CommitPlanner().freeze_action(
                        kind="waf_branch_stop",
                        payload={
                            "assessment_id": waf_assessment_id,
                            "reason": str(payload.get("reason") or "WAF 分支止损"),
                        },
                        source_type="automation_job",
                        source_id=str(job["id"]),
                        idempotency_key=f"job:{job['id']}:waf-stop",
                        aggregate_type="waf_assessment",
                        aggregate_id=waf_assessment_id,
                        run_id=run_id,
                        job_id=str(job["id"]),
                        control_version=control_version,
                    )
                    with self.store.locked():
                        if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
                            summaries.append(
                                f"[{job['member_name']}] 门禁已打开，候选结果保留至批准后提交"
                            )
                            break
                        CommitCoordinator(self.store, self.db).submit(plan)
                    self._finish_bound_direction(bound_direction, payload=payload)
                    self.db.mark_job_committed(job["id"])
                    summaries.append(
                        f"[{job['member_name']}] WAF 分支 {waf_assessment_id} 已止损；"
                        "其他目标和攻击面继续调度"
                    )
                    continue
                if payload.get("kind") == "decision" and payload.get("action") == "stop_loss":
                    original_reason = str(payload.get("reason") or "模型建议止损")
                    phase = self.store.load_state().phase
                    payload["action"] = "continue" if phase == "report" else "switch_target"
                    payload["reason"] = (
                        f"模型止损建议（无权终止 Run）：{original_reason}。"
                        "已保留为控制建议，运行终止仅接受项目所有者或确定性控制器指令。"
                    )
                    self.db.add_event(run_id, job["id"], "model_stop_loss_demoted", {
                        "member": job["member_name"],
                        "role": job["role"],
                        "original_reason": original_reason[:1000],
                        "effective_action": payload["action"],
                    })
                inventory = AssetInventory(self.store)
                profile_discoveries: list[str] = []
                profile_assignments = list(
                    (job.get("payload") or {}).get("profile_assignments") or []
                )
                if payload.get("kind") == "target_profile_batch":
                    accepted, discovered, rejected = inventory.filter_profile_records(
                        profile_assignments,
                        list(payload.get("records") or []),
                    )
                    payload["records"] = accepted
                    if discovered:
                        _sibling, discovered, _ignored = inventory.filter_profile_records(
                            run_profile_assignments,
                            [{"url": value} for value in discovered],
                        )
                    profile_discoveries.extend(discovered)
                    technology_rows = payload.get("technology_observations") or []
                    if isinstance(technology_rows, list):
                        accepted_technology, discovered_technology, rejected_technology = (
                            inventory.filter_profile_records(profile_assignments, technology_rows)
                        )
                        payload["technology_observations"] = accepted_technology
                        if discovered_technology:
                            _sibling, discovered_technology, _ignored = inventory.filter_profile_records(
                                run_profile_assignments,
                                [{"url": value} for value in discovered_technology],
                            )
                        profile_discoveries.extend(discovered_technology)
                        rejected.extend(rejected_technology)
                    if rejected:
                        self.db.add_event(run_id, job["id"], "profile_output_rejected", {
                            "rejected": rejected[:100],
                            "assignment_count": len(profile_assignments),
                        })
                self._attach_jev_shadow(run_id, job, payload)
                message = apply_worker_output(
                    self.store,
                    payload,
                    source_type="automation_job",
                    source_id=str(job["id"]),
                    idempotency_key=f"job:{job['id']}:{payload.get('kind', 'unknown')}",
                    run_id=run_id,
                    job_id=str(job["id"]),
                    control_version=control_version,
                )
                self._finish_bound_direction(bound_direction, payload=payload)
                if payload.get("kind") == "target_profile_batch" and profile_assignments:
                    # 按 Job 幂等回写：业务结果已投影、任务状态未更新时崩溃，
                    # 由 recover_profile_postprocess 补齐且不重复计数。
                    inventory.record_job_profile_result(
                        job,
                        list(payload.get("records") or []),
                        complete=bool(payload.get("exploration_complete", False)),
                    )
                discovered_values = (
                    profile_discoveries
                    if payload.get("kind") == "target_profile_batch"
                    else _profile_seed_urls_from_payload(payload)
                )
                profile_seeds = (job.get("payload") or {}).get("profile_seed_urls") or []
                bound_target = (
                    str(bound_intent.get("target") or "").strip()
                    or (str(profile_seeds[0]).strip() if profile_seeds else "")
                    or None
                )
                inventory_seeds = inventory.register_discovered_urls(
                    discovered_values,
                    parent_url=bound_target,
                    relation_type="worker_discovered",
                    discovery_method=job["role"],
                    evidence_path=str(
                        payload.get("evidence_path")
                        or payload.get("evidence_sink")
                        or ""
                    ),
                    confidence=float(payload.get("confidence", 0.5) or 0.5),
                )
                # 新发现 URL 由 register_discovered_urls 直接创建待办工作项
                # （_import_rows 内同事务），不再经 JSON 队列二次入队。
                if inventory_seeds:
                    self.db.add_event(run_id, job["id"], "profile_incremental_urls_queued", {
                        "seed_urls": inventory_seeds,
                    })
                if job["role"] == "waf_analyst" and waf_assessment_id:
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
                        waf_assessment_id,
                        status=waf_status,
                        used_delta=1,
                        differential_found=True if waf_status == "differential_found" else None,
                        idempotency_key=f"job:{job['id']}:waf-result",
                    )
                self.db.mark_job_committed(job["id"])
                summaries.append(f"[{job['member_name']}] {message}")
                if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
                    break
                if payload.get("kind") == "decision" and payload.get("action") == "stop_loss":
                    self.db.stop_run(run_id, str(payload.get("reason") or "controller_stop_loss"))
                    self._sync_run_state(run_id)
                    summaries.append("控制器 stop_loss 已终结当前 Run，后续候选写回已封锁")
                    break
            except Exception as exc:
                error = _compact_error(str(exc))
                current_job = next(
                    (item for item in self.db.list_jobs(run_id) if item["id"] == job["id"]),
                    {},
                )
                durable_commit_started = current_job.get("commit_state") in {
                    "enqueued",
                    "projected",
                }
                if durable_commit_started:
                    self.db.mark_job_committed(job["id"], error)
                    summaries.append(
                        f"[{job['member_name']}] 候选结果已进入 durable commit，"
                        f"投影或后置收敛延迟重放: {error}"
                    )
                    break
                if self.store.load_state().gate_status == GateStatus.AWAITING_APPROVAL.value:
                    summaries.append(
                        f"[{job['member_name']}] 门禁已打开，候选结果保留至批准后提交"
                    )
                    break
                self.db.reject_job_candidate(job["id"], error)
                self._finish_bound_direction(
                    bound_direction,
                    outcome="released",
                    reason=f"candidate_rejected:{error}"[:1000],
                )
                summaries.append(f"[{job['member_name']}] 损坏候选已拒绝，不再阻塞 Run: {error}")
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
        with self.store.locked():
            state = self.store.load_state()
            state.active_run_id = run_id
            state.run_status = str(run.get("status", "idle"))
            state.control_version = int(run.get("control_version", 0))
            self.store.save_state(state)
