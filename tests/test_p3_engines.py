"""P3 引擎适配定向测试（方案 §6.6-3/4、§8.3、§12-P3；§14 禁止假适配）。

- fscan：结构化 JSON 报告解析、固定 argv 安全基线（禁爆破/禁 POC）、
  逐目标批次恢复（restart_remaining）、环境缺失如实 capability_missing。
- 原生 dir_scan：随机路径基线对照、内容指纹、证据 sha256、批次账本。
- 原生 js_scan：脚本发现、线索规则提取、秘密值脱敏（形状线索保留）。
- 原生 subdomain_scan：DNS 字典解析（注入 resolver）、无字典时如实报缺口。
- 原生 pwd_crack：Basic/表单真实验证、凭据引用解析失败不做尝试、
  证据口令脱敏、取消后 unknown_outcome 不自动重试。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import resource_repository
from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne.engine_adapters import (
    fscan_adapter,
    pwdcrack_adapter,
    web_collect,
)
from p3_fixture_server import LocalFixtureServer, fixture_json_for_scope


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("p3-engines")
    store.init()
    resource_repository.ensure_defaults(store)
    return store


@pytest.fixture()
def server() -> LocalFixtureServer:
    fixture = LocalFixtureServer().start()
    yield fixture
    fixture.stop()


# ── fscan ────────────────────────────────────────────────────────────

FSCAN_REPORT = json.dumps({
    "scan_time": "2026-10-09T00:00:00Z",
    "summary": {"total_hosts": 1, "total_ports": 1, "total_services": 1, "total_vulns": 0},
    "hosts": [{"time": "t", "type": "HOST", "target": "127.0.0.1", "status": "alive", "details": {}}],
    "ports": [{"time": "t", "type": "PORT", "target": "127.0.0.1", "status": "open", "details": {"port": 8080}}],
    "services": [{
        "time": "t", "type": "SERVICE", "target": "127.0.0.1:8080", "status": "web",
        "details": {
            "plugin": "webtitle", "port": 8080, "protocol": "http",
            "url": "http://127.0.0.1:8080", "title": "Fixture", "status": 200,
            "server": "nginx", "fingerprints": ["Nginx"],
        },
    }],
})


class _FakeCompleted:
    def __init__(self, stdout: str) -> None:
        self.stdout = stdout
        self.returncode = 0
        self.stderr = ""


def test_fscan_parse_report_structures_all_sections() -> None:
    parsed = fscan_adapter.parse_fscan_report(FSCAN_REPORT)
    assert parsed["summary"]["total_ports"] == 1
    assert parsed["ports"] == [{"target": "127.0.0.1", "port": 8080, "status": "open"}]
    assert parsed["services"][0]["title"] == "Fixture"
    assert parsed["services"][0]["fingerprints"] == ["Nginx"]


def test_fscan_parse_rejects_non_json(project: ProjectStore) -> None:
    from src.sorne.engine_adapters.fscan_adapter import FscanExecutionError

    with pytest.raises(FscanExecutionError):
        fscan_adapter.parse_fscan_report("banner text not json")


def test_fscan_argv_has_security_baseline_and_recon_limits(project: ProjectStore) -> None:
    captured: dict = {}

    def runner(argv, **kwargs):
        captured["argv"] = argv
        return _FakeCompleted(FSCAN_REPORT)

    result = fscan_adapter.run_recon_scan(
        project, {"targets": ["http://fixture.invalid"]}, mode="url", runner=runner,
    )
    argv = captured["argv"]
    assert argv[0] == "docker"
    assert "--cap-drop" in argv and "ALL" in argv
    assert "--pids-limit" in argv
    # 侦察安全基线：禁爆破、禁 POC（§13.1-5：recon 的引擎调用不得顺带
    # 执行 crack/poc 类动作）
    assert "-nobr" in argv and "-nopoc" in argv
    assert "-f" in argv and argv[argv.index("-f") + 1] == "json"
    assert result["port_count"] == 1 and result["service_count"] == 1
    assert result["no_hit"] is False
    assert (project.path / result["evidence_path"]).is_file()
    assert Path(str(project.path / result["evidence_path"]) + ".sha256").is_file()


def test_fscan_ip_mode_uses_host_flag(project: ProjectStore) -> None:
    captured: dict = {}

    def runner(argv, **kwargs):
        captured["argv"] = argv
        return _FakeCompleted(FSCAN_REPORT)

    fscan_adapter.run_recon_scan(
        project, {"targets": ["127.0.0.1"]}, mode="ip", runner=runner,
    )
    assert "-h" in captured["argv"] and "127.0.0.1" in captured["argv"]


def test_fscan_batch_resume_skips_completed_targets(project: ProjectStore) -> None:
    calls: list[str] = []

    def runner(argv, **kwargs):
        calls.append(argv[argv.index("-u") + 1] if "-u" in argv else argv[argv.index("-h") + 1])
        return _FakeCompleted(FSCAN_REPORT)

    first = fscan_adapter.run_recon_scan(
        project, {"targets": ["http://fixture.invalid"]}, mode="url", runner=runner,
    )
    assert first["batch"]["completed"] == 1 and not calls == []
    calls.clear()
    second = fscan_adapter.run_recon_scan(
        project, {"targets": ["http://fixture.invalid"]}, mode="url", runner=runner,
    )
    assert calls == []  # 已完成目标不重扫（§8.3）
    assert second.get("resumed") is True


def test_fscan_reports_capability_missing_without_environment(
    project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(fscan_adapter, "availability_status", lambda: (False, "镜像未预取"))
    with pytest.raises(fscan_adapter.FscanUnavailable, match="capability_missing"):
        fscan_adapter.run_recon_scan(project, {"targets": ["http://fixture.invalid"]}, mode="url")


def test_fscan_rejects_empty_targets(project: ProjectStore) -> None:
    with pytest.raises(fscan_adapter.FscanExecutionError, match="targets"):
        fscan_adapter.run_recon_scan(project, {"targets": []}, mode="url", runner=lambda *a, **k: _FakeCompleted("{}"))


# ── dir_scan ─────────────────────────────────────────────────────────

def test_dir_scan_baseline_contrast_and_evidence(project: ProjectStore, server: LocalFixtureServer) -> None:
    result = web_collect.run_dir_scan(
        project, {"targets": [server.base_url]},
        wordlist_override=["index.html", "js", "definitely-missing-404"],
    )
    by_path = {record["path"]: record for record in result["records"]}
    assert by_path["/index.html"]["status"] == 200
    assert by_path["/index.html"]["same_as_baseline"] is False
    assert by_path["/definitely-missing-404"]["status"] == 404
    assert by_path["/definitely-missing-404"]["same_as_baseline"] is True  # catch-all 对照
    assert result["no_hit"] is False
    evidence = project.path / result["evidence_path"]
    assert evidence.is_file()
    payload = json.loads(evidence.read_text(encoding="utf-8"))
    assert payload["baseline"]["control_path"].startswith("sorne-baseline-")
    assert payload["baseline"]["status"] == 404
    assert result["batch"]["completed"] == 1


def test_dir_scan_requires_enabled_dictionary(project: ProjectStore, server: LocalFixtureServer) -> None:
    for entry in resource_repository.list_resources(project, category="service_dictionaries"):
        resource_repository.set_enabled(project, entry["id"], enabled=False)
    with pytest.raises(web_collect.CollectError, match="capability_missing.*dir_wordlist"):
        web_collect.run_dir_scan(project, {"targets": [server.base_url]})


def test_dir_scan_cancel_midway_marks_unknown_outcome(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    calls = {"n": 0}

    def cancel_after_baseline() -> bool:
        return calls["n"] >= 2  # 基线+第一个词之后取消

    def counting_fetch(url: str, **kwargs):
        calls["n"] += 1
        return web_collect.fetch_url(url, **kwargs)

    result = web_collect.run_dir_scan(
        project, {"targets": [server.base_url, f"{server.base_url}/js"]},
        wordlist_override=["index.html"],
        cancel_check=cancel_after_baseline, fetcher=counting_fetch,
    )
    assert result["cancelled"] is True
    summary = result["batch"]
    assert summary["pending"] + summary["unknown_outcome"] >= 1
    assert summary["completed"] < 2


# ── js_scan ──────────────────────────────────────────────────────────

def test_js_scan_extracts_leads_and_redacts_secret_values(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    result = web_collect.run_js_scan(project, {"targets": [server.base_url]})
    assert result["file_count"] == 1
    js_file = result["files"][0]
    assert js_file["source_url"].endswith("/js/app.js")
    assert js_file["content_sha256"] and js_file["size"] > 0
    rules_hit = {lead["rule_id"] for lead in js_file["leads"]}
    assert "js-api-path" in rules_hit
    # 秘密形状线索保留（值脱敏为标记），端点线索保留观察值
    assert "js-redacted-jwt" in rules_hit
    evidence = project.path / js_file["evidence_path"]
    content = evidence.read_text(encoding="utf-8")
    assert "eyJhbGciOiJIUzI1NiJ9" not in content  # JWT 原值不得进入证据（§7A.4）
    assert "[REDACTED-JWT]" in content


def test_js_scan_requires_enabled_rules(project: ProjectStore, server: LocalFixtureServer) -> None:
    for entry in resource_repository.list_resources(project, category="js_clue_rules"):
        resource_repository.set_enabled(project, entry["id"], enabled=False)
    with pytest.raises(web_collect.CollectError, match="capability_missing.*JS 线索规则"):
        web_collect.run_js_scan(project, {"targets": [server.base_url]})


# ── subdomain_scan ───────────────────────────────────────────────────

def test_subdomain_scan_resolves_dictionary_hits(project: ProjectStore) -> None:
    def resolver(host: str) -> list[str]:
        return ["93.184.216.34"] if host == "www.example.com" else []

    result = web_collect.run_subdomain_scan(
        project, {"targets": ["example.com"]}, resolver=resolver,
    )
    found = {record["subdomain"] for record in result["records"]}
    assert "example.com" in found
    assert "www.example.com" in found
    assert result["no_hit"] is False
    assert (project.path / result["evidence_path"]).is_file()


def test_subdomain_scan_requires_subdomain_dictionary(project: ProjectStore) -> None:
    for entry in resource_repository.list_resources(project, category="service_dictionaries"):
        if entry["id"] == "subdomains-common":
            resource_repository.set_enabled(project, entry["id"], enabled=False)
    with pytest.raises(web_collect.CollectError, match="capability_missing.*subdomain_wordlist"):
        web_collect.run_subdomain_scan(
            project, {"targets": ["example.com"]},
            resolver=lambda host: [],
        )


# ── pwd_crack ────────────────────────────────────────────────────────

def _pair_secret() -> str:
    return json.dumps({"pairs": [{"username": "admin", "password": "s3cret-pass"}]})


def test_pwd_crack_basic_verification_real_requests(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    result = pwdcrack_adapter.run_credential_check(
        project,
        {"targets": [f"{server.base_url}/protected"], "credential_ref": "cred"},
        resolve_secret=lambda ref: _pair_secret() if ref == "cred" else None,
    )
    assert result["verified_count"] == 1
    verified = result["verified"][0]
    assert verified["outcome"] == "verified"
    assert "401" in verified["verification_predicate"]
    transcript = (project.path / verified["evidence_path"]).read_text(encoding="utf-8")
    assert "s3cret-pass" not in transcript  # 口令绝不进入证据
    assert "[REDACTED]" in transcript


def test_pwd_crack_form_login_verification(project: ProjectStore, server: LocalFixtureServer) -> None:
    result = pwdcrack_adapter.run_credential_check(
        project,
        {"targets": [f"{server.base_url}/login"], "credential_ref": "cred"},
        resolve_secret=lambda ref: _pair_secret(),
    )
    verified = result["verified"][0]
    assert verified["outcome"] == "verified"
    assert "SESSIONID" in verified["verification_predicate"]


def test_pwd_crack_wrong_password_rejected(project: ProjectStore, server: LocalFixtureServer) -> None:
    secret = json.dumps({"pairs": [{"username": "admin", "password": "wrong-pass"}]})
    result = pwdcrack_adapter.run_credential_check(
        project,
        {"targets": [f"{server.base_url}/login"], "credential_ref": "cred"},
        resolve_secret=lambda ref: secret,
    )
    assert result["verified_count"] == 0
    assert result["results"][0]["outcome"] == "rejected"
    assert result["no_hit"] is True


def test_pwd_crack_missing_or_invalid_credential_ref_makes_no_attempts(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    with pytest.raises(pwdcrack_adapter.CredentialRefError, match="不存在或未配置"):
        pwdcrack_adapter.run_credential_check(
            project,
            {"targets": [server.base_url], "credential_ref": "ghost"},
            resolve_secret=lambda ref: None,
        )
    with pytest.raises(pwdcrack_adapter.CredentialRefError, match="无法解析"):
        pwdcrack_adapter.run_credential_check(
            project,
            {"targets": [server.base_url], "credential_ref": "cred"},
            resolve_secret=lambda ref: "garbage-payload",
        )


def test_pwd_crack_cancellation_marks_unknown_outcome_not_retried(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    from pathlib import Path as _P

    # 先错误组合（不命中，循环继续），再正确组合——第 4 次请求时触发取消
    secret = json.dumps({"pairs": [
        {"username": "root", "password": "toor"},
        {"username": "admin", "password": "s3cret-pass"},
    ]})
    gate = {"cancelled": False}

    def cancel() -> bool:
        return gate["cancelled"]

    fetch_calls = {"n": 0}
    original = web_collect.fetch_url

    def counting(url: str, **kwargs):
        fetch_calls["n"] += 1
        if fetch_calls["n"] > 3:
            gate["cancelled"] = True
            raise pwdcrack_adapter.CredentialCheckError("模拟中断")
        return original(url, **kwargs)

    result = pwdcrack_adapter.run_credential_check(
        project,
        {"targets": [f"{server.base_url}/login", f"{server.base_url}/protected"], "credential_ref": "cred"},
        resolve_secret=lambda ref: secret,
        cancel_check=cancel,
        fetcher=counting,
    )
    assert result["cancelled"] is True
    assert result["batch"]["unknown_outcome"] >= 1
    # 恢复语义（§8.3）：副作用动作 unknown_outcome 不自动重试
    batch_file = project.path / result["batch"]["batch_path"]
    record = json.loads(batch_file.read_text(encoding="utf-8"))
    assert any(status == "unknown_outcome" for status in record["targets"].values())
    # 再次以相同参数恢复：unknown_outcome 不进入重试集合
    rerun = pwdcrack_adapter.run_credential_check(
        project,
        {"targets": [f"{server.base_url}/login", f"{server.base_url}/protected"], "credential_ref": "cred"},
        resolve_secret=lambda ref: secret,
        cancel_check=lambda: False,
        fetcher=lambda url, **kwargs: web_collect.fetch_url(url, **kwargs),
    )
    retried = {f"{item['target']}|{item['username']}" for item in rerun["results"]}
    assert not any(
        status == "unknown_outcome" and key in retried
        for key, status in record["targets"].items()
    )


def test_js_scan_offscope_script_is_skipped_not_fatal(
    project: ProjectStore, server: LocalFixtureServer,
) -> None:
    """外链脚本（授权范围外）被跳过并显式标注，不拖垮整个目标采集。"""
    page = (b"<html><head>"
            b'<script src="http://127.0.0.1:1/evil.js"></script>'
            b'<script src="/js/app.js"></script></head></html>')

    class _ScopedServer(LocalFixtureServer):
        pass

    import http.server
    import threading

    handler = type("H", (http.server.BaseHTTPRequestHandler,), {
        "do_GET": lambda self: (
            self.send_response(200),
            self.send_header("Content-Length", str(len(page))),
            self.end_headers(),
            self.wfile.write(page),
        ),
        "log_message": lambda *a: None,
    })
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{port}"

        def fetcher(url: str, **kwargs):
            if not url.startswith(base):
                raise RuntimeError("目标 example.com 不在授权范围内（scope 测试注入）")
            return web_collect.fetch_url(url, **kwargs)

        result = web_collect.run_js_scan(project, {"targets": [base]}, fetcher=fetcher)
        assert result["file_count"] == 2  # 外链 + 本站脚本都有记录
        by_url = {f["source_url"]: f for f in result["files"]}
        offscope = by_url["http://127.0.0.1:1/evil.js"]
        assert offscope["fetch_error"] and offscope.get("skipped_out_of_scope") is True
        assert offscope["leads"] == []
        # 本站脚本照常采集
        assert (project.path / by_url[f"{base}/js/app.js"]["evidence_path"]).is_file()
    finally:
        httpd.shutdown()
        httpd.server_close()
