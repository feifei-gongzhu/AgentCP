from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .store import ROOT


OUTPUT_SCHEMA = Path(__file__).resolve().parent / "worker_output_schema.json"
ProgressCallback = Callable[[dict[str, Any]], None]


class DriverError(RuntimeError):
    pass


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


def _extract_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise DriverError("模型输出为空")
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start >= 0 and end > start:
            return json.loads(stripped[start : end + 1])
        raise DriverError(f"模型输出不是合法 JSON: {stripped}")


def _redact_secret(text: str, secret: str | None, limit: int | None = None) -> str:
    """Keep provider credentials out of driver errors and persisted events."""
    redacted = text.replace(secret, "[REDACTED]") if secret else text
    return redacted[:limit] if limit is not None else redacted


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    """Terminate only the process group created for this AgentCP model call."""
    try:
        if os.name == "nt":
            process.terminate()
        else:
            os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
    except ProcessLookupError:
        return


def _safe_stream_value(value: Any, secret: str | None, limit: int = 1200) -> str:
    sensitive_markers = ("key", "token", "secret", "password", "authorization", "cookie")

    def scrub(item: Any, key: str = "") -> Any:
        if any(marker in key.casefold() for marker in sensitive_markers):
            return "[REDACTED]"
        if isinstance(item, dict):
            return {str(name): scrub(child, str(name)) for name, child in item.items()}
        if isinstance(item, list):
            return [scrub(child) for child in item[:30]]
        if isinstance(item, str):
            return _redact_secret(item, secret)
        return item

    if isinstance(value, str):
        text = _redact_secret(value, secret)
    else:
        text = json.dumps(scrub(value), ensure_ascii=False, separators=(",", ":"))
    return text[:limit]


def _claude_stream_events(message: dict[str, Any], secret: str | None) -> tuple[list[dict[str, Any]], str | None]:
    events: list[dict[str, Any]] = []
    final_result: str | None = None
    message_type = str(message.get("type", ""))
    if message_type == "system" and message.get("subtype") == "init":
        tools = [str(item) for item in (message.get("tools") or [])[:80]]
        events.append({
            "event": "stream_started",
            "session_id": str(message.get("session_id", ""))[:200],
            "tools": tools,
        })
    elif message_type in {"assistant", "user"}:
        envelope = message.get("message") or {}
        content = envelope.get("content") or []
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "tool_use":
                events.append({
                    "event": "tool_started",
                    "tool_use_id": str(block.get("id", ""))[:200],
                    "tool_name": str(block.get("name", "unknown"))[:120],
                    "input_summary": _safe_stream_value(block.get("input") or {}, secret),
                })
            elif block_type == "tool_result":
                events.append({
                    "event": "tool_completed",
                    "tool_use_id": str(block.get("tool_use_id", ""))[:200],
                    "is_error": bool(block.get("is_error", False)),
                    "output_summary": _safe_stream_value(block.get("content", ""), secret),
                })
            elif block_type == "text" and message_type == "assistant":
                text = _safe_stream_value(block.get("text", ""), secret, limit=1000).strip()
                if text:
                    events.append({"event": "assistant_update", "text": text})
    elif message_type == "result":
        raw_result = message.get("result")
        if isinstance(raw_result, str):
            final_result = raw_result
        events.append({
            "event": "stream_result",
            "subtype": str(message.get("subtype", ""))[:80],
            "is_error": bool(message.get("is_error", False)),
            "api_error_status": message.get("api_error_status"),
            "terminal_reason": str(message.get("terminal_reason", ""))[:120],
            "duration_ms": message.get("duration_ms"),
            "duration_api_ms": message.get("duration_api_ms"),
            "num_turns": message.get("num_turns"),
            "total_cost_usd": message.get("total_cost_usd"),
        })
    return events, final_result


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

        cmd = [
            self.config.command or "codex",
            "exec",
            "--skip-git-repo-check",
            "--cd",
            str(ROOT),
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
            provider = "agentcp"
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

        result = self._run_cancellable(
            cmd,
            input_text=prompt,
        )
        if result.returncode != 0:
            raise DriverError(
                "Codex Driver 执行失败\n"
                f"returncode={result.returncode}\n"
                f"stderr={result.stderr.strip()}\n"
                f"stdout={result.stdout.strip()}"
            )
        return _extract_json(output_path.read_text(encoding="utf-8"))

    def _run_cancellable(
        self,
        cmd: list[str],
        input_text: str | None = None,
        env_override: dict[str, str] | None = None,
        cwd_override: Path | None = None,
        line_callback: Callable[[str], None] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        process_options: dict[str, Any] = {}
        if os.name == "nt":
            process_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            process_options["start_new_session"] = True
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE if input_text is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env_override or _merged_env(self.config),
            cwd=str(cwd_override) if cwd_override else None,
            **process_options,
        )
        if input_text is not None and process.stdin is not None:
            process.stdin.write(input_text)
            process.stdin.close()
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        reader_threads: list[threading.Thread] = []
        if line_callback is not None:
            def read_stdout() -> None:
                if process.stdout is None:
                    return
                retained = 0
                for line in iter(process.stdout.readline, ""):
                    if retained < 8 * 1024 * 1024:
                        stdout_lines.append(line)
                        retained += len(line)
                    try:
                        line_callback(line)
                    except Exception:
                        continue

            def read_stderr() -> None:
                if process.stderr is None:
                    return
                retained = 0
                for line in iter(process.stderr.readline, ""):
                    if retained < 1024 * 1024:
                        stderr_lines.append(line)
                        retained += len(line)

            reader_threads = [
                threading.Thread(target=read_stdout, daemon=True),
                threading.Thread(target=read_stderr, daemon=True),
            ]
            for reader in reader_threads:
                reader.start()
        deadline = time.monotonic() + self.timeout
        while process.poll() is None:
            if self.cancel_check():
                _terminate_process_tree(process)
                raise DriverError("任务已被调度器取消")
            if time.monotonic() >= deadline:
                _terminate_process_tree(process)
                raise DriverError(f"模型执行超时: {self.timeout}s")
            time.sleep(0.2)
        if line_callback is not None:
            for reader in reader_threads:
                reader.join(timeout=2)
            stdout = "".join(stdout_lines)
            stderr = "".join(stderr_lines)
        else:
            stdout = process.stdout.read() if process.stdout else ""
            stderr = process.stderr.read() if process.stderr else ""
        return subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)

