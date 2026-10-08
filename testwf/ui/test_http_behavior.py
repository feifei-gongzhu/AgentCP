"""HTTP 行为测试：真实子进程服务的路由、缓存头、路径防护与健康检查。"""
from __future__ import annotations

import time
from pathlib import Path

from src.sorne.store import ProjectStore

READYZ_REQUIRED_KEYS = {
    "ok", "status", "schema_version", "project_count", "outbox_pending",
    "outbox_failed", "projector_alive", "recovery_complete",
    "maintenance_projects", "errors", "dependencies",
}
PROJECT_REQUIRED_FIELDS = {
    "vendor", "phase", "gate_status", "run_status", "updated_at",
    "current_task", "goal", "target_count", "fact_count",
    "vulnerability_count", "quality_metrics",
}


def test_root_redirects_to_frontend(live_server) -> None:
    status, headers, _ = live_server.request("GET", "/")
    assert status == 302
    location = headers.get("location", "")
    assert location.startswith("/frontend/?vendor="), location


def test_frontend_index_served_with_no_store(live_server) -> None:
    status, headers, body = live_server.request("GET", "/frontend/")
    assert status == 200
    assert "text/html" in headers.get("content-type", "")
    text = body.decode("utf-8")
    assert "Sorne" in text
    assert 'id="app"' in text or 'src="app.js"' in text or 'app.js' in text
    cache_control = headers.get("cache-control", "")
    assert "no-store" in cache_control, cache_control
    assert "must-revalidate" in cache_control
    assert headers.get("pragma") == "no-cache"
    assert headers.get("expires") == "0"


def test_frontend_assets_revalidated_no_store(live_server) -> None:
    for asset in ("/frontend/app.js", "/frontend/styles.css", "/frontend/modules/api.js", "/frontend/modules/state.js"):
        status, headers, _ = live_server.request("GET", asset)
        assert status == 200, asset
        assert "no-store" in headers.get("cache-control", ""), asset


def test_translate_path_blocks_escape_and_repo_files(live_server) -> None:
    probes = [
        ("/frontend/../src/sorne/webapp.py", "AgentControlHandler"),
        ("/frontend/modules/../../src/sorne/webapp.py", "AgentControlHandler"),
        ("/frontend/..%2fsrc%2fsorne%2fstore.py", "PROJECTS"),
        ("/.git/config", "[core]"),
        ("/src/sorne/store.py", "PROJECTS"),
        ("/projects/klook/target.json", "authorization"),
        ("/sorne", "_reexec_into_venv"),
        ("/tests/conftest.py", "RuntimeSecretStore"),
    ]
    for path, marker in probes:
        status, _, body = live_server.request("GET", path)
        assert status == 404, (path, status)
        assert marker.encode("utf-8") not in body, f"{path} 泄露了文件内容（包含 {marker!r}）"


def test_healthz_shape(live_server) -> None:
    status, payload = live_server.get_json("/healthz")
    assert status == 200
    assert payload == {"ok": True, "status": "alive"}


def test_readyz_shape_and_consistency(live_server) -> None:
    # 投影器恢复有短暂窗口，先轮询到 ready，超时则至少校验形状一致性。
    deadline = time.monotonic() + 15.0
    payload = None
    status = None
    while time.monotonic() < deadline:
        status, payload = live_server.get_json("/readyz")
        if payload.get("ok") is True:
            break
        time.sleep(0.3)
    assert payload is not None and status is not None
    assert READYZ_REQUIRED_KEYS <= set(payload), sorted(READYZ_REQUIRED_KEYS - set(payload))
    assert payload["status"] in {"ready", "not_ready"}
    assert payload["ok"] is (payload["status"] == "ready")
    assert payload["projector_alive"] is True
    assert (status == 200) if payload["ok"] else (status == 503)


def test_api_projects_isolated_from_real_projects(live_server) -> None:
    status, payload = live_server.get_json("/api/projects")
    assert status == 200
    assert payload["ok"] is True
    assert payload["projects"] == [], "空隔离目录下不应列出任何项目（更不能扫到真实 projects/klook）"
    assert payload["quality_summary"] is not None


def test_api_projects_fields_complete(live_server, server_projects: Path) -> None:
    ProjectStore("ui-field-check").init()
    status, payload = live_server.get_json("/api/projects")
    assert status == 200
    vendors = [entry["vendor"] for entry in payload["projects"]]
    assert vendors == ["ui-field-check"]
    entry = payload["projects"][0]
    missing = PROJECT_REQUIRED_FIELDS - set(entry)
    assert not missing, f"/api/projects 字段缺失：{sorted(missing)}"
    assert entry["gate_status"] == "running"
    assert entry["run_status"] == "idle"
    assert entry["target_count"] == 0
    assert entry["fact_count"] == 0


def test_api_error_json_has_displayable_error(live_server) -> None:
    status, payload = live_server.get_json("/api/project/state?vendor=no-such-project")
    assert status == 404
    assert payload["ok"] is False
    error = payload.get("error")
    assert isinstance(error, str) and error.strip(), payload
    assert "项目不存在" in error
    # error 是纯文本（可被前端 showToast 的 textContent 安全展示，无 HTML 标签）
    assert "<" not in error and ">" not in error
