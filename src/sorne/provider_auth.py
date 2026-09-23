"""Anthropic 认证方式与 Provider 基础配置的唯一解析规则。

三种运行模式（local-cli / local-docker / agent-compose）都通过本模块解析
``auth_mode=auto``，保证相同配置得到相同的有效认证方式。各 runtime 保留
自己的异常类型：本模块只负责规则，抛出 ValueError，由调用方包装。

规则（实施规格 3.1）：
- 显式 ``bearer`` / ``x-api-key`` 始终优先；
- ``auto`` 且未配置地址：按官方默认地址解析为 ``x-api-key``；
- ``auto`` 且 URL 解析出的 hostname **精确等于** ``api.anthropic.com``：
  ``x-api-key``（禁止 substring 判断——路径/查询里出现官方域名、或
  ``api.anthropic.com.example.org`` 这类伪装域名都不算官方地址）；
- ``auto`` 且其他合法服务地址：``bearer``；
- 非法 mode 或非法地址：明确报错。
"""

from __future__ import annotations

from urllib.parse import urlsplit


ANTHROPIC_OFFICIAL_HOST = "api.anthropic.com"
ANTHROPIC_AUTH_MODES = frozenset({"bearer", "x-api-key"})


def _hostname(base_url: object) -> str | None:
    raw = str(base_url or "").strip()
    if not raw:
        return None
    candidate = raw if "://" in raw else f"https://{raw}"
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return None
    host = (parsed.hostname or "").strip().casefold()
    return host or None


def resolve_anthropic_auth_mode(auth_mode: object, base_url: object) -> str:
    """Resolve the effective Anthropic auth mode for one credential config."""
    if auth_mode is None:
        mode = "auto"
    else:
        mode = str(auth_mode).strip().lower()
    if mode in ANTHROPIC_AUTH_MODES:
        return mode
    if mode != "auto":
        # 空串、大小写外的拼错值都视为非法配置（None 容忍为 auto）。
        raise ValueError(f"不支持的 Claude 鉴权方式: {auth_mode}")
    raw = str(base_url or "").strip()
    if not raw:
        # 未配置地址：按官方默认端点处理。
        return "x-api-key"
    host = _hostname(raw)
    if host is None:
        raise ValueError(f"非法 Anthropic 服务地址: {base_url}")
    return "x-api-key" if host == ANTHROPIC_OFFICIAL_HOST else "bearer"


def anthropic_secret_env_var(resolved_mode: str) -> str:
    """Map a resolved auth mode to its (mutually exclusive) env var name."""
    if resolved_mode == "bearer":
        return "ANTHROPIC_AUTH_TOKEN"
    if resolved_mode == "x-api-key":
        return "ANTHROPIC_API_KEY"
    raise ValueError(f"未知的 Anthropic 鉴权结果: {resolved_mode}")


def normalize_base_url(base_url: object) -> str:
    """Normalize a provider base URL: strip whitespace and trailing slashes."""
    return str(base_url or "").strip().rstrip("/")
