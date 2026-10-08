"""P2 nuclei 组件验证适配器定向测试：结构化解析、请求/响应证据落盘、
固定 argv、取消语义、运行可用性（方案 §6.5-6.6；§14 禁止假适配）。

本机无 nuclei 镜像：真实 docker 执行路径按 capability_missing 报缺口；
解析/证据/argv 逻辑用注入 runner 的真实 nuclei JSONL 样本验证（不是
固定返回成功的假适配）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne.engine_adapters import nuclei_adapter
from src.sorne.engine_adapters.nuclei_adapter import (
    NucleiUnavailable,
    parse_nuclei_jsonl,
    run_scan,
)
from src.sorne.tool_registry import capability_gap, get_tool


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("nuclei-fixture")
    store.init()
    return store


NUCLEI_SAMPLE_LINES = [
    json.dumps({
        "template-id": "apache-shiro-cve-2016-4437",
        "type": "http",
        "host": "https://fixture.invalid",
        "matched-at": "https://fixture.invalid/login",
        "info": {
            "name": "Apache Shiro rememberMe 反序列化",
            "severity": "critical",
            "description": "desc",
            "reference": ["https://example.com/advisory"],
        },
        "matcher-name": "default",
        "matcher-status": True,
        "extracted-results": ["rememberMe=deleteMe"],
        "curl-command": "curl -X GET https://fixture.invalid/login",
        "request": "GET /login HTTP/1.1\r\nHost: fixture.invalid",
        "response": "HTTP/1.1 200 OK\r\nSet-Cookie: rememberMe=deleteMe",
        "timestamp": "2026-10-08T00:00:00Z",
    }),
    json.dumps({
        "template-id": "generic-error-page",
        "info": {"name": "统一错误页", "severity": "info"},
        "host": "https://fixture.invalid",
        "matched-at": "https://fixture.invalid/random",
        "matcher-status": True,
    }),
    "not-json-line",
]


class _FakeCompleted:
    def __init__(self, stdout: str, returncode: int = 0, stderr: str = "") -> None:
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


def test_parse_nuclei_jsonl_normalizes_hits() -> None:
    hits = parse_nuclei_jsonl(NUCLEI_SAMPLE_LINES)
    assert len(hits) == 2  # 非 JSON 行被忽略
    first = hits[0]
    assert first["template_id"] == "apache-shiro-cve-2016-4437"
    assert first["severity"] == "critical"
    assert first["matched_at"] == "https://fixture.invalid/login"
    assert first["matcher_status"] is True
    assert first["extracted_results"] == ["rememberMe=deleteMe"]
    assert "rememberMe=deleteMe" in first["response"]
    assert first["request"].startswith("GET /login")


def test_parse_base64_request_response() -> None:
    import base64

    encoded = base64.b64encode(b"GET / HTTP/1.1\r\nHost: x").decode()
    hits = parse_nuclei_jsonl([json.dumps({
        "template-id": "t", "info": {"name": "n", "severity": "low"},
        "request": encoded,
    })])
    assert hits[0]["request"].startswith("GET /")


def test_run_scan_uses_fixed_argv_and_writes_evidence(project: ProjectStore) -> None:
    captured: dict = {}

    def runner(argv, **kwargs):
        captured["argv"] = argv
        return _FakeCompleted("\n".join(NUCLEI_SAMPLE_LINES))

    result = run_scan(
        project,
        {"targets": ["https://fixture.invalid"], "template_ids": ["shiro-check"]},
        runner=runner,
    )
    argv = captured["argv"]
    # 固定 argv（无 shell 拼接），带安全基线与资源上限（§6.3/§6.5）
    assert argv[0] == "docker"
    assert "--cap-drop" in argv and "ALL" in argv
    assert "--network" in argv
    for flag in ("-json", "-irr", "-silent", "-duc"):
        assert flag in argv
    assert "-t" in argv and "shiro-check" in argv
    assert "-u" in argv and "https://fixture.invalid" in argv
    # 结构化结果 + 证据落盘
    assert result["hit_count"] == 2
    assert result["no_hit"] is False
    raw = project.path / result["evidence_path"]
    assert raw.is_file()
    assert Path(str(raw) + ".sha256").is_file()
    assert "argv" in raw.read_text(encoding="utf-8")
    # 逐命中请求/响应证据（§12-P2：请求/响应证据落盘）
    assert len(result["hit_evidence_paths"]) == 2
    hit_file = project.path / result["hit_evidence_paths"][0]
    content = hit_file.read_text(encoding="utf-8")
    assert "# request" in content and "# response" in content
    assert "rememberMe=deleteMe" in content
    assert result["note"]


def test_run_scan_no_hit_is_a_valid_result(project: ProjectStore) -> None:
    result = run_scan(
        project,
        {"targets": ["https://fixture.invalid"]},
        runner=lambda argv, **kw: _FakeCompleted(""),
    )
    assert result["hit_count"] == 0
    assert result["no_hit"] is True
    assert (project.path / result["evidence_path"]).is_file()


def test_run_scan_rejects_empty_and_oversized_targets(project: ProjectStore) -> None:
    from src.sorne.engine_adapters.nuclei_adapter import NucleiExecutionError

    with pytest.raises(NucleiExecutionError, match="targets"):
        run_scan(project, {"targets": []}, runner=lambda argv, **kw: _FakeCompleted(""))
    with pytest.raises(NucleiExecutionError, match="上限"):
        run_scan(
            project,
            {"targets": [f"https://fixture.invalid/{i}" for i in range(64)]},
            runner=lambda argv, **kw: _FakeCompleted(""),
        )


def test_run_scan_without_environment_reports_capability_missing(
    project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(nuclei_adapter, "availability_status", lambda: (False, "镜像未预取"))
    with pytest.raises(NucleiUnavailable, match="capability_missing"):
        run_scan(project, {"targets": ["https://fixture.invalid"]})


def test_tool_registry_gap_when_engine_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "src.sorne.tool_registry.ENGINE_AVAILABILITY",
        {"poc_scan": lambda: (False, "镜像未预取（测试注入）")},
    )
    spec = get_tool("poc_scan")
    assert spec is not None and spec.implemented
    assert not spec.available
    gap = capability_gap("poc_scan")
    assert "适配层已实现" in gap and "不可用" in gap


def test_availability_reflects_real_environment() -> None:
    """真实环境探测（本机 Docker 可达但无 nuclei 镜像）：如实报缺口。"""
    nuclei_adapter.reset_availability_cache()
    available, reason = nuclei_adapter.availability_status()
    if not available:
        assert reason  # 缺口必须带说明
        assert "nuclei" in nuclei_adapter.image_ref()
    # 环境预取镜像后本用例自然转为 available=True，不需要改测试。
