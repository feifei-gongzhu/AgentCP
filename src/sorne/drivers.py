from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import store as store_module
from .agent_compose import (
    AgentComposeError,
    AgentComposeRuntime,
    find_docker_binary,
    profile_from_driver_config,
)
from . import claude_events
from . import secret_redact
from . import worker_payload
from .cancellable_process import (
    ProcessCancelled,
    ProcessTimeout,
    run_cancellable_process,
)
from .docker_command import bind_mount, docker_base_args
from .openai_urls import openai_chat_completions_url
from .local_docker import LocalDockerError, LocalDockerRuntime
from .provider_auth import normalize_base_url, resolve_anthropic_auth_mode
from .runtime_config import canonical_runtime_mode
from .schemas import VALID_WORKER_KINDS
from .store import ROOT
from .platform_process import terminate_process_tree


OUTPUT_SCHEMA = Path(__file__).resolve().parent / "worker_output_schema.json"
ProgressCallback = Callable[[dict[str, Any]], None]
class DriverError(RuntimeError):
    pass


# GUI/launchd services inherit a minimal PATH that usually excludes Homebrew and
# other user-local bin directories, so a CLI that a terminal can find is invisible
# to the daemon-launched service. Mirror find_docker_binary(): honor an explicit
# override, fall back to PATH, then probe the well-known install locations.
_CLI_FALLBACK_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
)
_CLI_BIN_ENV_OVERRIDE = {
    "codex": "SORNE_CODEX_BIN",
    "claude": "SORNE_CLAUDE_BIN",
}


def resolve_cli_binary(command: str | None, default: str) -> str:
    """Resolve a model CLI independently from a daemon's limited PATH.

    ``command`` is the role's explicit override (absolute path or bare name);
    ``default`` is the canonical binary name (``codex``/``claude``). An explicit
    override or a name that already resolves through PATH is returned as-is; only
    a bare default name that PATH cannot find is probed against the well-known
    install directories. Returns the original name on miss so the caller still
    raises its actionable FileNotFoundError message.
    """
    configured = str(command or "").strip()
    if configured:
        # An absolute/relative path is used verbatim; a bare override name still
        # benefits from PATH + fallback resolution below.
        if os.sep in configured or (os.altsep and os.altsep in configured):
            return configured
        name = configured
    else:
        name = default
    discovered = shutil.which(name)
    if discovered:
        return discovered
    env_override = os.environ.get(_CLI_BIN_ENV_OVERRIDE.get(name, ""), "").strip()
    if env_override:
        candidate = Path(env_override).expanduser()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
        raise DriverError(f"{_CLI_BIN_ENV_OVERRIDE[name]} 指向的文件不可执行: {candidate}")
    for directory in _CLI_FALLBACK_DIRS:
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
    return name


@dataclass
class DriverConfig:
    type: str = "codex"
    model: str | None = None
    base_url: str | None = None
    api_key_env: str | None = None
    auth_mode: str = "auto"
    profile: str | None = None
    sandbox: str = "read-only"
    dangerously_bypass_sandbox: bool = False
    env: dict[str, str] = field(default_factory=dict)
    command: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _merged_env(config: DriverConfig) -> dict[str, str]:
    env = os.environ.copy()
    env.update({key: str(value) for key, value in config.env.items()})
    return env


def _project_working_directory(config: DriverConfig) -> Path:
    value = str(config.extra.get("project_path", "") or "").strip()
    if not value:
        return ROOT
    path = Path(value).resolve()
    if not path.is_dir():
        raise DriverError(f"项目工作目录不存在: {path}")
    if not any(
        _is_relative_to(path, root)
        for root in (ROOT.resolve(), store_module.PROJECTS.resolve())
    ):
        raise DriverError("宿主机 Worker 的项目目录必须位于 Sorne 工作区或项目根目录内")
    return path


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _extract_json(text: str) -> dict[str, Any]:
    # 共享严格提取（对象 + 合法 kind）；本包装保留 DriverError 错误类型。
    try:
        return worker_payload.extract_worker_json(text)
    except worker_payload.WorkerPayloadError as exc:
        raise DriverError(str(exc)) from exc


def _validate_worker_payload(payload: Any) -> dict[str, Any]:
    try:
        return worker_payload.require_worker_kind(payload)
    except worker_payload.WorkerPayloadError as exc:
        raise DriverError(str(exc)) from exc


