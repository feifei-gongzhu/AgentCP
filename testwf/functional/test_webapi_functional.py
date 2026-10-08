"""Web API 功能路径：目标保存规范化与 mrecon 钳制、hints 四种干预类型、
findings/review 六种裁决组合、方向 dismiss/restore 理由必填、metrics 口径与
authorization 锁定。使用 in-process 服务器模式（不起子进程、不占端口）。"""
from __future__ import annotations

import pytest

from src.sorne.database import ControlDatabase
from src.sorne.store import ProjectStore


def _vuln_fact(fact_id: str, category: str = "auth") -> dict:
    return {
        "id": fact_id,
        "kind": "fact",
        "title": "越权读取订单数据",
        "category": category,
        "severity": "high",
        "status": "vulnerability",
        "classification": "vulnerability",
        "proposed_by": "worker",
    }


# ---------------------------------------------------------------------------
# /api/target：字段规范化与 mrecon 参数钳制
# ---------------------------------------------------------------------------

def test_target_save_normalizes_fields_and_clamps_mrecon(api, project: ProjectStore) -> None:
    resp = api("POST", "/api/target", json_body={
        "vendor": project.vendor,
        "target": {
            "targets": [" https://a.example.com ", "https://a.example.com", "https://b.example.com", "", "   "],
            "out_of_scope": "内网管理后台\n\n10.0.0.0/8",
            "success_criteria": ["获取订单数据读写", "获取订单数据读写"],
            "goal": "  验证订单越权  ",
            "project_type": "web应用",
            "authorization": "unauthorized",
            "scope": ["nothing"],
            "mrecon": {
                "enabled": True,
                "max_pages": 99999,
                "timeout_seconds": 1,
                "delay_seconds": -3.5,
                "browser_pages": 99,
                "browser_clicks": -2,
            },
        },
    })

    assert resp.status == 200, resp.json
    target = resp.json["target"]
    # 多行文本拆分、strip、去空、去重。
    assert target["targets"] == ["https://a.example.com", "https://b.example.com"]
    assert target["out_of_scope"] == ["内网管理后台", "10.0.0.0/8"]
    assert target["success_criteria"] == ["获取订单数据读写"]
    assert target["goal"] == "验证订单越权"
    assert target["project_type"] == "web应用"
    assert target["vendor"] == project.vendor
    # 授权锁定：服务端强制 authorized，不采纳请求体里的未授权声明。
    assert target["authorization"] == "authorized"
    assert target["authorization_mode"] == "owner_asserted_all_targets"
    assert target["authorized_by"] == "project_owner"
    assert target["scope"] == ["*"]
    # mrecon 钳制：[1,3000] / [3,60] / [0,5] / [0,30] / [0,30]。
    assert target["mrecon"] == {
        "enabled": True,
        "max_pages": 3000,
        "timeout_seconds": 3,
        "delay_seconds": 0.0,
        "browser_pages": 30,
        "browser_clicks": 0,
    }

    persisted = project.read_json("target.json")
    assert persisted["mrecon"]["max_pages"] == 3000
    assert persisted["authorization"] == "authorized"
    markdown = project.read_text("目标信息.md")
    assert "https://a.example.com" in markdown
    assert "owner_asserted_all_targets" in markdown


def test_target_save_rejects_illegal_mrecon_and_empty_targets(api, project: ProjectStore) -> None:
    resp = api("POST", "/api/target", json_body={
        "vendor": project.vendor,
        "target": {"targets": ["https://keep.example.com"], "mrecon": {"max_pages": "abc"}},
    })
    assert resp.status == 400
    assert "mrecon 参数非法" in resp.json["error"]

    resp = api("POST", "/api/target", json_body={
        "vendor": project.vendor,
        "target": {"targets": [], "target_path": "", "project_type": ""},
    })
    assert resp.status == 400
    assert "至少填写一个目标地址" in resp.json["error"]
    # 失败请求不落盘。
    assert project.read_json("target.json").get("targets", []) == []


def test_target_save_defaults_mrecon_when_omitted(api, project: ProjectStore) -> None:
    resp = api("POST", "/api/target", json_body={
        "vendor": project.vendor,
        "target": {"targets": ["https://only.example.com"]},
    })
    assert resp.status == 200
    mrecon = resp.json["target"]["mrecon"]
    assert mrecon["max_pages"] == 300
    assert mrecon["timeout_seconds"] == 20
    assert mrecon["delay_seconds"] == 0.1
    assert mrecon["browser_pages"] == 8
    assert mrecon["browser_clicks"] == 10
    assert mrecon["enabled"] is True


