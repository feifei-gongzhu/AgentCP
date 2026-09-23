"""Secret 脱敏的共享底层规则（实施规格 6.4）。

不同输出场景（异常文本、流式事件、日志片段）各自保留长度与类型要求；
键名敏感标记与“已知秘密值替换”这一底层规则在本模块唯一维护。
测试使用假密钥，不为验证脱敏打印任何真实凭据。
"""

from __future__ import annotations

import json
from typing import Any


SENSITIVE_KEY_MARKERS = (
    "key", "token", "secret", "password", "authorization", "cookie",
)


def redact_secret(text: str, secret: str | None, limit: int | None = None) -> str:
    """Replace a known secret value, then optionally truncate."""
    redacted = text.replace(secret, "[REDACTED]") if secret else text
    return redacted[:limit] if limit is not None else redacted


def _scrub(item: Any, key: str, secret: str | None) -> Any:
    if any(marker in key.casefold() for marker in SENSITIVE_KEY_MARKERS):
        return "[REDACTED]"
    if isinstance(item, dict):
        return {str(name): _scrub(child, str(name), secret) for name, child in item.items()}
    if isinstance(item, list):
        return [_scrub(child, "", secret) for child in item[:30]]
    if isinstance(item, str):
        return redact_secret(item, secret)
    return item


def safe_stream_value(value: Any, secret: str | None, limit: int = 1200) -> str:
    """Redact a structured or string stream/event value for persistence or UI."""
    if isinstance(value, str):
        text = redact_secret(value, secret)
    else:
        text = json.dumps(_scrub(value, "", secret), ensure_ascii=False, separators=(",", ":"))
    return text[:limit]
