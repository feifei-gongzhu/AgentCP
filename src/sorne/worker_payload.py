"""Worker JSON 提取与错误识别的分层共享实现（实施规格 6.2）。

分四层，各运行模式共用底层，不统一成“扫描到任意 JSON 就当成功”：
1. ``find_json_objects``：从文本找 JSON 候选（raw_decode 完整对象扫描，
   不做首尾大括号切片——那会把多个片段错误拼接）；
2. ``require_json_object``：候选必须是 JSON 对象；
3. ``require_worker_kind``：对象必须带合法 ``kind``（VALID_WORKER_KINDS）；
4. ``parse_api_error``：判定模型服务错误文本。

“是否允许把部分输出恢复为业务结果”是另一层规则：local-docker 的
宽松恢复（_recover_fact_from_output/_build_partial_payload）只保留在其
原场景，本模块不提供也不推广该策略。
"""

from __future__ import annotations

import json
import re
from typing import Any

from .schemas import VALID_WORKER_KINDS


class WorkerPayloadError(ValueError):
    """Structured worker output extraction failure (mode-agnostic)."""


def find_json_objects(text: str) -> list[Any]:
    """Scan complete JSON values (objects first) embedded in free text."""
    stripped = text.strip()
    if not stripped:
        return []
    try:
        return [json.loads(stripped)]
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    found: list[Any] = []
    for index, character in enumerate(stripped):
        if character != "{":
            continue
        try:
            value, _end = decoder.raw_decode(stripped, index)
        except json.JSONDecodeError:
            continue
        found.append(value)
    return found


def require_json_object(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise WorkerPayloadError("模型 JSON 返回值必须是对象")
    return payload


def require_worker_kind(payload: Any) -> dict[str, Any]:
    require_json_object(payload)
    if payload.get("kind") not in VALID_WORKER_KINDS:
        raise WorkerPayloadError("模型未返回带合法 kind 的 Sorne Worker JSON")
    return payload


def extract_worker_json(text: str) -> dict[str, Any]:
    """Strict extraction: prefer a kind-valid object, else the last complete
    object (then enforce kind); never accept arrays/scalars."""
    stripped = text.strip()
    if not stripped:
        raise WorkerPayloadError("模型输出为空")
    candidates = find_json_objects(stripped)
    for value in candidates:
        if isinstance(value, dict) and value.get("kind") in VALID_WORKER_KINDS:
            return value
    if not candidates:
        raise WorkerPayloadError(f"模型输出不是合法 JSON: {stripped}")
    payload = candidates[-1]
    if isinstance(payload, str):
        # 兼容个别中转把 JSON 再包一层字符串。
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise WorkerPayloadError("模型未返回合法的 Sorne Worker JSON") from exc
    return require_worker_kind(payload)


_API_ERROR_PATTERN = re.compile(
    r"API\s+Error:\s*(?:(\d{3})\s*)?([^\r\n]+)", re.IGNORECASE,
)


def parse_api_error(text: str) -> str | None:
    """Recognize provider "API Error: ..." lines; returns a normalized message."""
    if not text:
        return None
    match = _API_ERROR_PATTERN.search(text)
    if not match:
        return None
    status = match.group(1)
    message = match.group(2).strip() or "模型服务返回错误"
    status_text = f"HTTP {status} " if status else ""
    return f"模型 API 调用失败: {status_text}{message}".strip()
