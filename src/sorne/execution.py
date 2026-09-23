"""统一单 Worker 执行服务（实施规格 7）。

三个调用方（run-worker / run-team / AutomationEngine）共享的真实执行流程：
Prompt 编译与脱敏快照、RuntimeSecret 解析与注入、Driver 调用与进度回调、
标准执行结果与人工指令版本信息。本服务**不直接写业务结果**——编排器各自
负责提交（AutomationEngine 仍先持久化候选、再统一提交）。

输入至少包含：有效成员配置（TeamMember）、规范角色（member.role 已由
入口规范化）、本次任务上下文（context_suffix）、超时/取消检查/进度回调。
输出为标准 WorkerResult（payload/prompt_context/control_context/…）。
"""

from __future__ import annotations

from typing import Any, Callable

from .context_compiler import parse_task_context, persist_prompt_snapshot
from .directives import authoritative_directives, directive_ids
from .drivers import DriverConfig, run_driver
from .runtime_secrets import RuntimeSecretStore
from .schemas import now_iso
from .store import ProjectStore
from .worker import compile_worker_prompt

if False:  # TYPE_CHECKING（避免与 team/worker 的运行时导入环）
    from .team import TeamMember


def run_member(
    store: ProjectStore,
    member: "TeamMember",
    timeout: int,
    dry_run: bool,
    context_suffix: str = "",
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    owner_directives = authoritative_directives(store)
    observed_directive_ids = directive_ids(owner_directives)
    task_context, retry_delta = parse_task_context(context_suffix)
    prompt, context_manifest = compile_worker_prompt(
        store,
        member.role,
        owner_directives,
        custom_prompt=member.custom_prompt,
        member_name=member.name,
        task_context=task_context,
        retry_delta=retry_delta,
    )
    extra = dict(member.extra or {})
    extra["runtime_mode"] = member.runtime_mode or "local-docker"
    extra.setdefault("role", member.role)
    member_env = dict(member.env or {})
    api_key_env = member.api_key_env
    runtime_secret = RuntimeSecretStore.get(store.vendor, member.name)
    if runtime_secret:
        api_key_env = "SORNE_RUNTIME_API_KEY"
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
            "\n\n运行目录约定：Sorne 项目根目录挂载在 /workspace。"
            "所有 evidence_path/evidence_sink 必须写为相对 Sorne 项目根目录的路径，"
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
            "Sorne 项目根目录挂载在 /sorne-project。"
            "所有 evidence_path/evidence_sink 必须写为相对 Sorne 项目根目录的路径，"
            "并将实际文件写入 /sorne-project/evidence/。"
        )
        if target_path:
            prompt += "用户配置的本地目标源码以只读方式挂载在 /target。"
    if (member.type or member.backend) == "container":
        if target_path:
            prompt += "\n\n容器内目标源码以只读方式挂载在 /target；项目证据目录位于 /workspace/evidence。"
    context_manifest["final_prompt_chars"] = len(prompt)
    context_manifest["runtime_mode"] = extra["runtime_mode"]
    if dry_run:
        return {
            "member": member.name,
            "role": member.role,
            "status": "dry_run",
            "prompt": prompt,
            "context_manifest": context_manifest,
            "control_context": {"human_directive_ids": observed_directive_ids},
            "created_at": now_iso(),
        }
    prompt_snapshot = persist_prompt_snapshot(
        store,
        prompt,
        context_manifest,
        member_name=member.name,
        role=member.role,
        runtime_mode=extra["runtime_mode"],
    )
    if progress_callback is not None:
        progress_callback({
            "event": "context_compiled",
            "snapshot_id": prompt_snapshot["id"],
            "prompt_chars": prompt_snapshot["prompt_chars"],
            "prompt_sha256": prompt_snapshot["prompt_sha256"],
            "prompt_path": prompt_snapshot["prompt_path"],
            "context_budget_chars": context_manifest["budget_chars"],
            "context_chars": context_manifest["rendered_context_chars"],
            "selected_ids": context_manifest["selected_ids"],
            "omitted_counts": context_manifest["omitted_counts"],
        })
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
        "prompt_context": prompt_snapshot,
        "control_context": {"human_directive_ids": observed_directive_ids},
        "created_at": now_iso(),
    }