# ---------------------------------------------------------------------------
# /api/hints：四种干预类型与非法值
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("intervention_type", [
    "supplement", "redirect", "evidence_correction", "metacog_review",
])
def test_hints_accepts_four_intervention_types(api, project: ProjectStore, intervention_type: str) -> None:
    resp = api("POST", "/api/hints", json_body={
        "vendor": project.vendor,
        "content": "优先验证订单接口的越权读写路径",
        "intervention_type": intervention_type,
        "priority": 2,
        "target": "订单模块",
    })
    assert resp.status == 200, resp.json
    hint = resp.json["hint"]
    assert hint["intervention_type"] == intervention_type
    assert hint["authority"] == "project_owner"
    assert hint["scope"] == "project"
    assert hint["status"] == "open"
    persisted = project.read_jsonl("hints.jsonl")
    assert [h["intervention_type"] for h in persisted] == [intervention_type]


def test_hints_rejects_illegal_values(api, project: ProjectStore) -> None:
    base = {"vendor": project.vendor, "content": "补充上下文"}

    resp = api("POST", "/api/hints", json_body={**base, "intervention_type": "nudge"})
    assert resp.status == 400
    assert "不支持的人工干预类型: nudge" in resp.json["error"]

    resp = api("POST", "/api/hints", json_body={**base, "content": "   "})
    assert resp.status == 400
    assert "缺少 content" in resp.json["error"]

    resp = api("POST", "/api/hints", json_body={**base, "scope": "global"})
    assert resp.status == 400
    assert "不支持的人工干预作用域: global" in resp.json["error"]

    resp = api("POST", "/api/hints", json_body={**base, "run_id": "R-not-exist"})
    assert resp.status == 400
    assert "运行不存在: R-not-exist" in resp.json["error"]
    assert project.read_jsonl("hints.jsonl") == []


# ---------------------------------------------------------------------------
# /api/findings/review：六种裁决组合校验
# ---------------------------------------------------------------------------

def _review(api, project: ProjectStore, **overrides):
    payload = {
        "vendor": project.vendor,
        "finding_id": "F-1",
        "action": "accepted",
        "final_classification": "vulnerability",
        "final_severity": "high",
        "reason": "复核确认可利用",
    }
    payload.update(overrides)
    return api("POST", "/api/findings/review", json_body=payload)


def _seed_facts(project: ProjectStore, *fact_ids: str) -> None:
    for index, fact_id in enumerate(fact_ids):
        project.append_jsonl("facts.jsonl", _vuln_fact(fact_id, category=f"cat{index}"))


def test_findings_review_accepts_and_adjusted_require_vulnerability(api, project: ProjectStore) -> None:
    _seed_facts(project, "F-ok-acc", "F-ok-adj", "F-bad-acc", "F-bad-adj")

    resp = _review(api, project, finding_id="F-ok-acc", action="accepted",
                   final_classification="vulnerability")
    assert resp.status == 200, resp.json
    assert resp.json["verdict"]["action"] == "accepted"

    resp = _review(api, project, finding_id="F-ok-adj", action="adjusted",
                   final_classification="vulnerability", final_severity="critical",
                   reason="影响范围更大，调级")
    assert resp.status == 200
    assert resp.json["verdict"]["final_severity"] == "critical"

    # 认可（accepted/adjusted）必须 vulnerability。
    resp = _review(api, project, finding_id="F-bad-acc", action="accepted",
                   final_classification="risk_lead")
    assert resp.status == 400
    assert "必须仍为 vulnerability" in resp.json["error"]
    resp = _review(api, project, finding_id="F-bad-adj", action="adjusted",
                   final_classification="attack_surface")
    assert resp.status == 400
    assert "必须仍为 vulnerability" in resp.json["error"]


def test_findings_review_refuted_and_reclassified_forbid_vulnerability(api, project: ProjectStore) -> None:
    _seed_facts(project, "F-ok-ref", "F-ok-rec", "F-bad-ref", "F-bad-rec")

    resp = _review(api, project, finding_id="F-ok-ref", action="refuted",
                   final_classification="risk_lead", reason="复现失败，环境已修复")
    assert resp.status == 200, resp.json
    assert resp.json["verdict"]["action"] == "refuted"

    resp = _review(api, project, finding_id="F-ok-rec", action="reclassified",
                   final_classification="attack_surface", reason="仅信息暴露")
    assert resp.status == 200

    # 驳斥（refuted/reclassified）不能仍是 vulnerability。
    resp = _review(api, project, finding_id="F-bad-ref", action="refuted",
                   final_classification="vulnerability")
    assert resp.status == 400
    assert "不能仍为 vulnerability" in resp.json["error"]
    resp = _review(api, project, finding_id="F-bad-rec", action="reclassified",
                   final_classification="vulnerability")
    assert resp.status == 400
    assert "不能仍为 vulnerability" in resp.json["error"]


