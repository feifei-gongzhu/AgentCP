from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any
from collections.abc import Callable

from .dashboard import render_dashboard
from .directives import authoritative_directives, directive_ids, missing_directive_ids
from .drivers import DriverConfig, run_driver
from .lifecycle import project_execution_lock, require_executable_target, require_initialized_project
from .schemas import now_iso, normalize_role
from .execution import run_member as _run_member
from .runtime_config import canonical_runtime_mode, effective_backend
from .scheduler import Scheduler
from .store import ROOT, ProjectStore
from .worker import WorkerError, apply_worker_output, compile_worker_prompt


TEAMS_DIR = ROOT / "teams"


@dataclass
class TeamMember:
    name: str
    type: str | None = None
    backend: str = "codex"
    role: str = "reason"
    runtime_mode: str = "local-docker"
    custom_prompt: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key_env: str | None = None
    auth_mode: str = "auto"
    profile: str | None = None
    sandbox: str = "read-only"
    dangerously_bypass_sandbox: bool = False
    env: dict[str, str] | None = None
    command: str | None = None
    max_running: int = 1
    priority: int = 0
    extra: dict[str, Any] | None = None


def load_team(name: str, store: ProjectStore | None = None) -> list[TeamMember]:
    project_config = store.path / "team_config.json" if store is not None else None
    path = (
        project_config
        if project_config is not None and project_config.exists() and name in {"default", "project"}
        else TEAMS_DIR / f"{name}.json"
    )
    if not path.exists():
        raise WorkerError(f"团队配置不存在: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    members = []
    for item in data.get("members", []):
        item = dict(item)
        # 旧配置里的 pentester 读取时即规范化为 executor；写回发生在
        # 用户正常保存配置时，不在读取路径自动重写文件。
        item["role"] = normalize_role(item.get("role"))
        try:
            item["runtime_mode"] = canonical_runtime_mode(item.get("runtime_mode"))
        except ValueError as exc:
            raise WorkerError(str(exc)) from exc
        # type/backend 并存时非空 type 优先（与使用点 member.type or member.backend
        # 的历史有效行为一致），两字段同步为同一有效值。
        effective = effective_backend(item.get("type"), item.get("backend"))
        item["type"] = effective
        item["backend"] = effective
        members.append(TeamMember(**item))
    return sorted(members, key=lambda item: item.priority)


def run_team(
    store: ProjectStore,
    team_name: str,
    timeout: int = 300,
    dry_run: bool = False,
    max_workers: int | None = None,
    task: str | None = None,
) -> str:
    with project_execution_lock(store):
        require_initialized_project(store)
        if not dry_run:
            require_executable_target(store)
        return _run_team_locked(store, team_name, timeout, dry_run, max_workers, task)


def _run_team_locked(
    store: ProjectStore,
    team_name: str,
    timeout: int = 300,
    dry_run: bool = False,
    max_workers: int | None = None,
    task: str | None = None,
) -> str:
    state = store.load_state()
    if state.gate_status == "awaiting_approval" and not dry_run:
        raise WorkerError("强制门禁正在等待用户批准，禁止启动新的并发批次。")
    members = load_team(team_name, store)
    if not members:
        raise WorkerError(f"团队 {team_name} 没有成员")

    task_text = str(task or "").strip()
    # executor 要求明确任务：一次性批次没有调度器分配的 Direction，必须由
    # 入口 --task 或成员 custom_prompt 提供；否则拒绝启动而不是让模型自选目标。
    executor_members = [item for item in members if item.role == "executor"]
    if (
        executor_members
        and not task_text
        and not any(item.custom_prompt for item in executor_members)
    ):
        raise WorkerError(
            "团队包含 executor 角色但未提供明确任务：请用 --task 提供本次批次的"
            "任务说明，或在该成员配置中填写专属提示词；持续运行请改用 automate。"
        )
    context_suffix = (
        json.dumps({"调度任务": task_text}, ensure_ascii=False, indent=2)
        if task_text else ""
    )

    results: list[dict[str, Any]] = []
    if max_workers is not None and max_workers < 1:
        raise WorkerError("max_workers 必须大于 0")
    concurrency = min(len(members), max_workers or 8)
    effective_timeout = min(timeout, max(1, state.gate_interval_minutes) * 60)
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {
            executor.submit(
                _run_member, store, member, effective_timeout, dry_run,
                context_suffix=context_suffix,
            ): member
            for member in members
        }
        for future in as_completed(futures):
            member = futures[future]
            try:
                results.append(future.result())
            except Exception as exc:
                results.append({
                    "member": member.name,
                    "role": member.role,
                    "status": "error",
                    "error": str(exc),
                    "created_at": now_iso(),
                })

    store.append_jsonl("team_runs.jsonl", {
        "team": team_name,
        "dry_run": dry_run,
        "created_at": now_iso(),
        "results": results,
    })

    if dry_run:
        preview = [
            f"[{item['member']}/{item['role']}] prompt chars={len(item.get('prompt', ''))}"
            for item in results
        ]
        return "\n".join(preview)

    applied: list[str] = []
    for item in results:
        if item.get("status") != "ok":
            applied.append(f"[{item.get('member')}] 失败: {item.get('error')}")
            continue
        missing = missing_directive_ids(
            store,
            (item.get("control_context") or {}).get("human_directive_ids"),
        )
        if missing:
            applied.append(
                f"[{item['member']}] 结果已丢弃：执行期间收到更高优先级人工指令 "
                + ", ".join(missing)
            )
            continue
        try:
            applied.append(f"[{item['member']}] {apply_worker_output(store, item['payload'])}")
        except Exception as exc:
            applied.append(f"[{item['member']}] 写回失败: {exc}")
    gate = Scheduler(store).complete_subtask(
        f"并发批次 {team_name} 完成，{len(results)} 个 Worker 已收敛",
        require_approval=False,
    )
    render_dashboard(store)
    return "\n".join(applied) + "\n\n" + gate
