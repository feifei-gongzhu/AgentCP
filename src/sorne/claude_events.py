"""Claude stream-json 消息到标准事件的共享解析（实施规格 6.3）。

同一消息样本经过不同 Adapter 生成相同核心字段；传输、进度节流、
thinking/progress、structured_output 偏好、未知事件兼容等 Adapter 特有
行为留在各自模块（drivers / local_docker）。
"""

from __future__ import annotations

from typing import Any

from .secret_redact import safe_stream_value


def claude_message_events(
    message: dict[str, Any],
    secret: str | None,
) -> tuple[list[dict[str, Any]], str | None]:
    """Parse one Claude stream-json message into standard progress events.

    返回 (events, final_result)。``final_result`` 仅在 ``result`` 消息的
    ``result`` 字段是字符串时非空；``stream_result`` 事件的原始字段
    （subtype/is_error/api_error_status/时长/成本）原样透传，由调用方
    决定如何消费。
    """
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
                    "input_summary": safe_stream_value(block.get("input") or {}, secret),
                })
            elif block_type == "tool_result":
                events.append({
                    "event": "tool_completed",
                    "tool_use_id": str(block.get("tool_use_id", ""))[:200],
                    "is_error": bool(block.get("is_error", False)),
                    "output_summary": safe_stream_value(block.get("content", ""), secret),
                })
            elif block_type == "text" and message_type == "assistant":
                text = safe_stream_value(block.get("text", ""), secret, limit=1000).strip()
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
