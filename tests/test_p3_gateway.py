"""P3 网关接线与调度侧自动执行定向测试（方案 §6.6-3/4、§7A.4、§4.3、
§13.1-4/5/6/17/18 相关项）。

- 六个 P3 采集/验证工具经网关真实执行（本地夹具）；授权范围与角色白名单
  由运行时拒绝（不是 Prompt 约定）。
- 目录/JS 扫描结果自动入队独立研判（触发源接通）；分析器独立启停
  （analysis_config 覆盖 → 入队跳过、排队任务取消）。
- pwd_crack 的动作审批票据（requires_human_confirmation 方向）。
- 任务胶囊 tool_ref 的调度侧自动执行：引擎工具不经模型循环直接驱动，
  权限/审批/证据全部走网关；方向终态与事件留痕。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import resource_repository
from src.sorne import store as store_module
from src.sorne.database import ControlDatabase
from src.sorne.store import ProjectStore
from src.sorne.tool_gateway import GatewayIdentity, ToolGateway
from p3_fixture_server import LocalFixtureServer, fixture_json_for_scope


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    from src.sorne import team as team_module

    monkeypatch.setattr(team_module, "TEAMS_DIR", tmp_path / "teams")
    team_module.TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    store = ProjectStore("p3-gateway")
    store.init()
    resource_repository.ensure_defaults(store)
    return store


@pytest.fixture()
def server() -> LocalFixtureServer:
    fixture = LocalFixtureServer().start()
    store = None
    yield fixture
    fixture.stop()


@pytest.fixture()
def scoped(project: ProjectStore, server: LocalFixtureServer) -> ProjectStore:
    project.write_text("target.json", json.dumps(fixture_json_for_scope(server)))
    return project


@pytest.fixture()
def database(scoped: ProjectStore, server: LocalFixtureServer) -> ControlDatabase:
    database = ControlDatabase(scoped.path / "control_plane.db")
    database.register_direction({
        "id": "I-P3", "verb": "collect", "target": f"{server.base_url}/",
        "hypothesis": "目录与 JS 采集", "success_criteria": "采集记录落盘",
        "assigned_role": "recon", "tool_id": "dir_scan",
    }, tool_ref={"tool_id": "dir_scan", "arguments": {}})
    database.register_direction({
        "id": "I-CRED", "verb": "verify", "target": f"{server.base_url}/login",
        "hypothesis": "口令验证", "success_criteria": "验证结论与证据",
        "assigned_role": "crack", "tool_id": "pwd_crack",
        "requires_human_confirmation": True,
    })
    return database


def _gateway(project, role, run=None, task_id=None) -> ToolGateway:
    run_id, control_version = run if run else (None, None)
    return ToolGateway(project, GatewayIdentity(
        vendor=project.vendor, member_name=f"{role}-p3", role=role,
        run_id=run_id, task_id=task_id, control_version=control_version,
    ))


def test_recon_gateway_tools_execute_against_local_fixture(
    scoped: ProjectStore, server: LocalFixtureServer, database: ControlDatabase,
) -> None:
    run_id = database.create_run(scoped.vendor, "default", 120, 2)
    control_version = int(database.get_run(run_id)["control_version"])
    gw = _gateway(scoped, "recon", run=(run_id, control_version), task_id="I-P3")

    out, err = gw.dispatch("dir_scan", {"targets": [server.base_url]})
    assert not err, out
    assert '"engine": "sorne-native-dir-collect"' in out
    assert '"analysis_job_id"' in out
    jobs = database.list_analysis_jobs()
    assert any(job["analyzer_kind"] == "directory" for job in jobs)

    out, err = gw.dispatch("js_scan", {"targets": [server.base_url]})
    assert not err, out
    assert '"engine": "sorne-native-js-collect"' in out
    jobs = database.list_analysis_jobs()
    assert any(job["analyzer_kind"] == "js" for job in jobs)

    # subdomain_scan 走网关（无外发 DNS：注入内存 resolver，适配器本体
    # 的真实解析路径在 test_p3_engines 验证）
    import socket as socket_module

    scoped_module = pytest.importorskip("src.sorne.engine_adapters.web_collect")
    monkeypatch_dir = pytest.MonkeyPatch()
    monkeypatch_dir.setattr(
        socket_module, "getaddrinfo",
        lambda host, *a, **k: ([(socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]
                               if host in {"127.0.0.1", "www.127.0.0.1"} else
                               (_ for _ in ()).throw(socket_module.gaierror())),
    )
    try:
        out, err = gw.dispatch("subdomain_scan", {"targets": [server.base_url]})
        assert not err, out
        assert '"record_count"' in out or '"records"' in out
    finally:
        monkeypatch_dir.undo()


def test_scope_and_role_enforced_at_runtime(
    scoped: ProjectStore, server: LocalFixtureServer,
) -> None:
    gw = _gateway(scoped, "recon")
    out, err = gw.dispatch("dir_scan", {"targets": ["http://example.com"]})
    assert err and "不在授权范围内" in out

    # crack 不能调用 dir_scan；recon 不能调用 pwd_crack（§13.1-5）
    crack = _gateway(scoped, "crack")
    out, err = crack.dispatch("dir_scan", {"targets": [server.base_url]})
    assert err and "permission_denied" in out
    out, err = gw.dispatch("pwd_crack", {
        "targets": [server.base_url], "credential_ref": "x",
    })
    assert err and "permission_denied" in out

    # 非执行角色不得执行扫描（§13.1-4）
    for role in ("orchestrator", "planner", "reviewer"):
        denied = _gateway(scoped, role)
        out, err = denied.dispatch("dir_scan", {"targets": [server.base_url]})
        assert err, role
        assert "permission_denied" in out or "capability_missing" in out


def test_model_visible_tools_include_p3_scan_capabilities(scoped: ProjectStore) -> None:
    recon_tools = {d["function"]["name"] for d in _gateway(scoped, "recon").tool_definitions()}
    assert {"url_scan", "ip_scan", "subdomain_scan", "dir_scan", "js_scan"} <= recon_tools
    crack_tools = {d["function"]["name"] for d in _gateway(scoped, "crack").tool_definitions()}
    assert "pwd_crack" in crack_tools and "dir_scan" not in crack_tools
    planner_tools = {d["function"]["name"] for d in _gateway(scoped, "planner").tool_definitions()}
    assert not ({"dir_scan", "pwd_crack", "url_scan"} & planner_tools)


def test_analyzer_disable_config_skips_enqueue_and_cancels(
    scoped: ProjectStore, server: LocalFixtureServer, database: ControlDatabase,
) -> None:
    run_id = database.create_run(scoped.vendor, "default", 120, 2)
    control_version = int(database.get_run(run_id)["control_version"])
    scoped.write_text("analysis_config.json", json.dumps({
        "analyzers": {"directory": {"enabled": False}},
    }))
    gw = _gateway(scoped, "recon", run=(run_id, control_version), task_id="I-P3")

    out, err = gw.dispatch("dir_scan", {"targets": [server.base_url]})
    assert not err, out
    assert "已停用" in out
    kinds = {job["analyzer_kind"] for job in database.list_analysis_jobs()}
    assert "directory" not in kinds  # 停用的分析器不入队（§7A.4 独立启停）
    # js 未停用，仍应入队
    gw.dispatch("js_scan", {"targets": [server.base_url]})
    kinds = {job["analyzer_kind"] for job in database.list_analysis_jobs()}
    assert "js" in kinds


def test_pwd_crack_requires_approval_ticket_when_direction_demands_it(
    scoped: ProjectStore, server: LocalFixtureServer, database: ControlDatabase,
) -> None:
    from src.sorne.runtime_secrets import RuntimeSecretStore

    run_id = database.create_run(scoped.vendor, "default", 120, 2)
    control_version = int(database.get_run(run_id)["control_version"])
    RuntimeSecretStore.set_many(scoped.vendor, {
        "cred-fixture": json.dumps({"pairs": [
            {"username": "admin", "password": "s3cret-pass"},
        ]}),
    }, {"cred-fixture"})

    gw = _gateway(scoped, "crack", run=(run_id, control_version), task_id="I-CRED")
    out, err = gw.dispatch("pwd_crack", {
        "targets": [f"{server.base_url}/protected"], "credential_ref": "cred-fixture",
    })
    assert err and out.startswith("tool_error: approval_required")
    pending = scoped.read_jsonl("pending_approvals.jsonl")
    assert pending and pending[-1]["tool_id"] == "pwd_crack"

    # reviewer 开出绑定票据后放行（真实验证执行）
    reviewer = _gateway(scoped, "reviewer", run=(run_id, control_version))
    import hashlib
    params_digest = hashlib.sha256(json.dumps(
        {"tool_id": "pwd_crack", "targets": [f"{server.base_url}/protected"],
         "credential_ref": "cred-fixture"},
        ensure_ascii=False, sort_keys=True,
    ).encode()).hexdigest()[:16]
    review_out, review_err = reviewer.dispatch("submit_review", {
        "mode": "action_review",
        "payload": {
            "task_id": "I-CRED", "tool_id": "pwd_crack",
            "params_digest": params_digest, "decision": "approve",
            "rationale": "本地夹具授权验证",
        },
    })
    assert not review_err, review_out
    out, err = gw.dispatch("pwd_crack", {
        "targets": [f"{server.base_url}/protected"], "credential_ref": "cred-fixture",
    })
    assert not err, out
    assert '"verified_count": 1' in out
    assert '"approved_via_ticket"' in out


def test_tool_ref_auto_execution_drives_engine_without_model(
    scoped: ProjectStore, server: LocalFixtureServer, database: ControlDatabase,
) -> None:
    """tool_ref 调度侧自动执行：引擎调用直接经网关，方向终态/事件留痕。"""
    from src.sorne.automation import AutomationEngine

    direction = database.claim_direction(
        "w-recon", intent_filter=lambda intent: intent.get("assigned_role") == "recon",
    )
    assert direction["id"] == "I-P3"
    assert direction["tool_ref"] == {"tool_id": "dir_scan", "arguments": {}}

    run_id = database.create_run(scoped.vendor, "default", 120, 2)
    run = database.get_run(run_id)
    # 计划图 tool_ref 的 arguments 是完整参数；本夹具补目标
    direction["tool_ref"]["arguments"] = {"targets": [server.base_url]}
    payload = {
        "member": {
            "name": "recon-auto", "type": "mock", "role": "recon",
            "runtime_mode": "local-cli",
        },
        "direction": direction,
    }
    job_id = database.enqueue_job(run_id, "swarm", "recon-auto", "recon", payload)
    engine = AutomationEngine(scoped)
    claimed = database.claim_job(run_id, "swarm", "recon-auto", lease_seconds=60)
    assert claimed is not None and claimed["id"] == job_id
    summary = engine._execute_bound_engine_tool(
        run, claimed, payload["member"], direction, "dir_scan", direction["tool_ref"]["arguments"],
    )
    assert "已按任务胶囊执行" in summary
    job = next(j for j in database.list_jobs(run_id, "swarm") if j["id"] == job_id)
    assert job["status"] == "completed"
    assert job["result"]["payload"]["tool_id"] == "dir_scan"
    assert job.get("committed_at")
    updated = database.get_direction("I-P3")
    assert updated["status"] == "completed"
    assert "engine_scan_via_tool_ref" in str(updated.get("terminal_reason"))
    events = [e for e in database.events(run_id) if e.get("event_type") == "engine_tool_executed"]
    assert events and events[-1]["data"]["tool_id"] == "dir_scan"
    # 研判入队也发生了（网关内 enqueue）
    assert any(j["analyzer_kind"] == "directory" for j in database.list_analysis_jobs())


def test_tool_ref_auto_execution_failure_blocks_direction(
    scoped: ProjectStore, database: ControlDatabase,
) -> None:
    from src.sorne.automation import AutomationEngine

    direction = database.claim_direction(
        "w-recon", intent_filter=lambda intent: intent.get("assigned_role") == "recon",
    )
    run_id = database.create_run(scoped.vendor, "default", 120, 2)
    run = database.get_run(run_id)
    payload = {
        "member": {"name": "recon-auto", "type": "mock", "role": "recon",
                    "runtime_mode": "local-cli"},
        "direction": direction,
    }
    job_id = database.enqueue_job(run_id, "swarm", "recon-auto", "recon", payload)
    engine = AutomationEngine(scoped)
    claimed = database.claim_job(run_id, "swarm", "recon-auto", lease_seconds=60)
    assert claimed is not None and claimed["id"] == job_id
    summary = engine._execute_bound_engine_tool(
        run, claimed, payload["member"], direction,
        "dir_scan", {"targets": []},  # 非法参数 → invalid_arguments，不可重试
    )
    assert "执行失败" in summary
    job = next(j for j in database.list_jobs(run_id, "swarm") if j["id"] == job_id)
    assert job["status"] == "failed"
    updated = database.get_direction("I-P3")
    assert updated["status"] == "blocked"


def test_analyzer_runtime_secret_takes_precedence_over_inherited_api_key_env(
    scoped: ProjectStore, server: LocalFixtureServer, database: ControlDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """§7A.5 真实模型端到端中发现的缺陷回归：运行时秘密（按分析成员名
    引用）优先于继承配置里的 api_key_env——与 execution.run_member 一致。"""
    from src.sorne import analysis_service as service_module
    from src.sorne.analysis_service import AnalysisService
    from src.sorne.runtime_secrets import RuntimeSecretStore

    # 团队 reviewer 带 api_key_env=OPENAI_API_KEY（未设置的环境变量）
    scoped.write_text("team_config.json", json.dumps({"members": [{
        "name": "reviewer-quality", "type": "claude-cli", "role": "reviewer",
        "model": "fixture-model", "base_url": "https://fixture.invalid/anthropic",
        "api_key_env": "OPENAI_API_KEY", "runtime_mode": "local-cli",
    }]}))
    RuntimeSecretStore.set_many(
        scoped.vendor, {"analysis:directory": "fixture-secret-value"},
        {"analysis:directory"}, persist=False,
    )

    run_id = database.create_run(scoped.vendor, "default", 120, 2)
    control_version = int(database.get_run(run_id)["control_version"])
    gw = _gateway(scoped, "recon", run=(run_id, control_version), task_id="I-P3")
    gw.dispatch("dir_scan", {"targets": [server.base_url]})

    captured: dict = {}

    def fake_run_driver(config, prompt, **kwargs):
        captured["api_key_env"] = config.api_key_env
        captured["env"] = dict(config.env or {})
        return {
            "kind": "analysis_record", "analyzer_kind": "directory",
            "observations": [{
                "text": "夹具观察", "evidence_ref": "evidence/dir/x.json",
                "kind": "observed",
            }],
            "candidate_assessments": [],
            "recommended_followups": [],
            "uncertainties": [],
        }

    monkeypatch.setattr(service_module, "run_driver", fake_run_driver)
    summaries = AnalysisService(scoped).drain(max_jobs=1)
    assert any("分析完成" in s for s in summaries), summaries
    assert captured["api_key_env"] == "SORNE_RUNTIME_API_KEY"
    assert captured["env"].get("SORNE_RUNTIME_API_KEY") == "fixture-secret-value"
    records = database.list_analysis_records()
    assert records and records[-1]["record"]["model_analysis"] is True
