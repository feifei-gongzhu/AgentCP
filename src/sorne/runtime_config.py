"""运行模式与旧配置字段的唯一规范化规则。

收敛此前散落在 team 加载、Web 加载/保存、driver 选择处的四份迁移映射：
- ``host-native`` → ``local-cli``、``ct-agent-compose`` → ``agent-compose``；
- 旧 ``backend`` 字段与新 ``type`` 字段并存时**非空 ``type`` 优先**，缺失时
  回退 ``backend``，两者同步为同一个有效值，避免不同入口选择不同后端。
"""

from __future__ import annotations


RUNTIME_MODE_ALIASES = {
    "host-native": "local-cli",
    "ct-agent-compose": "agent-compose",
}
SUPPORTED_RUNTIME_MODES = frozenset({"local-cli", "local-docker", "agent-compose"})
DEFAULT_RUNTIME_MODE = "local-docker"
DEFAULT_BACKEND = "codex"


def canonical_runtime_mode(mode: object) -> str:
    """Normalize a runtime mode, migrating legacy values; reject unknown ones."""
    raw = str(mode or DEFAULT_RUNTIME_MODE).strip()
    value = RUNTIME_MODE_ALIASES.get(raw, raw)
    if value not in SUPPORTED_RUNTIME_MODES:
        raise ValueError(
            f"未知运行模式: {mode}；支持 local-cli / local-docker / agent-compose"
            "（host-native、ct-agent-compose 为兼容别名自动迁移）"
        )
    return value


def effective_backend(member_type: object, member_backend: object) -> str:
    """Resolve the effective model backend from legacy ``backend``/new ``type``.

    优先级固定：非空 ``type`` > 非空 ``backend`` > 默认 codex。
    """
    typed = str(member_type or "").strip()
    if typed:
        return typed
    legacy = str(member_backend or "").strip()
    return legacy or DEFAULT_BACKEND
