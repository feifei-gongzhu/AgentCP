"""外部 MCP 注册表（实施方案 §9、§12-P5）。

注册条目包含 §9 要求的全部字段：``transport``、连接配置引用
（``connection_config_ref``——连接参数存在 ``mcp_servers/connections/``
下的独立文件，秘密只允许环境变量**引用**，绝不落明文）、``enabled``、
``visible_roles``、健康状态（``health``）、工具缓存（``tool_cache``）与
版本（注册结构版本 + 外部服务器版本）。

visible_roles 服务端强制（§9）：

- 角色只来自 ``tool_gateway`` 会话身份（服务端绑定），不接受调用参数；
  ``external_mcp_call`` 的参数 Schema 关闭 additionalProperties，
  模型无法注入 ``role`` 字段。
- 解析按 ``(server_id, tool_name)`` **精确匹配**注册条目：重命名注册 ID、
  伪称别名都无法命中另一个条目——不存在“换个名字绕过 visible_roles”
  的路径。
- 工具是否真实存在以缓存/实时握手结果为准，不用猜测放行。

健康检查与工具缓存刷新是**真实协议交互**（mcp_client：initialize →
notifications/initialized → tools/list），不是标记位。
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from .mcp_client import (
    DEFAULT_TIMEOUT_SECONDS,
    HttpMcpClient,
    McpClientError,
    StdioMcpClient,
)
from .role_registry import get_role
from .schemas import now_iso

REGISTRY_VERSION = 1
INDEX_PATH = ("mcp_servers", "index.json")
CONNECTIONS_DIR = ("mcp_servers", "connections")
VALID_TRANSPORTS = ("stdio", "http")
MAX_TOOLS_CACHED = 512
HEALTH_TIMEOUT_SECONDS = 20.0


class McpRegistryError(RuntimeError):
    pass


def _index_path(store) -> Path:
    return store.path.joinpath(*INDEX_PATH)


def _connections_root(store) -> Path:
    return store.path.joinpath(*CONNECTIONS_DIR)


def _load_entries(store) -> list[dict[str, Any]]:
    path = _index_path(store)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise McpRegistryError(f"外部 MCP 注册表损坏: {exc}") from exc
    if not isinstance(data, list):
        raise McpRegistryError("外部 MCP 注册表格式错误（应为条目数组）")
    return data


def _save_entries(store, entries: list[dict[str, Any]]) -> None:
    path = _index_path(store)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8",
    )


def _load_connection(store, ref: str) -> dict[str, Any]:
    path = _connections_root(store) / f"{ref}.json"
    if not path.is_file():
        raise McpRegistryError(f"连接配置缺失: {ref}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise McpRegistryError(f"连接配置损坏（{ref}）: {exc}") from exc
    return value if isinstance(value, dict) else {}


def _save_connection(store, ref: str, config: dict[str, Any]) -> None:
    root = _connections_root(store)
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{ref}.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8",
    )


def _validate_visible_roles(roles: list[str]) -> list[str]:
    cleaned: list[str] = []
    for role in roles or []:
        role = str(role or "").strip()
        if not role:
            continue
        if get_role(role) is None:
            raise McpRegistryError(
                f"visible_roles 含未知角色: {role}（必须来自 role_registry）"
            )
        cleaned.append(role)
    return sorted(dict.fromkeys(cleaned))


def register_server(
    store,
    *,
    server_id: str,
    name: str,
    transport: str,
    visible_roles: list[str],
    command: str = "",
    args: list[str] | None = None,
    env_refs: list[str] | None = None,
    url: str = "",
    header_env_refs: dict[str, str] | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    enabled: bool = True,
) -> dict[str, Any]:
    """注册/更新一个外部 MCP 服务器（同 ID 覆盖连接配置并保留健康历史字段）。"""
    server_id = str(server_id or "").strip()
    if not server_id or not re.fullmatch(r"[A-Za-z0-9_.\-]{2,64}", server_id):
        raise McpRegistryError(f"服务器 ID 非法: {server_id!r}（2-64 位字母数字._-）")
    if not str(name or "").strip():
        raise McpRegistryError("必须提供服务器名称")
    transport = str(transport or "").strip().lower()
    if transport not in VALID_TRANSPORTS:
        raise McpRegistryError(
            f"transport 只支持 {VALID_TRANSPORTS}（收到 {transport!r}）"
        )
    roles = _validate_visible_roles(visible_roles)
    if not roles:
        raise McpRegistryError("visible_roles 不能为空（至少一个角色可见才会被调用）")

    connection: dict[str, Any] = {"transport": transport}
    if transport == "stdio":
        command = str(command or "").strip()
        if not command:
            raise McpRegistryError("stdio transport 需要 command")
        connection["command"] = command
        connection["args"] = [str(item) for item in (args or [])]
        if env_refs:
            connection["env_refs"] = [str(item) for item in env_refs]
    else:
        url = str(url or "").strip()
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise McpRegistryError(f"http transport 需要 http(s) URL（收到 {url!r}）")
        connection["url"] = url
        if header_env_refs:
            connection["header_env_refs"] = {
                str(key): str(value) for key, value in header_env_refs.items()
            }
    connection["timeout_seconds"] = max(3.0, min(120.0, float(timeout_seconds)))

    entries = _load_entries(store)
    existing = next(
        (item for item in entries if str(item.get("id")) == server_id), None,
    )
    entry = {
        "id": server_id,
        "name": str(name).strip(),
        "transport": transport,
        "connection_config_ref": server_id,
        "enabled": bool(enabled),
        "visible_roles": roles,
        "health": (existing or {}).get("health")
        or {"status": "unknown", "checked_at": None, "detail": "", "latency_ms": None},
        "tool_cache": (existing or {}).get("tool_cache")
        or {"tools": [], "fetched_at": None, "server_name": None,
            "server_version": None, "protocol_version": None},
        "registry_version": REGISTRY_VERSION,
        "registered_at": (existing or {}).get("registered_at") or now_iso(),
        "updated_at": now_iso(),
    }
    _save_connection(store, server_id, connection)
    entries = [
        entry if str(item.get("id")) == server_id else item for item in entries
    ]
    if existing is None:
        entries.append(entry)
    _save_entries(store, entries)
    return entry


def list_servers(store) -> list[dict[str, Any]]:
    return _load_entries(store)


def get_server(store, server_id: str) -> dict[str, Any]:
    server_id = str(server_id or "").strip()
    entry = next(
        (item for item in _load_entries(store) if str(item.get("id")) == server_id),
        None,
    )
    if entry is None:
        raise McpRegistryError(f"外部 MCP 服务器未注册: {server_id}")
    return entry


def set_enabled(store, server_id: str, *, enabled: bool) -> dict[str, Any]:
    entries = _load_entries(store)
    updated: dict[str, Any] | None = None
    for index, item in enumerate(entries):
        if str(item.get("id")) == str(server_id):
            item = dict(item)
            item["enabled"] = bool(enabled)
            item["updated_at"] = now_iso()
            entries[index] = item
            updated = item
            break
    if updated is None:
        raise McpRegistryError(f"外部 MCP 服务器未注册: {server_id}")
    _save_entries(store, entries)
    return updated


def set_visible_roles(store, server_id: str, roles: list[str]) -> dict[str, Any]:
    cleaned = _validate_visible_roles(roles)
    if not cleaned:
        raise McpRegistryError("visible_roles 不能为空")
    entries = _load_entries(store)
    updated: dict[str, Any] | None = None
    for index, item in enumerate(entries):
        if str(item.get("id")) == str(server_id):
            item = dict(item)
            item["visible_roles"] = cleaned
            item["updated_at"] = now_iso()
            entries[index] = item
            updated = item
            break
    if updated is None:
        raise McpRegistryError(f"外部 MCP 服务器未注册: {server_id}")
    _save_entries(store, entries)
    return updated


def remove_server(store, server_id: str) -> dict[str, Any]:
    server_id = str(server_id or "").strip()
    entries = _load_entries(store)
    remaining = [item for item in entries if str(item.get("id")) != server_id]
    if len(remaining) == len(entries):
        raise McpRegistryError(f"外部 MCP 服务器未注册: {server_id}")
    _save_entries(store, remaining)
    config = _connections_root(store) / f"{server_id}.json"
    if config.is_file():
        config.unlink()
    return {"removed": server_id}


def _client_for(entry: dict[str, Any], connection: dict[str, Any]):
    transport = str(entry.get("transport") or connection.get("transport"))
    timeout = float(connection.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS)
    if transport == "stdio":
        return StdioMcpClient(
            connection.get("command") or "",
            list(connection.get("args") or []),
            env_refs=list(connection.get("env_refs") or []),
            timeout_seconds=min(timeout, HEALTH_TIMEOUT_SECONDS),
        )
    return HttpMcpClient(
        connection.get("url") or "",
        header_env_refs=dict(connection.get("header_env_refs") or {}),
        timeout_seconds=min(timeout, HEALTH_TIMEOUT_SECONDS),
    )


def refresh_health(store, server_id: str) -> dict[str, Any]:
    """真实健康检查：完整 MCP 握手 + tools/list，更新 health 与工具缓存。"""
    entry = get_server(store, server_id)
    connection = _load_connection(store, str(entry.get("connection_config_ref")))
    started = time.monotonic()
    try:
        client = _client_for(entry, connection).start() \
            if str(entry.get("transport")) == "stdio" \
            else _client_for(entry, connection)
    except McpClientError as exc:
        return _record_health(store, entry, "unhealthy", str(exc), 0.0, None)
    try:
        handshake = client.initialize()
        tools = client.list_tools()
    except McpClientError as exc:
        return _record_health(store, entry, "unhealthy", str(exc), time.monotonic() - started, None)
    finally:
        client.close()

    latency_ms = int((time.monotonic() - started) * 1000)
    cached_tools = [
        {
            "name": str(tool.get("name") or ""),
            "description": str(tool.get("description") or "")[:2000],
            "inputSchema": tool.get("inputSchema")
            if isinstance(tool.get("inputSchema"), dict) else None,
        }
        for tool in tools[:MAX_TOOLS_CACHED]
        if isinstance(tool, dict) and tool.get("name")
    ]
    server_info = handshake.server_info or {}
    return _record_health(
        store, entry, "healthy",
        f"握手成功；缓存 {len(cached_tools)} 个工具",
        latency_ms,
        {
            "tools": cached_tools,
            "fetched_at": now_iso(),
            "server_name": str(server_info.get("name") or ""),
            "server_version": str(server_info.get("version") or ""),
            "protocol_version": handshake.protocol_version,
        },
    )


def _record_health(
    store,
    entry: dict[str, Any],
    status: str,
    detail: str,
    latency_ms: float,
    tool_cache: dict[str, Any] | None,
) -> dict[str, Any]:
    entries = _load_entries(store)
    updated: dict[str, Any] | None = None
    for index, item in enumerate(entries):
        if str(item.get("id")) == str(entry.get("id")):
            item = dict(item)
            item["health"] = {
                "status": status,
                "checked_at": now_iso(),
                "detail": str(detail)[:600],
                "latency_ms": int(latency_ms * 1000) if latency_ms else None,
            }
            if tool_cache is not None:
                item["tool_cache"] = tool_cache
            item["updated_at"] = now_iso()
            entries[index] = item
            updated = item
            break
    if updated is None:  # pragma: no cover —— 条目刚被删除的竞态
        raise McpRegistryError(f"外部 MCP 服务器未注册: {entry.get('id')}")
    _save_entries(store, entries)
    return updated


def _entry_allows_role(entry: dict[str, Any], role: str) -> None:
    """服务端强制入口：enabled + visible_roles（角色来自网关身份）。"""
    if not bool(entry.get("enabled")):
        raise McpRegistryError(
            f"permission_denied: 外部 MCP 服务器 {entry.get('id')} 已停用"
        )
    visible = {str(item) for item in (entry.get("visible_roles") or [])}
    if role not in visible:
        raise McpRegistryError(
            f"permission_denied: 角色 {role} 不在服务器 {entry.get('id')} 的 "
            f"visible_roles（{sorted(visible)}）中；本调用被服务端拒绝"
        )


def external_tools_for_role(store, role: str) -> list[dict[str, Any]]:
    """列出角色可见的外部工具（供解释/展示；调用仍走 call_external_tool 强制）。"""
    descriptors: list[dict[str, Any]] = []
    for entry in _load_entries(store):
        if not bool(entry.get("enabled")):
            continue
        if role not in {str(item) for item in (entry.get("visible_roles") or [])}:
            continue
        if str(((entry.get("health") or {}).get("status"))) != "healthy":
            continue
        for tool in (entry.get("tool_cache") or {}).get("tools") or []:
            descriptors.append({
                "server_id": str(entry.get("id")),
                "server_name": str(entry.get("name")),
                "tool_name": str(tool.get("name")),
                "description": tool.get("description"),
                "inputSchema": tool.get("inputSchema"),
            })
    return descriptors


def call_external_tool(
    store,
    *,
    role: str,
    server_id: str,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """受控代理调用：解析注册条目 → 服务端角色强制 → 真实 MCP 调用。

    解析按 ``(server_id, tool_name)`` 精确匹配；``role`` 只来自网关会话
    身份（调用参数无法提供）。工具存在性以工具缓存为准，缓存缺失时先做
    一次真实握手刷新（仍然经过同一强制路径）。
    """
    entry = get_server(store, server_id)  # 精确 ID；未注册即拒绝
    _entry_allows_role(entry, role)
    tool_name = str(tool_name or "").strip()
    if not tool_name:
        raise McpRegistryError("tool_name 不能为空")

    cache = (entry.get("tool_cache") or {})
    known = {str(tool.get("name")) for tool in (cache.get("tools") or [])}
    if tool_name not in known:
        refreshed = refresh_health(store, str(entry.get("id")))
        if str((refreshed.get("health") or {}).get("status")) != "healthy":
            raise McpRegistryError(
                f"capability_missing: 服务器 {entry.get('id')} 健康检查失败"
                f"（{(refreshed.get('health') or {}).get('detail')}），"
                "无法调用其工具"
            )
        known = {
            str(tool.get("name"))
            for tool in ((refreshed.get("tool_cache") or {}).get("tools") or [])
        }
        if tool_name not in known:
            raise McpRegistryError(
                f"invalid tool: 服务器 {entry.get('id')} 不提供工具 {tool_name}"
                f"（可用: {sorted(known)[:20]}）"
            )
        entry = refreshed

    if cancel_check and cancel_check():
        raise McpRegistryError("任务已被调度器取消")

    connection = _load_connection(store, str(entry.get("connection_config_ref")))
    started = time.monotonic()
    client = _client_for(entry, connection)
    if str(entry.get("transport")) == "stdio":
        client = client.start()
    try:
        client.initialize()
        result = client.call_tool(tool_name, dict(arguments or {}))
    except McpClientError as exc:
        raise McpRegistryError(f"external call failed: {exc}") from exc
    finally:
        client.close()
    content = [
        item for item in (result.get("content") or []) if isinstance(item, dict)
    ]
    return {
        "server_id": str(entry.get("id")),
        "tool_name": tool_name,
        "content": content,
        "latency_ms": int((time.monotonic() - started) * 1000),
        "note": (
            "结果来自外部 MCP 服务器透传（未修饰）；其证据效力按普通工具输出"
            "对待，进入项目仍需统一提交链。"
        ),
    }
