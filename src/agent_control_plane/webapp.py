from __future__ import annotations

import json
import hashlib
import hmac
import ipaddress
import os
import re
import shutil
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from .dashboard import render_dashboard
from .automation import AutomationEngine
from .database import ControlDatabase
from .lifecycle import ProjectLifecycleBusy, project_deletion_lock
from .scheduler import Scheduler
from .schemas import GateStatus, Hint, coverage_template_for_project_type, now_iso
from .methodology import ensure_methodology
from .agent_compose import shutdown_project_runtimes
from .metrics import collect_metrics, refresh_asset_count
from .quality import QualityLedger
from .waf import WAFManager
from .store import PROJECTS, ROOT, ProjectStore
from .team import run_team
from .runtime_secrets import RuntimeSecretStore


class WebAppError(RuntimeError):
    pass


class ProjectNotFound(WebAppError):
    pass


DEFAULT_VENDOR = "production-security"
MAX_CLIENT_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
_PROJECT_ACTIVITY_CONDITION = threading.Condition(threading.RLock())
_PROJECT_ACTIVITY: dict[str, int] = {}
_PROJECTS_BEING_DELETED: set[str] = set()


def _error_status(exc: Exception) -> int:
    return 404 if isinstance(exc, ProjectNotFound) else 400


def _reserve_project_activity(vendor_value: object) -> str:
    vendor = _validate_vendor(vendor_value)
    with _PROJECT_ACTIVITY_CONDITION:
        if vendor in _PROJECTS_BEING_DELETED:
            raise ProjectNotFound("项目正在删除或已不存在")
        _PROJECT_ACTIVITY[vendor] = _PROJECT_ACTIVITY.get(vendor, 0) + 1
    return vendor


def _release_project_activity(vendor: str) -> None:
    with _PROJECT_ACTIVITY_CONDITION:
        current = _PROJECT_ACTIVITY.get(vendor, 0)
        if current <= 0:
            raise RuntimeError(f"项目活动计数下溢: {vendor}")
        remaining = current - 1
        if remaining > 0:
            _PROJECT_ACTIVITY[vendor] = remaining
        else:
            _PROJECT_ACTIVITY.pop(vendor, None)
        _PROJECT_ACTIVITY_CONDITION.notify_all()


@contextmanager
def _project_activity(vendor_value: object):
    vendor = _reserve_project_activity(vendor_value)
    try:
        yield vendor
    finally:
        _release_project_activity(vendor)


@contextmanager
def _project_deletion(vendor: str):
    deadline = time.monotonic() + 1.5
    with _PROJECT_ACTIVITY_CONDITION:
        if vendor in _PROJECTS_BEING_DELETED:
            raise WebAppError("项目删除正在进行，请勿重复提交")
        _PROJECTS_BEING_DELETED.add(vendor)
        try:
            while _PROJECT_ACTIVITY.get(vendor, 0) > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WebAppError("项目仍有请求或模型任务正在处理，请先取消并等待任务退出后再删除")
                _PROJECT_ACTIVITY_CONDITION.wait(remaining)
        except Exception:
            _PROJECTS_BEING_DELETED.discard(vendor)
            _PROJECT_ACTIVITY_CONDITION.notify_all()
            raise
    try:
        yield
    finally:
        with _PROJECT_ACTIVITY_CONDITION:
            _PROJECTS_BEING_DELETED.discard(vendor)
            _PROJECT_ACTIVITY_CONDITION.notify_all()


def _run_reserved_activity(vendor: str, engine: AutomationEngine, run_id: str) -> None:
    try:
        engine.run(run_id)
    finally:
        _release_project_activity(vendor)


def _start_background_run(store: ProjectStore, engine: AutomationEngine, run_id: str) -> None:
    """Start only an AgentCP-owned run and keep project deletion guarded."""
    reserved_vendor = _reserve_project_activity(store.vendor)
    thread = threading.Thread(
        target=_run_reserved_activity,
        args=(reserved_vendor, engine, run_id),
        name=f"agentcp-{run_id}",
        daemon=True,
    )
    try:
        thread.start()
    except Exception:
        _release_project_activity(reserved_vendor)
        engine.db.set_run_status(run_id, "paused", "background_start_failed")
        raise


def _apply_gate_run_action(
    store: ProjectStore,
    action: str,
    run_id: str | None,
) -> dict[str, object]:
    """Turn a gate decision into a real run transition when applicable."""
    engine = AutomationEngine(store)
    run = engine.db.get_run(run_id) if run_id else (engine.db.latest_resumable_run() or engine.db.latest_run())
    if run_id and run is None:
        raise WebAppError(f"运行不存在: {run_id}")
    if run is None:
        return {
            "run_id": None, "previous_run_id": None, "run_status": None,
            "transition": "gate_only", "resumed": False, "started": False, "cancelled": False,
        }

    result: dict[str, object] = {
        "run_id": run["id"],
        "previous_run_id": run["id"],
        "run_status": run["status"],
        "transition": "none",
        "resumed": False,
        "started": False,
        "cancelled": False,
    }
    if action in {"continue", "switch_target", "switch_phase"} and run["status"] == "paused":
        engine.resume(run["id"])
        _start_background_run(store, engine, run["id"])
        result.update({"run_status": "running", "transition": "resumed", "resumed": True})
    elif action in {"continue", "switch_target", "switch_phase"} and run["status"] == "running":
        result.update({"transition": "continued", "resumed": True})
    elif action in {"continue", "switch_target", "switch_phase"} and run["status"] in {
        "completed", "failed", "stopped", "cancelled",
    }:
        new_run_id = engine.start(
            str(run.get("team") or "default"),
            timeout=int(run.get("timeout_seconds") or 600),
            max_workers=int(run.get("max_workers") or 3),
        )
        _start_background_run(store, engine, new_run_id)
        result.update({
            "run_id": new_run_id,
            "run_status": "running",
            "transition": "started_next_iteration",
            "started": True,
        })
    elif action == "stop_loss" and run["status"] in {"running", "paused", "stopping"}:
        engine.cancel(run["id"], "gate_stop_loss")
        result.update({"run_status": "stopped", "transition": "stopped", "cancelled": True})
    elif action == "stop_loss":
        result.update({"transition": "already_terminal"})
    return result