def test_findings_review_same_root_requires_master_finding(api, project: ProjectStore) -> None:
    _seed_facts(project, "F-master", "F-sr-no-master", "F-sr-self", "F-sr-ghost",
                "F-sr-class", "F-sr-ret", "F-sr-dup", "F-sr-ok")

    # same_root 必须指定另一个主漏洞。
    resp = _review(api, project, finding_id="F-sr-no-master", action="same_root",
                   final_classification="same_root_vulnerability")
    assert resp.status == 400
    assert "必须指定另一个主漏洞" in resp.json["error"]

    # 指向自身也不行。
    resp = _review(api, project, finding_id="F-sr-self", action="same_root",
                   final_classification="same_root_vulnerability",
                   duplicate_of_finding_id="F-sr-self")
    assert resp.status == 400
    assert "必须指定另一个主漏洞" in resp.json["error"]

    # 主漏洞不存在。
    resp = _review(api, project, finding_id="F-sr-ghost", action="same_root",
                   final_classification="same_root_vulnerability",
                   duplicate_of_finding_id="F-404")
    assert resp.status == 400
    assert "主漏洞不存在" in resp.json["error"]

    # 分类必须配套 same_root_vulnerability。
    resp = _review(api, project, finding_id="F-sr-class", action="same_root",
                   final_classification="risk_lead", duplicate_of_finding_id="F-master")
    assert resp.status == 400
    assert "必须为 same_root_vulnerability" in resp.json["error"]

    # 非同源裁决不能使用该分类，也不能带主漏洞。
    resp = _review(api, project, finding_id="F-sr-ret", action="retest_requested",
                   final_classification="same_root_vulnerability")
    assert resp.status == 400
    resp = _review(api, project, finding_id="F-sr-dup", action="accepted",
                   duplicate_of_finding_id="F-master")
    assert resp.status == 400
    assert "只有同源漏洞裁决可以指定主漏洞" in resp.json["error"]

    # 正确组合成功。
    resp = _review(api, project, finding_id="F-sr-ok", action="same_root",
                   final_classification="same_root_vulnerability",
                   duplicate_of_finding_id="F-master", reason="同一鉴权缺陷的另一个入口")
    assert resp.status == 200, resp.json
    assert resp.json["verdict"]["duplicate_of_finding_id"] == "F-master"


def test_findings_review_retest_and_generic_rejections(api, project: ProjectStore) -> None:
    _seed_facts(project, "F-retest", "F-unknown-action", "F-empty-reason",
                "F-bad-severity")

    resp = _review(api, project, finding_id="F-retest", action="retest_requested",
                   final_classification="inconclusive", reason="证据失效，需要重新验证")
    assert resp.status == 200, resp.json
    assert resp.json["verdict"]["action"] == "retest_requested"

    resp = _review(api, project, finding_id="F-unknown-action", action="confirmed")
    assert resp.status == 400
    assert "不支持的人工裁决动作: confirmed" in resp.json["error"]

    resp = _review(api, project, finding_id="F-empty-reason", reason="   ")
    assert resp.status == 400
    assert "必须填写理由" in resp.json["error"]

    resp = _review(api, project, finding_id="F-bad-severity", final_severity="super")
    assert resp.status == 400
    assert "不支持的最终等级" in resp.json["error"]

    resp = _review(api, project, finding_id="F-404")
    assert resp.status == 400
    assert "漏洞不存在: F-404" in resp.json["error"]


def test_findings_review_valid_request_after_invalid_one_on_same_finding(api, project: ProjectStore) -> None:
    """同一 finding 上先提交一次非法裁决，紧接着的合法裁决应成功。

    实际行为（2026-10-08 复现）：第二次合法请求返回上一次的旧错误
    “不支持的人工裁决动作: confirmed”，且阻塞约 2 秒。
    """
    _seed_facts(project, "F-seq")

    resp = _review(api, project, finding_id="F-seq", action="confirmed")
    assert resp.status == 400

    resp = _review(api, project, finding_id="F-seq", action="accepted",
                   final_classification="vulnerability")
    assert resp.status == 200, resp.json


# ---------------------------------------------------------------------------
# /api/directions/dismiss 与 restore：理由必填
# ---------------------------------------------------------------------------

def _seed_direction(project: ProjectStore) -> str:
    database = ControlDatabase(project.path / "control_plane.db")
    direction_id, _ = database.register_direction({
        "id": "I-fn-1",
        "verb": "inspect",
        "target": "https://example.com/orders",
        "hypothesis": "订单接口可能存在越权",
        "success_criteria": "读取到他人订单",
    })
    return direction_id


