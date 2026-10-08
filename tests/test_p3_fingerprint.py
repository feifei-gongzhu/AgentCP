"""P3 双轨指纹定向测试（方案 §7.1；验收 §13.1 相关项）。

- 被动轨消费已有观察（mrecon 证据/采集层即时观察）；
- 主动轨只对已分配目标执行配置路径检查，重定向/统一错误页/登录页/
  catch-all 经随机路径基线对照；**状态码命中不等于技术确认**；
- 冲突保留双方证据（被动观察到 + 主动未确认 → 两轨证据都保留）；
- 未确认的主动探针不进入技术观察；匹配/冲突落入账本（规则 ID/版本/
  片段/证据/时间/状态/置信来源）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import fingerprint, resource_repository
from src.sorne import store as store_module
from src.sorne.engine_adapters import web_collect
from src.sorne.store import ProjectStore
from p3_fixture_server import LocalFixtureServer


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("p3-fingerprint")
    store.init()
    resource_repository.ensure_defaults(store)
    return store


@pytest.fixture()
def server() -> LocalFixtureServer:
    fixture = LocalFixtureServer().start()
    yield fixture
    fixture.stop()


@pytest.fixture()
def catchall_server() -> LocalFixtureServer:
    fixture = LocalFixtureServer(catchall=True).start()
    yield fixture
    fixture.stop()


def _evaluate(project, targets, **kwargs):
    return fingerprint.evaluate(
        project, targets, fetcher=web_collect.fetch_url,
        evidence_writer=lambda url, kind, response: f"evidence/fp/{kind}.http",
        **kwargs,
    )


def test_active_track_confirms_only_with_marker_and_baseline_contrast(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    evaluation = _evaluate(project, [server.base_url])
    spring = [
        match for match in evaluation["active_matches"]
        if match["technology"] == "Spring Boot Actuator"
    ]
    assert spring, "主动轨应探到 /actuator/health"
    confirmed = [m for m in spring if m["status"] == "confirmed_by_marker"]
    assert confirmed
    assert confirmed[0]["matched_fragment"]  # 内容标记片段留档
    assert confirmed[0]["probe"]["baseline_status"] == 404  # 随机路径基线


def test_catchall_never_confirms_by_status_code(
    project: ProjectStore, catchall_server: LocalFixtureServer,
) -> None:
    """统一 200 catch-all：探针 200 且与基线同形 → 不确认（§7.1）。"""
    evaluation = _evaluate(project, [catchall_server.base_url])
    statuses = [m["status"] for m in evaluation["active_matches"]]
    assert statuses
    assert "confirmed_by_marker" not in statuses
    assert all(m["probe"]["baseline_identical"] for m in evaluation["active_matches"])


def test_passive_observed_with_active_unconfirmed_keeps_both_sides(
    project: ProjectStore, catchall_server: LocalFixtureServer,
) -> None:
    """冲突：被动（X-Application-Context 头）观察到、主动探针未确认。"""
    extra = [{
        "url": f"{catchall_server.base_url}/",
        "evidence_ref": "evidence/fp/passive.http",
        "transcript": (
            "HTTP/1.1 200 OK\r\nX-Application-Context: application:8080\r\n"
            "Set-Cookie: JSESSIONID=x\r\n\r\n<html>fallback page</html>"
        ),
        "source_kind": "mrecon",
    }]
    evaluation = _evaluate(project, [catchall_server.base_url], extra_observations=extra)
    passive = [
        m for m in evaluation["passive_matches"]
        if m["technology"] == "Spring Boot Actuator"
    ]
    assert passive and passive[0]["matched_fragment"] == "X-Application-Context"
    conflicts = [
        c for c in evaluation["conflicts"]
        if c["technology"] == "Spring Boot Actuator"
    ]
    assert conflicts
    conflict = conflicts[0]
    assert conflict["both_sides_kept"] is True
    assert "evidence/fp/passive.http" in conflict["passive_evidence_refs"]
    assert conflict["active_evidence_refs"]  # 双方证据都在


def test_unconfirmed_active_probes_do_not_become_observations(
    project: ProjectStore, catchall_server: LocalFixtureServer,
) -> None:
    evaluation = _evaluate(project, [catchall_server.base_url])
    rows = fingerprint.to_technology_observations(evaluation)
    assert rows == []  # 无标记确认 → 不进技术观察


def test_confirmed_active_and_passive_rows_carry_rule_metadata(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    extra = [{
        "url": f"{server.base_url}/",
        "evidence_ref": "evidence/fp/passive.http",
        "transcript": (
            "HTTP/1.1 200 OK\r\nX-Application-Context: application:8080\r\n\r\n"
        ),
        "source_kind": "mrecon",
    }]
    evaluation = _evaluate(project, [server.base_url], extra_observations=extra)
    rows = fingerprint.to_technology_observations(evaluation)
    by_track = {row["fingerprint_track"]: row for row in rows}
    assert set(by_track) == {"passive", "active"}
    assert by_track["passive"]["rule_id"] == "fp-spring-actuator"
    assert by_track["passive"]["rule_version"]
    assert by_track["passive"]["confidence_source"] == "passive_pattern"


def test_ledger_persists_matches_and_conflicts(project: ProjectStore, catchall_server: LocalFixtureServer) -> None:
    extra = [{
        "url": f"{catchall_server.base_url}/",
        "evidence_ref": "evidence/fp/passive.http",
        "transcript": "HTTP/1.1 200 OK\r\nX-Application-Context: application:8080\r\n\r\n",
        "source_kind": "mrecon",
    }]
    evaluation = _evaluate(project, [catchall_server.base_url], extra_observations=extra)
    count = fingerprint.persist_matches(project, evaluation, targets=[catchall_server.base_url])
    assert count > 0
    rows = project.read_jsonl("fingerprint_matches.jsonl")
    assert any(row.get("rule_id") for row in rows)
    assert any(row.get("record_kind") == "conflict" for row in rows)
    conflict = next(row for row in rows if row.get("record_kind") == "conflict")
    assert conflict["passive_evidence_refs"] and conflict["active_evidence_refs"]
    # §7.1 字段齐全：规则 ID/版本、匹配片段、证据、时间、状态、置信来源
    sample = next(row for row in rows if row.get("rule_id"))
    for field in ("rule_id", "rule_version", "evidence_ref", "observed_at", "status", "confidence_source"):
        assert field in sample


def test_disabled_rules_report_capability_missing(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    for entry in resource_repository.list_resources(project, category="fingerprint_rules"):
        resource_repository.set_enabled(project, entry["id"], enabled=False)
    with pytest.raises(fingerprint.FingerprintError, match="capability_missing"):
        fingerprint.evaluate(project, [server.base_url], fetcher=web_collect.fetch_url)


def test_passive_track_consumes_mrecon_evidence(project: ProjectStore, server: LocalFixtureServer) -> None:
    rules, _meta = fingerprint.load_rules(project)
    # 构造一条 mrecon 观察（原始证据含 Shiro Cookie 指纹）
    evidence_name = "mrecon_sample.http"
    (project.path / "evidence").mkdir(parents=True, exist_ok=True)
    (project.path / "evidence" / evidence_name).write_text(
        "HTTP/1.1 200 OK\r\nSet-Cookie: rememberMe=deleteMe\r\n\r\n<html></html>",
        encoding="utf-8",
    )
    project.append_jsonl("mrecon_observations.jsonl", {
        "id": "MR-1", "url": f"{server.base_url}/login", "method": "GET",
        "status": 200, "evidence_ref": f"evidence/{evidence_name}",
        "source": "http_crawl",
    })
    matches = fingerprint.passive_track(project, rules, [server.base_url])
    shiro = [m for m in matches if m["technology"] == "Apache Shiro"]
    assert shiro
    assert shiro[0]["matched_fragment"] == "rememberMe=deleteMe"
    assert shiro[0]["match_source"].startswith("mrecon:cookie")
