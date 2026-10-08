"""P1 工具网关定向测试：权限交集、capability_missing、受控 HTTP、业务提交链、
审计与项目绑定（方案 §6.1-6.4、§12-P1；验收 §13.1-4/5）。"""

from __future__ import annotations

import http.server
import json
import socketserver
import threading
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne.tool_gateway import GatewayIdentity, ToolGateway


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("gateway-fixture")
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized",
        "scope": ["fixture.invalid", "127.0.0.1"],
        "out_of_scope": ["denied.example"],
        "targets": ["https://fixture.invalid"],
    }))
    return store


def _gateway(store: ProjectStore, role: str, **binding) -> ToolGateway:
    return ToolGateway(store, GatewayIdentity(
        vendor=store.vendor, member_name=f"{role}-1", role=role, **binding,
    ))


# ── 权限交集与运行时拒绝（§6.4、§13.1-4/5）─────────────────────────────

def test_non_execution_roles_cannot_bash_scan_or_http(project: ProjectStore) -> None:
    for role in ("orchestrator", "planner", "reviewer"):
        gateway = _gateway(project, role)
        for name, arguments in (
            ("Bash", {"command": "id"}),
            ("http_request", {"url": "https://fixture.invalid/"}),
            ("pwd_crack", {"targets": ["https://fixture.invalid"]}),
        ):
            output, is_error = gateway.dispatch(name, arguments)
            assert is_error, f"{role} 调用 {name} 必须被运行时拒绝"
            assert "permission_denied" in output, output


def test_model_visible_tools_exclude_bash_for_new_roles(project: ProjectStore) -> None:
    names = {
        definition["function"]["name"]
        for definition in _gateway(project, "operator").tool_definitions()
    }
    assert "Bash" not in names
    assert {"http_request", "session_ref", "query_results", "record_finding"} <= names
    # 无配方的 helper_recipe 不进入可见列表；未实现扫描引擎不进入可见列表。
    assert "helper_recipe" not in names
    assert "poc_scan" not in names and "pwd_crack" not in names
    planner_names = {
        definition["function"]["name"]
        for definition in _gateway(project, "planner").tool_definitions()
    }
    assert planner_names == {
        "project_summary", "list_facts", "query_results", "query_http",
        "target_profile_query", "tool_query", "submit_plan",
    }
    # 旧 executor 保留迁移期 Bash 名称。
    legacy_names = {
        definition["function"]["name"]
        for definition in _gateway(project, "executor").tool_definitions()
    }
    assert "Bash" in legacy_names


def test_capability_missing_for_unimplemented_engines(project: ProjectStore) -> None:
    cases = [
        ("crack", "pwd_crack", {"targets": ["https://fixture.invalid"]}, "P3"),
        ("poc", "poc_scan", {"targets": ["https://fixture.invalid"]}, "P2"),
        ("recon", "dir_scan", {"targets": ["https://fixture.invalid"]}, "P3"),
        ("reviewer", "submit_review", {"mode": "finding_review", "payload": {}}, "P2"),
    ]
    for role, capability, arguments, phase in cases:
        output, is_error = _gateway(project, role).dispatch(capability, arguments)
        assert is_error
        assert "capability_missing" in output, output
        assert phase in output, f"{capability} 缺口说明应包含目标阶段 {phase}"


def test_operator_cannot_dispatch_and_specialists_stay_in_lane(project: ProjectStore) -> None:
    # operator 不能自行 dispatch（§13.1-5）。
    output, is_error = _gateway(project, "operator").dispatch(
        "submit_dispatch", {"direction_id": "I-1", "reason": "x"},
    )
    assert is_error and "permission_denied" in output
    # recon 不能调用 pwd_crack（§13.1-5）。
    output, is_error = _gateway(project, "recon").dispatch(
        "pwd_crack", {"targets": ["https://fixture.invalid"]},
    )
    assert is_error and "permission_denied" in output


