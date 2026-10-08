"""P2 技能系统定向测试：家族卡注册/校验、特征路由、角色白名单、版本快照
（方案 §5.2-5.4；验收 §13.1-3）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import skill_registry
from src.sorne.skill_registry import (
    SkillRegistryError,
    load_skill_cards,
    snapshot,
    skill_cards,
    skill_ids_for_role,
    skill_status,
    verify_snapshot,
)
from src.sorne.skill_router import route_skills
from src.sorne.tool_registry import TOOL_CATALOG


def test_minimal_complete_card_set_loaded() -> None:
    """§5.4 最小完整集合：研究环 + Web 家族四卡 + 组件总卡 + 四短卡。"""
    cards = skill_cards()
    expected = {
        "research-pipeline", "web-methods",
        "web-auth-session", "web-api", "web-injection", "web-client-side",
        "component-verification",
        "shiro-verification", "fastjson-verification",
        "spring-verification", "log4j-verification",
    }
    assert expected <= set(cards)
    for card in cards.values():
        assert card.version
        assert card.content_sha256
        assert card.body.strip()
        # 卡片声明的工具必须真实存在于目录（声明不存在的工具=注册失败）
        for capability in card.required_capabilities:
            assert capability in TOOL_CATALOG


def test_card_with_unknown_capability_rejected(tmp_path: Path) -> None:
    card = {
        "id": "bad-card", "version": "1.0.0", "title": "t", "description": "d",
        "roles": ["poc"], "required_capabilities": ["no_such_tool"],
        "trigger_features": ["x"], "preconditions": [],
        "references": [], "source": "s", "license": "l",
        "body": "何时使用\n先看什么证据\n调用哪个已注册能力\n怎样解读结果\n怎样排除\n怎样交付\n何时停止",
    }
    (tmp_path / "bad.json").write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(SkillRegistryError, match="不存在的能力"):
        load_skill_cards(tmp_path)


def test_card_with_missing_reference_rejected(tmp_path: Path) -> None:
    base = {
        "version": "1.0.0", "title": "t", "description": "d", "roles": ["poc"],
        "required_capabilities": ["http_request"], "trigger_features": ["x"],
        "preconditions": [], "references": ["no-such-card"], "source": "s",
        "license": "l",
        "body": "何时使用\n先看什么证据\n调用哪个已注册能力\n怎样解读结果\n怎样排除\n怎样交付\n何时停止",
    }
    (tmp_path / "a.json").write_text(json.dumps({**base, "id": "a"}, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(SkillRegistryError, match="不可解析"):
        load_skill_cards(tmp_path)


def test_card_with_circular_reference_rejected(tmp_path: Path) -> None:
    body = "何时使用\n先看什么证据\n调用哪个已注册能力\n怎样解读结果\n怎样排除\n怎样交付\n何时停止"
    a = {"id": "a", "version": "1", "title": "t", "description": "d", "roles": ["poc"],
         "required_capabilities": [], "trigger_features": ["x"], "preconditions": [],
         "references": ["b"], "source": "s", "license": "l", "body": body}
    b = dict(a, id="b", references=["a"])
    (tmp_path / "a.json").write_text(json.dumps(a, ensure_ascii=False), encoding="utf-8")
    (tmp_path / "b.json").write_text(json.dumps(b, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(SkillRegistryError, match="循环引用"):
        load_skill_cards(tmp_path)


def test_empty_body_card_rejected(tmp_path: Path) -> None:
    card = {
        "id": "empty", "version": "1", "title": "t", "description": "d", "roles": ["poc"],
        "required_capabilities": [], "trigger_features": ["x"], "preconditions": [],
        "references": [], "source": "s", "license": "l", "body": "  ",
    }
    (tmp_path / "empty.json").write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(SkillRegistryError, match="空卡"):
        load_skill_cards(tmp_path)


def test_deterministic_routing_scenarios() -> None:
    """§5.4 确定性测试情景：输入特征→预期技能（→工具）→前置不足行为→结果类别。"""
    # Shiro 指纹特征 → shiro 短卡（poc 角色），组件总卡同时命中
    result = route_skills(["rememberMe=deleteMe", "apache shiro"], role="poc")
    ids = [item["skill_id"] for item in result["matches"]]
    assert ids[0] in {"shiro-verification", "component-verification"}
    assert "shiro-verification" in ids
    shiro = next(item for item in result["matches"] if item["skill_id"] == "shiro-verification")
    assert "poc_scan" in shiro["required_capabilities"]
    assert "matched_features" in shiro

    # fastjson 特征
    result = route_skills(["fastjson", "autoType"], role="poc")
    assert "fastjson-verification" in [item["skill_id"] for item in result["matches"]]

    # 登录特征 → 认证方法卡（operator）
    result = route_skills(["登录", "jwt", "session cookie"], role="operator")
    assert "web-auth-session" in [item["skill_id"] for item in result["matches"]]

    # API 特征
    result = route_skills(["/api/", "order_id", "越权"], role="operator")
    assert "web-api" in [item["skill_id"] for item in result["matches"]]

    # 未覆盖特征 → 方法缺口显式返回（不伪造技能）
    result = route_skills(["cobol-mainframe-bug"], role="poc")
    assert "cobol-mainframe-bug" in result["uncovered_features"]


def test_role_whitelist_enforced_in_routing() -> None:
    # crack 角色不在任何 Web 方法卡白名单内 → 路由不返回
    result = route_skills(["登录", "jwt", "shiro"], role="crack")
    assert result["matches"] == []


def test_component_card_blocked_when_engine_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """组件验证卡声明 poc_scan：引擎不可用时卡片状态 blocked_tool_unavailable，
    缺口说明列出 capability_missing。"""
    cards = skill_cards()
    status = skill_status(cards["component-verification"])
    if cards["component-verification"].required_capabilities:
        # 本环境无 nuclei 镜像 → blocked；若环境预取了镜像则 active
        assert status["status"] in {"active", "blocked_tool_unavailable"}
    monkeypatch.setattr(
        "src.sorne.tool_registry.ENGINE_AVAILABILITY",
        {"poc_scan": lambda: (False, "测试：镜像缺失")},
    )
    status = skill_status(cards["component-verification"])
    assert status["status"] == "blocked_tool_unavailable"
    assert any(
        item["capability"] == "poc_scan" for item in status["unavailable_capabilities"]
    )


def test_snapshot_pins_version_and_hash() -> None:
    """任务开始固定版本/内容哈希（§5.3）；运行中变化可被 verify_snapshot 报出。"""
    snap = snapshot(["shiro-verification", "does-not-exist"])
    assert snap["shiro-verification"]["version"] == skill_cards()["shiro-verification"].version
    assert snap["shiro-verification"]["content_sha256"]
    assert snap["does-not-exist"] == {"missing": True}
    # 恢复核对：一致时无报出
    assert verify_snapshot(snap) == ["does-not-exist: 技能已不存在"]
    # 版本变化被报出
    tampered = {"shiro-verification": {"version": "0.0.1", "content_sha256": "deadbeef"}}
    mismatches = verify_snapshot(tampered)
    assert any("shiro-verification" in item for item in mismatches)


def test_role_skill_whitelist_service_side() -> None:
    """角色技能白名单来自卡片 roles（服务端强制）；poc 可加载短卡。"""
    assert "shiro-verification" in skill_ids_for_role("poc")
    assert "shiro-verification" not in skill_ids_for_role("crack")
    assert skill_registry.skill_cards()["research-pipeline"].roles  # 总卡覆盖七角色
