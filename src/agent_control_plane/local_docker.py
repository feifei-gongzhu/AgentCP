from __future__ import annotations

import http.client
import json
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .agent_compose import (
    DEFAULT_LOCAL_GUEST_IMAGE,
    AgentComposeError,
    ensure_local_guest_image,
    find_docker_binary,
    profile_from_driver_config,
)
from .schemas import VALID_WORKER_KINDS
from .platform_process import process_group_options, terminate_process_tree


ProgressCallback = Callable[[dict[str, Any]], None]
RESULT_PREFIX = "__AGENT_RESULT__"
VPN_ROUTED_READ_ONLY_ROLES = frozenset({"profile_mapper", "metacog"})
THIRD_PARTY_CLAUDE_SYSTEM_PROMPT = (
    "You are an autonomous, non-interactive AgentCP worker. Follow the user "
    "prompt as the complete task and policy specification. Do not stop after "
    "describing what you intend to do. When the task requires inspection or "
    "execution, call the available tools immediately and continue until the "
    "task reaches a supported conclusion. Do not emit progress narration as "
    "your final answer. Your final answer must be exactly one JSON object that "
    "matches the supplied JSON schema, with no Markdown or surrounding prose."
)
OPENAI_TOOL_MAX_ROUNDS = 24
OPENAI_TOOL_OUTPUT_LIMIT = 12_000
OPENAI_TOOL_REQUEST_ATTEMPTS = 3
OPENAI_TOOL_REQUEST_TIMEOUT_SECONDS = 120


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
        if self._uses_openai_tool_compatibility():
            return self._run_openai_tool_compatibility(
                prompt,
                image=image,
                runtime_root=runtime_root,
            )
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

    def _uses_openai_tool_compatibility(self) -> bool:
        """Route models whose Anthropic relay drops tool_use to native tools."""

        configured = str(
            self.config.extra.get("claude_tool_compatibility") or "auto"
        ).strip().casefold()
        if configured in {"openai", "openai-tools", "native-openai"}:
            return True
        if configured in {"claude", "anthropic", "off", "disabled"}:
            return False
        model = str(self.profile.model or "").strip().casefold()
        return bool(
            self.profile.provider == "claude"
            and self.profile.base_url
            and model.startswith("grok")
        )

    def _run_openai_tool_compatibility(
        self,
        prompt: str,
        *,
        image: str,
        runtime_root: Path,
    ) -> dict[str, Any]:
        """Run an OpenAI function-calling loop with tools executed in Docker.

        Some gateways expose Grok through both Anthropic and OpenAI protocols
        but lose ``tool_use`` blocks while translating Anthropic Messages.
        Calling the gateway's native OpenAI endpoint preserves tool calls. Only
        the model protocol changes: every command still runs in the same
        capability-dropped, resource-bounded AgentCP guest container.
        """

        schema = json.loads(
            (Path(__file__).resolve().parent / "worker_output_schema.json").read_text(
                encoding="utf-8"
            )
        )
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "Bash",
                    "description": (
                        "Run one bounded shell command inside the isolated "
                        "AgentCP worker container. Use /workspace/evidence for "
                        "evidence and /workspace/.agentcp-work for reusable "
                        "intermediate files."
                    ),
                    "parameters": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "command": {
                                "type": "string",
                                "description": "Shell command to execute.",
                            },
                        },
                        "required": ["command"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "StructuredOutput",
                    "description": (
                        "Submit the final AgentCP Worker payload only after all "
                        "required tool work and evidence writing are complete."
                    ),
                    "parameters": schema,
                },
            },
        ]
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": THIRD_PARTY_CLAUDE_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        self.progress_callback({
            "event": "stream_started",
            "runtime": "local-docker-openai-tools",
            "session_id": "",
            "tools": ["Bash", "StructuredOutput"],
        })
        deadline = time.monotonic() + self.timeout
        for _round in range(OPENAI_TOOL_MAX_ROUNDS):
            if self.cancel_check():
                raise LocalDockerError("任务已被调度器取消")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LocalDockerError(f"本地 Docker 模型执行超时: {self.timeout}s")
            response = self._openai_chat_completion(
                messages,
                tools,
                timeout=max(1.0, remaining),
            )
            choices = response.get("choices") or []
            message = choices[0].get("message") if choices and isinstance(choices[0], dict) else None
            if not isinstance(message, dict):
                raise LocalDockerError("Grok OpenAI 兼容接口未返回 assistant message")
            assistant_message = {
                key: message[key]
                for key in ("role", "content", "tool_calls")
                if key in message
            }
            assistant_message.setdefault("role", "assistant")
            messages.append(assistant_message)
            content = str(message.get("content") or "").strip()
            if content:
                self.progress_callback({
                    "event": "assistant_update",
                    "runtime": "local-docker-openai-tools",
                    "text": _safe_value(content, self.profile.api_key)[:1000],
                })
            tool_calls = message.get("tool_calls") or []
            if not isinstance(tool_calls, list) or not tool_calls:
                try:
                    payload = _extract_final_text(content)
                except LocalDockerError:
                    messages.append({
                        "role": "user",
                        "content": (
                            "You have not completed the worker protocol. Call "
                            "Bash if work remains, or call StructuredOutput with "
                            "the final AgentCP JSON payload now."
                        ),
                    })
                    continue
                self.progress_callback({
                    "event": "stream_result",
                    "runtime": "local-docker-openai-tools",
                    "is_error": False,
                    "num_turns": _round + 1,
                })
                return payload
            for call in tool_calls:
                if not isinstance(call, dict):
                    continue
                call_id = str(call.get("id") or f"tool-{_round}")
                function = call.get("function") or {}
                name = str(function.get("name") or "")
                try:
                    arguments = json.loads(str(function.get("arguments") or "{}"))
                except json.JSONDecodeError:
                    arguments = {}
                if name.casefold() == "structuredoutput":
                    payload = _validate_tool_payload(arguments)
                    self.progress_callback({
                        "event": "stream_result",
                        "runtime": "local-docker-openai-tools",
                        "is_error": False,
                        "num_turns": _round + 1,
                    })
                    return payload
                self.progress_callback({
                    "event": "tool_started",
                    "runtime": "local-docker-openai-tools",
                    "tool_use_id": call_id,
                    "tool_name": name or "unknown",
                    "input_summary": _safe_value(arguments, self.profile.api_key),
                })
                if name.casefold() != "bash":
                    output = f"Unsupported tool: {name}"
                    is_error = True
                else:
                    command = str(arguments.get("command") or "").strip()
                    if not command:
                        output = "Bash command is empty"
                        is_error = True
                    else:
                        output, is_error = self._run_compatibility_bash(
                            command,
                            image=image,
                            runtime_root=runtime_root,
                            deadline=deadline,
                        )
                self.progress_callback({
                    "event": "tool_completed",
                    "runtime": "local-docker-openai-tools",
                    "tool_use_id": call_id,
                    "tool_name": name or "unknown",
                    "is_error": is_error,
                    "output_summary": _safe_value(output, self.profile.api_key),
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": output,
                })
        raise LocalDockerError(
            f"Grok 工具调用超过 {OPENAI_TOOL_MAX_ROUNDS} 轮，未返回 AgentCP Worker JSON"
        )

    def _openai_chat_completion(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        assert self.profile.base_url is not None
        url = self.profile.base_url.rstrip("/") + "/v1/chat/completions"
        body = {
            "model": self.profile.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "temperature": 0,
        }
        request = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.profile.api_key}",
                # Some gateways apply browser-default WAF rules to Python's
                # urllib UA while allowing their documented CLI clients.
                "User-Agent": "claude-cli/2 AgentCP/3.3",
            },
            method="POST",
        )
        deadline = time.monotonic() + timeout
        last_error = "unknown transport error"
        for attempt in range(1, OPENAI_TOOL_REQUEST_ATTEMPTS + 1):
            if self.cancel_check():
                raise LocalDockerError("任务已被调度器取消")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            request_timeout = max(
                1.0,
                min(OPENAI_TOOL_REQUEST_TIMEOUT_SECONDS, remaining),
            )
            try:
                with urllib.request.urlopen(
                    request,
                    timeout=request_timeout,
                ) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("response is not a JSON object")
                return payload
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                last_error = f"HTTP {exc.code} " + _redact(
                    detail,
                    self.profile.api_key,
                )
                if exc.code not in {408, 409, 425, 429} and exc.code < 500:
                    raise LocalDockerError(
                        "Grok OpenAI 工具接口失败: " + last_error
                    ) from exc
            except (
                http.client.RemoteDisconnected,
                urllib.error.URLError,
                TimeoutError,
                ConnectionError,
                json.JSONDecodeError,
                ValueError,
            ) as exc:
                last_error = _redact(str(exc), self.profile.api_key)
            if attempt >= OPENAI_TOOL_REQUEST_ATTEMPTS:
                break
            delay = min(2 ** (attempt - 1), max(0.0, deadline - time.monotonic()))
            self.progress_callback({
                "event": "transport_retry",
                "runtime": "local-docker-openai-tools",
                "attempt": attempt + 1,
                "max_attempts": OPENAI_TOOL_REQUEST_ATTEMPTS,
                "error": last_error[:1000],
            })
            if delay > 0:
                time.sleep(delay)
        raise LocalDockerError(
            "Grok OpenAI 工具接口失败，单次续推请求已重试 "
            f"{OPENAI_TOOL_REQUEST_ATTEMPTS} 次: {last_error}"
        )

    def _run_compatibility_bash(
        self,
        shell_command: str,
        *,
        image: str,
        runtime_root: Path,
        deadline: float,
    ) -> tuple[str, bool]:
        mount_mode = "ro" if self.profile.sandbox == "read-only" else "rw"
        workspace_root = runtime_root / "workspace"
        evidence_root = self.profile.project_path / "evidence"
        work_root = self.profile.project_path / ".agentcp-work"
        for path in (workspace_root, evidence_root, work_root):
            path.mkdir(parents=True, exist_ok=True)
        (workspace_root / "evidence").mkdir(exist_ok=True)
        (workspace_root / ".agentcp-work").mkdir(exist_ok=True)
        command = [
            find_docker_binary(),
            "run", "--rm", "--init",
            "--network", str(self.config.extra.get("network") or "bridge"),
            "--cpus", str(self.config.extra.get("cpus") or "2"),
            "--memory", str(self.config.extra.get("memory") or "2g"),
            "--pids-limit", str(self.config.extra.get("pids_limit") or 256),
            "--security-opt", "no-new-privileges:true",
            "--cap-drop", "ALL",
            "-v", f"{workspace_root}:/workspace:{mount_mode}",
            "-v", f"{evidence_root}:/workspace/evidence:{mount_mode}",
            "-v", f"{work_root}:/workspace/.agentcp-work:{mount_mode}",
            "-w", "/workspace",
        ]
        if self.profile.target_path is not None:
            command.extend(["-v", f"{self.profile.target_path}:/target:ro"])
        command.extend([
            "--entrypoint", "/bin/sh",
            image,
            "-lc", shell_command,
        ])
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            **process_group_options(),
        )
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
        combined = (
            f"exit_code={process.returncode}\n"
            f"stdout:\n{stdout}\n"
            f"stderr:\n{stderr}"
        )
        if len(combined) > OPENAI_TOOL_OUTPUT_LIMIT:
            combined = (
                combined[: OPENAI_TOOL_OUTPUT_LIMIT // 2]
                + "\n... [tool output truncated] ...\n"
                + combined[-OPENAI_TOOL_OUTPUT_LIMIT // 2 :]
            )
        return _redact(combined, self.profile.api_key), process.returncode != 0

    def _command(self, input_root: Path, runtime_root: Path) -> tuple[list[str], dict[str, str]]:
        mount_mode = "ro" if self.profile.sandbox == "read-only" else "rw"
        image = str(self.config.extra.get("guest_image") or DEFAULT_LOCAL_GUEST_IMAGE)
        workspace_root = runtime_root / "workspace"
        evidence_root = self.profile.project_path / "evidence"
        work_root = self.profile.project_path / ".agentcp-work"
        workspace_root.mkdir(parents=True, exist_ok=True)
        # Docker must resolve nested bind targets before the container starts.
        # When /workspace is mounted read-only it cannot create these targets
        # itself, so keep empty mountpoints in the per-member workspace.
        (workspace_root / "evidence").mkdir(exist_ok=True)
        (workspace_root / ".agentcp-work").mkdir(exist_ok=True)
        evidence_root.mkdir(parents=True, exist_ok=True)
        work_root.mkdir(parents=True, exist_ok=True)
        command = [
            find_docker_binary(),
            "run", "--rm", "--init", "-i",
            "--network", str(self.config.extra.get("network") or "bridge"),
            "--cpus", str(self.config.extra.get("cpus") or "2"),
            "--memory", str(self.config.extra.get("memory") or "2g"),
            "--pids-limit", str(self.config.extra.get("pids_limit") or 256),
            "--security-opt", "no-new-privileges:true",
            "--cap-drop", "ALL",
            "-v", f"{workspace_root}:/workspace:{mount_mode}",
            "-v", f"{evidence_root}:/workspace/evidence:{mount_mode}",
            "-v", f"{work_root}:/workspace/.agentcp-work:{mount_mode}",
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
            role = str(self.config.extra.get("role") or "").strip()
            third_party_compatible = bool(
                self.profile.base_url
                and "api.anthropic.com" not in self.profile.base_url.casefold()
            )
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
            if third_party_compatible:
                # Claude Code's full default system prompt is optimized for
                # Anthropic models and includes many Claude-specific agent
                # conventions. OpenAI/xAI/DeepSeek models reached through an
                # Anthropic-compatible relay can otherwise end after narrating
                # a plan without producing tool_use. Replace that prompt with a
                # small provider-neutral agent contract; the complete AgentCP
                # role, task and safety policy remains in the user prompt.
                command.extend([
                    "--system-prompt", THIRD_PARTY_CLAUDE_SYSTEM_PROMPT,
                ])
            if self.profile.sandbox == "read-only":
                if role in VPN_ROUTED_READ_ONLY_ROLES:
                    # Claude WebFetch runs outside the local Docker/VPN route and
                    # cannot reliably reach RFC1918 or HTTP-only assessment
                    # targets. Read-only roles that need direct target
                    # observation may use bounded curl commands inside the
                    # isolated container; project mounts stay read-only and
                    # Docker remains capability-dropped.
                    command.extend([
                        "--permission-mode", "auto",
                        "--tools", "Bash,Read,Glob,Grep,WebFetch,WebSearch",
                    ])
                else:
                    command.extend([
                        "--permission-mode", "plan",
                        "--tools", "Read,Glob,Grep,WebFetch,WebSearch",
                    ])
            else:
                # The guest image deliberately runs as root. Claude Code rejects
                # --dangerously-skip-permissions for root, so use its supported
                # non-interactive permission mode and rely on Docker isolation.
                command.extend([
                    "--permission-mode", "auto",
                    "--tools", "Bash,Read,Glob,Grep,Write,Edit",
                ])
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
            encoding="utf-8",
            errors="replace",
            env=environment,
            **process_group_options(),
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
        cancelled = False
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
                    except LocalDockerError as stream_error:
                        # API 返回错误但 stdout 中已有大量有效数据 —— 尝试恢复
                        partial = _build_partial_payload(stdout_lines)
                        if partial is not None:
                            final_result = json.dumps(partial, ensure_ascii=False)
                            # 排空剩余缓冲后退出主循环
                            try:
                                if process.stdin:
                                    process.stdin.close()
                            except (BrokenPipeError, OSError):
                                pass
                            _drain_queue(output_queue, stdout_lines, stderr_lines, 10)
                            if process.poll() is None:
                                _terminate(process)
                            break
                        if process.poll() is None:
                            _terminate(process)
                        raise stream_error
                    if parsed is not None:
                        final_result = parsed
            # ── 优雅取消 / 超时 ──
            interrupting = (self.cancel_check() or time.monotonic() >= deadline) and process.poll() is None
            if interrupting and not cancelled:
                cancelled = self.cancel_check()
                # 关闭 stdin 告知模型不再有新输入
                try:
                    if process.stdin:
                        process.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
                # 给模型 30 秒宽限期排空当前产出
                grace_deadline = time.monotonic() + 30
                while time.monotonic() < grace_deadline and process.poll() is None:
                    try:
                        drain_item = output_queue.get(timeout=0.5)
                    except queue.Empty:
                        continue
                    if drain_item is None:
                        finished_readers += 1
                        break
                    elif drain_item[1]:
                        src, ln = drain_item
                        (stdout_lines if src == "stdout" else stderr_lines).append(ln)
                        if src == "stdout":
                            try:
                                parsed = self._handle_claude_line(ln)
                            except LocalDockerError:
                                pass
                            if parsed is not None:
                                final_result = parsed
                if process.poll() is None:
                    _terminate(process)
                break
        for reader in readers:
            reader.join(timeout=2)
        writer.join(timeout=2)
        if cancelled:
            # 尝试从已收集的输出中提取部分结果
            partial = None
            if final_result is None and stdout_lines:
                partial = _build_partial_payload(stdout_lines)
            if partial is not None:
                return partial
            # 归档原始输出作为证据
            self.progress_callback({
                "event": "stream_cancelled",
                "runtime": "local-docker",
                "stdout_lines": len(stdout_lines),
                "stderr_lines": len(stderr_lines),
                "had_result": final_result is not None,
            })
            raise LocalDockerError(
                "任务已被用户取消；已归档 "
                f"{len(stdout_lines)} 行 stdout / {len(stderr_lines)} 行 stderr"
            )
        if time.monotonic() >= deadline and final_result is None:
            # 超时但尝试从已有输出恢复
            partial = _build_partial_payload(stdout_lines) if stdout_lines else None
            if partial is not None:
                return partial
            raise LocalDockerError(f"本地 Docker 模型执行超时: {self.timeout}s")
        if process.returncode != 0 and final_result is None:
            # 尝试从已收集输出恢复
            if stdout_lines:
                partial = _build_partial_payload(stdout_lines)
                if partial is not None:
                    return partial
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
        return _extract_claude_worker_payload(final_result, stdout_lines)

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
        elif message_type == "system" and message.get("subtype") == "thinking_tokens":
            # 每 ~10 个 token 或首次触发时推送思考进度
            tokens = int(message.get("estimated_tokens", 0) or 0)
            last = getattr(self, "_last_thinking_push", 0)
            if tokens > 0 and (tokens - last >= 10 or tokens <= 5):
                self._last_thinking_push = tokens
                self.progress_callback({
                    "event": "thinking_progress",
                    "runtime": "local-docker",
                    "estimated_tokens": tokens,
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
                elif block.get("type") == "text" and message_type == "assistant":
                    text = _safe_value(block.get("text") or "", self.profile.api_key).strip()
                    if text:
                        self.progress_callback({
                            "event": "assistant_update",
                            "runtime": "local-docker",
                            "text": text[:1000],
                        })
        elif message_type == "result":
            result = message.get("structured_output", message.get("result"))
            final_text = json.dumps(result, ensure_ascii=False) if isinstance(result, dict) else str(result or "")
            error_detail = ""
            if message.get("is_error"):
                raw_error = message.get("error") or message.get("errors")
                if raw_error:
                    error_detail = (
                        json.dumps(raw_error, ensure_ascii=False)
                        if isinstance(raw_error, (dict, list))
                        else str(raw_error)
                    )
                if not error_detail:
                    error_detail = final_text or str(message.get("subtype") or "")
                error_detail = _redact(error_detail, self.profile.api_key).strip()
                if not error_detail or error_detail in {"error", "failed", "error_during_execution"}:
                    error_detail = "模型服务返回错误，但 Claude CLI 未提供错误详情"
            self.progress_callback({
                "event": "stream_result",
                "runtime": "local-docker",
                "is_error": bool(message.get("is_error", False)),
                "duration_ms": message.get("duration_ms"),
                "num_turns": message.get("num_turns"),
                **({"error": error_detail} if error_detail else {}),
            })
            if message.get("is_error"):
                raise LocalDockerError("模型 API 调用失败: " + error_detail)
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


def _validate_tool_payload(arguments: Any) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise LocalDockerError("StructuredOutput 工具参数不是 JSON 对象")
    return _extract_final_text(json.dumps(arguments, ensure_ascii=False))


def _drain_queue(
    output_queue: queue.Queue[tuple[str, str] | None],
    stdout_lines: list[str],
    stderr_lines: list[str],
    timeout_seconds: float,
) -> None:
    """排空 output_queue 中剩余的行，用于异常恢复前保留缓冲数据."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            item = output_queue.get(timeout=0.3)
        except queue.Empty:
            continue
        if item is None:
            break
        if item[1]:
            src, ln = item
            (stdout_lines if src == "stdout" else stderr_lines).append(ln)


def _recover_fact_from_output(
    final_result: str,
    assistant_text_count: int,
    assistant_tool_use_count: int,
) -> dict[str, Any] | None:
    """当模型做了工具调用但没用 StructuredOutput 时，从返回文本恢复 fact."""
    # 尝试从 assistant response 中提取 JSON
    decoder = json.JSONDecoder()
    best: dict[str, Any] | None = None
    for index, ch in enumerate(final_result):
        if ch != "{":
            continue
        try:
            value, _end = decoder.raw_decode(final_result, index)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("kind"):
            return value
        if isinstance(value, dict) and ("title" in value or "evidence" in value):
            best = value
    if best is not None:
        best.setdefault("kind", "fact")
        best.setdefault("quality_notes", [])
        best["quality_notes"].append("自动从模型文本输出恢复；模型未使用 StructuredOutput 工具")
        return best
    # 没有任何 JSON——把模型输出作为 evidence 打包成 fact
    evidence_snippet = final_result[:6000] if final_result else "(模型输出为空)"
    return {
        "kind": "fact",
        "title": "模型分析产出（自动恢复）",
        "category": "attack_surface",
        "evidence": evidence_snippet,
        "business_impact": "模型完成了工具调用和分析但未输出结构化结果；以下为自动提取的原始输出",
        "reproduction_steps": [
            f"模型调用了 {assistant_tool_use_count} 次工具，"
            f"产生了 {assistant_text_count} 段文本输出"
        ],
        "evidence_path": "",
        "quality_notes": ["自动恢复产物：模型未调用 StructuredOutput，从文本输出重建"],
    }


def _build_partial_payload(stdout_lines: list[str]) -> dict[str, Any] | None:
    """从取消/超时后的 stdout 缓冲中尽力恢复结构化输出."""
    tools_used: list[dict[str, Any]] = []
    last_assistant_text = ""
    last_thinking = ""
    for line in stdout_lines:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(msg, dict):
            continue
        msg_type = str(msg.get("type") or "")
        if msg_type in {"assistant", "user"}:
            content = (msg.get("message") or {}).get("content") or []
            for block in (content if isinstance(content, list) else []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    tools_used.append({
                        "tool": str(block.get("name") or "unknown"),
                        "input": block.get("input"),
                    })
                elif block.get("type") == "tool_result":
                    for tool in tools_used:
                        if "result" not in tool:
                            tool["result"] = str(block.get("content") or "")[:2000]
                            break
                elif block.get("type") == "text":
                    last_assistant_text = str(block.get("text") or "")[:5000]
                elif block.get("type") == "thinking":
                    last_thinking = str(block.get("thinking") or "")[:5000]

    if not tools_used:
        return None

    findings = []
    for tool in tools_used:
        findings.append(
            f"工具: {tool.get('tool','?')}\n"
            f"输入: {json.dumps(tool.get('input'), ensure_ascii=False)[:500]}\n"
            f"输出: {tool.get('result', '无')[:1000]}"
        )

    partial_text = (
        f"[用户取消或超时后的部分恢复结果]\n\n"
        f"模型最后思考:\n{last_thinking[:3000]}\n\n"
        f"模型最后输出:\n{last_assistant_text[:2000]}\n\n"
        f"工具调用记录 ({len(tools_used)} 次):\n"
        + "\n---\n".join(findings)
    )

    return {
        "payload": {
            "kind": "fact",
            "title": "任务中断前部分结果",
            "category": "partial_recovery",
            "evidence": partial_text[:8000],
            "business_impact": "任务被取消/超时；以下为中断前已完成的工具调用和分析摘要",
            "reproduction_steps": [
                f"工具调用 #{i+1}: {t.get('tool','?')} → {str(t.get('result',''))[:300]}"
                for i, t in enumerate(tools_used[:10])
            ],
            "evidence_path": "",
            "quality_notes": ["此为自动恢复的部分结果，未经完整审计闭环验证"],
        }
    }


def _extract_claude_worker_payload(
    final_result: str,
    stdout_lines: list[str],
) -> dict[str, Any]:
    """Recover a valid worker payload from Claude-compatible stream-json.

    Some Anthropic-compatible relays report a successful terminal ``result``
    while leaving ``result``/``structured_output`` empty or rendering the JSON
    only in the preceding assistant message. Claude CLI still exits zero in
    that case. Prefer the canonical terminal result, then recover only from
    explicit assistant text or StructuredOutput tool input in the same stream.
    Every candidate still passes the normal kind allow-list validation.
    """
    candidates: list[tuple[str, str]] = []
    if final_result.strip():
        candidates.append(("result", final_result))

    assistant_text_count = 0
    assistant_tool_use_count = 0
    structured_output_count = 0
    for line in reversed(stdout_lines):
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, dict) or message.get("type") != "assistant":
            continue
        content = (message.get("message") or {}).get("content") or []
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for block in reversed(content if isinstance(content, list) else []):
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text" and str(block.get("text") or "").strip():
                assistant_text_count += 1
                candidates.append(("assistant_text", str(block["text"])))
            elif (
                block_type == "tool_use"
                and str(block.get("name") or "").casefold() == "structuredoutput"
                and isinstance(block.get("input"), dict)
            ):
                assistant_tool_use_count += 1
                structured_output_count += 1
                candidates.append((
                    "structured_output_tool",
                    json.dumps(block["input"], ensure_ascii=False),
                ))
            elif block_type == "tool_use":
                assistant_tool_use_count += 1

    invalid_json_sources: list[str] = []
    invalid_kind_sources: list[str] = []
    for source, candidate in candidates:
        try:
            return _extract_final_text(candidate)
        except LocalDockerError as exc:
            if "带合法 kind" in str(exc):
                invalid_kind_sources.append(source)
            else:
                invalid_json_sources.append(source)

    result_state = "非空" if final_result.strip() else "为空"
    detail = (
        f"terminal result {result_state}；assistant 文本候选 {assistant_text_count} 个；"
        f"工具调用 {assistant_tool_use_count} 个；"
        f"StructuredOutput 候选 {structured_output_count} 个"
    )
    # 模型做了大量工具调用但没有输出 StructuredOutput —— 尝试从文本中恢复
    if assistant_text_count or assistant_tool_use_count:
        recovery = _recover_fact_from_output(final_result, assistant_text_count, assistant_tool_use_count)
        if recovery is not None:
            return recovery
    if invalid_kind_sources and not invalid_json_sources:
        raise LocalDockerError(
            f"模型未返回带合法 kind 的 AgentCP Worker JSON（{detail}）"
        )
    if assistant_text_count and not assistant_tool_use_count:
        raise LocalDockerError(
            f"模型仅返回叙述文本，未执行工具且未输出 AgentCP Worker JSON（{detail}）"
        )
    raise LocalDockerError(f"模型未返回合法的 AgentCP Worker JSON（{detail}）")


def _extract_final_text(final_text: str) -> dict[str, Any]:
    try:
        payload = json.loads(final_text)
    except json.JSONDecodeError as original_error:
        # Compatible providers sometimes wrap the object in prose or emit more
        # than one JSON fragment. Scan complete objects instead of slicing from
        # the first "{" to the last "}", which incorrectly joins fragments.
        decoder = json.JSONDecoder()
        decoded_objects: list[Any] = []
        for index, character in enumerate(final_text):
            if character != "{":
                continue
            try:
                value, _end = decoder.raw_decode(final_text, index)
            except json.JSONDecodeError:
                continue
            decoded_objects.append(value)
            if isinstance(value, dict) and value.get("kind") in VALID_WORKER_KINDS:
                return value
        if not decoded_objects:
            raise LocalDockerError("模型未返回合法的 AgentCP Worker JSON") from original_error
        payload = decoded_objects[-1]
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
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
    terminate_process_tree(process)
