from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from collections.abc import Callable

from .dashboard import render_dashboard
from .directives import authoritative_directives, directive_ids, missing_directive_ids
from .drivers import DriverConfig, run_driver
from .lifecycle import project_execution_lock, require_executable_target, require_initialized_project
from .schemas import now_iso
from .scheduler import Scheduler
from .store import ROOT, ProjectStore
from .worker import WorkerError, apply_worker_output, build_worker_prompt
from .runtime_secrets import RuntimeSecretStore


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
        if "type" in item and "backend" not in item:
            item["backend"] = item["type"]
        item["runtime_mode"] = {
            "host-native": "local-cli",
            "ct-agent-compose": "agent-compose",
        }.get(str(item.get("runtime_mode") or "local-docker"), str(item.get("runtime_mode") or "local-docker"))
        members.append(TeamMember(**item))
    return sorted(members, key=lambda item: item.priority)


def _run_member(
    store: ProjectStore,
    member: TeamMember,
    timeout: int,
    dry_run: bool,
    context_suffix: str = "",
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    owner_directives = authoritative_directives(store)
    observed_directive_ids = directive_ids(owner_directives)
    prompt = build_worker_prompt(
        store,
        member.role,
        owner_directives,
        custom_prompt=member.custom_prompt,
        member_name=member.name,
    )
    if context_suffix:
        prompt += "\n\n当前调度器候选状态（只读）：\n" + context_suffix
    if dry_run:
        return {
            "member": member.name,
            "role": member.role,
            "status": "dry_run",
            "prompt": prompt,
            "control_context": {"human_directive_ids": observed_directive_ids},
            "created_at": now_iso(),
        }
    extra = dict(member.extra or {})
    extra["runtime_mode"] = member.runtime_mode or "local-docker"
    member_env = dict(member.env or {})
    api_key_env = member.api_key_env
    runtime_secret = RuntimeSecretStore.get(store.vendor, member.name)
    if runtime_secret:
        api_key_env = "AGENTCP_RUNTIME_API_KEY"
        member_env[api_key_env] = runtime_secret
    # Runtime routing data never contains the provider secret. The three modes
    # share one DriverConfig but have independent execution paths.
    extra.setdefault("project_path", str(store.path.resolve()))
    extra.setdefault("member_name", member.name)
    target_path = str(store.read_json("target.json").get("target_path", "")).strip()
    if target_path:
        extra.setdefault("target_path", target_path)
    if extra["runtime_mode"] == "local-docker":
        prompt += (
            "\n\n运行目录约定：AgentCP 项目根目录挂载在 /workspace。"
            "所有 evidence_path/evidence_sink 必须写为相对 AgentCP 项目根目录的路径，"
            "并将实际文件写入 /workspace/evidence/。"
            "工具输出必须有界：搜索前先缩小到具体包、文件或类名，禁止用 class C 这类"
            "宽泛模式扫描整棵反编译树；rg/find/sed 的单次终端输出不得超过 200 行，"
            "更多结果应直接写入 evidence_sink，再在会话中只读取精确命中和摘要。"
        )
        if target_path:
            prompt += "用户配置的本地目标源码以只读方式挂载在 /target。"
    elif extra["runtime_mode"] == "agent-compose":
        prompt += (
            "\n\n运行目录约定：CT agent-compose 自有工作区是 /workspace；"
            "AgentCP 项目根目录挂载在 /agentcp-project。"
            "所有 evidence_path/evidence_sink 必须写为相对 AgentCP 项目根目录的路径，"
            "并将实际文件写入 /agentcp-project/evidence/。"
        )
        if target_path:
            prompt += "用户配置的本地目标源码以只读方式挂载在 /target。"
    if (member.type or member.backend) == "container":
        if target_path:
            prompt += "\n\n容器内目标源码以只读方式挂载在 /target；项目证据目录位于 /workspace/evidence。"
    payload = run_driver(DriverConfig(
        type=member.type or member.backend,
        model=member.model,
        profile=member.profile,
        base_url=member.base_url,
        api_key_env=api_key_env,
        auth_mode=member.auth_mode,
        sandbox=member.sandbox,
        env=member_env,
        command=member.command,
        extra=extra,
        dangerously_bypass_sandbox=member.dangerously_bypass_sandbox,
    ), prompt, timeout=timeout, cancel_check=cancel_check, progress_callback=progress_callback)
    return {
        "member": member.name,
        "role": member.role,
        "status": "ok",
        "payload": payload,
        "control_context": {"human_directive_ids": observed_directive_ids},
        "created_at": now_iso(),
    }


def run_team(
    store: ProjectStore,
    team_name: str,
    timeout: int = 300,
    dry_run: bool = False,
    max_workers: int | None = None,
) -> str:
    with project_execution_lock(store):
        require_initialized_project(store)
        if not dry_run:
            require_executable_target(store)
        return _run_team_locked(store, team_name, timeout, dry_run, max_workers)


def _run_team_locked(
    store: ProjectStore,
    team_name: str,
    timeout: int = 300,
    dry_run: bool = False,
    max_workers: int | None = None,
) -> str:
    state = store.load_state()
    if state.gate_status == "awaiting_approval" and not dry_run:
        raise WorkerError("强制门禁正在等待用户批准，禁止启动新的并发批次。")
    members = load_team(team_name, store)
    if not members:
        raise WorkerError(f"团队 {team_name} 没有成员")

    results: list[dict[str, Any]] = []
    if max_workers is not None and max_workers < 1:
        raise WorkerError("max_workers 必须大于 0")
    concurrency = min(len(members), max_workers or 8)
    effective_timeout = min(timeout, max(1, state.gate_interval_minutes) * 60)
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {executor.submit(_run_member, store, member, effective_timeout, dry_run): member for member in members}
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
        f"并发批次 {team_name} 完成，{len(results)} 个 Worker 已收敛"
    )
    render_dashboard(store)
    return "\n".join(applied) + "\n\n" + gate
