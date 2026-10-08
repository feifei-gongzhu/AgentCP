"""技能特征路由（实施方案 §5.3、§12-P2）。

路由表来自 ``skill_registry`` 的结构化配置（正向特征 / 排除特征 /
证据成熟度 / 优先级），不是提示词散文。核心纪律：

- **指纹→短技能→POC 是候选选择链**：路由命中只表示“该技能卡的方法
  适用”，绝不表示漏洞成立。
- **服务端角色白名单**：卡片 ``roles`` 不含当前角色时，该卡不出现在
  路由结果（方案 §5.3“服务端检查角色技能白名单”）。卡片声明的工具
  不扩权：实际调用仍经 tool_gateway 的角色白名单交集。
- **未覆盖特征 = 方法缺口**：没有卡接住的特征显式返回，允许 planner
  安排通用验证或提交待补方法，不伪造不存在的技能。
"""

from __future__ import annotations

from typing import Any, Iterable

from .skill_registry import SkillCard, skill_cards, skill_status


def _features_of(raw: Iterable[Any]) -> set[str]:
    result: set[str] = set()
    for item in raw or ():
        text = str(item or "").strip().casefold()
        if text:
            result.add(text)
    return result


def route_skills(
    features: Iterable[Any],
    *,
    role: str | None = None,
    limit: int = 8,
) -> dict[str, Any]:
    """按特征路由候选技能卡。

    ``features`` 通常来自技术观察/事实/画像的指纹与关键词集合。返回：

    - ``matches``：按（匹配强度、优先级）排序的卡片；``blocked`` 表示
      卡片声明的能力当前不可用（capability_missing 语义，附缺口说明）。
    - ``uncovered_features``：没有任何卡接住的特征（方法缺口）。
    """
    feature_set = _features_of(features)
    cards = skill_cards()
    matches: list[dict[str, Any]] = []
    covered: set[str] = set()

    for card in cards.values():
        if role is not None and role not in card.roles:
            continue
        positives = _features_of(card.trigger_features)
        exclusions = _features_of(card.exclusion_features)
        hit = {
            feature for feature in feature_set
            if any(
                feature == trigger or trigger in feature or feature in trigger
                for trigger in positives
            )
        }
        if not hit:
            continue
        excluded = {
            feature for feature in feature_set
            if any(
                feature == exclusion or exclusion in feature or feature in exclusion
                for exclusion in exclusions
            )
        }
        status = skill_status(card)
        matches.append({
            **status,
            "matched_features": sorted(hit),
            "excluded_features": sorted(excluded),
            "match_strength": len(hit) - len(excluded),
        })
        covered |= hit

    matches.sort(key=lambda item: (-item["match_strength"], -item["priority"], item["skill_id"]))
    uncovered = sorted(feature_set - covered)
    return {
        "matches": matches[: max(1, int(limit))],
        "match_count": len(matches),
        "uncovered_features": uncovered,
        "note": (
            "路由命中表示方法适用（候选选择链），不表示漏洞成立；"
            "blocked 卡片的引擎能力当前不可用，缺口已列出。"
        ),
    }


def suggest_task_skills(intent: dict[str, Any], *, role: str | None = None) -> list[str]:
    """从方向/任务线索推导建议技能 ID（供 plan 图的 skill_ids 预填）。"""
    features: list[str] = []
    for key in ("verb", "target", "hypothesis", "method"):
        value = str((intent or {}).get(key) or "").strip()
        if value:
            features.append(value)
    result = route_skills(features, role=role, limit=4)
    return [
        item["skill_id"] for item in result["matches"]
        if item["status"] == "active"
    ]


def skill_routing_explanation(features: Iterable[Any], *, role: str | None = None) -> dict[str, Any]:
    """路由解释（供工具查询与 UI 展示：为什么命中/为什么缺口）。"""
    return route_skills(features, role=role, limit=20)


def card_for_role(card: SkillCard, role: str) -> bool:
    """角色是否在卡片白名单内（服务端强制的单一判定）。"""
    return role in card.roles
