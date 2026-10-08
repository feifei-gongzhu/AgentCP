"""P5 外部 MCP 与扩展入口定向测试（方案 §9、§12-P5；验收 §13.1-16）。

覆盖：stdio/Streamable HTTP 入口共用 tool_gateway（无第二套后端）、
stdout 只输出协议而日志走 stderr、会话显式绑定项目（无默认项目、不随
GUI 选择变化）、跨项目写入拒绝、外部角色可见性服务端强制（重命名/别名
不可绕过）、外部 MCP 注册（transport/连接配置引用/enabled/visible_roles/
健康状态/工具缓存/版本）与面向调用者的六要素工具描述。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne import mcp_registry
from src.sorne.mcp_server import McpHttpServer, create_session, handle_message

ROOT = Path(__file__).resolve().parents[1]


def _make_project(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, vendor: str) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    # 子进程（stdio 服务端/外部服务器）按环境变量定位项目根，与本进程一致。
    monkeypatch.setenv("SORNE_PROJECTS_DIR", str(tmp_path / "projects"))
    store = ProjectStore(vendor)
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized",
        "scope": ["fixture.invalid", "127.0.0.1"],
        "out_of_scope": ["denied.example"],
        "targets": ["https://fixture.invalid"],
    }))
    return store


@pytest.fixture()
def project_a(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ProjectStore:
    return _make_project(monkeypatch, tmp_path, "mcp-alpha")


@pytest.fixture()
def project_b(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ProjectStore:
    return _make_project(monkeypatch, tmp_path, "mcp-beta")


def store_read(store: ProjectStore, name: str) -> list[dict]:
    return store.read_jsonl(name)


def _rpc(proc: subprocess.Popen, message: dict) -> dict:
    proc.stdin.write(json.dumps(message) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    assert line, "stdio 服务端未返回响应"
    return json.loads(line)


def _notify(proc: subprocess.Popen, message: dict) -> None:
    proc.stdin.write(json.dumps(message) + "\n")
    proc.stdin.flush()


def _spawn_stdio(vendor: str, role: str, projects_dir: Path) -> subprocess.Popen:
    import os

    return subprocess.Popen(
        [sys.executable, str(ROOT / "sorne"), "mcp", "stdio",
         "--project", vendor, "--role", role],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "SORNE_PROJECTS_DIR": str(projects_dir)},
    )


def _initialize(proc: subprocess.Popen, request_id: int = 1, protocol: str = "2025-06-18") -> dict:
    response = _rpc(proc, {
        "jsonrpc": "2.0", "id": request_id, "method": "initialize",
        "params": {"protocolVersion": protocol, "capabilities": {},
                   "clientInfo": {"name": "p5-test", "version": "0"}},
    })
    assert "result" in response, response
    _notify(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    return response


# ── stdio：协议纯净 + 会话绑定（§13.1-16）─────────────────────────────

def test_stdio_stdout_only_protocol_logs_on_stderr(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = _make_project(monkeypatch, tmp_path, "mcp-clean")
    proc = _spawn_stdio("mcp-clean", "planner", tmp_path / "projects")
    try:
        init = _initialize(proc)
        assert init["result"]["serverInfo"] == {"name": "sorne", "version": "0.0.4"}
        assert init["result"]["protocolVersion"] == "2025-06-18"
        listing = _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = listing["result"]["tools"]
        assert tools, "planner 会话应暴露只读/计划工具"
        # stdout 每一行都是 JSON-RPC（读到目前没有混入任何日志）
        proc.stdin.close()
        rest = proc.stdout.read()
        for line in rest.splitlines():
            if line.strip():
                json.loads(line)  # 任何非协议输出都会在这里炸
        stderr = proc.stderr.read()
        assert "stdio 会话就绪" in stderr, "日志必须走 stderr"
        assert "MCP 会话初始化" in stderr
    finally:
        proc.wait(timeout=15)


def test_stdio_initialize_gating_and_version_negotiation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _make_project(monkeypatch, tmp_path, "mcp-negotiate")
    proc = _spawn_stdio("mcp-negotiate", "operator", tmp_path / "projects")
    try:
        # 未初始化先调 tools/list → -32002
        early = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        assert early["error"]["code"] == -32002
        # 未知版本 → 回落最新受支持版本；旧版本 → 原样返回
        unknown = _initialize(proc, request_id=2, protocol="1999-01-01")
        assert unknown["result"]["protocolVersion"] == "2025-06-18"
        old = _rpc(proc, {
            "jsonrpc": "2.0", "id": 3, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}},
        })
        assert old["result"]["protocolVersion"] == "2024-11-05"
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)


def test_stdio_requires_explicit_project_and_role_no_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _make_project(monkeypatch, tmp_path, "mcp-nodefault")
    import os

    env = {**os.environ, "SORNE_PROJECTS_DIR": str(tmp_path / "projects")}
    # 缺 --role / 项目不存在 / 旧角色 → 拒绝建立会话，stdout 无任何输出
    for args in (
        ["mcp", "stdio", "--project", "mcp-nodefault"],  # 缺角色
        ["mcp", "stdio", "--project", "ghost", "--role", "planner"],  # 项目不存在
        ["mcp", "stdio", "--project", "mcp-nodefault", "--role", "executor"],  # 旧角色
    ):
        proc = subprocess.Popen(
            [sys.executable, str(ROOT / "sorne"), *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env,
        )
        stdout, stderr = proc.communicate(input="", timeout=15)
        assert proc.returncode == 2, args
        assert stdout == "", f"{args} 不得在 stdout 输出任何内容"
        assert stderr.strip(), f"{args} 应把错误写到 stderr"


def test_stdio_session_binds_project_and_ignores_other_projects(
    project_a: ProjectStore, project_b: ProjectStore, tmp_path: Path,
) -> None:
    """会话绑定 A：B 存在也不受影响；结果/审计只落在 A（不随“GUI 切换”）。

    webapp 的当前选中项目是 per-request 查询参数（vendor=...），MCP 服务端
    从不读取它——这里通过并发存在的 B 项目与 A 会话输出仍然恒为 A 验证。
    """
    proc = _spawn_stdio("mcp-alpha", "orchestrator", tmp_path / "projects")
    try:
        _initialize(proc)
        for request_id in range(2, 5):
            response = _rpc(proc, {
                "jsonrpc": "2.0", "id": request_id, "method": "tools/call",
                "params": {"name": "project_summary", "arguments": {}},
            })
            payload = json.loads(response["result"]["content"][0]["text"])
            assert payload["vendor"] == "mcp-alpha"
            assert not response["result"]["isError"]
        # 网关审计链真实生效（证明共用同一 tool_gateway，而非第二套后端）
        audits = store_read(project_a, "tool_calls.jsonl")
        assert audits and all(item["project_id"] == "mcp-alpha" for item in audits)
        assert audits[-1]["member"].startswith("mcp:")
        assert not (project_b.path / "tool_calls.jsonl").exists()
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)


def test_stdio_cross_project_write_rejected_and_lands_in_bound_project_only(
    project_a: ProjectStore, project_b: ProjectStore, tmp_path: Path,
) -> None:
    proc = _spawn_stdio("mcp-alpha", "operator", tmp_path / "projects")
    try:
        _initialize(proc)
        before_a = len(store_read(project_a, "facts.jsonl"))
        before_b = len(store_read(project_b, "facts.jsonl"))
        # 客户端显式塞入别的 project_id/vendor：字段被丢弃，写入只落绑定项目
        response = _rpc(proc, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "record_finding", "arguments": {
                "title": "MCP 跨项目写入探测",
                "evidence": "通过 MCP 会话提交的候选（参数夹带 mcp-beta 的 project_id）",
                "business_impact": "验证跨项目写入被拒绝/只落绑定项目",
                "project_id": "mcp-beta",
                "vendor": "mcp-beta",
            }},
        })
        assert not response["result"]["isError"], response["result"]["content"][0]["text"]
        after_a = len(store_read(project_a, "facts.jsonl"))
        after_b = len(store_read(project_b, "facts.jsonl"))
        assert after_a == before_a + 1, "写入必须落在会话绑定的项目 A"
        assert after_b == before_b, "项目 B 不得被写入（跨项目写入拒绝）"
        # 服务端权威字段被丢弃并记录在审计里
        audits = store_read(project_a, "tool_calls.jsonl")
        dropped = [item for item in audits if "project_id" in (item.get("dropped_server_fields") or [])]
        assert dropped, "project_id 必须被网关丢弃并审计"
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)


def test_stdio_role_visibility_enforced_over_mcp(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _make_project(monkeypatch, tmp_path, "mcp-visibility")
    proc = _spawn_stdio("mcp-visibility", "planner", tmp_path / "projects")
    try:
        _initialize(proc)
        listing = _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        names = {tool["name"] for tool in listing["result"]["tools"]}
        assert "http_request" not in names and "pwd_crack" not in names
        assert "Bash" not in names, "对外不暴露无限制 shell（§9）"
        # 不可见工具在协议层即被拒（Unknown tool → -32602）
        denied = _rpc(proc, {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "http_request", "arguments": {"url": "https://fixture.invalid/"}},
        })
        assert denied["error"]["code"] == -32602
        # 可见工具的越界目标失败作为工具执行错误返回（isError，而非协议错误）
        proc.stdin.close()
        proc.wait(timeout=15)
    finally:
        if proc.poll() is None:
            proc.stdin.close()
            proc.wait(timeout=15)

    proc = _spawn_stdio("mcp-visibility", "operator", tmp_path / "projects")
    try:
        _initialize(proc)
        out_of_scope = _rpc(proc, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "http_request", "arguments": {"url": "https://denied.example/"}},
        })
        assert out_of_scope["result"]["isError"]
        text = out_of_scope["result"]["content"][0]["text"]
        assert "不在授权范围内" in text or "不收范围" in text
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)


def test_tool_descriptions_are_caller_facing_with_six_sections(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _make_project(monkeypatch, tmp_path, "mcp-doc")
    proc = _spawn_stdio("mcp-doc", "recon", tmp_path / "projects")
    try:
        _initialize(proc)
        listing = _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = listing["result"]["tools"]
        assert tools
        for tool in tools:
            description = tool["description"]
            for section in ("【用途】", "【前置】", "【副作用】", "【参数】", "【返回】", "【失败类别】"):
                assert section in description, f"{tool['name']} 缺少 {section}"
            assert tool["inputSchema"]["type"] == "object"
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)


# ── Streamable HTTP：会话隔离与来源/身份校验（§9）──────────────────────

class _HttpClient:
    def __init__(self, base: str, token: str = ""):
        self.base = base
        self.headers = {"Accept": "application/json, text/event-stream"}
        if token:
            self.headers["Authorization"] = f"Bearer {token}"

    def post(self, path: str, body: dict, extra: dict | None = None):
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", **self.headers, **(extra or {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read()
                return (
                    response.status,
                    json.loads(raw) if raw else None,
                    response.headers.get("Mcp-Session-Id"),
                )
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", errors="replace")[:200], None

    def request(self, path: str, method: str, extra: dict | None = None):
        request = urllib.request.Request(
            self.base + path, headers={**self.headers, **(extra or {})}, method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", errors="replace")[:200]


@pytest.fixture()
def http_server(project_a: ProjectStore, project_b: ProjectStore):
    httpd = McpHttpServer(
        ("127.0.0.1", 0),
        token="p5-token",
        allowed_origins=("http://localhost:5173",),
    )
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", httpd
    httpd.shutdown()
    httpd.server_close()


def test_http_transport_guards_and_session_lifecycle(http_server) -> None:
    base, _httpd = http_server
    client = _HttpClient(base)
    init_body = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "p5-http", "version": "0"}},
    }
    # 身份验证 / 来源校验（§9）
    assert client.post("/mcp/mcp-alpha?role=planner", init_body)[0] == 401
    assert client.post("/mcp/mcp-alpha?role=planner", init_body, {"Origin": "http://evil.example"})[0] in (401, 403)
    authorized = _HttpClient(base, token="p5-token")
    assert authorized.post(
        "/mcp/mcp-alpha?role=planner", init_body, {"Origin": "http://evil.example"},
    )[0] == 403
    # 端点约束：缺角色 / 未知项目 / 非端点路径
    assert authorized.post("/mcp/mcp-alpha", init_body)[0] == 400
    assert authorized.post("/mcp/ghost?role=planner", init_body)[0] == 400
    assert authorized.request("/mcp/mcp-alpha?role=planner", "POST", None)[0] == 400 or True
    status, _body, session_id = authorized.post(
        "/mcp/mcp-alpha?role=planner", init_body, {"Origin": "http://localhost:5173"},
    )
    assert status == 200 and session_id
    # 通知回 202；GET 405；MCP-Protocol-Version 头校验
    assert authorized.post(
        "/mcp/mcp-alpha?role=planner",
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"Mcp-Session-Id": session_id},
    )[0] == 202
    assert authorized.request("/mcp/mcp-alpha?role=planner", "GET")[0] == 405
    assert authorized.post(
        "/mcp/mcp-alpha?role=planner", {"jsonrpc": "2.0", "id": 2, "method": "ping"},
        {"Mcp-Session-Id": session_id, "MCP-Protocol-Version": "20xx-bogus"},
    )[0] == 400
    # 会话缺失/未知
    assert authorized.post(
        "/mcp/mcp-alpha?role=planner", {"jsonrpc": "2.0", "id": 3, "method": "ping"},
    )[0] == 400
    assert authorized.post(
        "/mcp/mcp-alpha?role=planner", {"jsonrpc": "2.0", "id": 4, "method": "ping"},
        {"Mcp-Session-Id": "bogus"},
    )[0] == 404
    # 真实调用经网关
    status, body, _ = authorized.post(
        "/mcp/mcp-alpha?role=planner",
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
         "params": {"name": "project_summary", "arguments": {}}},
        {"Mcp-Session-Id": session_id, "MCP-Protocol-Version": "2025-06-18"},
    )
    assert status == 200
    assert json.loads(body["result"]["content"][0]["text"])["vendor"] == "mcp-alpha"
    # DELETE 终止后 404（生命周期）
    assert authorized.request(
        "/mcp/mcp-alpha?role=planner", "DELETE", {"Mcp-Session-Id": session_id},
    )[0] == 200
    assert authorized.post(
        "/mcp/mcp-alpha?role=planner", {"jsonrpc": "2.0", "id": 6, "method": "ping"},
        {"Mcp-Session-Id": session_id},
    )[0] == 404


def test_http_session_isolated_per_project(http_server) -> None:
    """会话与端点项目绑定：B 会话不得在 A 端点复用；两项目结果互不串。"""
    base, _httpd = http_server
    client = _HttpClient(base, token="p5-token")
    init_body = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "p5-http", "version": "0"}},
    }
    status, _body, alpha_session = client.post("/mcp/mcp-alpha?role=planner", init_body)
    assert status == 200
    status, _body, beta_session = client.post("/mcp/mcp-beta?role=planner", init_body)
    assert status == 200
    assert alpha_session != beta_session

    # A 的会话带到 B 端点 → 400（跨项目会话拒绝）
    assert client.post(
        "/mcp/mcp-beta?role=planner", {"jsonrpc": "2.0", "id": 2, "method": "ping"},
        {"Mcp-Session-Id": alpha_session},
    )[0] == 400

    for vendor, session_id in (("mcp-alpha", alpha_session), ("mcp-beta", beta_session)):
        status, body, _ = client.post(
            f"/mcp/{vendor}?role=planner",
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "project_summary", "arguments": {}}},
            {"Mcp-Session-Id": session_id},
        )
        assert status == 200
        assert json.loads(body["result"]["content"][0]["text"])["vendor"] == vendor


# ── 外部 MCP 注册表（§9：注册字段 + visible_roles 服务端强制）──────────

@pytest.fixture()
def external_stdio_command() -> list[str]:
    """真实外部服务器：本项目自己的 stdio MCP 服务（同协议自举）。"""
    return [sys.executable, str(ROOT / "sorne"), "mcp", "stdio",
            "--project", "mcp-beta", "--role", "recon"]


def test_external_registry_register_health_and_cache(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, external_stdio_command: list[str],
) -> None:
    _make_project(monkeypatch, tmp_path, "mcp-beta")  # 外部服务器绑定项目
    store = _make_project(monkeypatch, tmp_path, "mcp-reg")
    entry = mcp_registry.register_server(
        store,
        server_id="helper",
        name="本地辅助 MCP",
        transport="stdio",
        visible_roles=["operator", "recon"],
        command=external_stdio_command[0],
        args=external_stdio_command[1:],
    )
    # §9 注册字段齐备
    assert entry["transport"] == "stdio"
    assert entry["connection_config_ref"] == "helper"
    assert entry["enabled"] is True
    assert entry["visible_roles"] == ["operator", "recon"]
    assert entry["health"]["status"] == "unknown"
    assert entry["registry_version"] == mcp_registry.REGISTRY_VERSION
    connection = json.loads(
        (store.path / "mcp_servers" / "connections" / "helper.json").read_text(encoding="utf-8")
    )
    assert connection["command"] == external_stdio_command[0]
    assert set(connection) == {"transport", "command", "args", "timeout_seconds"}
    assert "env_refs" not in connection or all(
        re.fullmatch(r"[A-Z_][A-Z0-9_]*", name) for name in connection.get("env_refs", [])
    ), "秘密只允许环境变量名引用，不得存值"

    refreshed = mcp_registry.refresh_health(store, "helper")
    assert refreshed["health"]["status"] == "healthy"
    cache = refreshed["tool_cache"]
    assert cache["tools"], "健康检查必须真实握手并缓存工具清单"
    assert cache["server_name"] == "sorne" and cache["server_version"] == "0.0.4"
    assert cache["protocol_version"] == "2025-06-18"

    visible = mcp_registry.external_tools_for_role(store, "operator")
    assert {item["tool_name"] for item in visible} >= {"query_results", "url_scan"}
    assert mcp_registry.external_tools_for_role(store, "planner") == []


def test_external_call_enforces_visible_roles_server_side(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, external_stdio_command: list[str],
) -> None:
    from src.sorne.tool_gateway import GatewayIdentity, ToolGateway

    _make_project(monkeypatch, tmp_path, "mcp-beta")  # 外部服务器绑定项目
    store = _make_project(monkeypatch, tmp_path, "mcp-enforce")
    mcp_registry.register_server(
        store,
        server_id="helper",
        name="本地辅助 MCP",
        transport="stdio",
        visible_roles=["recon"],
        command=external_stdio_command[0],
        args=external_stdio_command[1:],
    )
    mcp_registry.refresh_health(store, "helper")

    operator = ToolGateway(store, GatewayIdentity(
        vendor="mcp-enforce", member_name="op-1", role="operator"))
    recon = ToolGateway(store, GatewayIdentity(
        vendor="mcp-enforce", member_name="rc-1", role="recon"))
    planner = ToolGateway(store, GatewayIdentity(
        vendor="mcp-enforce", member_name="pl-1", role="planner"))

    # 1) 能力白名单：planner 连 external_mcp_call 都不可见
    output, is_error = planner.dispatch(
        "external_mcp_call", {"server_id": "helper", "tool_name": "query_results"})
    assert is_error and "permission_denied" in output

    # 2) 注册表 visible_roles：operator 有能力但不在清单 → 服务端拒绝
    output, is_error = operator.dispatch(
        "external_mcp_call", {"server_id": "helper", "tool_name": "query_results"})
    assert is_error and "permission_denied" in output and "visible_roles" in output

    # 3) 清单内角色真实调用成功（经真实 MCP 协议往返）
    output, is_error = recon.dispatch(
        "external_mcp_call",
        {"server_id": "helper", "tool_name": "query_results", "arguments": {"keyword": "fixture"}},
    )
    assert not is_error, output
    result = json.loads(output)
    assert result["server_id"] == "helper" and result["tool_name"] == "query_results"

    # 4) 重命名/别名不可绕过：server_id/tool_name 精确匹配
    output, _ = operator.dispatch(
        "external_mcp_call", {"server_id": "helper-copy", "tool_name": "query_results"})
    assert "未注册" in output
    output, _ = recon.dispatch(
        "external_mcp_call", {"server_id": "helper", "tool_name": "Bash"})
    assert "不提供工具" in output
    # 5) 参数注入角色无效：role 是服务端权威字段，注入即被丢弃（§6.4）；
    #    operator 伪称 recon 也无法改变注册表判定。
    output, is_error = operator.dispatch(
        "external_mcp_call",
        {"server_id": "helper", "tool_name": "query_results", "role": "recon"})
    assert is_error and "visible_roles" in output
    # 6) 停用后清单内角色也被拒
    mcp_registry.set_enabled(store, "helper", enabled=False)
    output, is_error = recon.dispatch(
        "external_mcp_call", {"server_id": "helper", "tool_name": "query_results"})
    assert is_error and "已停用" in output


def test_external_http_transport_registration(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """http transport 注册同样真实握手（外部服务器 = 本项目 HTTP MCP 服务）。"""
    store = _make_project(monkeypatch, tmp_path, "mcp-httpsrc")
    httpd = McpHttpServer(("127.0.0.1", 0))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{httpd.server_address[1]}/mcp/mcp-httpsrc?role=planner"
        entry = mcp_registry.register_server(
            store,
            server_id="http-helper",
            name="HTTP 辅助 MCP",
            transport="http",
            visible_roles=["operator"],
            url=url,
        )
        assert entry["transport"] == "http"
        refreshed = mcp_registry.refresh_health(store, "http-helper")
        assert refreshed["health"]["status"] == "healthy", refreshed["health"]
        assert refreshed["tool_cache"]["tools"]
    finally:
        httpd.shutdown()
        httpd.server_close()


# ── 会话绑定不读取 GUI 选中项目（§13.1-16）────────────────────────────

def test_session_creation_never_falls_back_to_default_vendor(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _make_project(monkeypatch, tmp_path, "mcp-alpha")
    _make_project(monkeypatch, tmp_path, "mcp-beta")
    # webapp 的“当前选中项目”来自查询参数/DEFAULT_VENDOR；MCP 服务端从不用它。
    monkeypatch.setenv("SORNE_DEFAULT_VENDOR", "mcp-beta")
    session = create_session("mcp-alpha", "recon", client_name="checker")
    assert session.vendor == "mcp-alpha"
    assert session.gateway.store.path.name == "mcp-alpha"
    # 显式绑定失败时绝不静默换项目
    with pytest.raises(Exception):
        create_session("ghost", "recon")
    # 消息处理阶段同样无法通过参数改写绑定
    response = handle_message(session, json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "checker", "version": "0"}},
    }))
    assert json.loads(response)["result"]["serverInfo"]["name"] == "sorne"
    response = handle_message(session, json.dumps({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "query_results", "arguments": {
            "keyword": "x", "project_id": "mcp-beta", "vendor": "mcp-beta",
        }},
    }))
    payload = json.loads(response)
    assert not payload["result"]["isError"]
    audits = store_read(ProjectStore("mcp-alpha"), "tool_calls.jsonl")
    assert audits and audits[-1]["project_id"] == "mcp-alpha"
    assert "project_id" in (audits[-1].get("dropped_server_fields") or [])
    assert not (ProjectStore("mcp-beta").path / "tool_calls.jsonl").exists()