def _approve_gate_and_transition(
    store: ProjectStore,
    action: str,
    reason: str,
    run_id: str | None,
) -> tuple[str, dict[str, object]]:
    """Approve and apply the run transition as one recoverable operation."""
    before = store.load_state()
    original_reason = before.gate_reason
    output = Scheduler(store).approve(action, reason)
    try:
        transition = _apply_gate_run_action(store, action, run_id)
    except Exception as exc:
        state = store.load_state()
        state.gate_status = GateStatus.AWAITING_APPROVAL.value
        state.gate_reason = (
            f"{original_reason} | 审批动作执行失败，门禁保持暂停：{exc}"
            if original_reason else f"审批动作执行失败，门禁保持暂停：{exc}"
        )
        state.current_decision = "request_confirmation"
        store.save_state(state)
        raise
    return output, transition


def _has_active_job_lease(engine: AutomationEngine) -> bool:
    now = datetime.now(timezone.utc)
    for job in engine.db.list_all_jobs():
        if job.get("status") not in {"running", "cancelling"} or not job.get("lease_expires_at"):
            continue
        try:
            expires_at = datetime.fromisoformat(str(job["lease_expires_at"]).replace("Z", "+00:00"))
        except ValueError:
            continue
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at > now:
            return True
    return False


def _validate_vendor(value: object) -> str:
    vendor = str(value or "").strip()
    if (
        not vendor
        or len(vendor) > 80
        or vendor in {".", ".."}
        or vendor.startswith(".")
        or any(char in vendor for char in ("/", "\\", "\0"))
        or not all(char.isalnum() or char in {"-", "_", "."} for char in vendor)
    ):
        raise WebAppError("项目名只能包含中文、字母、数字、点、短横线和下划线")
    return vendor


def _project_names() -> list[str]:
    if not PROJECTS.exists():
        return []
    return sorted(
        path.name
        for path in PROJECTS.iterdir()
        if (
            not path.name.startswith(".")
            and not path.is_symlink()
            and path.is_dir()
            and (path / "target.json").is_file()
            and not (path / "target.json").is_symlink()
        )
    )


def _safe_project(vendor: str) -> ProjectStore:
    vendor = _validate_vendor(vendor)
    candidate = PROJECTS / vendor
    if (
        candidate.is_symlink()
        or not candidate.is_dir()
        or not (candidate / "target.json").is_file()
        or (candidate / "target.json").is_symlink()
    ):
        raise ProjectNotFound(f"项目不存在: {vendor}")
    try:
        candidate.resolve().relative_to(PROJECTS.resolve())
    except ValueError as exc:
        raise ProjectNotFound(f"项目路径无效: {vendor}") from exc
    store = ProjectStore(vendor)
    return store


def _delete_project(vendor_value: object, confirmation: object) -> list[str]:
    vendor = _validate_vendor(vendor_value)
    if str(confirmation or "") != vendor:
        raise WebAppError("删除确认不匹配，请完整输入项目名称")
    with _project_deletion(vendor):
        project_root = PROJECTS.resolve()
        project_path = PROJECTS / vendor
        if project_path.is_symlink():
            raise WebAppError("拒绝删除符号链接项目")
        if not project_path.is_dir() or not (project_path / "target.json").is_file():
            raise ProjectNotFound("项目不存在或不是有效项目")
        try:
            project_path.resolve().relative_to(project_root)
        except ValueError as exc:
            raise WebAppError("项目路径越界") from exc

        store = _safe_project(vendor)
        try:
            with project_deletion_lock(store):
                engine = AutomationEngine(store)
                active_runs = [
                    run for run in engine.db.list_runs()
                    if run.get("status") in {"running", "paused"}
                ]
                if active_runs:
                    run_ids = "、".join(str(run.get("id")) for run in active_runs[:3])
                    raise WebAppError(f"项目仍有运行中或暂停的自动化任务（{run_ids}），请先取消并等待任务退出后再删除")
                if _has_active_job_lease(engine):
                    raise WebAppError("项目仍有尚未退出的 Worker，请等待任务租约结束后再删除")

                shutdown_project_runtimes(project_path)
                RuntimeSecretStore.clear(vendor, persistent=True)
                quarantine = PROJECTS / f".deleting-{vendor}-{uuid4().hex}"
                project_path.rename(quarantine)
                try:
                    shutil.rmtree(quarantine)
                except Exception as exc:
                    if quarantine.exists() and not project_path.exists():
                        quarantine.rename(project_path)
                    raise WebAppError("项目文件清理失败，目录已恢复") from exc
        except ProjectLifecycleBusy as exc:
            raise WebAppError(str(exc)) from exc
    return _project_names()


def _string_list(value: object, field: str) -> list[str]:
    if isinstance(value, str):
        items = value.splitlines()
    elif isinstance(value, list):
        items = value
    elif value is None:
        items = []
    else:
        raise WebAppError(f"{field} 必须是数组或多行文本")
    clean = [str(item).strip() for item in items if str(item).strip()]
    if len(clean) > 200 or any(len(item) > 2048 for item in clean):
        raise WebAppError(f"{field} 内容过多或单项过长")
    return list(dict.fromkeys(clean))