def test_argument_schema_enforced(project: ProjectStore) -> None:
    gateway = _gateway(project, "operator")
    # 未定义参数（extra_args 绕过被拒，§6.3）。
    output, is_error = gateway.dispatch(
        "http_request", {"url": "https://fixture.invalid/", "extra_args": "--admin"},
    )
    assert is_error and "invalid_arguments" in output
    # 缺必填。
    output, is_error = gateway.dispatch("http_request", {})
    assert is_error and "必填参数" in output
    # 枚举越界。
    output, is_error = gateway.dispatch(
        "http_request", {"url": "https://fixture.invalid/", "method": "CONNECT"},
    )
    assert is_error and "invalid_arguments" in output


def test_server_authority_fields_dropped_and_audited(project: ProjectStore) -> None:
    gateway = _gateway(project, "planner", run_id="R-real", control_version=7)
    output, is_error = gateway.dispatch("project_summary", {
        "project_id": "OTHER-PROJECT", "run_id": "FAKE", "control_version": 999,
    })
    assert not is_error, output
    audit = store_read(project, "tool_calls.jsonl")[-1]
    assert audit["dropped_server_fields"] == ["project_id", "run_id", "control_version"]
    assert audit["run_id"] == "R-real" and audit["control_version"] == 7
    assert audit["role"] == "planner"


def store_read(store: ProjectStore, name: str) -> list[dict]:
    return store.read_jsonl(name)


# ── 受控 HTTP（真实本地夹具服务）───────────────────────────────────────

