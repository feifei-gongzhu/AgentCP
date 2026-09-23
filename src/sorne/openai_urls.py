"""OpenAI-compatible endpoint 构造契约（实施规格 6.7 / 用户复核问题 8 修订）。

**旧配置含义必须保留**（两种调用场景的历史语义不同）：

- ``api_root``（drivers.OpenAICompatibleDriver / local-cli 的历史行为）：
  ``base_url`` 直接拼 ``/chat/completions``。base_url 是**含自定义路径
  前缀的 API 根**——例如 ``https://relay.example/api`` 请求
  ``https://relay.example/api/chat/completions``，**不会自动加 /v1**。
- ``service_root``（local_docker 兼容回退的历史行为）：``base_url`` 拼
  ``/v1/chat/completions``。base 是服务根地址；若 base 已以 ``/v1``
  结尾则不重复叠加（幂等归一，修复旧实现 ``/v1/v1`` 的缺陷）。

两种场景通过**显式**配置互通：``extra["openai_url_style"]`` 取
``"api_root" | "service_root"``。不做任何隐式改写——未以 /v1 结尾的地址
绝不自动加 /v1，避免破坏自定义路径前缀的中转站。
"""

from __future__ import annotations


_CHAT_COMPLETIONS_PATH = "/chat/completions"
_V1_PREFIX = "/v1"


def openai_chat_completions_url(base_url: object, *, style: str) -> str:
    """Build the chat-completions endpoint under an explicit style contract.

    ``style`` 是必填的显式契约：调用方按自己的历史语义传入
    ``"api_root"``（base 原样 + /chat/completions）或 ``"service_root"``
    （base + /v1/chat/completions；base 已含 /v1 时不叠加）。
    """
    if style not in {"api_root", "service_root"}:
        raise ValueError(
            f"未知 openai_url_style: {style}（支持 api_root / service_root）"
        )
    raw = str(base_url or "").strip().rstrip("/")
    if not raw:
        raise ValueError("openai-compatible base_url 不能为空")
    if style == "api_root":
        return raw + _CHAT_COMPLETIONS_PATH
    if raw.endswith(_V1_PREFIX):
        return raw + _CHAT_COMPLETIONS_PATH
    return raw + _V1_PREFIX + _CHAT_COMPLETIONS_PATH