def _normalize_target(vendor: str, payload: dict, current: dict | None = None) -> dict:
    if not isinstance(payload, dict):
        raise WebAppError("目标配置必须是对象")
    base = dict(current or {})
    targets = _string_list(payload.get("targets", base.get("targets", [])), "targets")
    target_path = str(payload.get("target_path", base.get("target_path", "")) or "").strip()
    out_of_scope = _string_list(
        payload.get("out_of_scope", base.get("out_of_scope", [])),
        "out_of_scope",
    )
    success_criteria = _string_list(
        payload.get("success_criteria", base.get("success_criteria", [])),
        "success_criteria",
    )
    project_type = str(payload.get("project_type", base.get("project_type", "")) or "").strip()
    if not targets and not target_path and not _is_client_project_type(project_type):
        raise WebAppError("请至少填写一个目标地址，或填写本地目标目录")
    for field in ("goal", "notes"):
        value = str(payload.get(field, base.get(field, "")) or "").strip()
        if len(value) > 10000:
            raise WebAppError(f"{field} 内容过长")
        base[field] = value
    if len(project_type) > 10000:
        raise WebAppError("project_type 内容过长")
    base["project_type"] = project_type
    base.update({
        "vendor": vendor,
        "targets": targets,
        "target_path": target_path,
        "out_of_scope": out_of_scope,
        "success_criteria": success_criteria,
        "authorization": "authorized",
        "authorization_mode": "owner_asserted_all_targets",
        "authorized_by": "project_owner",
        "scope": ["*"],
    })
    return base


def _target_markdown(target: dict) -> str:
    def bullets(items: list[str]) -> str:
        return "\n".join(f"- {item}" for item in items) or "- 无"

    artifact = target.get("uploaded_artifact") if isinstance(target.get("uploaded_artifact"), dict) else {}
    artifact_section = (
        "\n## 已上传客户端文件\n\n"
        f"- 文件名：{artifact.get('name') or '未知'}\n"
        f"- 大小：{artifact.get('size') or 0} bytes\n"
        f"- SHA-256：{artifact.get('sha256') or '未知'}\n"
        f"- 保存路径：{artifact.get('path') or target.get('target_path') or '未知'}\n"
        if artifact else ""
    )
    return (
        f"# {target['vendor']} 目标信息\n\n"
        "## 授权\n\n"
        "- 授权状态：已授权（所有测试目标）\n"
        "- 授权模式：owner_asserted_all_targets\n"
        "- 授权范围：*\n\n"
        "## 测试目标\n\n"
        f"{bullets(target.get('targets', []))}\n\n"
        f"- 本地目标路径：{target.get('target_path') or '无'}\n"
        f"- 项目类型：{target.get('project_type') or '未填写'}\n"
        f"- 测试目标：{target.get('goal') or '未填写'}\n\n"
        "## 不收范围\n\n"
        f"{bullets(target.get('out_of_scope', []))}\n\n"
        "## 成功条件\n\n"
        f"{bullets(target.get('success_criteria', []))}\n\n"
        "## 补充说明\n\n"
        f"{target.get('notes') or '无'}\n"
        f"{artifact_section}"
    )


def _save_target(store: ProjectStore, payload: dict) -> dict:
    current = store.read_json("target.json") if (store.path / "target.json").exists() else {}
    previous_type = str(current.get("project_type", "") or "")
    target = _normalize_target(store.vendor, payload, current)
    store.write_json("target.json", target)
    store.write_text("目标信息.md", _target_markdown(target))
    selected_type = str(target.get("project_type", "") or "")
    desired_coverage = coverage_template_for_project_type(selected_type)
    state = store.load_state()
    if selected_type != previous_type or set(state.attack_surface_coverage) != set(desired_coverage):
        state.attack_surface_coverage = desired_coverage
        store.save_state(state)
    ensure_methodology(store, ControlDatabase(store.path / "control_plane.db"))
    refresh_asset_count(store)
    return target


def _is_client_project_type(value: object) -> bool:
    text = str(value or "").strip().casefold()
    return any(marker in text for marker in (
        "客户端", "client", "desktop", "electron", "android", "ios", "apk", "ipa", "移动端", "桌面端",
    )) and not any(marker in text for marker in ("web", "api", "网站", "网页"))


def _client_upload_limit() -> int:
    raw = os.environ.get("AGENTCP_MAX_CLIENT_UPLOAD_BYTES", "").strip()
    if not raw:
        return MAX_CLIENT_UPLOAD_BYTES
    try:
        value = int(raw)
    except ValueError as exc:
        raise WebAppError("AGENTCP_MAX_CLIENT_UPLOAD_BYTES 必须是正整数") from exc
    if value <= 0:
        raise WebAppError("AGENTCP_MAX_CLIENT_UPLOAD_BYTES 必须是正整数")
    return value


def _safe_upload_filename(value: object) -> str:
    original = str(value or "").replace("\\", "/").split("/")[-1].strip()
    cleaned = re.sub(r"[^\w.() +@-]+", "_", original, flags=re.UNICODE).strip(" .")
    if not cleaned:
        raise WebAppError("上传文件名为空或不合法")
    return cleaned[:160]