def _redact_secret(text: str, secret: str | None, limit: int | None = None) -> str:
    """Keep provider credentials out of driver errors and persisted events."""
    return secret_redact.redact_secret(text, secret, limit=limit)


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    """Terminate only the process group created for this Sorne model call."""
    terminate_process_tree(process)


def _safe_stream_value(value: Any, secret: str | None, limit: int = 1200) -> str:
    return secret_redact.safe_stream_value(value, secret, limit=limit)


def _claude_stream_events(message: dict[str, Any], secret: str | None) -> tuple[list[dict[str, Any]], str | None]:
    return claude_events.claude_message_events(message, secret)


def _resolved_claude_auth(auth_mode: str, base_url: str | None) -> str:
    """Shared Anthropic auth resolution, keeping this module's error type."""
    try:
        return resolve_anthropic_auth_mode(auth_mode, base_url)
    except ValueError as exc:
        raise DriverError(str(exc)) from exc


class BaseDriver:
    def __init__(
        self,
        config: DriverConfig,
        timeout: int = 300,
        cancel_check: Callable[[], bool] | None = None,
        progress_callback: ProgressCallback | None = None,
    ):
        self.config = config
        self.timeout = timeout
        self.cancel_check = cancel_check or (lambda: False)
        self.progress_callback = progress_callback or (lambda _event: None)

    def run(self, prompt: str) -> dict[str, Any]:
        raise NotImplementedError


