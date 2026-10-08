"""MCP 协议层（实施方案 §9、§12-P5）：JSON-RPC 2.0 消息、版本协商、
面向调用者的工具描述。

为什么不用官方 ``mcp`` SDK：仓库运行时固定 Python 3.9（pyproject
``requires-python >=3.9``，本机/venv 均为 3.9.6），官方 Python SDK 要求
>=3.10，无法在不破坏仓库 Python 契约的前提下引入。因此按官方规范
（2025-06-18 transports/tools/lifecycle 章）实现协议层：

- stdio：换行分隔的单行 JSON-RPC；stdout 只输出协议消息，日志一律 stderr。
- Streamable HTTP：单端点 POST（application/json 单响应；通知/响应回 202）；
  ``Mcp-Session-Id`` 会话管理；``MCP-Protocol-Version`` 头校验；
  Origin 校验与默认本机监听（安全要求见规范 transports 章）。

协议事实源：https://modelcontextprotocol.io/specification/2025-06-18
（实施时按规范核对；不照抄任何未经验证的第三方实现命令）。
"""

from __future__ import annotations

import json
from typing import Any

from .tool_registry import TOOL_CATALOG, ToolSpec

SORNE_VERSION = "0.0.4"
SERVER_NAME = "sorne"

# 本服务端支持的协议版本（版本协商：请求版本受支持则原样返回，
# 否则返回最新受支持版本，由客户端决定是否继续——规范 lifecycle 章）。
SUPPORTED_PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18")
LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[-1]

# JSON-RPC 2.0 错误码
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
SERVER_NOT_INITIALIZED = -32002

JSONRPC_VERSION = "2.0"


def negotiate_protocol_version(requested: Any) -> str:
    requested = str(requested or "").strip()
    if requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return LATEST_PROTOCOL_VERSION


def make_result(request_id: Any, result: dict[str, Any]) -> str:
    return json.dumps(
        {"jsonrpc": JSONRPC_VERSION, "id": request_id, "result": result},
        ensure_ascii=False,
    )


def make_error(request_id: Any, code: int, message: str) -> str:
    return json.dumps(
        {"jsonrpc": JSONRPC_VERSION, "id": request_id, "error": {"code": code, "message": message}},
        ensure_ascii=False,
    )


def parse_message(raw: str) -> tuple[dict[str, Any] | None, str | None]:
    """解析一条 JSON-RPC 消息；返回 (消息, 错误响应文本)。

    协议层只做形状校验；方法分发在 mcp_server。
    """
    try:
        message = json.loads(raw)
    except json.JSONDecodeError:
        return None, make_error(None, PARSE_ERROR, "Parse error: 消息不是合法 JSON")
    if not isinstance(message, dict):
        return None, make_error(
            None, INVALID_REQUEST, "Invalid Request: 消息必须是 JSON-RPC 单对象",
        )
    if message.get("jsonrpc") != JSONRPC_VERSION:
        return None, make_error(
            message.get("id"), INVALID_REQUEST, "Invalid Request: jsonrpc 必须是 2.0",
        )
    if "method" not in message and "result" not in message and "error" not in message:
        return None, make_error(
            message.get("id"), INVALID_REQUEST,
            "Invalid Request: 缺少 method/result/error",
        )
    return message, None


def is_notification(message: dict[str, Any]) -> bool:
    return "method" in message and "id" not in message


# ── 面向调用者的工具描述（§9：用途/前置/副作用/参数/返回/失败类别）──────

_SIDE_EFFECT_TEXT = {
    "none": "无（只读查询，不改项目状态）",
    "network_readonly": "对外发起只读网络请求；请求/响应证据自动落盘",
    "network_mutating": "可能产生外部副作用（保守按可变更外部状态对待）",
    "state_mutating": "变更项目状态（经 CommitPlan/Outbox/投影器提交链）",
}

_RETURN_TEXT = {
    "project_read": "返回 JSON 对象（列表、计数与摘要字段）",
    "plan_coordination": "返回 JSON 对象（接受/拒绝与关联任务 ID）",
    "scan_collect": "返回扫描结果 JSON（命中、覆盖与证据路径；证据已落盘）",
    "controlled_probe": "返回响应摘要 JSON（body_preview 截断，复核以证据文件为准）",
    "business_commit": "返回 accepted 与提交链消息（只产生候选，不直接确认漏洞）",
    "knowledge": "返回技能卡/目录/路由 JSON",
    "local_aux": "返回读取/写入结果 JSON",
    "external_mcp": "返回外部 MCP 工具的原始结果 JSON（透传，不修饰）",
}

_PREREQUISITE_BY_SIDE_EFFECT = {
    "network_readonly": "目标必须在当前会话绑定项目的授权范围内（scope）且项目已确认授权",
    "network_mutating": "目标必须在授权范围内；外部工具自身的要求见其工具描述",
}

_FAILURE_CATEGORIES = (
    "permission_denied（会话绑定的角色没有该能力，运行时拒绝）"
    "；capability_missing（能力未实现或运行环境缺失，不用假结果代替）"
    "；invalid_arguments（参数不符合 Schema）"
    "；approval_required（高风险动作缺少匹配的人工审批票据）"
    "；tool_error（执行失败，原文在返回文本中，含目标越界/请求失败等）"
)


def caller_facing_description(spec: ToolSpec) -> str:
    """为 MCP 调用者合成六要素工具描述（§9）。

    全部从工具目录单一事实源派生，不手写第二份契约。
    """
    prerequisites = ["会话已显式绑定项目与角色（参数中的项目/角色字段一律被丢弃）"]
    extra = _PREREQUISITE_BY_SIDE_EFFECT.get(spec.side_effects)
    if extra:
        prerequisites.append(extra)

    schema = spec.parameters or {}
    properties = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    if properties:
        params = "; ".join(
            f"{name}（{str(rule.get('type') or 'any')}"
            f"{'，必填' if name in required else ''}"
            f"{'，' + str(rule.get('description')) if rule.get('description') else ''}）"
            for name, rule in properties.items()
        )
    else:
        params = "无参数"

    return (
        f"【用途】{spec.description}\n"
        f"【前置】{'；'.join(prerequisites)}\n"
        f"【副作用】{_SIDE_EFFECT_TEXT.get(spec.side_effects, spec.side_effects)}\n"
        f"【参数】{params}\n"
        f"【返回】{_RETURN_TEXT.get(spec.category, '返回 JSON 文本')}\n"
        f"【失败类别】{_FAILURE_CATEGORIES}"
    )


def mcp_tool_descriptor(spec: ToolSpec) -> dict[str, Any]:
    return {
        "name": spec.callable_name,
        "title": spec.id,
        "description": caller_facing_description(spec),
        "inputSchema": spec.parameters or {"type": "object", "properties": {}},
    }


def descriptor_for_capability(capability_id: str) -> dict[str, Any] | None:
    spec = TOOL_CATALOG.get(capability_id)
    if spec is None or not spec.visible_to_model:
        return None
    return mcp_tool_descriptor(spec)