class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/landed")
            self.end_headers()
            return
        body = json.dumps({"path": self.path}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture()
def local_server():
    server = socketserver.TCPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_http_request_real_call_writes_evidence(project: ProjectStore, local_server: str) -> None:
    gateway = _gateway(project, "operator", run_id="R1", task_id="I-1")
    output, is_error = gateway.dispatch("http_request", {"url": f"{local_server}/probe?k=1"})
    assert not is_error, output
    result = json.loads(output)
    assert result["status"] == 200
    evidence = project.path / result["evidence_path"]
    assert evidence.is_file()
    assert evidence.with_name(evidence.name + ".sha256").is_file()
    transcript = evidence.read_text(encoding="utf-8", errors="replace")
    assert "tool_gateway http_request" in transcript
    assert "run: R1" in transcript and "task: I-1" in transcript


def test_http_request_follows_redirects_within_scope(project: ProjectStore, local_server: str) -> None:
    gateway = _gateway(project, "operator")
    output, is_error = gateway.dispatch("http_request", {"url": f"{local_server}/redirect"})
    assert not is_error, output
    result = json.loads(output)
    assert result["url"].endswith("/landed")
    assert result["redirect_chain"] and result["redirect_chain"][0].endswith("/landed")


def test_http_request_rejects_out_of_scope_and_denied(project: ProjectStore, local_server: str) -> None:
    gateway = _gateway(project, "operator")
    output, is_error = gateway.dispatch("http_request", {"url": "https://elsewhere.example/"})
    assert is_error and "不在授权范围内" in output
    # 范围内主机但命中不收路径子串（与 guardian.review_intent 同源语义）。
    output, is_error = gateway.dispatch("http_request", {"url": "https://fixture.invalid/denied.example/x"})
    assert is_error and "不收范围" in output


def test_http_request_unknown_session_ref_rejected(project: ProjectStore, local_server: str) -> None:
    gateway = _gateway(project, "operator")
    output, is_error = gateway.dispatch(
        "http_request", {"url": f"{local_server}/", "session_ref": "ghost"},
    )
    assert is_error and "会话引用" in output


# ── 业务提交走统一提交链（Guardian 只降不升）──────────────────────────

def test_record_finding_submits_candidate_through_commit_chain(project: ProjectStore) -> None:
    gateway = _gateway(project, "operator", job_id="J1")
    output, is_error = gateway.dispatch("record_finding", {
        "title": "网关候选",
        "evidence": "我发送了对照请求并观察到差异响应",
        "business_impact": "尚无直接业务损害，仅信息暴露",
        "evidence_path": "",
    })
    assert not is_error, output
    facts = store_read(project, "facts.jsonl")
    assert facts and facts[-1]["title"] == "网关候选"
    assert facts[-1]["proposed_by"] == "operator-1"
    # 只提交候选：Guardian 只降不升，不可能直写 confirmed 漏洞（§6.2）。
    assert facts[-1]["classification"] != "vulnerability" or facts[-1].get("review_status")
    # 提交链真实生效：commit_events 落库。
    from src.sorne.database import ControlDatabase

    database = ControlDatabase(project.path / "control_plane.db")
    with database.connect() as db:
        rows = db.execute(
            "SELECT COUNT(*) FROM commit_events WHERE source_type='tool_gateway'"
        ).fetchone()
    assert rows[0] >= 1


def test_negative_evidence_and_technology_observe(project: ProjectStore) -> None:
    gateway = _gateway(project, "recon", job_id="J2")
    output, is_error = gateway.dispatch("negative_evidence_submit", {
        "hypothesis": "目录遍历", "target": "https://fixture.invalid/",
        "reason": "对照请求无差异", "method": "受控请求对照",
        "evidence_type": "target_negative",
    })
    assert not is_error, output
    assert store_read(project, "negative_evidence.jsonl")

    output, is_error = gateway.dispatch("technology_observe", {
        "observations": [{
            "url": "https://fixture.invalid/", "technology": "Nginx",
            "evidence_path": "evidence/mrecon/x.http",
        }],
    })
    assert not is_error, output
    assert store_read(project, "technology_observations.jsonl")


def test_upsert_fact_rejects_unknown_fact(project: ProjectStore) -> None:
    gateway = _gateway(project, "operator")
    output, is_error = gateway.dispatch("upsert_fact", {
        "updates_fact_id": "F-missing", "title": "x",
        "evidence": "y" * 40, "business_impact": "z" * 20,
    })
    assert is_error and "不存在" in output


def test_workspace_guards(project: ProjectStore) -> None:
    gateway = _gateway(project, "operator")
    output, is_error = gateway.dispatch("workspace_write", {
        "path": "evidence/evil.txt", "content": "x",
    })
    assert is_error and ".sorne-work" in output
    output, is_error = gateway.dispatch("workspace_read", {"path": "control_plane.db"})
    assert is_error and "允许读取范围" in output
    output, is_error = gateway.dispatch("workspace_read", {"path": "../../etc/passwd"})
    assert is_error
    output, is_error = gateway.dispatch("workspace_write", {
        "path": ".sorne-work/notes.md", "content": "中间结论",
    })
    assert not is_error, output
    assert (project.path / ".sorne-work" / "notes.md").read_text(encoding="utf-8") == "中间结论"


# ── 计划协调：planner/orchestrator 分离（§4.2）────────────────────────

def test_submit_plan_only_for_planner_and_commits(project: ProjectStore) -> None:
    from src.sorne.planning import normalize_plan_batch  # noqa: F401  确认契约存在

    # plan_batch 通道的 Intent 携带 scope_refs=["*"]（methodology.
    # intent_from_hypothesis），需要通配授权项目（与真实项目 target 一致）。
    target = project.read_json("target.json")
    target["scope"] = ["*"]
    project.write_json("target.json", target)
    denied = _gateway(project, "operator").dispatch("submit_plan", {
        "plan": {"kind": "plan_batch", "hypotheses": []},
    })
    assert denied[1] and "permission_denied" in denied[0]

    gateway = _gateway(project, "planner", job_id="J3")
    plan = {
        "kind": "plan_batch",
        "strategy_summary": "覆盖认证边界",
        "hypotheses": [{
            "title": "登录重置越权", "statement": "重置接口未校验归属",
            "target": "https://fixture.invalid/reset", "dimension": "priv_esc_path",
            "validation_plan": {
                "verb": "verify",
                "evidence_sink": "evidence/planner/reset.txt",
                "success_criteria": "越权修改成功或 403",
                "method": "对照请求",
            },
        }],
    }
    output, is_error = gateway.dispatch("submit_plan", {"plan": plan})
    assert not is_error, output
    assert store_read(project, "plan_batches.jsonl")
    # 方向已注册：执行角色可按能力认领。
    from src.sorne.database import ControlDatabase
    from src.sorne.role_registry import member_can_claim

    database = ControlDatabase(project.path / "control_plane.db")
    directions = database.list_directions()
    assert directions
    assert any(
        member_can_claim("operator", item["intent"])
        for item in directions
    )


def test_submit_dispatch_activates_existing_direction_only(project: ProjectStore) -> None:
    from src.sorne.database import ControlDatabase

    database = ControlDatabase(project.path / "control_plane.db")
    database.register_direction({
        "id": "I-dispatch", "verb": "verify", "target": "https://fixture.invalid/",
        "hypothesis": "h", "success_criteria": "s", "priority_score": 0.0,
    })
    gateway = _gateway(project, "orchestrator", run_id="R9")
    output, is_error = gateway.dispatch("submit_dispatch", {
        "direction_id": "I-dispatch", "reason": "证据成熟",
    })
    assert not is_error, output
    claimed = database.claim_direction("w-dispatch")
    assert claimed and claimed["id"] == "I-dispatch"
    assert float(claimed["intent"].get("priority_score") or 0) > 0

    # 不存在的方向：dispatch 不创建任务（§4.2）。
    output, is_error = gateway.dispatch("submit_dispatch", {
        "direction_id": "I-nope", "reason": "x",
    })
    assert is_error and "不创建新任务" in output


def test_finish_task_requires_bound_direction_and_respects_claim(project: ProjectStore) -> None:
    from src.sorne.database import ControlDatabase

    database = ControlDatabase(project.path / "control_plane.db")
    database.register_direction({
        "id": "I-fin", "verb": "verify", "target": "t", "hypothesis": "h",
        "success_criteria": "s",
    })
    # operator 无 finish_task 能力（契约：编排角色持有）。
    output, is_error = _gateway(project, "operator", run_id="R1").dispatch(
        "finish_task", {"outcome": "completed", "reason": "done"},
    )
    assert is_error and "permission_denied" in output
    # 无绑定无 direction_id → 拒绝。
    output, is_error = _gateway(project, "orchestrator", run_id="R1").dispatch(
        "finish_task", {"outcome": "completed", "reason": "done"},
    )
    assert is_error and ("direction_id" in output or "绑定" in output)

    direction = database.claim_direction("R1:operator-primary")
    # 编排角色：跨运行终结被拒。
    output, is_error = _gateway(project, "orchestrator", run_id="OTHER").dispatch(
        "finish_task", {"outcome": "completed", "reason": "done", "direction_id": direction["id"]},
    )
    assert is_error and "跨运行" in output
    # 编排角色：同运行内已认领任务可声明终态。
    output, is_error = _gateway(project, "orchestrator", run_id="R1").dispatch(
        "finish_task", {"outcome": "completed", "reason": "验证闭环", "direction_id": direction["id"]},
    )
    assert not is_error, output
    assert database.get_direction(direction["id"])["status"] == "completed"


def test_query_tools_read_project_state(project: ProjectStore, local_server: str) -> None:
    gateway = _gateway(project, "operator")
    gateway.dispatch("http_request", {"url": f"{local_server}/a"})
    facts_gateway = _gateway(project, "reviewer")
    output, is_error = facts_gateway.dispatch("query_results", {"keyword": "fixture"})
    assert not is_error
    output, is_error = facts_gateway.dispatch("query_evidence", {"path_prefix": "evidence/gateway"})
    assert not is_error
    result = json.loads(output)
    assert result["total"] >= 1
    output, is_error = facts_gateway.dispatch("rule_query", {})
    assert not is_error
    output, is_error = _gateway(project, "planner").dispatch("tool_query", {"capability_id": "pwd_crack"})
    assert not is_error
    assert "P3" in output


def test_audit_trail_covers_every_dispatch(project: ProjectStore) -> None:
    gateway = _gateway(project, "planner", run_id="R5", job_id="J5")
    gateway.dispatch("project_summary", {})
    gateway.dispatch("Bash", {"command": "id"})
    gateway.dispatch("pwd_crack", {"targets": ["x"]})
    rows = store_read(project, "tool_calls.jsonl")
    assert len(rows) == 3
    statuses = [row["status"] for row in rows]
    assert statuses == ["ok", "rejected", "rejected"]
    assert rows[1]["error_kind"] == "permission_denied"
    assert rows[2]["error_kind"] == "permission_denied"
    assert all(row["run_id"] == "R5" and row["job_id"] == "J5" for row in rows)
    assert all(row["role"] == "planner" for row in rows)


def test_gateway_from_extra_binds_identity_from_runtime_only(project: ProjectStore) -> None:
    extra = {
        "role": "operator",
        "project_path": str(project.path.resolve()),
        "member_name": "operator-primary",
        "run_id": "R7",
        "task_id": "I-7",
        "control_version": 3,
    }
    gateway = ToolGateway.from_extra(extra)
    assert gateway is not None
    assert gateway.identity.vendor == project.vendor
    assert gateway.identity.role == "operator"
    assert gateway.identity.run_id == "R7" and gateway.identity.task_id == "I-7"
    # 缺少角色绑定时拒绝构造（严格模式不退回任意 Shell 循环）。
    assert ToolGateway.from_extra({"project_path": str(project.path)}) is None


# ── OpenAI 工具循环 × 网关集成（local_docker 兼容循环按角色注入）────────

def test_openai_tool_loop_uses_gateway_and_rejects_unauthorized_calls(
    project: ProjectStore,
    local_server: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.sorne import local_docker
    from src.sorne.drivers import DriverConfig

    rounds: list[list[dict]] = [
        # 第一轮：尝试 Bash（新角色无 compat_bash → 网关拒绝）+ 受控 HTTP。
        [
            {"id": "c1", "type": "function", "function": {
                "name": "Bash", "arguments": json.dumps({"command": "id"}),
            }},
            {"id": "c2", "type": "function", "function": {
                "name": "http_request", "arguments": json.dumps({"url": f"{local_server}/gw"}),
            }},
        ],
        # 第二轮：提交最终结构化输出。
        [],
    ]

    def fake_completion(messages, tools, *, timeout):
        tool_calls = rounds.pop(0)
        content = "" if tool_calls else json.dumps({"kind": "none", "reason": "done"})
        return {"choices": [{"message": {"role": "assistant", "content": content, "tool_calls": tool_calls}}]}

    monkeypatch.setattr(local_docker, "ensure_local_guest_image", lambda *a, **k: None)
    runtime = local_docker.LocalDockerRuntime(
        DriverConfig(type="claude-cli", base_url="http://relay.invalid", extra={
            "project_path": str(project.path.resolve()),
            "member_name": "operator-primary",
            "role": "operator",
            "run_id": "R-gw",
            "job_id": "J-gw",
            "claude_tool_compatibility": "openai",
        }),
        timeout=30,
        cancel_check=lambda: False,
        progress_callback=lambda event: None,
    )
    object.__setattr__(runtime.profile, "api_key", "test-key")
    monkeypatch.setattr(runtime, "_openai_chat_completion", fake_completion)

    payload = runtime._run_openai_tool_compatibility(
        "prompt", image="img", runtime_root=project.path / ".sorne-runtime",
    )
    assert payload["kind"] == "none"
    audit = store_read(project, "tool_calls.jsonl")
    bash_call = next(item for item in audit if item["tool_id"] == "compat_bash")
    http_call = next(item for item in audit if item["tool_id"] == "http_request")
    assert bash_call["status"] == "rejected" and bash_call["error_kind"] == "permission_denied"
    assert http_call["status"] == "ok" and http_call["run_id"] == "R-gw"
    # 受控请求真实落盘证据。
    assert list((project.path / "evidence" / "gateway").glob("*.http"))


def test_openai_tool_loop_refuses_unbound_session(project: ProjectStore) -> None:
    """缺少角色/项目绑定的会话无法执行角色白名单：严格模式拒绝启动
    （方案 §6.4：不能悄悄退回拥有任意 Shell 的工具循环）。"""
    from src.sorne import local_docker
    from src.sorne.drivers import DriverConfig

    runtime = local_docker.LocalDockerRuntime(
        DriverConfig(type="claude-cli", base_url="http://relay.invalid", extra={
            # 有项目路径但缺少角色绑定：无法执行角色白名单。
            "project_path": str(project.path.resolve()),
            "member_name": "unknown-role-member",
            "claude_tool_compatibility": "openai",
        }),
        timeout=10,
        cancel_check=lambda: False,
        progress_callback=lambda event: None,
    )
    object.__setattr__(runtime.profile, "api_key", "test-key")
    with pytest.raises(local_docker.LocalDockerError, match="角色/项目运行时绑定"):
        runtime._run_openai_tool_compatibility("prompt", image="img", runtime_root=project.path)
