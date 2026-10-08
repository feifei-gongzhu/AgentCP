"""Sorne MCP 服务端（实施方案 §9、§12-P5）：对同一 ``tool_gateway`` 做协议
包装，不创建第二套扫描后端（§6.1）。

入口（CLI ``sorne mcp …``）：

- ``sorne mcp stdio --project V --role R``：stdio transport。stdout 只输出
  协议消息（换行分隔 JSON-RPC），日志一律写 stderr（§9）。
- ``sorne mcp serve``：Streamable HTTP transport（规范 2025-06-18）。
  端点 ``/mcp/{vendor}?role=R``；``Mcp-Session-Id`` 会话管理；通知/响应
  回 202；GET 返回 405；DELETE 终止会话；默认只监听 127.0.0.1；
  可选 Bearer Token 与 Origin 校验（§9：身份验证、会话隔离、来源校验、
  生命周期）。

会话绑定（§9 / §13.1-16）：

- 会话在握手时显式绑定（项目, 角色），二者都是**服务端配置**：stdio 来自
  CLI 参数，HTTP 来自端点路径与查询参数；模型/客户端在工具参数里传的
  ``project_id``/``role`` 等字段一律丢弃（沿 tool_gateway 的
  SERVER_AUTHORITY_ARGUMENT_FIELDS）。
- 不存在默认项目：项目/角色缺失或不合法时拒绝建立会话，绝不回落到
  任何默认项目；也不读取 GUI 的当前选中项目（GUI 选中是 webapp 的
  per-request 查询参数，与本服务无关）。
- 每个会话的网关绑定到该项目的 ``ProjectStore``：所有写入只可能落在
  绑定项目（跨项目写入结构性不可达）；HTTP 会话与端点 vendor 绑定，
  换端点复用会话 ID 直接 400。
- 会话角色只允许七角色（origin=seven_role）：迁移期旧角色携带
  compat_bash（任意 Shell 通路），按 §9“不向外直接暴露无限制 shell”
  不对外提供。
"""

from __future__ import annotations

import hmac
import logging
import secrets
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .maintenance import ProjectLocator
from .mcp_protocol import (
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    SERVER_NOT_INITIALIZED,
    SERVER_NAME,
    SORNE_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    descriptor_for_capability,
    is_notification,
    make_error,
    make_result,
    negotiate_protocol_version,
    parse_message,
)
from .role_registry import get_role, role_ids
from .store import ProjectStore
from .tool_gateway import GatewayIdentity, ToolGateway
from .tool_registry import TOOL_CATALOG

logger = logging.getLogger("sorne.mcp")

SESSION_INSTRUCTIONS = (
    "本会话已显式绑定一个 Sorne 项目与一个七角色之一。可见工具 = 角色白名单 "
    "∩ 已实现能力（部署策略严格模式）。所有项目写入经统一提交链 "
    "（CommitPlan/Outbox/投影器）落在绑定项目内；跨项目写入与越权能力调用"
    "会被运行时拒绝。工具参数中的 project_id/role 等服务端字段一律被丢弃。"
)


class McpServerError(RuntimeError):
    pass


@dataclass
class McpSession:
    session_id: str
    vendor: str
    role: str
    member_name: str
    gateway: ToolGateway
    protocol_version: str = ""
    initialized: bool = False
    created_at: float = field(default_factory=time.monotonic)
    last_seen_at: float = field(default_factory=time.monotonic)
    dispatch_lock: threading.Lock = field(default_factory=threading.Lock)

    def visible_tool_names(self) -> set[str]:
        return {
            TOOL_CATALOG[capability_id].callable_name
            for capability_id in self.gateway.granted_capabilities()
            if TOOL_CATALOG[capability_id].visible_to_model
        }


def _validate_binding(vendor: str, role: str) -> tuple[ProjectStore, Any]:
    """会话绑定校验：项目必须存在、角色必须是七角色（无默认回落）。"""
    vendor = str(vendor or "").strip()
    role = str(role or "").strip()
    if not vendor:
        raise McpServerError("MCP 会话必须显式绑定项目（--project / /mcp/{vendor}）；不存在默认项目")
    if not role:
        raise McpServerError(
            "MCP 会话必须显式绑定角色（--role / ?role=）；不提供默认角色"
        )
    try:
        ProjectLocator.project_path(vendor)
    except Exception as exc:  # noqa: BLE001 —— 统一转成会话建立失败
        raise McpServerError(f"项目绑定失败: {exc}") from exc
    spec = get_role(role)
    if spec is None:
        raise McpServerError(
            f"未知角色: {role}（可选: {', '.join(role_ids(origin='seven_role'))}）"
        )
    if spec.origin != "seven_role":
        raise McpServerError(
            f"角色 {role} 是迁移期旧角色（含兼容 Bash 通路），按 §9 不对外提供；"
            f"请使用七角色之一: {', '.join(role_ids(origin='seven_role'))}"
        )
    return ProjectStore(vendor), spec