def _store_client_upload(
    store: ProjectStore,
    filename: object,
    stream,
    content_length: int,
    project_type: object | None = None,
) -> tuple[dict, dict]:
    active_run = ControlDatabase(store.path / "control_plane.db").latest_resumable_run()
    if active_run is not None:
        raise WebAppError(
            f"运行 {active_run['id']} 当前为 {active_run['status']}，请先结束当前审计再替换客户端目标文件"
        )
    current = store.read_json("target.json")
    selected_type = str(project_type or current.get("project_type") or "").strip()
    if not _is_client_project_type(selected_type):
        raise WebAppError("只有客户端项目可以上传测试文件，请先选择“客户端”项目类型")
    limit = _client_upload_limit()
    if content_length <= 0:
        raise WebAppError("上传文件为空或缺少 Content-Length")
    if content_length > limit:
        raise WebAppError(f"上传文件超过大小限制：最大 {limit} bytes")

    safe_name = _safe_upload_filename(filename)
    upload_root = store.path / "uploads"
    upload_root.mkdir(parents=True, exist_ok=True)
    destination = upload_root / f"{uuid4().hex[:12]}-{safe_name}"
    temporary = upload_root / f".upload-{uuid4().hex}.part"
    digest = hashlib.sha256()
    remaining = content_length
    try:
        with temporary.open("xb") as output:
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise WebAppError("上传连接提前结束，文件未完整接收")
                output.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
        os.replace(temporary, destination)
        target = _save_target(store, {
            **current,
            "project_type": selected_type,
            # All runtime modes can mount directories. CT agent-compose rejects
            # file bind mounts, so mount the isolated upload directory and keep
            # the selected file path in uploaded_artifact.
            "target_path": str(upload_root.resolve()),
        })
        artifact = {
            "name": safe_name,
            "path": str(destination.resolve()),
            "size": content_length,
            "sha256": digest.hexdigest(),
            "uploaded_at": now_iso(),
        }
        target["uploaded_artifact"] = artifact
        store.write_json("target.json", target)
        store.write_text("目标信息.md", _target_markdown(target))
        previous_artifact = current.get("uploaded_artifact")
        if isinstance(previous_artifact, dict):
            previous_path_value = str(previous_artifact.get("path") or "").strip()
            if previous_path_value:
                previous_path = Path(previous_path_value).resolve()
                try:
                    previous_path.relative_to(upload_root.resolve())
                except ValueError:
                    previous_path = None
                if (
                    previous_path is not None
                    and previous_path != destination.resolve()
                    and not previous_path.is_symlink()
                    and previous_path.is_file()
                ):
                    try:
                        previous_path.unlink()
                    except OSError:
                        # The new target is already durable and valid. A stale
                        # file cleanup failure must not roll it back or leave
                        # target.json pointing at a deleted replacement.
                        pass
        return artifact, target
    except Exception:
        temporary.unlink(missing_ok=True)
        if destination.exists() and str(current.get("target_path") or "") != str(destination):
            destination.unlink(missing_ok=True)
        raise


def _config_path(store: ProjectStore) -> Path:
    return store.path / "team_config.json"


def _load_config(store: ProjectStore) -> dict:
    path = _config_path(store)
    if path.exists():
        config = json.loads(path.read_text(encoding="utf-8"))
    else:
        fallback = ROOT / "teams" / "default.json"
        config = json.loads(fallback.read_text(encoding="utf-8"))
    for member in config.get("members", []):
        runtime_mode = str(member.get("runtime_mode") or "local-docker")
        member["runtime_mode"] = {
            "host-native": "local-cli",
            "ct-agent-compose": "agent-compose",
        }.get(runtime_mode, runtime_mode)
    return config


def _redact_config(config: dict) -> dict:
    clean = json.loads(json.dumps(config, ensure_ascii=False))
    for member in clean.get("members", []):
        api_key_env = member.get("api_key_env")
        if api_key_env and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(api_key_env)):
            member["api_key_env"] = None
        env = member.get("env") or {}
        for key in list(env):
            if "KEY" in key.upper() or "TOKEN" in key.upper() or "SECRET" in key.upper():
                env[key] = "******" if env[key] else ""
    return clean


