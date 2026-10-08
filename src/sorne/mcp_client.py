"""MCP 客户端（实施方案 §9、§12-P5）：供外部 MCP 注册表做真实健康检查、
工具清单缓存与受控代理调用。

按官方规范实现 stdio（换行分隔 JSON-RPC 子进程）与 Streamable HTTP
（POST + ``Mcp-Session-Id``）两种 transport 的最小完整客户端：
initialize 握手 → notifications/initialized → tools/list / tools/call。

每次操作都是一次独立握手（无连接池）：注册表场景是低频健康检查与
按需代理调用，简单无状态优于长驻子进程管理；超时与取消由调用方注入。
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any

from .mcp_protocol import JSONRPC_VERSION, LATEST_PROTOCOL_VERSION

CLIENT_NAME = "sorne-mcp-client"
CLIENT_VERSION = "1.0"
DEFAULT_TIMEOUT_SECONDS = 15.0


class McpClientError(RuntimeError):
    """外部 MCP 服务器交互失败（连接/握手/协议错误）。"""


@dataclass
class ServerHandshake:
    server_info: dict[str, Any] = field(default_factory=dict)
    protocol_version: str = LATEST_PROTOCOL_VERSION
    session_id: str | None = None


def _next_id() -> int:
    return uuid.uuid4().int % 1_000_000_000


class McpSessionClient:
    """一次会话（一次握手）内的请求器：transport 差异由子类实现。"""

    handshake: ServerHandshake

    def initialize(self) -> ServerHandshake:
        request_id = _next_id()
        response = self._request({
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": "initialize",
            "params": {
                "protocolVersion": LATEST_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": CLIENT_VERSION},
            },
        })
        if "error" in response:
            raise McpClientError(
                f"initialize 失败: {response['error'].get('message')}"
            )
        result = response.get("result") or {}
        self.handshake = ServerHandshake(
            server_info=dict(result.get("serverInfo") or {}),
            protocol_version=str(result.get("protocolVersion") or LATEST_PROTOCOL_VERSION),
            session_id=self._session_id_from_initialize(response),
        )
        # 规范 lifecycle：客户端在 initialize 响应后发送 initialized 通知。
        self._notify({"jsonrpc": JSONRPC_VERSION, "method": "notifications/initialized"})
        return self.handshake

    def list_tools(self) -> list[dict[str, Any]]:
        response = self._request({
            "jsonrpc": JSONRPC_VERSION,
            "id": _next_id(),
            "method": "tools/list",
            "params": {},
        })
        if "error" in response:
            raise McpClientError(f"tools/list 失败: {response['error'].get('message')}")
        tools = (response.get("result") or {}).get("tools")
        if not isinstance(tools, list):
            raise McpClientError("tools/list 响应缺少 tools 数组")
        return tools

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = self._request({
            "jsonrpc": JSONRPC_VERSION,
            "id": _next_id(),
            "method": "tools/call",
            "params": {"name": str(name), "arguments": dict(arguments or {})},
        })
        if "error" in response:
            raise McpClientError(
                f"tools/call {name} 被对端拒绝: {response['error'].get('message')}"
            )
        result = response.get("result") or {}
        if not isinstance(result, dict) or "content" not in result:
            raise McpClientError(f"tools/call {name} 响应缺少 content")
        if result.get("isError"):
            text = " ".join(
                str(item.get("text") or "")
                for item in (result.get("content") or [])
                if isinstance(item, dict)
            )
            raise McpClientError(f"外部工具 {name} 执行失败: {text[:500]}")
        return result

    # ── transport 差异点 ─────────────────────────────────────────────
    def _request(self, message: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def _notify(self, message: dict[str, Any]) -> None:
        raise NotImplementedError

    def _session_id_from_initialize(self, response: dict[str, Any]) -> str | None:
        return None

    def close(self) -> None:
        pass


class StdioMcpClient(McpSessionClient):
    def __init__(
        self,
        command: str,
        args: list[str] | None = None,
        *,
        env_refs: list[str] | None = None,
        cwd: str | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        self._command = str(command)
        self._args = [str(item) for item in (args or [])]
        self._timeout = float(timeout_seconds)
        self._process: subprocess.Popen | None = None
        # env_refs：连接配置引用声明的环境变量名（不存在则忽略，不伪造值）。
        environment = dict(os.environ)
        for name in env_refs or []:
            value = os.environ.get(str(name))
            if value is not None:
                environment[str(name)] = value
        self._env = environment
        self._cwd = cwd or None
        self._pending = 0

    def start(self) -> "StdioMcpClient":
        try:
            self._process = subprocess.Popen(
                [self._command, *self._args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=self._env,
                cwd=self._cwd,
            )
        except OSError as exc:
            raise McpClientError(f"无法启动外部 MCP 进程: {exc}") from exc
        return self

    def _send(self, message: dict[str, Any]) -> None:
        assert self._process is not None and self._process.stdin is not None
        line = json.dumps(message, ensure_ascii=False) + "\n"
        try:
            self._process.stdin.write(line.encode("utf-8"))
            self._process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise McpClientError(
                f"外部 MCP 进程已退出（写 stdin 失败）: {self._stderr_tail() or exc}"
            ) from exc

    def _read_response(self) -> dict[str, Any]:
        assert self._process is not None and self._process.stdout is not None
        while True:
            line = self._process.stdout.readline()
            if not line:
                raise McpClientError(
                    f"外部 MCP 进程关闭了 stdout: {self._stderr_tail()}"
                )
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except json.JSONDecodeError as exc:
                raise McpClientError(
                    f"外部 MCP 进程 stdout 输出了非 JSON 内容: {text[:200]}"
                ) from exc
            if not isinstance(message, dict):
                continue
            if "id" in message and ("result" in message or "error" in message):
                return message
            # 通知/服务端请求跳过（本客户端不承接服务端发起的交互）。

    def _request(self, message: dict[str, Any]) -> dict[str, Any]:
        self._send(message)
        try:
            import threading

            # Python 3.9 无 timeout 参数的 readline；用定时器强杀读阻塞。
            timer = threading.Timer(self._timeout, self._kill)
            timer.start()
            try:
                return self._read_response()
            finally:
                timer.cancel()
        except McpClientError:
            raise
        except Exception as exc:  # noqa: BLE001 —— 统一转成客户端错误
            raise McpClientError(f"与外部 MCP 进程通信失败: {exc}") from exc

    def _notify(self, message: dict[str, Any]) -> None:
        self._send(message)

    def _kill(self) -> None:
        if self._process is not None and self._process.poll() is None:
            self._process.kill()

    def _stderr_tail(self) -> str:
        if self._process is None or self._process.stderr is None:
            return ""
        try:
            import fcntl

            fcntl.fcntl(self._process.stderr.fileno(), fcntl.F_SETFL, os.O_NONBLOCK)
            data = self._process.stderr.read() or b""
            return data.decode("utf-8", errors="replace")[-500:]
        except Exception:  # noqa: BLE001 —— 诊断信息尽力而为
            return ""

    def close(self) -> None:
        if self._process is None:
            return
        try:
            if self._process.stdin and not self._process.stdin.closed:
                self._process.stdin.close()
            try:
                self._process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=3)
        except OSError:
            pass
        finally:
            self._process = None


class HttpMcpClient(McpSessionClient):
    def __init__(
        self,
        url: str,
        *,
        header_env_refs: dict[str, str] | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        self._url = str(url)
        self._timeout = float(timeout_seconds)
        self._session_id: str | None = None
        self._protocol_header: str | None = None
        # header_env_refs：{HTTP 头名: 环境变量名}，运行时解析，不存明文。
        self._header_env_refs = dict(header_env_refs or {})

    def _headers(self, *, with_session: bool) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        for header_name, env_name in self._header_env_refs.items():
            value = os.environ.get(str(env_name))
            if value is not None:
                headers[str(header_name)] = value
        if with_session and self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        if self._protocol_header:
            headers["MCP-Protocol-Version"] = self._protocol_header
        return headers

    def _post(self, message: dict[str, Any], *, with_session: bool) -> tuple[int, dict[str, Any] | None, str | None]:
        body = json.dumps(message, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self._url,
            data=body,
            headers=self._headers(with_session=with_session),
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                raw = response.read(4_000_000)
                return (
                    int(response.status),
                    json.loads(raw.decode("utf-8")) if raw else None,
                    response.headers.get("Mcp-Session-Id"),
                )
        except urllib.error.HTTPError as exc:
            detail = exc.read(2_000).decode("utf-8", errors="replace")
            raise McpClientError(
                f"外部 MCP HTTP 端点返回 {exc.code}: {detail[:300]}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise McpClientError(f"外部 MCP HTTP 端点不可达: {exc}") from exc

    def _request(self, message: dict[str, Any]) -> dict[str, Any]:
        status, payload, _ = self._post(message, with_session=True)
        if status == 202:
            raise McpClientError("外部 MCP 端点把请求当通知处理（202）")
        if payload is None:
            raise McpClientError("外部 MCP 端点返回空响应体")
        return payload

    def _notify(self, message: dict[str, Any]) -> None:
        status, _, _ = self._post(message, with_session=True)
        if status != 202:
            raise McpClientError(f"initialized 通知未被接受（HTTP {status}）")

    def _session_id_from_initialize(self, response: dict[str, Any]) -> str | None:
        return self._session_id

    def initialize(self) -> ServerHandshake:
        request_id = _next_id()
        message = {
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": "initialize",
            "params": {
                "protocolVersion": LATEST_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": CLIENT_VERSION},
            },
        }
        status, payload, session_id = self._post(message, with_session=False)
        if payload is None or "error" in payload:
            raise McpClientError(
                f"initialize 失败: {(payload or {}).get('error', {}).get('message') or status}"
            )
        self._session_id = session_id
        result = payload.get("result") or {}
        self._protocol_header = str(result.get("protocolVersion") or "") or None
        self.handshake = ServerHandshake(
            server_info=dict(result.get("serverInfo") or {}),
            protocol_version=str(result.get("protocolVersion") or LATEST_PROTOCOL_VERSION),
            session_id=session_id,
        )
        self._notify({"jsonrpc": JSONRPC_VERSION, "method": "notifications/initialized"})
        return self.handshake


def handshake_snapshot(client: McpSessionClient) -> dict[str, Any]:
    """一次完整健康检查：握手 + 工具清单（供注册表缓存）。"""
    handshake = client.initialize()
    tools = client.list_tools()
    return {
        "server_info": handshake.server_info,
        "protocol_version": handshake.protocol_version,
        "tools": tools,
    }
