from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


ProgressCallback = Callable[[dict[str, Any]], None]
DEFAULT_LOCAL_GUEST_IMAGE = "agent-compose-guest:latest"
VALID_WORKER_KINDS = frozenset({
    "fact", "intent", "plan_batch", "decision", "negative_evidence", "none",
})


class AgentComposeError(RuntimeError):
    pass


@dataclass(frozen=True)
class AgentComposeProfile:
    project_path: Path
    member_name: str
    provider: str
    model: str | None
    base_url: str | None
    auth_mode: str
    api_key: str | None
    sandbox: str
    target_path: Path | None = None
    guest_image: str = DEFAULT_LOCAL_GUEST_IMAGE
    external_host: str | None = None


_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()
_IMAGE_BUILD_LOCK = threading.Lock()


def _runtime_lock(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


def _safe_name(value: str, default: str = "agent") -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip(".-")
    return (normalized or default)[:64]


def _provider_name(backend: str) -> str:
    value = backend.strip().lower()
    if value in {"claude", "claude-cli", "claude-code", "claude_code"}:
        return "claude"
    if value in {"codex", "openai-compatible", "openai", "ollama", "container"}:
        return "codex"
    if value in {"gemini", "opencode"}:
        return value
    raise AgentComposeError(f"agent-compose 不支持模型后端: {backend}")


def _find_binary() -> Path:
    configured = os.environ.get("AGENTCP_AGENT_COMPOSE_BIN", "").strip()
    if configured:
        binary = Path(configured).expanduser().resolve()
    else:
        binary = Path(__file__).resolve().parents[2] / "third_party" / "agent-compose" / "build" / "agent-compose"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise AgentComposeError(
            "当前角色选择了 agent-compose 模式，但未找到可执行文件: " + str(binary)
        )
    return binary


def find_docker_binary() -> str:
    """Resolve Docker independently from a GUI/launchd service's limited PATH."""
    configured = os.environ.get("AGENTCP_DOCKER_BIN", "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
        raise AgentComposeError(f"AGENTCP_DOCKER_BIN 指向的文件不可执行: {candidate}")
    discovered = shutil.which("docker")
    if discovered:
        return str(Path(discovered).resolve())
    for value in (
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ):
        candidate = Path(value)
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
    raise AgentComposeError(
        "未找到本机 Docker CLI；请启动 Docker Desktop，或设置 AGENTCP_DOCKER_BIN"
    )


def docker_image_exists(image: str) -> bool:
    try:
        docker_binary = find_docker_binary()
        result = subprocess.run(
            [docker_binary, "image", "inspect", image],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def ensure_local_guest_image(
    image: str,
    *,
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: ProgressCallback | None = None,
    runtime: str = "local-docker",
) -> None:
    """Ensure the vendored worker image exists before any local Docker run."""
    image = image.strip()
    if not image:
        raise AgentComposeError("本地 Docker 模式缺少 guest image 名称")
    if docker_image_exists(image):
        return
    cancel_check = cancel_check or (lambda: False)
    progress_callback = progress_callback or (lambda _event: None)
    with _IMAGE_BUILD_LOCK:
        if docker_image_exists(image):
            return
        source_root = Path(__file__).resolve().parents[2] / "third_party" / "agent-compose"
        builder = source_root / "scripts" / "build-agent-compose-guest.sh"
        if not builder.is_file():
            raise AgentComposeError(f"本地 guest image 构建脚本不存在: {builder}")
        docker_binary = find_docker_binary()
        try:
            docker = subprocess.run(
                [docker_binary, "info"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=15,
                check=False,
            )
        except FileNotFoundError as exc:
            raise AgentComposeError("本机 Docker CLI 路径已经失效") from exc
        except subprocess.TimeoutExpired as exc:
            raise AgentComposeError("本机 Docker 状态检查超时") from exc
        if docker.returncode != 0:
            raise AgentComposeError(
                "默认运行模式需要本机 Docker，但 Docker 当前不可用: "
                + docker.stderr.strip()[:1000]
            )
        progress_callback({
            "event": "local_guest_image_build_started",
            "runtime": runtime,
            "image": image,
        })
        env = os.environ.copy()
        env["IMAGE_TAG"] = image
        env["PATH"] = str(Path(docker_binary).parent) + os.pathsep + env.get("PATH", "")
        process = subprocess.Popen(
            [str(builder)],
            cwd=str(source_root),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        recent: list[str] = []
        deadline = time.monotonic() + 1800
        assert process.stdout is not None
        output_queue: queue.Queue[str | None] = queue.Queue()

        def read_build_output() -> None:
            assert process.stdout is not None
            for output_line in iter(process.stdout.readline, ""):
                output_queue.put(output_line)
            output_queue.put(None)

        reader = threading.Thread(target=read_build_output, daemon=True)
        reader.start()
        while process.poll() is None:
            try:
                line = output_queue.get(timeout=0.2)
            except queue.Empty:
                line = ""
            if line:
                recent.append(line.rstrip())
                recent = recent[-30:]
                progress_callback({
                    "event": "local_guest_image_build_progress",
                    "runtime": runtime,
                    "image": image,
                    "text": line.rstrip()[:1500],
                })
            if cancel_check():
                _terminate_process(process)
                raise AgentComposeError("本地 guest image 构建已被取消")
            if time.monotonic() >= deadline:
                _terminate_process(process)
                raise AgentComposeError("本地 guest image 构建超过 1800 秒")
        reader.join(timeout=2)
        while not output_queue.empty():
            line = output_queue.get_nowait()
            if line:
                recent.append(line.rstrip())
        if process.returncode != 0 or not docker_image_exists(image):
            raise AgentComposeError(
                "本地 guest image 构建失败:\n" + "\n".join(recent[-30:])[-5000:]
            )
        progress_callback({
            "event": "local_guest_image_build_completed",
            "runtime": runtime,
            "image": image,
        })


def _reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _pid_is_ours(pid: int, binary: Path) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            text=True,
            capture_output=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    command = result.stdout.strip()
    return str(binary) in command and "daemon" in command


def _terminate_owned_daemon(pid: int, binary: Path) -> None:
    if not _pid_is_ours(pid, binary):
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        return
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if not _pid_is_ours(pid, binary):
            return
        time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass


class AgentComposeRuntime:
    """AgentCP's local-Docker execution adapter for agent-compose."""

    def __init__(
        self,
        profile: AgentComposeProfile,
        timeout: int,
        cancel_check: Callable[[], bool] | None = None,
        progress_callback: ProgressCallback | None = None,
    ):
        self.profile = profile
        self.timeout = timeout
        self.cancel_check = cancel_check or (lambda: False)
        self.progress_callback = progress_callback or (lambda _event: None)
        self.binary = _find_binary()
        self.runtime_dir = profile.project_path / ".agent-compose" / _safe_name(profile.member_name)
        self.compose_file = self.runtime_dir / "agent-compose.yml"
        self.metadata_file = self.runtime_dir / "daemon.json"

    @property
    def agent_name(self) -> str:
        return _safe_name(self.profile.member_name)

    @property
    def project_name(self) -> str:
        digest = hashlib.sha256(
            f"{self.profile.project_path.resolve()}:{self.profile.member_name}".encode("utf-8")
        ).hexdigest()[:12]
        return f"agentcp-{digest}"

    def run(self, prompt: str) -> dict[str, Any]:
        if not prompt.strip():
            raise AgentComposeError("提交给 agent-compose 的 Prompt 为空")
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        if not self.profile.external_host:
            self._ensure_local_guest_image()
        with _runtime_lock(self.runtime_dir):
            host = self._ensure_daemon()
            self._write_compose_file()
            self.progress_callback({
                "event": "agent_compose_project_applying",
                "runtime": "agent-compose",
                "project": self.project_name,
                "agent": self.agent_name,
            })
            self._execute_json([
                "--host", host,
                "--file", str(self.compose_file),
                "--json", "up",
            ], timeout=min(180, self.timeout))

        self.progress_callback({
            "event": "agent_compose_run_started",
            "runtime": "agent-compose",
            "project": self.project_name,
            "agent": self.agent_name,
            "provider": self.profile.provider,
            "model": self.profile.model,
        })
        detail = self._run_detached(host, prompt)
        status = str(detail.get("status", "")).lower()
        if status not in {"succeeded", "completed", "success"}:
            reason = str(detail.get("error") or status or "unknown error")
            raise AgentComposeError(f"agent-compose 运行失败: {reason}")
        self.progress_callback({
            "event": "agent_compose_run_completed",
            "runtime": "agent-compose",
            "run_id": detail.get("id"),
            "sandbox_id": detail.get("sandbox_id"),
            "duration_ms": detail.get("duration_ms"),
        })
        return _extract_worker_result(detail)

    def _run_detached(self, host: str, prompt: str) -> dict[str, Any]:
        metadata = self._read_metadata()
        reusable_sandbox = str(metadata.get("sandbox_id") or "").strip()
        output_schema = Path(__file__).with_name("worker_output_schema.json")
        if not output_schema.is_file():
            raise AgentComposeError(f"AgentCP Worker JSON Schema 不存在: {output_schema}")
        run_args = [
            "--host", host,
            "--file", str(self.compose_file),
            "--json", "run", "--keep-running", "--detach",
            self.agent_name,
            "--prompt", prompt,
            "--output-schema-file", str(output_schema),
        ]
        if reusable_sandbox:
            run_args.extend(["--sandbox", reusable_sandbox])
        try:
            started = self._execute_json(run_args, timeout=min(30, self.timeout))
        except AgentComposeError:
            if not reusable_sandbox:
                raise
            self._clear_cached_sandbox()
            sandbox_index = run_args.index("--sandbox")
            del run_args[sandbox_index:sandbox_index + 2]
            started = self._execute_json(run_args, timeout=min(30, self.timeout))
        run_id = str(started.get("id") or "").strip()
        sandbox_id = str(started.get("sandbox_id") or "").strip()
        if not run_id:
            raise AgentComposeError("agent-compose detached run 未返回 run id")
        if sandbox_id:
            self._cache_sandbox(sandbox_id)
        self.progress_callback({
            "event": "agent_compose_run_detached",
            "runtime": "agent-compose",
            "run_id": run_id,
            "sandbox_id": sandbox_id,
            "status": started.get("status"),
        })
        follower, follower_thread = self._follow_logs(host, run_id)
        deadline = time.monotonic() + max(1, self.timeout)
        last_status = ""
        transient_errors = 0
        try:
            while True:
                if self.cancel_check():
                    self._stop_sandbox(host, sandbox_id)
                    self._clear_cached_sandbox()
                    raise AgentComposeError("agent-compose 运行已被 AgentCP 控制器取消")
                if time.monotonic() >= deadline:
                    self._stop_sandbox(host, sandbox_id)
                    self._clear_cached_sandbox()
                    raise AgentComposeError(f"agent-compose 执行超时: {self.timeout}s")
                try:
                    detail = self._execute_json([
                        "--host", host,
                        "--file", str(self.compose_file),
                        "--json", "inspect", "run", run_id,
                    ], timeout=min(5, max(1, self.timeout)))
                    transient_errors = 0
                except AgentComposeError:
                    transient_errors += 1
                    if transient_errors >= 3:
                        raise
                    time.sleep(0.3)
                    continue
                status = str(detail.get("status") or "").strip().lower()
                if status and status != last_status:
                    last_status = status
                    self.progress_callback({
                        "event": "agent_compose_status",
                        "runtime": "agent-compose",
                        "run_id": run_id,
                        "sandbox_id": detail.get("sandbox_id") or sandbox_id,
                        "status": status,
                    })
                if status in {"succeeded", "completed", "success", "failed", "error", "cancelled", "stopped"}:
                    return detail
                time.sleep(0.5)
        finally:
            _terminate_process(follower)
            follower_thread.join(timeout=2)

    def _follow_logs(self, host: str, run_id: str) -> tuple[subprocess.Popen[str], threading.Thread]:
        process = subprocess.Popen(
            [
                str(self.binary), "--host", host,
                "--file", str(self.compose_file),
                "logs", "--run", run_id, "--follow",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            start_new_session=True,
        )

        def read_lines() -> None:
            if process.stdout is None:
                return
            pending: list[str] = []
            pending_length = 0

            def flush_pending() -> None:
                nonlocal pending_length
                text = "".join(pending).strip()
                pending.clear()
                pending_length = 0
                if text:
                    self.progress_callback({
                        "event": "agent_compose_log",
                        "runtime": "agent-compose",
                        "run_id": run_id,
                        "text": text[:2000],
                    })

            try:
                for raw in iter(process.stdout.readline, ""):
                    fragment = _agent_compose_log_fragment(raw, self.profile.api_key)
                    if not fragment:
                        continue
                    tool = re.search(r"\[tool:([^\]]+)\]", fragment)
                    if tool:
                        flush_pending()
                        self.progress_callback({
                            "event": "tool_started",
                            "runtime": "agent-compose",
                            "tool_use_id": f"ac-{run_id}-{time.monotonic_ns()}",
                            "tool_name": tool.group(1)[:120],
                            "input_summary": "等待 agent-compose 工具参数",
                        })
                        continue
                    pending.append(fragment)
                    pending_length += len(fragment)
                    if pending_length >= 480:
                        flush_pending()
            finally:
                flush_pending()

        thread = threading.Thread(target=read_lines, daemon=True)
        thread.start()
        return process, thread

    def _stop_sandbox(self, host: str, sandbox_id: str) -> None:
        if not sandbox_id:
            return
        try:
            self._execute_json([
                "--host", host,
                "--file", str(self.compose_file),
                "--json", "stop", sandbox_id,
            ], timeout=10)
        except AgentComposeError:
            pass

    def _write_compose_file(self) -> None:
        writable = self.profile.sandbox in {"workspace-write", "danger-full-access"}
        volumes: list[dict[str, Any]] = [{
            "type": "bind",
            "source": str(self.profile.project_path.resolve()),
            # /workspace is owned by agent-compose itself. AgentCP state and
            # evidence use a separate mount to avoid duplicate Docker targets.
            "target": "/agentcp-project",
            "read_only": not writable,
        }]
        if self.profile.target_path is not None:
            volumes.append({
                "type": "bind",
                "source": str(self.profile.target_path.resolve()),
                "target": "/target",
                "read_only": True,
            })
        agent: dict[str, Any] = {
            "provider": self.profile.provider,
            "system_prompt": (
                "You are an AgentCP V3 worker. Follow the supplied blackboard methodology, "
                "operate only on the mounted authorized target, use /agentcp-project for project "
                "state and evidence, and return exactly one JSON object."
            ),
            "image": self.profile.guest_image,
            "driver": {"docker": {}},
            "volumes": volumes,
        }
        if self.profile.model:
            agent["model"] = self.profile.model
        document = {"name": self.project_name, "agents": {self.agent_name: agent}}
        # JSON is valid YAML. Keeping one deterministic serializer also makes it
        # straightforward to prove that provider secrets never enter the spec.
        self.compose_file.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _ensure_local_guest_image(self) -> None:
        ensure_local_guest_image(
            self.profile.guest_image,
            cancel_check=self.cancel_check,
            progress_callback=self.progress_callback,
            runtime="agent-compose",
        )

    @staticmethod
    def _docker_image_exists(image: str) -> bool:
        return docker_image_exists(image)

    def _ensure_daemon(self) -> str:
        if self.profile.external_host:
            self._execute_json(
                ["--host", self.profile.external_host, "--json", "status"],
                timeout=10,
            )
            return self.profile.external_host
        if not self.profile.api_key:
            raise AgentComposeError(
                "当前角色没有可用 API Key；V3 会将前端保存的密钥仅注入 agent-compose daemon"
            )
        fingerprint = self._profile_fingerprint()
        metadata = self._read_metadata()
        old_pid = int(metadata.get("pid") or 0)
        old_host = str(metadata.get("host") or "")
        if (
            metadata.get("fingerprint") == fingerprint
            and old_host
            and _pid_is_ours(old_pid, self.binary)
            and self._status_ok(old_host)
        ):
            return old_host

        _terminate_owned_daemon(old_pid, self.binary)
        port = _reserve_port()
        host = f"http://127.0.0.1:{port}"
        socket_digest = hashlib.sha256(str(self.runtime_dir.resolve()).encode("utf-8")).hexdigest()[:16]
        socket_path = f"/private/tmp/agentcp-ac-{socket_digest}.sock"
        env = self._daemon_environment(port, socket_path, fingerprint)
        log_file = (self.runtime_dir / "daemon.log").open("a", encoding="utf-8")
        try:
            process = subprocess.Popen(
                [str(self.binary), "daemon"],
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
                text=True,
            )
        finally:
            log_file.close()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AgentComposeError(
                    f"agent-compose daemon 启动失败，退出码 {process.returncode}"
                )
            if self._status_ok(host):
                self.metadata_file.write_text(json.dumps({
                    "pid": process.pid,
                    "host": host,
                    "fingerprint": fingerprint,
                    "provider": self.profile.provider,
                    "started_at": int(time.time()),
                }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                return host
            time.sleep(0.25)
        _terminate_owned_daemon(process.pid, self.binary)
        raise AgentComposeError("agent-compose daemon 在 15 秒内未就绪")

    def _daemon_environment(self, port: int, socket_path: str, fingerprint: str | None = None) -> dict[str, str]:
        env = os.environ.copy()
        for name in (
            "LLM_API_ENDPOINT", "LLM_API_KEY", "OPENAI_API_KEY", "LLM_MODEL",
            "ANTHROPIC_BASE_URL", "ANTHROPIC_API_ENDPOINT", "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "CLAUDE_MODEL",
        ):
            env.pop(name, None)
        profile_id = (fingerprint or self._profile_fingerprint())[:16]
        env.update({
            "HTTP_LISTEN": f"0.0.0.0:{port}",
            "AGENT_COMPOSE_SOCKET": socket_path,
            "AGENT_COMPOSE_RUNTIME_BASE_URL": f"http://host.docker.internal:{port}",
            # Provider bootstrap is intentionally isolated per credential
            # profile. agent-compose persists daemon-side providers, so reusing
            # one database after a frontend key change would keep the old key.
            "DATA_ROOT": str((self.runtime_dir / "profiles" / profile_id).resolve()),
            "RUNTIME_DRIVER": "docker",
            "DEFAULT_IMAGE": self.profile.guest_image,
        })
        secret = self.profile.api_key or ""
        if self.profile.provider == "claude":
            if self.profile.base_url:
                env["ANTHROPIC_BASE_URL"] = self.profile.base_url.rstrip("/")
            auth_mode = _resolved_anthropic_auth_mode(
                self.profile.auth_mode,
                self.profile.base_url,
            )
            if auth_mode == "bearer":
                env["ANTHROPIC_AUTH_TOKEN"] = secret
            else:
                env["ANTHROPIC_API_KEY"] = secret
            if self.profile.model:
                env["ANTHROPIC_MODEL"] = self.profile.model
                env["CLAUDE_MODEL"] = self.profile.model
        else:
            if self.profile.base_url:
                env["LLM_API_ENDPOINT"] = self.profile.base_url.rstrip("/")
            env["LLM_API_KEY"] = secret
            env["OPENAI_API_KEY"] = secret
            env["LLM_API_PROTOCOL"] = "responses"
            if self.profile.model:
                env["LLM_MODEL"] = self.profile.model
        return env

    def _profile_fingerprint(self) -> str:
        secret_hash = hashlib.sha256((self.profile.api_key or "").encode("utf-8")).hexdigest()
        source = json.dumps({
            "provider": self.profile.provider,
            "model": self.profile.model,
            "base_url": self.profile.base_url,
            "auth_mode": self.profile.auth_mode,
            "guest_image": self.profile.guest_image,
            "sandbox": self.profile.sandbox,
            "target_path": str(self.profile.target_path.resolve()) if self.profile.target_path else None,
            "secret_hash": secret_hash,
        }, sort_keys=True)
        return hashlib.sha256(source.encode("utf-8")).hexdigest()

    def _read_metadata(self) -> dict[str, Any]:
        try:
            value = json.loads(self.metadata_file.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _cache_sandbox(self, sandbox_id: str) -> None:
        metadata = self._read_metadata()
        metadata["sandbox_id"] = sandbox_id
        self.metadata_file.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _clear_cached_sandbox(self) -> None:
        metadata = self._read_metadata()
        if "sandbox_id" not in metadata:
            return
        metadata.pop("sandbox_id", None)
        self.metadata_file.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _status_ok(self, host: str) -> bool:
        try:
            self._execute_json(["--host", host, "--json", "status"], timeout=3)
            return True
        except AgentComposeError:
            return False

    def _execute_json(self, args: list[str], timeout: int) -> dict[str, Any]:
        command = [str(self.binary), *args]
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        deadline = time.monotonic() + max(1, timeout)
        stdout = ""
        stderr = ""
        while True:
            try:
                stdout, stderr = process.communicate(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                pass
            if self.cancel_check():
                _terminate_process(process)
                raise AgentComposeError("agent-compose 运行已被 AgentCP 控制器取消")
            if time.monotonic() >= deadline:
                _terminate_process(process)
                raise AgentComposeError(f"agent-compose 执行超时: {timeout}s")
        if process.returncode != 0:
            raise AgentComposeError(
                f"agent-compose 命令失败 returncode={process.returncode}: "
                + (stderr.strip() or stdout.strip())[:3000]
            )
        try:
            value = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise AgentComposeError(
                "agent-compose 未返回合法 JSON: " + stdout.strip()[:2000]
            ) from exc
        if not isinstance(value, dict):
            raise AgentComposeError("agent-compose JSON 返回值不是对象")
        return value


def profile_from_driver_config(config: Any) -> AgentComposeProfile:
    extra = dict(config.extra or {})
    project_path_value = str(extra.get("project_path", "")).strip()
    if not project_path_value:
        raise AgentComposeError("agent-compose driver 缺少 project_path")
    project_path = Path(project_path_value).resolve()
    if not project_path.is_dir():
        raise AgentComposeError(f"AgentCP 项目目录不存在: {project_path}")
    target_value = str(extra.get("target_path", "")).strip()
    target_path = Path(target_value).resolve() if target_value else None
    if target_path is not None and not target_path.exists():
        raise AgentComposeError(f"目标源码路径不存在: {target_path}")
    api_key = None
    if config.api_key_env:
        api_key = dict(config.env or {}).get(config.api_key_env) or os.environ.get(config.api_key_env)
    external_host = str(extra.get("agent_compose_host", "")).strip() or None
    return AgentComposeProfile(
        project_path=project_path,
        member_name=str(extra.get("member_name") or "agent"),
        provider=_provider_name(config.type),
        model=config.model,
        base_url=config.base_url,
        auth_mode=config.auth_mode,
        api_key=api_key,
        sandbox=config.sandbox,
        target_path=target_path,
        guest_image=str(extra.get("guest_image") or DEFAULT_LOCAL_GUEST_IMAGE),
        external_host=external_host,
    )


def _terminate_process(process: subprocess.Popen[str]) -> None:
    # A log follower commonly exits on its own immediately after the model run.
    # Never let best-effort cleanup overwrite an otherwise successful result.
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)
    except (ProcessLookupError, PermissionError):
        pass


def _extract_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start < 0 or end <= start:
            raise AgentComposeError("模型返回不是合法 JSON") from None
        try:
            value = json.loads(stripped[start:end + 1])
        except json.JSONDecodeError as exc:
            raise AgentComposeError(f"模型返回不是合法 JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise AgentComposeError("模型 JSON 返回值必须是对象")
    return value


def _extract_worker_result(detail: dict[str, Any]) -> dict[str, Any]:
    """Extract the model's final AgentCP payload, never agent-compose metadata."""
    metadata_text = str(detail.get("result_json") or "").strip()
    metadata: dict[str, Any] = {}
    if metadata_text:
        try:
            decoded = json.loads(metadata_text)
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, dict):
            metadata = decoded

    candidates = [
        str(metadata.get("finalText") or "").strip(),
        str(detail.get("output") or "").strip(),
    ]
    for text in [*candidates, str(detail.get("error") or "").strip()]:
        error = _model_api_error(text)
        if error:
            raise AgentComposeError(error)

    # New agent-compose builds expose finalText in result_json. Keep accepting a
    # direct Worker payload for compatibility with tests and external runtimes.
    if metadata.get("kind") in VALID_WORKER_KINDS:
        return metadata
    for text in candidates:
        if not text:
            continue
        try:
            payload = _extract_json(text)
        except AgentComposeError:
            continue
        if payload.get("kind") in VALID_WORKER_KINDS:
            return payload

    raise AgentComposeError(
        "agent-compose 运行结束，但未返回带合法 kind 的 AgentCP Worker JSON"
    )


def _model_api_error(text: str) -> str | None:
    if not text:
        return None
    match = re.search(
        r"API\s+Error:\s*(?:(\d{3})\s*)?([^\r\n]+)",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    status = match.group(1)
    message = match.group(2).strip() or "模型服务返回错误"
    status_text = f"HTTP {status} " if status else ""
    return f"模型 API 调用失败: {status_text}{message}".strip()


def _redact_runtime_text(value: str, secret: str | None) -> str:
    text = value
    if secret:
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(
        r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)((?:api[_-]?key|auth[_-]?token|secret)\s*[:=]\s*)[^\s,}\]]+",
        r"\1[REDACTED]",
        text,
    )
    return text


def _agent_compose_log_fragment(raw: str, secret: str | None) -> str:
    """Remove the repeated runner prefix without destroying token spacing."""
    text = _redact_runtime_text(raw.rstrip("\r\n"), secret)
    return re.sub(r"^[^|\r\n]{1,160}\|", "", text, count=1)


def _resolved_anthropic_auth_mode(auth_mode: str, base_url: str | None) -> str:
    normalized = str(auth_mode or "auto").strip().lower()
    if normalized in {"bearer", "x-api-key"}:
        return normalized
    if normalized != "auto":
        raise AgentComposeError(f"不支持的 Claude 鉴权方式: {auth_mode}")
    # Anthropic's official endpoint uses x-api-key. Most Anthropic-compatible
    # relays use Authorization: Bearer; the frontend can still explicitly
    # override either mode for a non-standard relay.
    endpoint = str(base_url or "https://api.anthropic.com").strip().lower()
    return "x-api-key" if "api.anthropic.com" in endpoint else "bearer"


def shutdown_project_runtimes(project_path: Path) -> int:
    """Stop only agent-compose daemons and sandboxes owned by one project."""
    root = project_path / ".agent-compose"
    if not root.is_dir():
        return 0
    try:
        binary = _find_binary()
    except AgentComposeError:
        return 0
    stopped = 0
    for metadata_file in root.glob("*/daemon.json"):
        try:
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        pid = int(metadata.get("pid") or 0)
        host = str(metadata.get("host") or "").strip()
        compose_file = metadata_file.parent / "agent-compose.yml"
        if host and compose_file.is_file() and _pid_is_ours(pid, binary):
            try:
                subprocess.run(
                    [
                        str(binary), "--host", host, "--file", str(compose_file),
                        "--json", "down",
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=15,
                    check=False,
                )
            except (OSError, subprocess.SubprocessError):
                pass
        if _pid_is_ours(pid, binary):
            _terminate_owned_daemon(pid, binary)
            stopped += 1
    return stopped
