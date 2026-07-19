from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .agent_compose import (
    DEFAULT_LOCAL_GUEST_IMAGE,
    AgentComposeError,
    ensure_local_guest_image,
    find_docker_binary,
    profile_from_driver_config,
)


ProgressCallback = Callable[[dict[str, Any]], None]
RESULT_PREFIX = "__AGENT_RESULT__"
VALID_WORKER_KINDS = frozenset({
    "fact", "intent", "plan_batch", "decision", "negative_evidence", "none",
})


class LocalDockerError(RuntimeError):
    pass


class LocalDockerRuntime:
    """Run one model CLI in an AgentCP-owned Docker container.

    This path does not start or call the agent-compose daemon. It only reuses
    the local guest image's model runtime for deterministic structured output.
    """

    def __init__(
        self,
        config: Any,
        timeout: int,
        cancel_check: Callable[[], bool],
        progress_callback: ProgressCallback,
    ):
        try:
            self.profile = profile_from_driver_config(config)
        except AgentComposeError as exc:
            raise LocalDockerError(str(exc)) from exc
        self.config = config
        self.timeout = timeout
        self.cancel_check = cancel_check
        self.progress_callback = progress_callback

    def run(self, prompt: str) -> dict[str, Any]:
        if not prompt.strip():
            raise LocalDockerError("提交给本地 Docker Worker 的 Prompt 为空")
        if not self.profile.api_key:
            raise LocalDockerError("本地 Docker 模式需要在前端填写会话 API Key")

        image = str(self.config.extra.get("guest_image") or DEFAULT_LOCAL_GUEST_IMAGE)
        try:
            ensure_local_guest_image(
                image,
                cancel_check=self.cancel_check,
                progress_callback=self.progress_callback,
                runtime="local-docker",
            )
        except AgentComposeError as exc:
            raise LocalDockerError(str(exc)) from exc

        runtime_root = self.profile.project_path / ".agentcp-runtime" / _safe_name(self.profile.member_name)
        runtime_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="agentcp-docker-input-") as temporary:
            input_root = Path(temporary)
            (input_root / "prompt.txt").write_text(prompt, encoding="utf-8")
            schema_source = Path(__file__).resolve().parent / "worker_output_schema.json"
            (input_root / "worker_output_schema.json").write_bytes(schema_source.read_bytes())
            try:
                command, environment = self._command(input_root, runtime_root)
            except AgentComposeError as exc:
                raise LocalDockerError(str(exc)) from exc
            return self._execute(command, environment, prompt)

    def _command(self, input_root: Path, runtime_root: Path) -> tuple[list[str], dict[str, str]]:
        mount_mode = "ro" if self.profile.sandbox == "read-only" else "rw"
        image = str(self.config.extra.get("guest_image") or DEFAULT_LOCAL_GUEST_IMAGE)
        command = [
            find_docker_binary(),
            "run", "--rm", "--init", "-i",
            "--network", str(self.config.extra.get("network") or "bridge"),
            "--cpus", str(self.config.extra.get("cpus") or "2"),
            "--memory", str(self.config.extra.get("memory") or "2g"),
            "--pids-limit", str(self.config.extra.get("pids_limit") or 256),
            "--security-opt", "no-new-privileges:true",
            "--cap-drop", "ALL",
            "-v", f"{self.profile.project_path}:/workspace:{mount_mode}",
            "-v", f"{runtime_root}:/agent-state:rw",
            "-v", f"{input_root}:/agent-input:ro",
            "-w", "/workspace",
        ]
        if self.profile.target_path is not None:
            command.extend(["-v", f"{self.profile.target_path}:/target:ro"])

        environment = os.environ.copy()
        provider_env = self._provider_environment()
        provider_env["HOME"] = "/agent-state/home"
        environment.update(provider_env)
        for name in provider_env:
            command.extend(["-e", name])
        if self.profile.provider == "claude":
            schema = json.dumps(
                json.loads((input_root / "worker_output_schema.json").read_text(encoding="utf-8")),
                ensure_ascii=False,
                separators=(",", ":"),
            )
            command.extend([
                "--entrypoint", "/usr/bin/claude",
                image,
                "-p",
                "--no-session-persistence",
                "--setting-sources", "project",
                "--settings", "{}",
                "--strict-mcp-config",
                "--output-format", "stream-json",
                "--verbose",
                "--json-schema", schema,
            ])
            if self.profile.sandbox == "read-only":
                command.extend([
                    "--permission-mode", "plan",
                    "--tools", "Read,Glob,Grep,WebFetch,WebSearch",
                ])
            else:
                # The guest image deliberately runs as root. Claude Code rejects
                # --dangerously-skip-permissions for root, so use its supported
                # non-interactive permission mode and rely on Docker isolation.
                command.extend(["--permission-mode", "auto"])
            if self.profile.model:
                command.extend(["--model", self.profile.model])
            return command, environment
        command.extend([
            "--entrypoint", "/usr/bin/agent-compose-runtime",
            image,
            "prompt",
            "--provider", self.profile.provider,
            "--message-file", "/agent-input/prompt.txt",
            "--state-root", "/agent-state/state",
            "--home", "/agent-state/home",
            "--workspace", "/workspace",
        ])
        # Codex Responses enforces OpenAI's strict-schema subset: every object
        # property must also be listed in `required`. AgentCP's worker protocol is
        # a discriminated union with kind-specific optional fields, so the shared
        # Claude-compatible schema is intentionally not sent to Codex. The final
        # payload is still parsed and kind-validated by _extract_final_text and
        # then passes through AgentCP's deterministic Guardian.
        if self.profile.provider != "codex":
            command.extend([
                "--output-schema-file", "/agent-input/worker_output_schema.json",
            ])
        if self.profile.model:
            command.extend(["--model", self.profile.model])
        return command, environment

    def _provider_environment(self) -> dict[str, str]:
        secret = str(self.profile.api_key or "")
        values = {
            "LLM_API_KEY": secret,
            "AGENTCP_STATELESS_WORKER": "1",
        }
        if self.profile.model:
            values["LLM_MODEL"] = self.profile.model
        if self.profile.base_url:
            values["LLM_API_ENDPOINT"] = self.profile.base_url.rstrip("/")
        if self.profile.provider == "claude":
            if self.profile.base_url:
                values["ANTHROPIC_BASE_URL"] = self.profile.base_url.rstrip("/")
            auth_mode = self.profile.auth_mode
            if auth_mode == "auto":
                auth_mode = "x-api-key" if "api.anthropic.com" in (self.profile.base_url or "").lower() else "bearer"
            if auth_mode == "bearer":
                values["ANTHROPIC_AUTH_TOKEN"] = secret
            elif auth_mode == "x-api-key":
                values["ANTHROPIC_API_KEY"] = secret
            else:
                raise LocalDockerError(f"不支持的 Claude 鉴权方式: {auth_mode}")
        else:
            values["OPENAI_API_KEY"] = secret
            if self.profile.base_url:
                values["OPENAI_BASE_URL"] = self.profile.base_url.rstrip("/")
        return values

    def _execute(self, command: list[str], environment: dict[str, str], prompt: str) -> dict[str, Any]:
        self.progress_callback({
            "event": "runtime_started",
            "runtime": "local-docker",
            "image": str(self.config.extra.get("guest_image") or DEFAULT_LOCAL_GUEST_IMAGE),
        })
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE if self.profile.provider == "claude" else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
            start_new_session=True,
        )
        if self.profile.provider == "claude":
            return self._consume_claude_stream(process, prompt)
        deadline = time.monotonic() + self.timeout
        stdout = ""
        stderr = ""
        while True:
            try:
                stdout, stderr = process.communicate(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                pass
            if self.cancel_check():
                _terminate(process)
                raise LocalDockerError("任务已被调度器取消")
            if time.monotonic() >= deadline:
                _terminate(process)
                raise LocalDockerError(f"本地 Docker 模型执行超时: {self.timeout}s")
        if process.returncode != 0:
            raise LocalDockerError(
                "本地 Docker Worker 执行失败\n"
                f"returncode={process.returncode}\n"
                f"stderr={_redact(stderr, self.profile.api_key)}\n"
                f"stdout={_redact(stdout, self.profile.api_key)}"
            )
        payload = _extract_runtime_payload(stdout)
        self.progress_callback({"event": "stream_result", "runtime": "local-docker", "is_error": False})
        return payload

    def _consume_claude_stream(
        self,
        process: subprocess.Popen[str],
        prompt: str,
    ) -> dict[str, Any]:
        output_queue: queue.Queue[tuple[str, str] | None] = queue.Queue()

        def read_stream(stream: Any, source: str) -> None:
            if stream is not None:
                for line in iter(stream.readline, ""):
                    output_queue.put((source, line))
            output_queue.put(None)

        readers = [
            threading.Thread(target=read_stream, args=(process.stdout, "stdout"), daemon=True),
            threading.Thread(target=read_stream, args=(process.stderr, "stderr"), daemon=True),
        ]
        for reader in readers:
            reader.start()

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        final_result: str | None = None
        prompt_delivery_failed = threading.Event()

        def write_prompt() -> None:
            if process.stdin is None:
                return
            try:
                process.stdin.write(prompt)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                # Keep consuming both streams so the UI receives the real
                # Docker/Claude startup error instead of a generic errno 32.
                prompt_delivery_failed.set()
                try:
                    process.stdin.close()
                except (BrokenPipeError, OSError):
                    pass

        writer = threading.Thread(target=write_prompt, daemon=True)
        writer.start()
        finished_readers = 0
        deadline = time.monotonic() + self.timeout
        while process.poll() is None or finished_readers < len(readers):
            try:
                item = output_queue.get(timeout=0.2)
            except queue.Empty:
                item = ("", "")
            if item is None:
                finished_readers += 1
            elif item[1]:
                source, line = item
                (stdout_lines if source == "stdout" else stderr_lines).append(line)
                if source == "stdout":
                    try:
                        parsed = self._handle_claude_line(line)
                    except LocalDockerError:
                        if process.poll() is None:
                            _terminate(process)
                        raise
                    if parsed is not None:
                        final_result = parsed
            if self.cancel_check() and process.poll() is None:
                _terminate(process)
                raise LocalDockerError("任务已被调度器取消")
            if time.monotonic() >= deadline and process.poll() is None:
                _terminate(process)
                raise LocalDockerError(f"本地 Docker 模型执行超时: {self.timeout}s")
        for reader in readers:
            reader.join(timeout=2)
        writer.join(timeout=2)
        if process.returncode != 0:
            raise LocalDockerError(
                "本地 Docker Claude 执行失败\n"
                f"returncode={process.returncode}\n"
                f"stderr={_redact(''.join(stderr_lines), self.profile.api_key)}\n"
                f"stdout={_redact(''.join(stdout_lines), self.profile.api_key)}"
            )
        if final_result is None:
            if prompt_delivery_failed.is_set():
                raise LocalDockerError(
                    "本地 Docker Claude 在接收 Prompt 前已退出\n"
                    f"stderr={_redact(''.join(stderr_lines), self.profile.api_key)}\n"
                    f"stdout={_redact(''.join(stdout_lines), self.profile.api_key)}"
                )
            raise LocalDockerError("本地 Docker Claude 未返回最终 result 事件")
        return _extract_final_text(final_result)

    def _handle_claude_line(self, line: str) -> str | None:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return None
        if not isinstance(message, dict):
            return None
        message_type = str(message.get("type") or "")
        if message_type == "system" and message.get("subtype") == "init":
            self.progress_callback({
                "event": "stream_started",
                "runtime": "local-docker",
                "session_id": str(message.get("session_id") or "")[:200],
                "tools": [str(item) for item in (message.get("tools") or [])[:80]],
            })
        elif message_type in {"assistant", "user"}:
            content = (message.get("message") or {}).get("content") or []
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    self.progress_callback({
                        "event": "tool_started",
                        "runtime": "local-docker",
                        "tool_use_id": str(block.get("id") or "")[:200],
                        "tool_name": str(block.get("name") or "unknown")[:120],
                        "input_summary": _safe_value(block.get("input") or {}, self.profile.api_key),
                    })
                elif block.get("type") == "tool_result":
                    self.progress_callback({
                        "event": "tool_completed",
                        "runtime": "local-docker",
                        "tool_use_id": str(block.get("tool_use_id") or "")[:200],
                        "is_error": bool(block.get("is_error", False)),
                        "output_summary": _safe_value(block.get("content") or "", self.profile.api_key),
                    })
        elif message_type == "result":
            result = message.get("structured_output", message.get("result"))
            final_text = json.dumps(result, ensure_ascii=False) if isinstance(result, dict) else str(result or "")
            self.progress_callback({
                "event": "stream_result",
                "runtime": "local-docker",
                "is_error": bool(message.get("is_error", False)),
                "duration_ms": message.get("duration_ms"),
                "num_turns": message.get("num_turns"),
            })
            if message.get("is_error"):
                raise LocalDockerError("模型 API 调用失败: " + _redact(final_text, self.profile.api_key))
            return final_text
        return None


def _extract_runtime_payload(stdout: str) -> dict[str, Any]:
    result_line = next(
        (line[len(RESULT_PREFIX):] for line in reversed(stdout.splitlines()) if line.startswith(RESULT_PREFIX)),
        "",
    )
    if not result_line:
        raise LocalDockerError("本地 Docker runtime 未返回 Agent 结果")
    try:
        envelope = json.loads(result_line)
    except json.JSONDecodeError as exc:
        raise LocalDockerError(f"本地 Docker runtime 返回损坏: {exc}") from exc
    final_text = str(envelope.get("finalText") or "").strip()
    api_error = re.search(r"API\s+Error:\s*([^\r\n]+)", final_text, re.IGNORECASE)
    if api_error:
        raise LocalDockerError("模型 API 调用失败: " + api_error.group(1).strip())
    return _extract_final_text(final_text)


def _extract_final_text(final_text: str) -> dict[str, Any]:
    try:
        payload = json.loads(final_text)
    except json.JSONDecodeError:
        # Without Codex strict structured-output mode, tolerate a single JSON
        # object wrapped by a short explanation or Markdown fence. Validation
        # below still rejects protocol metadata and unknown kinds.
        start = final_text.find("{")
        end = final_text.rfind("}")
        if start < 0 or end <= start:
            raise LocalDockerError("模型未返回合法的 AgentCP Worker JSON")
        try:
            payload = json.loads(final_text[start:end + 1])
        except json.JSONDecodeError as exc:
            raise LocalDockerError("模型未返回合法的 AgentCP Worker JSON") from exc
    if not isinstance(payload, dict) or payload.get("kind") not in VALID_WORKER_KINDS:
        raise LocalDockerError("模型未返回带合法 kind 的 AgentCP Worker JSON")
    return payload


def _safe_value(value: Any, secret: str | None) -> str:
    sensitive_markers = ("key", "token", "secret", "password", "authorization", "cookie")

    def scrub(item: Any, key: str = "") -> Any:
        if any(marker in key.casefold() for marker in sensitive_markers):
            return "[REDACTED]"
        if isinstance(item, dict):
            return {str(name): scrub(child, str(name)) for name, child in item.items()}
        if isinstance(item, list):
            return [scrub(child) for child in item[:30]]
        if isinstance(item, str):
            return item.replace(secret, "[REDACTED]") if secret else item
        return item

    text = value if isinstance(value, str) else json.dumps(scrub(value), ensure_ascii=False, separators=(",", ":"))
    return _redact(str(text), secret)[:1200]


def _safe_name(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip(".-")
    return (normalized or "agent")[:64]


def _redact(text: str, secret: str | None) -> str:
    redacted = text.replace(secret, "[REDACTED]") if secret else text
    return _compact_diagnostic(redacted)


def _compact_diagnostic(text: str, limit: int = 4000) -> str:
    """Keep the command context and, crucially, the process failure tail.

    Model CLIs often print a long tool transcript before the actual transport or
    runtime error. Keeping only the first N characters hid the actionable cause
    and made every failure look like the last Bash command had failed.
    """
    if len(text) <= limit:
        return text
    marker = f"\n... [omitted {len(text) - limit} diagnostic characters] ...\n"
    head_size = min(900, max(0, limit - len(marker)))
    tail_size = max(0, limit - len(marker) - head_size)
    return text[:head_size] + marker + text[-tail_size:]


def _terminate(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
    except ProcessLookupError:
        return