def test_directions_dismiss_requires_reason(api, project: ProjectStore) -> None:
    direction_id = _seed_direction(project)

    resp = api("POST", "/api/directions/dismiss", json_body={
        "vendor": project.vendor, "direction_id": direction_id, "reason": "  ",
    })
    assert resp.status == 400
    assert "人工删除方向必须填写理由" in resp.json["error"]

    resp = api("POST", "/api/directions/dismiss", json_body={
        "vendor": project.vendor, "direction_id": direction_id, "reason": "假设不成立，停止验证",
    })
    assert resp.status == 200, resp.json
    assert resp.json["direction"]["status"] == "cancelled"
    assert resp.json["direction"]["terminal_reason"].startswith("human_dismissed:")

    resp = api("POST", "/api/directions/dismiss", json_body={
        "vendor": project.vendor, "direction_id": "D-404", "reason": "不存在",
    })
    assert resp.status == 400
    assert "方向不存在: D-404" in resp.json["error"]


def test_directions_restore_requires_reason(api, project: ProjectStore) -> None:
    direction_id = _seed_direction(project)
    api("POST", "/api/directions/dismiss", json_body={
        "vendor": project.vendor, "direction_id": direction_id, "reason": "先停掉",
    })

    resp = api("POST", "/api/directions/restore", json_body={
        "vendor": project.vendor, "direction_id": direction_id, "reason": "",
    })
    assert resp.status == 400
    assert "人工恢复方向必须填写理由" in resp.json["error"]

    resp = api("POST", "/api/directions/restore", json_body={
        "vendor": project.vendor, "direction_id": direction_id, "reason": "复核后恢复验证",
    })
    assert resp.status == 200, resp.json
    assert resp.json["direction"]["status"] != "cancelled"


# ---------------------------------------------------------------------------
# /api/metrics：口径数字准确性 + authorization 锁定
# ---------------------------------------------------------------------------

def _seed_metrics_project(project: ProjectStore) -> None:
    project.write_json("target.json", {
        **project.read_json("target.json"),
        "targets": ["https://a.example.com", "https://b.example.com"],
    })
    project.append_jsonl("facts.jsonl", {
        **_vuln_fact("F-vuln"), "assets": ["c.example.com"],
    })
    project.append_jsonl("facts.jsonl", {
        "id": "F-phen", "kind": "fact", "title": "banner 版本披露", "category": "other",
        "severity": "info", "status": "phenomenon", "classification": "risk_lead",
        "proposed_by": "worker", "assets": [],
    })
    state = project.load_state()
    state.attack_surface_coverage = {
        "web_framework": "verified", "auth_flow": "covered", "file_upload": "unverified",
    }
    project.save_state(state)
    _seed_direction(project)


def test_metrics_endpoint_reports_accurate_breakdown(api, project: ProjectStore) -> None:
    _seed_metrics_project(project)

    resp = api("GET", f"/api/metrics?vendor={project.vendor}")
    assert resp.status == 200, resp.json
    metrics = resp.json["metrics"]
    assert metrics["project"] == project.vendor

    assets = metrics["assets"]
    assert assets["total"] == 3          # 声明 2 + 发现 1
    assert assets["declared"] == 2
    assert assets["discovered"] == 1
    assert assets["declared_target_count"] == 2
    assert set(assets["items"]) == {"a.example.com", "b.example.com", "c.example.com"}

    coverage = metrics["coverage"]
    assert coverage["dimensions"] == 3
    assert coverage["covered"] == 2      # 非 unverified 即已覆盖
    assert coverage["verified"] == 1
    assert coverage["coverage_rate"] == pytest.approx(2 / 3)
    assert coverage["verification_coverage_rate"] == pytest.approx(1 / 3)

    quality = metrics["quality"]
    assert quality["facts"] == 2
    assert quality["phenomena"] == 1
    assert quality["vulnerabilities"] == 1
    assert quality["validation_rate"] == pytest.approx(0.5)

    directions = metrics["directions"]
    assert directions["unique"] == 1
    assert directions["open"] == 1
    assert directions["duplicates_blocked"] == 0


def test_metrics_and_api_locked_by_server_token(api, project: ProjectStore, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_metrics_project(project)
    monkeypatch.setenv("SORNE_SERVER_TOKEN", "fn-secret")

    resp = api("GET", f"/api/metrics?vendor={project.vendor}")
    assert resp.status == 401
    assert resp.json == {"ok": False, "error": "unauthorized"}

    resp = api("POST", "/api/hints", json_body={
        "vendor": project.vendor, "content": "应被拒绝的写入",
    })
    assert resp.status == 401
    assert project.read_jsonl("hints.jsonl") == []

    resp = api("GET", f"/api/metrics?vendor={project.vendor}", token="fn-secret")
    assert resp.status == 200
    assert resp.json["metrics"]["assets"]["total"] == 3

    resp = api("GET", f"/api/metrics?vendor={project.vendor}", token="wrong-token")
    assert resp.status == 401
