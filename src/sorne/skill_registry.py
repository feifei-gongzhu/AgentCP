"""技能注册表（实施方案 §5.2-5.3、§6.1；P0-契约设计 §5-P2）。

家族卡 = 元信息 + 方法正文，落盘在 ``skill_cards/*.json``（结构化配置，
不是提示词里手写的散文）。加载时做四类校验（方案 §5.3“启用前检查”）：

1. **引用可解析**：``references`` 指向的卡片 ID 必须存在；
2. **无循环引用**：references 闭包不得回到自身；
3. **工具真实存在**：``required_capabilities`` 必须在 ``tool_registry``
   目录中（卡片声明的工具不能扩权——网关仍按角色白名单取交集）；
4. **触发特征结构化**：trigger/exclusion 为字符串数组，可被路由器消费。

版本纪律（方案 §5.3“技能在任务开始时固定版本/内容哈希”）：每张卡带
``version``；``content_sha256`` 由注册表按当前内容计算。``snapshot()``
生成任务启动时的固定快照，写入方向载荷；运行中卡片更新不会让旧任务
悄悄换方法（快照里的哈希可用于事后核对）。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


SKILL_CARDS_DIR = Path(__file__).resolve().parent / "skill_cards"

_REQUIRED_META_FIELDS = (
    "id", "version", "title", "description", "roles",
    "required_capabilities", "trigger_features", "preconditions",
    "references", "source", "license",
)

_BODY_SECTIONS = (
    "何时使用", "先看什么证据", "调用哪个已注册能力",
    "怎样解读结果", "怎样排除", "怎样交付", "何时停止",
)


class SkillRegistryError(ValueError):
    """技能卡结构/引用/工具校验失败（注册即拒绝，不留半启用状态）。"""


@dataclass(frozen=True)
class SkillCard:
    id: str
    version: str
    title: str
    description: str
    roles: tuple[str, ...]
    required_capabilities: tuple[str, ...]
    trigger_features: tuple[str, ...]
    exclusion_features: tuple[str, ...]
    preconditions: tuple[str, ...]
    evidence_maturity: str
    priority: int
    references: tuple[str, ...]
    source: str
    license: str
    body: str
    content_sha256: str
    path: str

    def meta(self) -> dict[str, Any]:
        """不含正文的元信息（供路由与快照引用）。"""
        return {
            "skill_id": self.id,
            "version": self.version,
            "title": self.title,
            "description": self.description,
            "roles": list(self.roles),
            "required_capabilities": list(self.required_capabilities),
            "trigger_features": list(self.trigger_features),
            "exclusion_features": list(self.exclusion_features),
            "preconditions": list(self.preconditions),
            "evidence_maturity": self.evidence_maturity,
            "priority": self.priority,
            "references": list(self.references),
            "content_sha256": self.content_sha256,
        }


def _content_digest(card: dict[str, Any]) -> str:
    material = json.dumps(
        {
            key: card.get(key)
            for key in (
                "id", "version", "title", "description", "roles",
                "required_capabilities", "trigger_features",
                "exclusion_features", "preconditions", "evidence_maturity",
                "priority", "references", "body",
            )
        },
        ensure_ascii=False, sort_keys=True,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _string_tuple(raw: Any, *, field_name: str, card_id: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        raise SkillRegistryError(f"技能卡 {card_id} 的 {field_name} 必须是字符串数组")
    return tuple(dict.fromkeys(item.strip() for item in raw if item.strip()))


def load_skill_cards(directory: Path | None = None) -> dict[str, SkillCard]:
    """加载并校验全部技能卡；任何结构/引用错误都直接抛出（不静默跳过）。"""
    from .tool_registry import TOOL_CATALOG

    root = directory or SKILL_CARDS_DIR
    cards: dict[str, SkillCard] = {}
    if not root.is_dir():
        raise SkillRegistryError(f"技能卡目录不存在: {root}")
    for file in sorted(root.glob("*.json")):
        try:
            raw = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SkillRegistryError(f"技能卡 {file.name} 不是合法 JSON: {exc}") from exc
        if not isinstance(raw, dict):
            raise SkillRegistryError(f"技能卡 {file.name} 必须是 JSON 对象")
        missing = [key for key in _REQUIRED_META_FIELDS if key not in raw]
        if missing:
            raise SkillRegistryError(f"技能卡 {file.name} 缺少元字段: {missing}")
        card_id = str(raw.get("id") or "").strip()
        if not card_id:
            raise SkillRegistryError(f"技能卡 {file.name} 缺少 id")
        if card_id in cards:
            raise SkillRegistryError(f"技能卡 ID 重复: {card_id} ({file.name})")
        body = str(raw.get("body") or "")
        if not body.strip():
            raise SkillRegistryError(f"技能卡 {card_id} 正文为空；不允许为凑数量提交空卡")
        missing_sections = [s for s in _BODY_SECTIONS if s not in body]
        if missing_sections:
            raise SkillRegistryError(
                f"技能卡 {card_id} 正文缺少规定小节: {missing_sections}"
            )
        unknown_capabilities = sorted(
            set(_string_tuple(raw.get("required_capabilities"), field_name="required_capabilities", card_id=card_id))
            - set(TOOL_CATALOG)
        )
        if unknown_capabilities:
            raise SkillRegistryError(
                f"技能卡 {card_id} 引用了工具目录中不存在的能力: {unknown_capabilities}"
            )
        cards[card_id] = SkillCard(
            id=card_id,
            version=str(raw.get("version") or "1.0.0"),
            title=str(raw.get("title") or card_id),
            description=str(raw.get("description") or ""),
            roles=_string_tuple(raw.get("roles"), field_name="roles", card_id=card_id),
            required_capabilities=_string_tuple(raw.get("required_capabilities"), field_name="required_capabilities", card_id=card_id),
            trigger_features=_string_tuple(raw.get("trigger_features"), field_name="trigger_features", card_id=card_id),
            exclusion_features=_string_tuple(raw.get("exclusion_features"), field_name="exclusion_features", card_id=card_id),
            preconditions=_string_tuple(raw.get("preconditions"), field_name="preconditions", card_id=card_id),
            evidence_maturity=str(raw.get("evidence_maturity") or "observed"),
            priority=int(raw.get("priority") if raw.get("priority") is not None else 50),
            references=_string_tuple(raw.get("references"), field_name="references", card_id=card_id),
            source=str(raw.get("source") or ""),
            license=str(raw.get("license") or ""),
            body=body,
            content_sha256=_content_digest(raw),
            path=file.name,
        )
    _validate_references(cards)
    return cards


def _validate_references(cards: dict[str, SkillCard]) -> None:
    for card in cards.values():
        missing = [ref for ref in card.references if ref not in cards]
        if missing:
            raise SkillRegistryError(f"技能卡 {card.id} 的 references 不可解析: {missing}")
        # 沿 references 求闭包：回到自身即循环引用。
        closure: set[str] = set()
        stack = list(card.references)
        while stack:
            current = stack.pop()
            if current == card.id:
                raise SkillRegistryError(
                    f"技能卡 {card.id} 存在循环引用（经 references 回到自身）"
                )
            if current in closure or current not in cards:
                continue
            closure.add(current)
            stack.extend(cards[current].references)


_SKILL_CARDS: dict[str, SkillCard] | None = None


def skill_cards() -> dict[str, SkillCard]:
    global _SKILL_CARDS
    if _SKILL_CARDS is None:
        _SKILL_CARDS = load_skill_cards()
    return _SKILL_CARDS


def reload_skill_cards() -> dict[str, SkillCard]:
    global _SKILL_CARDS
    _SKILL_CARDS = None
    return skill_cards()


def get_skill(skill_id: str) -> SkillCard | None:
    return skill_cards().get(str(skill_id or "").strip())


def skill_status(card: SkillCard) -> dict[str, Any]:
    """卡片可用状态：声明的能力未实现时标记 blocked_tool_unavailable，
    并列出缺口（capability_missing 语义，不伪造可用）。"""
    from .tool_registry import effective_tool_spec

    unavailable: list[dict[str, Any]] = []
    for capability in card.required_capabilities:
        spec = effective_tool_spec(capability)
        if spec is None or not spec.available:
            unavailable.append({
                "capability": capability,
                "gap": _capability_gap_text(capability),
            })
    return {
        **card.meta(),
        "status": "active" if not unavailable else "blocked_tool_unavailable",
        "unavailable_capabilities": unavailable,
    }


def _capability_gap_text(capability_id: str) -> str:
    from .tool_registry import capability_gap

    return capability_gap(capability_id)


def snapshot(skill_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    """任务启动时的技能固定快照（版本+内容哈希；方案 §5.3）。"""
    result: dict[str, dict[str, Any]] = {}
    for skill_id in skill_ids:
        card = get_skill(skill_id)
        if card is None:
            result[str(skill_id)] = {"missing": True}
            continue
        result[card.id] = {
            "version": card.version,
            "content_sha256": card.content_sha256,
            "status": skill_status(card)["status"],
        }
    return result


def skill_ids_for_role(role_id: str) -> tuple[str, ...]:
    """角色技能白名单（服务端强制，方案 §5.3）：卡片 roles 声明。"""
    return tuple(
        card.id for card in skill_cards().values()
        if role_id in card.roles
    )


def verify_snapshot(pinned: dict[str, Any]) -> list[str]:
    """恢复/事后核对：固定快照与当前注册表不一致时明确报出（§8.3）。"""
    mismatches: list[str] = []
    for skill_id, pinned_meta in (pinned or {}).items():
        card = get_skill(skill_id)
        if card is None:
            mismatches.append(f"{skill_id}: 技能已不存在")
            continue
        if not isinstance(pinned_meta, dict) or pinned_meta.get("missing"):
            mismatches.append(f"{skill_id}: 快照记录缺失")
            continue
        if pinned_meta.get("version") != card.version:
            mismatches.append(
                f"{skill_id}: 版本 {pinned_meta.get('version')} → {card.version}"
            )
        elif pinned_meta.get("content_sha256") != card.content_sha256:
            mismatches.append(f"{skill_id}: 内容哈希变化")
    return mismatches