class ClaudeCliDriver(BaseDriver):
    def run(self, prompt: str) -> dict[str, Any]:
        env = _merged_env(self.config)
        source_secret: str | None = None
        if self.config.api_key_env:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", self.config.api_key_env):
                raise DriverError("api_key_env 必须是环境变量名，不能填写真实密钥")
            source_secret = env.get(self.config.api_key_env)
        # AgentCP never inherits Claude/CCSwitch routing from the host process.
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
            env["ANTHROPIC_BASE_URL"] = self.config.base_url.rstrip("/")
        if self.config.api_key_env:
            secret = source_secret
            if not secret:
                raise DriverError(f"缺少环境变量: {self.config.api_key_env}")
            auth_mode = self.config.auth_mode
            if auth_mode == "auto":
                auth_mode = "bearer" if self.config.api_key_env.endswith("AUTH_TOKEN") else "x-api-key"
            if auth_mode == "bearer":
                env["ANTHROPIC_AUTH_TOKEN"] = secret
                env.pop("ANTHROPIC_API_KEY", None)
            elif auth_mode == "x-api-key":
                env["ANTHROPIC_API_KEY"] = secret
                env.pop("ANTHROPIC_AUTH_TOKEN", None)
            else:
                raise DriverError(f"不支持的 Claude 鉴权方式: {auth_mode}")
            if self.config.api_key_env not in {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}:
                env.pop(self.config.api_key_env, None)

        # Frontend/project settings are authoritative. In particular, never load
        # Claude user or local settings into an AgentCP-owned subprocess.
        cmd = [
            self.config.command or "claude",
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
            cwd_override=ROOT,
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

        url = self.config.base_url.rstrip("/") + "/chat/completions"
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
        try:
            project_path.relative_to(ROOT.resolve())
        except ValueError as exc:
            raise DriverError("container project_path 必须位于控制平面工作区内") from exc
        target_path_value = str(self.config.extra.get("target_path", "")).strip()
        target_path = Path(target_path_value).resolve() if target_path_value else None
        if target_path is not None and not target_path.exists():
            raise DriverError(f"container target_path 不存在: {target_path}")
        cmd = [
            self.config.command or "docker",
            "run",
            "--rm",
            "--init",
            "--network",
            network,
            "--cpus",
            str(self.config.extra.get("cpus", "2")),
            "--memory",
            str(self.config.extra.get("memory", "2g")),
            "--pids-limit",
            str(self.config.extra.get("pids_limit", 256)),
            "--security-opt",
            "no-new-privileges:true",
            "--cap-drop",
            "ALL",
            "-v",
            f"{project_path}:/workspace:{mount_mode}",
            "-w",
            "/workspace",
        ]
        if target_path is not None:
            cmd.extend(["-v", f"{target_path}:/target:ro"])
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
    driver_cls = DRIVERS.get(config.type)
    if not driver_cls:
        raise DriverError(f"未知模型后端: {config.type}")
    return driver_cls(
        config,
        timeout=timeout,
        cancel_check=cancel_check,
        progress_callback=progress_callback,
    ).run(prompt)