def _normalize_runtime_secrets(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        raise WebAppError("secrets 必须是对象")
    normalized: dict[str, str] = {}
    for member, raw_secret in value.items():
        if not isinstance(raw_secret, str) or len(raw_secret) > 8192:
            raise WebAppError("会话密钥格式非法")
        secret = raw_secret.strip()
        if not secret:
            continue
        if any(not 33 <= ord(char) <= 126 for char in secret):
            raise WebAppError("会话 API Key 只能包含可打印 ASCII 字符，不能包含空格或换行")
        normalized[str(member)] = secret
    return normalized


def _save_config(store: ProjectStore, config: dict) -> None:
    if not isinstance(config.get("members"), list):
        raise WebAppError("配置必须包含 members 数组")
    if not config["members"]:
        raise WebAppError("至少需要一个角色")
    allowed_types = {"codex", "claude-cli", "openai-compatible", "ollama", "container"}
    allowed_roles = {"reason", "metacog", "executor", "pentester", "reviewer", "waf_analyst"}
    allowed_sandboxes = {"read-only", "workspace-write", "danger-full-access"}
    allowed_auth_modes = {"auto", "bearer", "x-api-key"}
    allowed_runtime_modes = {"local-docker", "agent-compose", "local-cli"}
    names: set[str] = set()
    for member in config["members"]:
        name = str(member.get("name", "")).strip()
        if not name or name in names:
            raise WebAppError("角色名称不能为空且不能重复")
        names.add(name)
        if member.get("type", "codex") not in allowed_types:
            raise WebAppError(f"不支持的模型后端: {member.get('type')}")
        if member.get("role") not in allowed_roles:
            raise WebAppError(f"不支持的角色: {member.get('role')}")
        if member.get("sandbox", "read-only") not in allowed_sandboxes:
            raise WebAppError(f"不支持的沙箱模式: {member.get('sandbox')}")
        runtime_mode = str(member.get("runtime_mode", "local-docker") or "local-docker")
        runtime_mode = {"host-native": "local-cli", "ct-agent-compose": "agent-compose"}.get(runtime_mode, runtime_mode)
        if runtime_mode not in allowed_runtime_modes:
            raise WebAppError(f"不支持的运行模式: {runtime_mode}")
        if runtime_mode == "local-cli" and member.get("type", "codex") == "container":
            raise WebAppError("本地 CLI 模式不能选择 Container Worker")
        member["runtime_mode"] = runtime_mode
        custom_prompt = str(member.get("custom_prompt", "") or "").strip()
        if len(custom_prompt) > 30000:
            raise WebAppError("单个 Agent 的专属提示词不能超过 30000 字符")
        member["custom_prompt"] = custom_prompt or None
        auth_mode = str(member.get("auth_mode", "auto") or "auto")
        if auth_mode not in allowed_auth_modes:
            raise WebAppError(f"不支持的鉴权方式: {auth_mode}")
        member["auth_mode"] = auth_mode
        api_key_env = str(member.get("api_key_env", "") or "").strip()
        if api_key_env and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", api_key_env):
            raise WebAppError("密钥变量必须填写环境变量名，不能填写真实 API Key")
        member["api_key_env"] = api_key_env or None
        member_type = member.get("type", "codex")
        if member_type == "ollama" and runtime_mode != "local-cli":
            raise WebAppError("Ollama 目前仅支持本地 CLI 模式")
        if member_type == "container":
            extra = member.get("extra") or {}
            if runtime_mode != "local-docker":
                raise WebAppError("Container Worker 仅支持本地 Docker 模式")
            if not str(extra.get("image", "")).strip() or not isinstance(extra.get("worker_command"), list):
                raise WebAppError("Container Worker 必须在 extra 中配置 image 和 worker_command")
        if member_type in {"claude-cli", "openai-compatible"} and not str(member.get("model", "") or "").strip():
            raise WebAppError(f"{member_type} 必须填写模型 ID")
        if member_type == "openai-compatible" and not str(member.get("base_url", "") or "").strip():
            raise WebAppError("openai-compatible 必须填写服务地址")
        if member_type == "claude-cli" and member.get("base_url") and not api_key_env:
            raise WebAppError("Claude 中转站配置必须填写密钥环境变量名")
        if member_type == "claude-cli" and runtime_mode == "local-cli" and member.get("sandbox") == "danger-full-access":
            raise WebAppError("Claude CLI 不允许在宿主机使用 danger-full-access；请改用本地 Docker")
        if bool(member.get("dangerously_bypass_sandbox", False)):
            raise WebAppError("Web 配置禁止绕过沙箱")
        max_running = int(member.get("max_running", 1))
        if max_running < 1 or max_running > 16:
            raise WebAppError("max_running 必须在 1 到 16 之间")
        member["name"] = name
        member["max_running"] = max_running
        member["priority"] = int(member.get("priority", 0))
        for key, value in (member.get("env") or {}).items():
            if any(marker in key.upper() for marker in ("KEY", "TOKEN", "SECRET")) and value not in {"", "******"}:
                raise WebAppError(f"禁止将真实密钥写入项目文件: {key}；请使用服务端环境变量")
    _config_path(store).write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _safe_evidence_file(store: ProjectStore, value: str) -> Path:
    relative = Path(value)
    if relative.is_absolute():
        raise WebAppError("证据路径必须是相对路径")
    resolved = (store.path / relative).resolve()
    allowed = (store.path / "evidence").resolve()
    try:
        resolved.relative_to(allowed)
    except ValueError as exc:
        raise WebAppError("证据路径越界") from exc
    if not resolved.is_file():
        raise WebAppError("证据文件不存在")
    return resolved


def _audit(store: ProjectStore, action: str, details: dict) -> None:
    store.append_jsonl("api_audit.jsonl", {
        "action": action,
        "details": details,
        "source": "http_api",
        "created_at": now_iso(),
    })


class AgentControlHandler(SimpleHTTPRequestHandler):
    server_version = "AgentControlPlane/3.1"

    def end_headers(self) -> None:
        # The console is a live local control plane. Serving stale JavaScript can
        # mislabel current backend states after a safe service reload, so frontend
        # assets must always be revalidated instead of relying on browser cache.
        if urlparse(self.path).path.startswith("/frontend/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        request_path = urlparse(path).path
        if not request_path.startswith("/frontend/"):
            return str(ROOT.resolve() / "__forbidden__")
        root = (ROOT / "frontend").resolve()
        candidate = (root / request_path.removeprefix("/frontend/")).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return str(root / "__forbidden__")
        return str(candidate)

    def _json(self, data: object, status: int = 200) -> None:
        if getattr(self, "_response_started", False):
            return
        self._response_started = True
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            return

    def _read_json(self) -> dict:
        cached = getattr(self, "_cached_json_payload", None)
        if cached is not None:
            return cached
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            self._cached_json_payload = {}
            return self._cached_json_payload
        if length > 1024 * 1024:
            raise WebAppError("请求体超过 1 MiB 限制")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise WebAppError("请求体必须是 JSON 对象")
        self._cached_json_payload = payload
        return payload

    def _api_authorized(self) -> bool:
        expected = os.environ.get("AGENTCP_SERVER_TOKEN")
        if not expected:
            return True
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, f"Bearer {expected}")

    def do_GET(self) -> None:
        self._response_started = False
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/") and not self._api_authorized():
            self._json({"ok": False, "error": "unauthorized"}, status=401)
            return
        if parsed.path.startswith("/api/") and parsed.path != "/api/projects":
            vendor = parse_qs(parsed.query).get("vendor", [DEFAULT_VENDOR])[0]
            try:
                with _project_activity(vendor):
                    self._handle_GET(parsed)
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))
            return
        self._handle_GET(parsed)

    def _handle_GET(self, parsed) -> None:
        if parsed.path == "/":
            projects = _project_names()
            vendor = DEFAULT_VENDOR if DEFAULT_VENDOR in projects else (projects[0] if projects else DEFAULT_VENDOR)
            self.send_response(302)
            self.send_header("Location", f"/frontend/?vendor={vendor}")
            self.end_headers()
            return
        if parsed.path == "/api/projects":
            projects = []
            quality_summary = None
            for vendor in _project_names():
                try:
                    with _project_activity(vendor):
                        store = _safe_project(vendor)
                        state = store.load_state()
                        target = store.read_json("target.json")
                        quality = QualityLedger().project_metrics(store)
                        latest_run = ControlDatabase(
                            store.path / "control_plane.db"
                        ).latest_run()
                        if quality_summary is None:
                            quality_summary = QualityLedger().global_metrics(store)
                        projects.append({
                            "vendor": vendor,
                            "phase": state.phase,
                            "gate_status": state.gate_status,
                            "run_status": (
                                "awaiting_approval"
                                if state.gate_status == GateStatus.AWAITING_APPROVAL.value
                                else str((latest_run or {}).get("status") or "idle")
                            ),
                            "updated_at": state.updated_at,
                            "current_task": state.current_task,
                            "goal": target.get("goal", ""),
                            "target_count": len(target.get("targets") or []) + (
                                1 if isinstance(target.get("uploaded_artifact"), dict) else 0
                            ),
                            "fact_count": state.fact_count,
                            "vulnerability_count": state.vulnerability_count,
                            "quality_metrics": quality,
                        })
                except ProjectNotFound:
                    continue
            self._json({
                "ok": True,
                "projects": projects,
                "quality_summary": quality_summary or {
                    "reviewed": 0,
                    "false_positives": 0,
                    "false_positive_rate": None,
                    "sample_size": 0,
                    "sample_quality": "样本严重不足",
                },
            })
            return
        if parsed.path == "/api/project/state":
            try:
                vendor = parse_qs(parsed.query).get("vendor", [DEFAULT_VENDOR])[0]
                store = _safe_project(vendor)
                database = AutomationEngine(store).db
                self._json({
                    "ok": True,
                    "state": store.load_state().__dict__,
                    "target": store.read_json("target.json"),
                    "facts": store.read_jsonl("facts.jsonl"),
                    "negative_evidence": store.read_jsonl("negative_evidence.jsonl"),
                    "human_verdicts": store.read_jsonl("human_verdicts.jsonl"),
                    "refutation_memories": store.read_jsonl("refutation_memories.jsonl"),
                    "waf_assessments": WAFManager().current(store),
                    "quality_metrics": QualityLedger().project_metrics(store),
                    "global_quality_metrics": QualityLedger().global_metrics(store),
                    "intents": store.read_jsonl("intents.jsonl"),
                    "hypotheses": store.read_jsonl("hypotheses.jsonl"),
                    "plan_batches": store.read_jsonl("plan_batches.jsonl"),
                    "counterfactuals": store.read_jsonl("counterfactuals.jsonl"),
                    "lessons": store.read_jsonl("lessons.jsonl"),
                    "phase_events": store.read_jsonl("phase_events.jsonl"),
                    "method_pack": (
                        store.read_json("method_pack.json")
                        if (store.path / "method_pack.json").exists() else {}
                    ),
                    "directions": database.list_directions(),
                    "decisions": store.read_jsonl("decision_log.jsonl"),
                    "hints": store.read_jsonl("hints.jsonl"),
                    "blackboard": store.read_text("项目黑板_知识库.md"),
                })
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))
            return
        if parsed.path == "/api/automation/status":
            try:
                query = parse_qs(parsed.query)
                store = _safe_project(query.get("vendor", [DEFAULT_VENDOR])[0])
                run_id = query.get("run_id", [None])[0]
                self._json({"ok": True, **AutomationEngine(store).status(run_id)})
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))
            return
        if parsed.path == "/api/metrics":
            try:
                vendor = parse_qs(parsed.query).get("vendor", [DEFAULT_VENDOR])[0]
                self._json({"ok": True, "metrics": collect_metrics(_safe_project(vendor))})
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))
            return
        if parsed.path == "/api/config":
            try:
                vendor = parse_qs(parsed.query).get("vendor", [DEFAULT_VENDOR])[0]
                store = _safe_project(vendor)
                config = _redact_config(_load_config(store))
                names = [str(item.get("name", "")) for item in config.get("members", [])]
                self._json({"ok": True, "config": config, "secret_status": RuntimeSecretStore.status(store.vendor, names)})
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))
            return
        if parsed.path == "/api/evidence":
            try:
                vendor = parse_qs(parsed.query).get("vendor", [DEFAULT_VENDOR])[0]
                store = _safe_project(vendor)
                self._json({"ok": True, "evidence": store.read_jsonl("evidence.jsonl")})
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))
            return
        if parsed.path == "/api/evidence/content":
            try:
                query = parse_qs(parsed.query)
                store = _safe_project(query.get("vendor", [DEFAULT_VENDOR])[0])
                path = query.get("path", [""])[0]
                evidence = _safe_evidence_file(store, path)
                raw = evidence.read_bytes()
                self._json({
                    "ok": True,
                    "path": path,
                    "content": raw[:65536].decode("utf-8", errors="replace"),
                    "truncated": len(raw) > 65536,
                })
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))
            return
        if parsed.path == "/api/audit":
            try:
                vendor = parse_qs(parsed.query).get("vendor", [DEFAULT_VENDOR])[0]
                self._json({"ok": True, "audit": _safe_project(vendor).read_jsonl("api_audit.jsonl")[-100:]})
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))
            return
        if parsed.path == "/frontend":
            self.send_response(302)
            self.send_header("Location", "/frontend/")
            self.end_headers()
            return
        if parsed.path.startswith("/frontend/"):
            return super().do_GET()
        self.send_error(404, "Not Found")

    def do_POST(self) -> None:
        self._response_started = False
        self._cached_json_payload = None
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/") and not self._api_authorized():
            self._json({"ok": False, "error": "unauthorized"}, status=401)
            return
        try:
            if parsed.path == "/api/target/upload":
                query = parse_qs(parsed.query)
                vendor = query.get("vendor", [DEFAULT_VENDOR])[0]
                filename = query.get("filename", [""])[0]
                project_type = query.get("project_type", [""])[0]
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                except ValueError as exc:
                    raise WebAppError("Content-Length 不合法") from exc
                with _project_activity(vendor):
                    store = _safe_project(vendor)
                    artifact, target = _store_client_upload(
                        store, filename, self.rfile, content_length, project_type,
                    )
                    _audit(store, "client_artifact_uploaded", {
                        "name": artifact["name"], "size": artifact["size"], "sha256": artifact["sha256"],
                    })
                    render_dashboard(store)
                    self._json({"ok": True, "artifact": artifact, "target": target}, status=201)
                return
            payload = self._read_json()
            if parsed.path == "/api/projects/delete":
                self._handle_POST(parsed)
                return
            guarded_paths = {
                "/api/projects", "/api/target", "/api/config", "/api/gate/approve",
                "/api/directions/dismiss",
                "/api/automation/start", "/api/automation/launch", "/api/automation/run",
                "/api/automation/resume", "/api/automation/cancel", "/api/subtask/complete",
                "/api/hints", "/api/team/run", "/api/findings/review",
            }
            if parsed.path in guarded_paths:
                with _project_activity(payload.get("vendor", DEFAULT_VENDOR)):
                    self._handle_POST(parsed)
                return
            self._handle_POST(parsed)
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))

    def _handle_POST(self, parsed) -> None:
        try:
            if parsed.path == "/api/projects/delete":
                payload = self._read_json()
                vendor = _validate_vendor(payload.get("vendor"))
                projects = _delete_project(vendor, payload.get("confirmation"))
                self._json({"ok": True, "deleted": vendor, "projects": projects})
                return

            if parsed.path == "/api/projects":
                payload = self._read_json()
                vendor = _validate_vendor(payload.get("vendor"))
                target_payload = payload.get("target")
                target = _normalize_target(vendor, target_payload, {})
                store = ProjectStore(vendor)
                if store.path.exists():
                    raise WebAppError("项目已存在，请选择该项目后修改目标")
                store.init()
                target = _save_target(store, target)
                _audit(store, "project_initialized", {"targets": len(target["targets"]), "has_target_path": bool(target["target_path"])})
                render_dashboard(store)
                self._json({"ok": True, "vendor": vendor, "target": target}, status=201)
                return

            if parsed.path == "/api/target":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                target = _save_target(store, payload.get("target"))
                _audit(store, "target_updated", {"targets": len(target["targets"]), "has_target_path": bool(target["target_path"])})
                render_dashboard(store)
                self._json({"ok": True, "target": target})
                return

            if parsed.path == "/api/findings/review":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                verdict = QualityLedger().review(
                    store,
                    finding_id=str(payload.get("finding_id", "")).strip(),
                    action=str(payload.get("action", "")).strip(),
                    final_classification=str(payload.get("final_classification", "")).strip(),
                    final_severity=str(payload.get("final_severity", "")).strip(),
                    reason=str(payload.get("reason", "")).strip(),
                    reason_codes=[str(item) for item in payload.get("reason_codes", [])],
                    applicable_scope=str(payload.get("applicable_scope", "current_finding")),
                    reviewed_by=str(payload.get("reviewed_by", "project_owner")),
                )
                _audit(store, "finding_human_reviewed", {
                    "finding_id": verdict.finding_id,
                    "action": verdict.action,
                    "reason_codes": verdict.reason_codes,
                })
                render_dashboard(store)
                self._json({
                    "ok": True,
                    "verdict": verdict.__dict__,
                    "quality_metrics": QualityLedger().project_metrics(store),
                    "global_quality_metrics": QualityLedger().global_metrics(store),
                })
                return

            if parsed.path == "/api/directions/dismiss":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                direction_id = str(payload.get("direction_id", "")).strip()
                reason = str(payload.get("reason", "")).strip()
                if not direction_id:
                    raise WebAppError("缺少 direction_id")
                if not reason:
                    raise WebAppError("人工删除方向必须填写理由")
                direction = AutomationEngine(store).db.dismiss_direction(direction_id, reason)
                _audit(store, "direction_human_dismissed", {
                    "direction_id": direction_id,
                    "reason": reason,
                    "previous_intent": (direction.get("intent") or {}).get("verb"),
                })
                render_dashboard(store)
                self._json({"ok": True, "direction": direction})
                return

            if parsed.path == "/api/config":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                config = payload.get("config")
                if not isinstance(config, dict):
                    raise WebAppError("缺少 config")
                runtime_secrets = _normalize_runtime_secrets(payload.get("secrets") or {})
                for member in config.get("members", []):
                    name = str(member.get("name", "")).strip()
                    secret = runtime_secrets.get(name)
                    if secret and not member.get("api_key_env"):
                        member["api_key_env"] = "AGENTCP_RUNTIME_API_KEY"
                current = _load_config(store)
                merged = _merge_secret_values(current, config)
                _save_config(store, merged)
                names = {str(item["name"]) for item in merged.get("members", [])}
                RuntimeSecretStore.set_many(store.vendor, runtime_secrets, names, persist=True)
                _audit(store, "config_updated", {"members": len(merged.get("members", []))})
                render_dashboard(store)
                self._json({"ok": True, "config": _redact_config(merged), "secret_status": RuntimeSecretStore.status(store.vendor, sorted(names))})
                return

            if parsed.path == "/api/gate/approve":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                action = str(payload.get("action", "continue"))
                requested_run_id = str(payload.get("run_id", "")).strip() or None
                if requested_run_id and AutomationEngine(store).db.get_run(requested_run_id) is None:
                    raise WebAppError(f"运行不存在: {requested_run_id}")
                reason = str(payload.get("reason", "")).strip() or "用户从 Web 控制台批准"
                output, run_transition = _approve_gate_and_transition(
                    store,
                    action,
                    reason,
                    requested_run_id,
                )
                _audit(store, "gate_approved", {
                    "action": action,
                    "reason": reason,
                    "transition": run_transition.get("transition"),
                    "previous_run_id": run_transition.get("previous_run_id"),
                    "run_id": run_transition.get("run_id"),
                })
                render_dashboard(store)
                self._json({"ok": True, "output": output, "action": action, **run_transition})
                return

            if parsed.path == "/api/automation/start":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                engine = AutomationEngine(store)
                run_id = engine.start(
                    str(payload.get("team", "default")),
                    timeout=int(payload.get("timeout", 300)),
                    max_workers=int(payload.get("max_workers", 4)),
                )
                self._json({"ok": True, "run_id": run_id})
                return

            if parsed.path == "/api/automation/launch":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                engine = AutomationEngine(store)
                run_id = engine.start(
                    str(payload.get("team", "default")),
                    timeout=int(payload.get("timeout", 600)),
                    max_workers=int(payload.get("max_workers", 3)),
                )
                _start_background_run(store, engine, run_id)
                _audit(store, "automation_launched", {"run_id": run_id, "team": payload.get("team", "default")})
                self._json({"ok": True, "run_id": run_id, "status": "running"}, status=202)
                return

            if parsed.path == "/api/automation/run":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                engine = AutomationEngine(store)
                output = engine.run(payload.get("run_id"))
                self._json({"ok": True, "output": output})
                return

            if parsed.path == "/api/automation/resume":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                engine = AutomationEngine(store)
                run_id = engine.resume(payload.get("run_id"))
                self._json({"ok": True, "run_id": run_id})
                return

            if parsed.path == "/api/automation/cancel":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                run_id = str(payload.get("run_id", "")).strip()
                if not run_id:
                    raise WebAppError("缺少 run_id")
                AutomationEngine(store).cancel(run_id, str(payload.get("reason", "cancelled_by_user")))
                _audit(store, "automation_cancelled", {"run_id": run_id, "reason": payload.get("reason")})
                self._json({"ok": True, "run_id": run_id})
                return

            if parsed.path == "/api/subtask/complete":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                summary = str(payload.get("summary", "")).strip()
                if not summary:
                    raise WebAppError("缺少 summary")
                output = Scheduler(store).complete_subtask(summary)
                render_dashboard(store)
                self._json({"ok": True, "output": output})
                return

            if parsed.path == "/api/hints":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                content = str(payload.get("content", "")).strip()
                if not content:
                    raise WebAppError("缺少 content")
                intervention_type = str(payload.get("intervention_type", "supplement")).strip()
                if intervention_type not in {
                    "supplement", "redirect", "evidence_correction", "metacog_review",
                }:
                    raise WebAppError(f"不支持的人工干预类型: {intervention_type}")
                run_id = str(payload.get("run_id", "")).strip() or None
                if run_id and AutomationEngine(store).db.get_run(run_id) is None:
                    raise WebAppError(f"运行不存在: {run_id}")
                scope = str(payload.get("scope", "project")).strip() or "project"
                if scope not in {"project", "run"}:
                    raise WebAppError(f"不支持的人工干预作用域: {scope}")
                hint = Hint(
                    content=content,
                    target=payload.get("target"),
                    priority=int(payload.get("priority", 0)),
                    intervention_type=intervention_type,
                    applies_to_run_id=run_id,
                    scope=scope,
                )
                store.append_jsonl("hints.jsonl", hint)
                _audit(store, "controller_intervention_added", {
                    "hint_id": hint.id,
                    "type": hint.intervention_type,
                    "target": hint.target,
                    "priority": hint.priority,
                    "run_id": hint.applies_to_run_id,
                    "scope": hint.scope,
                    "authority": hint.authority,
                })
                self._json({"ok": True, "hint": hint.__dict__})
                return

            if parsed.path == "/api/team/run":
                payload = self._read_json()
                store = _safe_project(payload.get("vendor", DEFAULT_VENDOR))
                output = run_team(
                    store,
                    team_name=str(payload.get("team", "default")),
                    timeout=int(payload.get("timeout", 300)),
                    dry_run=bool(payload.get("dry_run", False)),
                    max_workers=int(payload.get("max_workers", 4)),
                )
                render_dashboard(store)
                self._json({"ok": True, "output": output})
                return

            self._json({"ok": False, "error": "unknown endpoint"}, status=404)
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)}, status=_error_status(exc))


def _merge_secret_values(old: dict, new: dict) -> dict:
    old_members = {item.get("name"): item for item in old.get("members", [])}
    for member in new.get("members", []):
        old_member = old_members.get(member.get("name"), {})
        old_env = old_member.get("env") or {}
        env = member.setdefault("env", {})
        for key, value in list(env.items()):
            if value == "******":
                env[key] = old_env.get(key, "")
    return new


def serve(host: str = "127.0.0.1", port: int = 8765) -> None:
    normalized_host = host.strip().strip("[]").casefold()
    try:
        loopback = normalized_host == "localhost" or ipaddress.ip_address(normalized_host).is_loopback
    except ValueError:
        loopback = False
    if not loopback and not os.environ.get("AGENTCP_SERVER_TOKEN", "").strip():
        raise WebAppError(
            "非本机回环地址启动服务时必须设置 AGENTCP_SERVER_TOKEN"
        )
    for vendor in _project_names():
        try:
            refresh_asset_count(_safe_project(vendor))
        except Exception:
            continue
    httpd = ThreadingHTTPServer((host, port), AgentControlHandler)
    print(f"Agent Control Plane running at http://{host}:{port}/")
    httpd.serve_forever()