def create_session(vendor: str, role: str, *, client_name: str = "") -> McpSession:
    store, _spec = _validate_binding(vendor, role)
    member_name = f"mcp:{str(client_name or 'external')[:40]}:{role}"
    identity = GatewayIdentity(
        vendor=store.vendor,
        member_name=member_name,
        role=role,
        strict=True,
    )
    return McpSession(
        session_id=secrets.token_urlsafe(24),
        vendor=store.vendor,
        role=role,
        member_name=member_name,
        gateway=ToolGateway(store, identity),
    )


def handle_message(session: McpSession, raw: str) -> str | None:
    """处理一条 JSON-RPC 消息；返回响应文本（通知返回 None）。"""
    message, error = parse_message(raw)
    if error is not None:
        return error
    if message is None:  # pragma: no cover —— parse_message 保证二选一
        return make_error(None, INVALID_REQUEST, "Invalid Request")
    session.last_seen_at = time.monotonic()

    # 对端响应（本服务端不主动发起请求）：stdio 静默丢弃；HTTP 由传输层回 202。
    if "method" not in message:
        return None

    method = str(message.get("method") or "")
    request_id = message.get("id")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}

    if method == "initialize":
        requested = params.get("protocolVersion")
        session.protocol_version = negotiate_protocol_version(requested)
        client_info = params.get("clientInfo") or {}
        if isinstance(client_info, dict) and client_info.get("name"):
            session.member_name = (
                f"mcp:{str(client_info.get('name'))[:40]}:{session.role}"
            )
            session.gateway.identity.member_name = session.member_name
        session.initialized = True
        logger.info(
            "MCP 会话初始化: project=%s role=%s client=%s protocol=%s",
            session.vendor, session.role, client_info.get("name"),
            session.protocol_version,
        )
        if is_notification(message):
            return None
        return make_result(request_id, {
            "protocolVersion": session.protocol_version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SORNE_VERSION},
            "instructions": SESSION_INSTRUCTIONS,
        })

    if not session.initialized:
        if is_notification(message):
            return None
        return make_error(
            request_id, SERVER_NOT_INITIALIZED,
            "Server not initialized: 请先发送 initialize 请求",
        )

    if is_notification(message):
        # notifications/initialized 等通知：无需响应。
        return None

    if method == "ping":
        return make_result(request_id, {})

    if method == "tools/list":
        cursor = str(params.get("cursor") or "").strip()
        if cursor:
            # 单页返回全部工具；未签发过游标，游标请求得到空页。
            return make_result(request_id, {"tools": []})
        tools = [
            descriptor
            for descriptor in (
                descriptor_for_capability(capability_id)
                for capability_id in sorted(session.gateway.granted_capabilities())
            )
            if descriptor is not None
        ]
        return make_result(request_id, {"tools": tools})

    if method == "tools/call":
        name = str(params.get("name") or "").strip()
        arguments = params.get("arguments")
        if not name:
            return make_error(request_id, INVALID_PARAMS, "Invalid params: 缺少工具名 name")
        if arguments is not None and not isinstance(arguments, dict):
            return make_error(
                request_id, INVALID_PARAMS, "Invalid params: arguments 必须是对象",
            )
        if name not in session.visible_tool_names():
            return make_error(
                request_id, INVALID_PARAMS,
                f"Unknown tool: {name}（不在本会话角色的可见工具集中）",
            )
        with session.dispatch_lock:
            output, is_error = session.gateway.dispatch(name, arguments or {})
        return make_result(request_id, {
            "content": [{"type": "text", "text": output}],
            "isError": bool(is_error),
        })

    return make_error(request_id, METHOD_NOT_FOUND, f"Method not found: {method}")


# ── stdio transport（§9：stdout 只输出协议，日志走 stderr）─────────────

