"""OpenAI-compatible endpoint 构造的统一契约（实施规格 6.7）。

历史现状（两种模式各自拼 URL，行为分叉）：
- drivers.OpenAICompatibleDriver：``base_url + "/chat/completions"``——把
  base_url 当作**API 根**（已包含版本前缀 /v1）；
- local_docker._openai_chat_completion：``base_url + "/v1/chat/completions"``
  ——把 base_url 当作**服务根**（不含版本前缀）。

统一契约：``base_url`` 是服务根地址或已含 ``/v1`` 的 API 根地址。
- 已含 ``/v1``（如 ``https://relay.example.com/v1``）：追加
  ``/chat/completions``；
- 未含版本前缀（如 ``https://relay.example.com``）：追加
  ``/v1/chat/completions``。

两种配置风格在两种运行模式下构造出相同端点；不在网关直接把 chat 路由
暴露在根路径（无 /v1）的非标准中转不再被隐式支持——此类服务需在网关侧
补 /v1 路由（显式契约，替代原先"碰巧能用"的分裂行为）。
"""

from __future__ import annotations

_API_VERSION_SEGMENT = "/v1"
_CHAT_COMPLETIONS_PATH = "/chat/completions"


def openai_chat_completions_url(base_url: object) -> str:
    raw = str(base_url or "").strip().rstrip("/")
    if not raw:
        raise ValueError("openai-compatible base_url 不能为空")
    if raw.endswith(_API_VERSION_SEGMENT):
        return raw + _CHAT_COMPLETIONS_PATH
    return raw + _API_VERSION_SEGMENT + _CHAT_COMPLETIONS_PATH
