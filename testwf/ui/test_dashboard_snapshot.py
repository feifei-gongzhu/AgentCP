"""dashboard.py 离线快照：能渲染、关键区块齐全、用户数据全部转义。"""
from __future__ import annotations

from pathlib import Path

from src.sorne.dashboard import render_dashboard
from src.sorne.store import ProjectStore

HOSTILE_TITLE = '<script>alert("xss")</script> "onmouseover=alert(1)'


def _seed_project(projects: Path) -> ProjectStore:
    store = ProjectStore("ui-dashboard")
    store.init()
    target = store.read_json("target.json")
    target.update({
        "goal": HOSTILE_TITLE,
        "targets": ["https://app.example.test"],
        "authorization_mode": "owner_asserted_all_targets",
        "scope": ["*"],
    })
    store.write_json("target.json", target)
    store.append_jsonl("facts.jsonl", {
        "id": "F-0001", "status": "confirmed", "title": HOSTILE_TITLE,
        "business_impact": "<img src=x onerror=alert(2)>",
    })
    store.append_jsonl("intents.jsonl", {
        "id": "I-0001", "verb": "verify", "target": HOSTILE_TITLE,
        "risk_level": "high", "status": "pending",
    })
    store.append_jsonl("decision_log.jsonl", {"created_at": "2026-10-08T00:00:00Z", "action": "tick", "reason": HOSTILE_TITLE})
    return store


def test_dashboard_snapshot_renders_with_key_sections(isolated_projects_dir: Path) -> None:
    store = _seed_project(isolated_projects_dir)
    output = render_dashboard(store)
    assert output == store.path / "dashboard.html"
    assert output.is_file()
    document = output.read_text(encoding="utf-8")
    for section in (
        "十维攻击面覆盖", "发现与证据分级", "可执行 Intent", "Intent 方向租约",
        "自动化运行", "控制器决策日志", "双层项目黑板", "运行入口",
        "离线只读快照",
    ):
        assert section in document, f"快照缺少关键区块：{section}"
    assert "ui-dashboard" in document


def test_dashboard_escapes_hostile_user_data(isolated_projects_dir: Path) -> None:
    store = _seed_project(isolated_projects_dir)
    document = render_dashboard(store).read_text(encoding="utf-8")
    # 用户数据（标题/目标/理由）不允许以裸 HTML 形式进入快照
    assert HOSTILE_TITLE not in document
    assert "<img src=x" not in document
    assert "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;" in document


def test_dashboard_overwrites_stale_snapshot(isolated_projects_dir: Path) -> None:
    store = _seed_project(isolated_projects_dir)
    first = render_dashboard(store)
    store.append_jsonl("facts.jsonl", {"id": "F-0002", "status": "candidate", "title": "新增发现", "business_impact": ""})
    second = render_dashboard(store)
    assert second == first, "快照应固定写到 dashboard.html 并覆盖旧内容"
    assert "新增发现" in second.read_text(encoding="utf-8")
    # JSON 序列化的 scope 也会被 _escape 转义后输出（引号变 &quot;）
    assert "&quot;*&quot;" in second.read_text(encoding="utf-8")