def run_stdio(vendor: str, role: str, *, log_level: str = "info") -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=getattr(logging, str(log_level or "info").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        session = create_session(vendor, role)
    except McpServerError as exc:
        # 无法建立会话：协议尚未开始，错误写 stderr 并以非零退出；
        # 绝不在 stdout 输出非协议内容，也绝不回落到默认项目。
        logger.error("stdio 会话建立失败: %s", exc)
        sys.stderr.write(f"sorne mcp stdio: {exc}\n")
        raise SystemExit(2) from exc
    logger.info(
        "stdio 会话就绪: project=%s role=%s member=%s",
        session.vendor, session.role, session.member_name,
    )
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        response = handle_message(session, text)
        if response is None:
            continue
        # 单行 JSON（规范：消息不得含内嵌换行）。
        sys.stdout.write(response + "\n")
        sys.stdout.flush()


# ── Streamable HTTP transport（规范 2025-06-18）────────────────────────

class McpSessionStore:
    """会话注册表：会话隔离 + 生命周期（TTL 惰性过期 + DELETE 终止）。"""

    def __init__(self, *, ttl_seconds: float = 7200.0):
        self._sessions: dict[str, McpSession] = {}
        self._lock = threading.Lock()
        self._ttl_seconds = float(ttl_seconds)

    def register(self, session: McpSession) -> McpSession:
        with self._lock:
            self._sessions[session.session_id] = session
            return session

    def get(self, session_id: str, *, vendor: str) -> McpSession | None:
        with self._lock:
            self._expire_locked()
            session = self._sessions.get(str(session_id or ""))
            if session is None:
                return None
            if session.vendor != vendor:
                raise McpServerError(
                    f"会话 {session_id[:8]}… 绑定项目 {session.vendor}，"
                    f"不能在端点 /mcp/{vendor} 上复用（跨项目会话拒绝）"
                )
            return session

    def terminate(self, session_id: str) -> bool:
        with self._lock:
            return self._sessions.pop(str(session_id or ""), None) is not None

    def _expire_locked(self) -> None:
        now = time.monotonic()
        expired = [
            session_id for session_id, session in self._sessions.items()
            if now - session.last_seen_at > self._ttl_seconds
        ]
        for session_id in expired:
            logger.info("会话过期回收: %s…", session_id[:8])
            self._sessions.pop(session_id, None)

    def active_count(self) -> int:
        with self._lock:
            return len(self._sessions)


class McpHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        *,
        token: str = "",
        allowed_origins: tuple[str, ...] = (),
        session_ttl_seconds: float = 7200.0,
    ):
        self.mcp_token = str(token or "")
        self.mcp_allowed_origins = tuple(allowed_origins)
        self.mcp_sessions = McpSessionStore(ttl_seconds=session_ttl_seconds)
        super().__init__(address, McpStreamableHandler)


class McpStreamableHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"Sorne-MCP/{SORNE_VERSION}"

    # ── 基础设施 ─────────────────────────────────────────────────
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        logger.info("%s - %s", self.address_string(), fmt % args)

    def _cors_guard(self) -> bool:
        """规范安全要求：校验 Origin 防 DNS rebinding（浏览器来源一律
        显式放行才可访问；本地非浏览器客户端不发 Origin）。"""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if origin in self.server.mcp_allowed_origins:
            return True
        self._plain(403, "Origin 未在允许清单")
        return False

    def _auth_guard(self) -> bool:
        if not self.server.mcp_token:
            return True
        supplied = self.headers.get("Authorization", "")
        if hmac.compare_digest(supplied, f"Bearer {self.server.mcp_token}"):
            return True
        self._plain(401, "缺少或错误的 Bearer Token")
        return False

    def _protocol_version_guard(self) -> bool:
        header = self.headers.get("MCP-Protocol-Version")
        if header and header.strip() not in SUPPORTED_PROTOCOL_VERSIONS:
            self._plain(400, f"不支持的 MCP-Protocol-Version: {header}")
            return False
        return True

    def _plain(self, status: int, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_response(
        self, status: int, body: str, *, session_id: str | None = None,
    ) -> None:
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if session_id:
            self.send_header("Mcp-Session-Id", session_id)
        self.end_headers()
        self.wfile.write(payload)

    def _parse_endpoint(self) -> tuple[str, str] | None:
        parsed = urlparse(self.path)
        parts = [item for item in parsed.path.split("/") if item]
        if len(parts) != 2 or parts[0] != "mcp":
            self._plain(404, "MCP 端点是 /mcp/{vendor}?role=…（项目显式绑定，无默认端点）")
            return None
        vendor = parts[1]
        role = str((parse_qs(parsed.query).get("role") or [""])[0])
        return vendor, role

    # ── HTTP 方法 ────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802 —— http.server 约定
        if not (self._auth_guard() and self._cors_guard()):
            return
        self._plain(405, "本服务端不提供 GET 流（用 POST 发送 JSON-RPC 消息）")

    def do_DELETE(self) -> None:  # noqa: N802
        if not (self._auth_guard() and self._cors_guard()):
            return
        endpoint = self._parse_endpoint()
        if endpoint is None:
            return
        vendor, _role = endpoint
        session_id = self.headers.get("Mcp-Session-Id")
        if not session_id:
            self._plain(400, "缺少 Mcp-Session-Id")
            return
        try:
            session = self.server.mcp_sessions.get(session_id, vendor=vendor)
        except McpServerError as exc:
            self._plain(400, str(exc))
            return
        if session is None:
            self._plain(404, "会话不存在或已终止")
            return
        self.server.mcp_sessions.terminate(session_id)
        self._plain(200, "会话已终止")

    def do_POST(self) -> None:  # noqa: N802
        if not (self._auth_guard() and self._cors_guard() and self._protocol_version_guard()):
            return
        endpoint = self._parse_endpoint()
        if endpoint is None:
            return
        vendor, role = endpoint

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 8_000_000:
            self._json_response(
                400, make_error(None, INVALID_REQUEST, "Invalid Request: 请求体为空或过大"),
            )
            return
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        message, error = parse_message(raw)
        if error is not None or message is None:
            # 规范：无法接受的输入 → HTTP 400 + 无 id 的 JSON-RPC error。
            self._json_response(400, error or make_error(None, INVALID_REQUEST, "Invalid Request"))
            return

        is_initialize = (
            "method" in message
            and str(message.get("method")) == "initialize"
            and not is_notification(message)
        )
        if is_initialize:
            if self.headers.get("Mcp-Session-Id"):
                self._plain(400, "initialize 不能携带已有 Mcp-Session-Id")
                return
            try:
                client_name = str(
                    ((message.get("params") or {}).get("clientInfo") or {}).get("name") or ""
                )
                session = create_session(vendor, role, client_name=client_name)
            except McpServerError as exc:
                self._plain(400, str(exc))
                return
            self.server.mcp_sessions.register(session)
            response = handle_message(session, raw)
            self._json_response(
                200, response or "", session_id=session.session_id,
            )
            return

        # 非 initialize 请求/通知：必须携带会话 ID（规范：缺 400）。
        session_id = self.headers.get("Mcp-Session-Id")
        if not session_id:
            self._plain(400, "缺少 Mcp-Session-Id（先 POST initialize 建立会话）")
            return
        try:
            session = self.server.mcp_sessions.get(session_id, vendor=vendor)
        except McpServerError as exc:
            self._plain(400, str(exc))
            return
        if session is None:
            self._plain(404, "会话不存在或已过期；请重新 initialize")
            return

        response = handle_message(session, raw)
        if response is None:
            # 通知/对端响应：202 Accepted（规范）。
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._json_response(200, response)


def serve(
    *,
    host: str = "127.0.0.1",
    port: int = 8790,
    token: str = "",
    allowed_origins: tuple[str, ...] = (),
    session_ttl_minutes: float = 120.0,
) -> None:
    """启动 Streamable HTTP MCP 服务（默认只监听本机，§9）。"""
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    import ipaddress

    normalized = host.strip().strip("[]").casefold()
    try:
        loopback = normalized == "localhost" or ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        loopback = False
    if not loopback and not token:
        raise McpServerError(
            "非本机回环地址启动 MCP 服务必须提供 --token（或 SORNE_MCP_TOKEN）；"
            "工具网关暴露的是真实扫描与提交能力"
        )
    httpd = McpHttpServer(
        (host, int(port)),
        token=token,
        allowed_origins=tuple(allowed_origins),
        session_ttl_seconds=max(60.0, float(session_ttl_minutes) * 60.0),
    )
    logger.info(
        "MCP Streamable HTTP 服务已启动: http://%s:%s/mcp/{vendor}?role={role}"
        "（认证=%s，允许 Origin=%s）",
        host, port, "开启" if token else "关闭", list(allowed_origins) or "无",
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logger.info("MCP HTTP 服务停止")
    finally:
        httpd.server_close()