class CodexCliDriver(BaseDriver):
    def run(self, prompt: str) -> dict[str, Any]:
        with tempfile.NamedTemporaryFile("w+", encoding="utf-8", suffix=".json", delete=False) as out:
            output_path = Path(out.name)
        try:
            cmd = [
                resolve_cli_binary(self.config.command, "codex"),
                "exec",
                "--skip-git-repo-check",
                "--cd",
                str(_project_working_directory(self.config)),
                "--output-schema",
                str(OUTPUT_SCHEMA),
                "--output-last-message",
                str(output_path),
            ]
            if self.config.dangerously_bypass_sandbox:
                cmd.append("--dangerously-bypass-approvals-and-sandbox")
            else:
                cmd.extend(["--sandbox", self.config.sandbox])
            if self.config.model:
                cmd.extend(["--model", self.config.model])
            if self.config.profile:
                cmd.extend(["--profile", self.config.profile])
            if self.config.base_url:
                provider = "sorne"
                env_key = self.config.api_key_env or "OPENAI_API_KEY"
                cmd.extend(
                    [
                        "-c",
                        f'model_provider="{provider}"',
                        "-c",
                        f'model_providers.{provider}.name="{provider}"',
                        "-c",
                        f'model_providers.{provider}.wire_api="responses"',
                        "-c",
                        f'model_providers.{provider}.base_url="{self.config.base_url}"',
                        "-c",
                        f'model_providers.{provider}.env_key="{env_key}"',
                    ]
                )
            cmd.append("-")

            result = self._run_cancellable(cmd, input_text=prompt)
            if result.returncode != 0:
                raise DriverError(
                    "Codex Driver 执行失败\n"
                    f"returncode={result.returncode}\n"
                    f"stderr={result.stderr.strip()}\n"
                    f"stdout={result.stdout.strip()}"
                )
            return _extract_json(output_path.read_text(encoding="utf-8"))
        finally:
            output_path.unlink(missing_ok=True)

    def _run_cancellable(
        self,
        cmd: list[str],
        input_text: str | None = None,
        env_override: dict[str, str] | None = None,
        cwd_override: Path | None = None,
        line_callback: Callable[[str], None] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        # 共享可取消/超时执行（cancellable_process）；本包装只负责把
        # FileNotFoundError/OSError/取消/超时翻译成 DriverError 的可操作文案。
        executable = cmd[0] if cmd else "?"
        try:
            return run_cancellable_process(
                cmd,
                timeout_seconds=self.timeout,
                cancel_check=self.cancel_check,
                env=env_override or _merged_env(self.config),
                cwd=str(cwd_override) if cwd_override else None,
                input_text=input_text,
                line_callback=line_callback,
            )
        except FileNotFoundError as exc:
            # The CLI binary is not on the launching service's PATH. This is an
            # environment/config problem, not a model failure, so retrying is
            # pointless — surface an actionable message instead of a bare Errno.
            raise DriverError(
                f"未找到本地可执行文件 '{executable}'：请确认已安装该 CLI 且它在启动 "
                "Sorne 服务的进程 PATH 中（GUI/后台方式启动时常缺少 /opt/homebrew/bin "
                "等路径），或改用“本地 Docker”运行模式。"
            ) from exc
        except OSError as exc:
            raise DriverError(f"无法启动本地可执行文件 '{executable}': {exc}") from exc
        except ProcessCancelled as exc:
            raise DriverError("任务已被调度器取消") from exc
        except ProcessTimeout as exc:
            raise DriverError(f"模型执行超时: {self.timeout}s") from exc

class ClaudeCliDriver(BaseDriver):
    def run(self, prompt: str) -> dict[str, Any]:
        env = _merged_env(self.config)
        source_secret: str | None = None
        if self.config.api_key_env:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", self.config.api_key_env):
                raise DriverError("api_key_env 必须是环境变量名，不能填写真实密钥")
            source_secret = env.get(self.config.api_key_env)
        # Sorne never inherits Claude/CCSwitch routing from the host process.
        # A role must opt in to provider credentials through its own config.
        for name in (
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_SMALL_FAST_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ):
            env.pop(name, None)
        if self.config.base_url:
            env["ANTHROPIC_BASE_URL"] = normalize_base_url(self.config.base_url)
        if self.config.api_key_env:
            secret = source_secret
            if not secret:
                raise DriverError(f"缺少环境变量: {self.config.api_key_env}")
            auth_mode = _resolved_claude_auth(self.config.auth_mode, self.config.base_url)
            if auth_mode == "bearer":
                env["ANTHROPIC_AUTH_TOKEN"] = secret
                env.pop("ANTHROPIC_API_KEY", None)
            else:
                env["ANTHROPIC_API_KEY"] = secret
                env.pop("ANTHROPIC_AUTH_TOKEN", None)
            if self.config.api_key_env not in {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}:
                env.pop(self.config.api_key_env, None)

        # Frontend/project settings are authoritative. In particular, never load
        # Claude user or local settings into an Sorne-owned subprocess.
        cmd = [
            resolve_cli_binary(self.config.command, "claude"),
            "-p",
            "--no-session-persistence",
            "--setting-sources",
            "project",
            "--settings",
            "{}",
            "--strict-mcp-config",
            "--output-format",
            "stream-json",
            "--verbose",
        ]
        if self.config.model:
            cmd.extend(["--model", self.config.model])
        if self.config.sandbox == "read-only":
            cmd.extend(["--permission-mode", "plan", "--tools", "Read,Glob,Grep,WebFetch,WebSearch"])
        elif self.config.sandbox == "workspace-write":
            cmd.extend(["--permission-mode", "auto"])
        elif self.config.sandbox == "danger-full-access":
            raise DriverError("Claude CLI 不允许在宿主机使用 danger-full-access；请改用受限 Container Worker")
        else:
            raise DriverError(f"不支持的 Claude 权限模式: {self.config.sandbox}")
        final_result: str | None = None
        stream_error: str | None = None
        stream_error_status: int | None = None
        tool_names: dict[str, str] = {}

        def consume_stream_line(line: str) -> None:
            nonlocal final_result, stream_error, stream_error_status
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                return
            if not isinstance(message, dict):
                return
            events, result_text = _claude_stream_events(message, source_secret)
            if result_text is not None:
                final_result = result_text
            for event in events:
                tool_use_id = str(event.get("tool_use_id", ""))
                if event.get("event") == "tool_started" and tool_use_id:
                    tool_names[tool_use_id] = str(event.get("tool_name", "unknown"))
                elif event.get("event") == "tool_completed" and tool_use_id:
                    event["tool_name"] = tool_names.get(tool_use_id, "unknown")
                if event.get("event") == "stream_result" and event.get("is_error"):
                    stream_error = result_text or "模型服务返回错误"
                    try:
                        stream_error_status = int(event.get("api_error_status"))
                    except (TypeError, ValueError):
                        stream_error_status = None
                self.progress_callback(event)

        result = CodexCliDriver._run_cancellable(
            self,
            cmd,
            input_text=prompt,
            env_override=env,
            cwd_override=_project_working_directory(self.config),
            line_callback=consume_stream_line,
        )
        if stream_error:
            message = _redact_secret(stream_error.strip(), source_secret, limit=1200)
            message = re.sub(r"^API Error:\s*(?:\d{3}\s*)?", "", message, flags=re.IGNORECASE).strip()
            status_text = f"HTTP {stream_error_status} " if stream_error_status else ""
            raise DriverError(f"Claude API 调用失败: {status_text}{message}".strip())
        if result.returncode != 0:
            stderr = _redact_secret(result.stderr.strip(), source_secret, limit=4000)
            stdout = _redact_secret(result.stdout.strip(), source_secret, limit=4000)
            raise DriverError(
                "Claude CLI Driver 执行失败\n"
                f"returncode={result.returncode}\n"
                f"stderr={stderr}\n"
                f"stdout={stdout}"
            )
        try:
            if final_result is None:
                raise DriverError("Claude stream-json 未返回最终 result 事件")
            return _extract_json(final_result)
        except (DriverError, json.JSONDecodeError) as exc:
            raise DriverError(_redact_secret(str(exc), source_secret, limit=4000)) from None


class OpenAICompatibleDriver(BaseDriver):
    def run(self, prompt: str) -> dict[str, Any]:
        if not self.config.base_url:
            raise DriverError("openai-compatible driver 需要 base_url")
        if not self.config.model:
            raise DriverError("openai-compatible driver 需要 model")
        env = _merged_env(self.config)
        api_key_env = self.config.api_key_env or "OPENAI_API_KEY"
        api_key = env.get(api_key_env)
        if not api_key:
            raise DriverError(f"缺少环境变量: {api_key_env}")

        # 历史语义（api_root）：base_url 含自定义路径前缀，原样拼
        # /chat/completions；显式 extra["openai_url_style"] 可切换。
        style = str(self.config.extra.get("openai_url_style") or "api_root").strip()
        url = openai_chat_completions_url(self.config.base_url, style=style)
        body = {
            "model": self.config.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": self.config.extra.get("temperature", 0.2),
            "response_format": {"type": "json_object"},
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise DriverError(f"OpenAI-compatible 请求失败: {exc}") from exc
        content = data["choices"][0]["message"]["content"]
        return _extract_json(content)


class OllamaDriver(BaseDriver):
    def run(self, prompt: str) -> dict[str, Any]:
        base_url = (self.config.base_url or "http://127.0.0.1:11434").rstrip("/")
        if not self.config.model:
            raise DriverError("ollama driver 需要 model")
        body = {
            "model": self.config.model,
            "prompt": prompt,
            "stream": False,
            "format": "json",
        }
        req = urllib.request.Request(
            base_url + "/api/generate",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise DriverError(f"Ollama 请求失败: {exc}") from exc
        return _extract_json(data.get("response", ""))


class ContainerWorkerDriver(CodexCliDriver):
    """受限容器 Worker。

    镜像内命令从 stdin 读取 prompt，并在 stdout 输出唯一 JSON 对象。
    """

    def run(self, prompt: str) -> dict[str, Any]:
        cmd = self._docker_command()
        result = self._run_cancellable(cmd, input_text=prompt)
        if result.returncode != 0:
            raise DriverError(
                "Container Worker 执行失败\n"
                f"returncode={result.returncode}\n"
                f"stderr={result.stderr.strip()}\n"
                f"stdout={result.stdout.strip()}"
            )
        return _extract_json(result.stdout)

    def _docker_command(self) -> list[str]:
        image = str(self.config.extra.get("image", "")).strip()
        if not image:
            raise DriverError("container driver 需要 extra.image")
        worker_command = self.config.extra.get("worker_command", [])
        if not isinstance(worker_command, list) or not worker_command:
            raise DriverError("container driver 需要 extra.worker_command 数组")
        network = str(self.config.extra.get("network", "none"))
        if network not in {"none", "bridge", "host"}:
            raise DriverError("非法容器网络模式")
        mount_mode = "rw" if bool(self.config.extra.get("workspace_write", False)) else "ro"
        project_path = Path(str(self.config.extra.get("project_path", ROOT))).resolve()
        if not any(
            _is_relative_to(project_path, root)
            for root in (ROOT.resolve(), store_module.PROJECTS.resolve())
        ):
            raise DriverError("container project_path 必须位于控制平面工作区或项目根目录内")
        target_path_value = str(self.config.extra.get("target_path", "")).strip()
        target_path = Path(target_path_value).resolve() if target_path_value else None
        if target_path is not None and not target_path.exists():
            raise DriverError(f"container target_path 不存在: {target_path}")
        if target_path == project_path:
            raise DriverError("container target_path 不能指向 Sorne 项目控制目录")
        workspace_path = project_path / ".sorne-work"
        evidence_path = project_path / "evidence"
        workspace_path.mkdir(parents=True, exist_ok=True)
        # /workspace may be mounted read-only. Pre-create the target required
        # by the nested evidence bind so Docker never has to mutate that mount.
        (workspace_path / "evidence").mkdir(exist_ok=True)
        evidence_path.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.config.command or find_docker_binary(),
            *docker_base_args(
                network=network,
                cpus=self.config.extra.get("cpus", "2"),
                memory=self.config.extra.get("memory", "2g"),
                pids_limit=self.config.extra.get("pids_limit", 256),
            ),
            "-v", bind_mount(workspace_path, "/workspace", mount_mode),
            "-v", bind_mount(evidence_path, "/workspace/evidence", mount_mode),
            "-w",
            "/workspace",
        ]
        if target_path is not None:
            cmd.extend(["-v", bind_mount(target_path, "/target", "ro")])
        merged = _merged_env(self.config)
        pass_env = self.config.extra.get("pass_env", [])
        if not isinstance(pass_env, list):
            raise DriverError("extra.pass_env 必须是数组")
        for key in pass_env:
            key = str(key)
            if key in merged:
                cmd.extend(["-e", key])
        cmd.append(image)
        cmd.extend(str(item) for item in worker_command)
        return cmd


class MockDriver(BaseDriver):
    def run(self, prompt: str) -> dict[str, Any]:
        payload = self.config.extra.get("payload")
        if payload:
            return payload
        return {"kind": "none", "reason": "mock driver 未配置 payload"}


class AgentComposeDriver(BaseDriver):
    """Container-isolated V3 runtime backed by the local agent-compose build."""

    def run(self, prompt: str) -> dict[str, Any]:
        try:
            return AgentComposeRuntime(
                profile_from_driver_config(self.config),
                timeout=self.timeout,
                cancel_check=self.cancel_check,
                progress_callback=self.progress_callback,
            ).run(prompt)
        except AgentComposeError as exc:
            raise DriverError(str(exc)) from exc


class LocalDockerDriver(BaseDriver):
    """Sorne-owned Docker runtime; no agent-compose daemon is involved."""

    def run(self, prompt: str) -> dict[str, Any]:
        try:
            return LocalDockerRuntime(
                self.config,
                timeout=self.timeout,
                cancel_check=self.cancel_check,
                progress_callback=self.progress_callback,
            ).run(prompt)
        except LocalDockerError as exc:
            raise DriverError(str(exc)) from exc


DRIVERS = {
    "codex": CodexCliDriver,
    "claude-cli": ClaudeCliDriver,
    "openai-compatible": OpenAICompatibleDriver,
    "ollama": OllamaDriver,
    "mock": MockDriver,
    "container": ContainerWorkerDriver,
}


def run_driver(
    config: DriverConfig,
    prompt: str,
    timeout: int = 300,
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    try:
        runtime_mode = canonical_runtime_mode(config.extra.get("runtime_mode"))
    except ValueError as exc:
        raise DriverError(str(exc)) from exc
    if config.type == "mock":
        driver_cls = MockDriver
    elif runtime_mode == "local-cli":
        if config.type == "container":
            raise DriverError("本地 CLI 模式不能选择 Container Worker")
        if config.type not in DRIVERS:
            raise DriverError(f"本地 CLI 模式不支持模型后端: {config.type}")
        driver_cls = DRIVERS[config.type]
    elif runtime_mode == "agent-compose" and (config.type in DRIVERS or config.type in {"claude", "gemini", "opencode"}):
        driver_cls = AgentComposeDriver
    elif runtime_mode == "local-docker" and (config.type in DRIVERS or config.type in {"claude", "gemini", "opencode"}):
        driver_cls = ContainerWorkerDriver if config.type == "container" else LocalDockerDriver
    else:
        raise DriverError(f"未知模型后端: {config.type}")
    payload = driver_cls(
        config,
        timeout=timeout,
        cancel_check=cancel_check,
        progress_callback=progress_callback,
    ).run(prompt)
    return _validate_worker_payload(payload)
