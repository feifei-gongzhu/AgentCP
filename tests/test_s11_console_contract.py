"""§11 前端与配置体验的固化验证：DOM 契约 + 真实 HTTP 断言。

按仓库既有做法分两层（用户决定"后端契约测试 + 手工验证"，见
test_frontend_entity_contract.py；浏览器可用性另行人工/脚本目检）：

1. DOM 契约：沿用 test_dom_contract.py 的静态断言方式，固定 §11 各视图
   的容器、渲染模块与文案钩子在 index.html / modules 中存在；
2. HTTP 契约：起真实 ControlPlaneHTTPServer（回环 + 端口 0），按 §11
   逐条断言聚合 API 的载荷形状与真实数据来源。

覆盖：七角色卡与健康状态（含无口令服务时 crack 显示“等待匹配服务”）、
计划视图依赖与跳转数据、运行视图工具进度与阻塞/取消原因、发现详情六段
证据链、独立研判面板全要素（含排队分析进度——回归：queued 而非 pending）、
工具健康与技能路由解释、项目级专属 Prompt 与角色模型选择保留、
不新增弹药/费用额度界面。
"""

from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne import webapp as webapp_module
from src.sorne.store import ProjectStore
from src.sorne.database import ControlDatabase
from src.sorne.plan_graph import submit_plan_graph
from src.sorne.automation import AutomationEngine

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
INDEX_HTML = (FRONTEND / "index.html").read_text(encoding="utf-8")
JS_FILES = sorted(FRONTEND.glob("*.js")) + sorted((FRONTEND / "modules").glob("*.js"))
ALL_JS = "\n".join(f.read_text(encoding="utf-8") for f in JS_FILES)

SEVEN_ROLES = [
    "orchestrator", "planner", "recon", "crack", "poc", "operator", "reviewer",
]
# §11 明确列出的健康状态区分（原文为七种）
HEALTH_STATES = [
    "ready", "running", "waiting_dependency", "no_matching_task",
    "capability_missing", "blocked", "disabled",
]


# ── DOM 契约（§11 各视图容器与渲染钩子）──────────────────────────

def test_dom_role_cards_view_contract() -> None:
    assert 'id="roleCards"' in INDEX_HTML
    assert 'id="roleCardsNote"' in INDEX_HTML
    team_health = (FRONTEND / "modules" / "team-health.js").read_text(encoding="utf-8")
    for state in HEALTH_STATES:
        assert state in team_health, f"team-health.js 缺少状态 {state}"
    # 七要素渲染钩子：职责/模型/运行时/能力/技能/当前任务/健康状态
    for hook in ("role-duty", "模型", "运行时", "role-caps", "role-skills", "当前任务", "healthChip"):
        assert hook in team_health, f"角色卡缺要素渲染：{hook}"


def test_dom_plan_view_contract() -> None:
    for node_id in ("planBatchesBody", "planTasksBody", "planTaskDetail", "plansSummary"):
        assert f'id="{node_id}"' in INDEX_HTML
    plan_view = (FRONTEND / "modules" / "plan-view.js").read_text(encoding="utf-8")
    assert "depends_on" in plan_view and "依赖" in plan_view
    assert "assigned_role" in plan_view
    assert "skill_snapshot" in plan_view and "方法卡" in plan_view
    assert "tool_calls" in plan_view and "工具调用" in plan_view
    assert "openFinding" in plan_view  # 任务 → 发现跳转入口


def test_dom_run_view_contract() -> None:
    for node_id in ("runToolProgressBody", "runBlockPanel", "runRoleBreakdown", "jobsBody"):
        assert f'id="{node_id}"' in INDEX_HTML
    assert "阻塞与取消原因" in INDEX_HTML and "工具进度" in INDEX_HTML
    assert "角色分工" in INDEX_HTML
    team_health = (FRONTEND / "modules" / "team-health.js").read_text(encoding="utf-8")
    assert "renderRunBlockPanel" in team_health and "取消" in team_health


def test_dom_evidence_chain_contract() -> None:
    chain = (FRONTEND / "modules" / "evidence-chain.js").read_text(encoding="utf-8")
    for stage in (
        "request_response", "engine_hits", "independent_analysis",
        "reviewer", "guardian", "human_verdict",
    ):
        assert stage in chain, f"证据链缺阶段 {stage}"
    assert "请求/响应 → 引擎命中 → 独立研判 → review → Guardian → 人工" in chain
    assert "/api/findings/chain" in chain and "/api/evidence/content" in chain


def test_dom_analysis_panel_contract() -> None:
    for node_id in ("analyzerConfigPanel", "analysisRecordsBody", "analysisPanelNote"):
        assert f'id="{node_id}"' in INDEX_HTML
    panel = (FRONTEND / "modules" / "analysis-panel.js").read_text(encoding="utf-8")
    assert "独立研判" in INDEX_HTML
    # 启用状态 / 模型 / 分析进度 / 版本 / 证据 / 建议 / 重分析入口
    assert "enabled_effective" in panel
    assert "queued_jobs" in panel and "待处理分析任务" in panel
    assert "prompt_version" in panel and "schema_version" in panel
    assert "source_task_id" in panel  # 证据溯源（行 title 含 source_task）
    assert "recommended_followups" in panel
    assert "重分析" in panel and "/api/analysis/reanalyze" in panel


def _strip_js_comments(source: str) -> str:
    """去掉行注释与块注释：契约只针对真实代码/UI 文案，注释里的引用不算。"""
    without_block = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return "\n".join(
        re.sub(r"//.*$", "", line) for line in without_block.splitlines()
    )


def test_dom_tools_health_and_routing_contract() -> None:
    for node_id in (
        "enginesBody", "toolsBody", "skillsBody",
        "routingFeaturesInput", "routingRoleSelect", "routingExplanation",
    ):
        assert f'id="{node_id}"' in INDEX_HTML
    tools_panel = (FRONTEND / "modules" / "tools-panel.js").read_text(encoding="utf-8")
    assert "engine_gap" in tools_panel and "引擎缺口" in tools_panel
    assert "能力未接入" in tools_panel
    assert "AI 出错" not in _strip_js_comments(tools_panel)  # 不把失败统一显示成“AI 出错”
    assert "/api/skills/routing" in tools_panel


def test_dom_project_prompt_and_model_selection_contract() -> None:
    assert 'id="mCustomPrompt"' in INDEX_HTML
    assert 'id="mModel"' in INDEX_HTML
    assert "专属提示词" in INDEX_HTML
    app_js = (FRONTEND / "app.js").read_text(encoding="utf-8")
    # 成员面板读写 custom_prompt 与 model（项目级专属 Prompt 与角色模型选择）
    assert 'member.custom_prompt = $("mCustomPrompt").value' in app_js
    assert '$("mCustomPrompt").value = member.custom_prompt || ""' in app_js


def test_dom_no_ammo_or_quota_ui() -> None:
    """§11 最后一条：不新增“剩余 AI 弹药/每日次数/Token 配额”界面。"""
    code = _strip_js_comments(ALL_JS)
    for keyword in ("弹药", "配额界面", "剩余次数", "Token 配额", "每日调用", "daily quota"):
        assert keyword not in INDEX_HTML, f"index.html 出现额度类界面文案：{keyword}"
        assert keyword not in code, f"前端代码出现额度类界面逻辑：{keyword}"
    # 输入控件也不应有额度/次数类字段
    quota_inputs = re.findall(r'id="[^"]*(?:quota|ammo|allowance)[^"]*"', INDEX_HTML, re.I)
    assert not quota_inputs, f"发现额度类输入控件：{quota_inputs}"


# ── HTTP 契约夹具（真实 ControlPlaneHTTPServer，回环 + 端口 0）─────

def _seven_role_team() -> dict:
    return {"members": [
        {"name": f"{role}-1", "type": "codex", "role": role, "model": None,
         "runtime_mode": "local-docker",
         "sandbox": "read-only" if role in {"orchestrator", "planner", "reviewer"} else "workspace-write"}
        for role in SEVEN_ROLES
    ] + [{
        # planner 用带模型与专属 Prompt 的配置，验证保留链路
        "name": "planner-model", "type": "openai-compatible", "role": "planner",
        "model": "deepseek-chat", "base_url": "https://api.example.com/v1",
        "api_key_env": "PLANNER_KEY", "runtime_mode": "local-docker",
        "sandbox": "read-only", "custom_prompt": "项目级专属提示词：先查负向证据再规划。",
    }]}


@pytest.fixture()
def seeded_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("s11-http")
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized", "scope": ["fixture.invalid"],
        "out_of_scope": ["denied.example"], "targets": ["https://fixture.invalid"],
    }, ensure_ascii=False))
    store.write_text("team_config.json", json.dumps(
        _seven_role_team(), ensure_ascii=False,
    ))

    database = ControlDatabase(store.path / "control_plane.db")
    record = submit_plan_graph(store, database, {"tasks": [
        {"task_key": "recon", "goal": "采集目录", "verb": "collect",
         "targets": ["https://fixture.invalid/"], "success_criteria": "x",
         "depends_on": [], "assigned_role": "recon", "tool_id": "dir_scan"},
        {"task_key": "verify", "goal": "验证组件", "verb": "verify",
         "targets": ["https://fixture.invalid/"], "success_criteria": "x",
         "depends_on": ["recon"], "assigned_role": "poc", "tool_id": "poc_scan",
         "skill_ids": ["shiro-verification"]},
    ]}, proposed_by="planner-model")
    directions = {item["task_key"]: item["direction_id"] for item in record["tasks"]}
    recon_direction = directions["recon"]

    engine = AutomationEngine(store)
    run_id = engine.start("default", timeout=120, max_workers=1)
    store.append_jsonl("tool_calls.jsonl", {
        "tool_call_id": "TC-1", "tool_id": "dir_scan", "run_id": run_id,
        "task_id": recon_direction, "role": "recon", "status": "ok",
        "started_at": "2026-10-09T00:00:00Z", "duration_ms": 800,
        "output_summary": "evidence/dir.json 已落盘",
    })
    store.append_jsonl("tool_calls.jsonl", {
        "tool_call_id": "TC-2", "tool_id": "dir_scan", "run_id": "OTHER-RUN",
        "task_id": "other", "role": "recon", "status": "ok",
        "started_at": "2026-10-09T00:00:01Z",
    })

    evidence = store.path / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "poc-request.txt").write_text(
        "POST /login HTTP/1.1\r\nHost: fixture.invalid\r\n\r\nuser=anonymous\n",
        encoding="utf-8",
    )
    (evidence / "poc-response.txt").write_text(
        'HTTP/1.1 200 OK\r\n\r\n{"account": "other-user"}\n', encoding="utf-8",
    )

    job, _ = database.enqueue_analysis_job(
        "poc", {"kind": "engine_hits"}, "hash-s11-http",
    )
    database.insert_analysis_record(
        analyzer_kind="poc", input_hash="hash-s11-http", record={
            "analysis_status": "completed",
            "conclusion": "响应包含其他账户数据，建议越权对照复核",
            "recommended_followups": [
                {"kind": "verify", "target": "https://fixture.invalid/login",
                 "reason": "匿名身份返回他账户数据"},
            ],
        }, job_id=str(job.get("id")), run_id=run_id,
        source_task_id=recon_direction, model_id="deepseek-chat",
        prompt_version="poc-analyzer-v1",
    )
    store.append_jsonl("review_flags.jsonl", {"fact_ids": ["F-S11"], "flag": "suspect_false_positive"})
    store.append_jsonl("facts.jsonl", {
        "id": "F-S11", "title": "登录接口认证绕过", "classification": "vulnerability",
        "severity": "high", "intent_id": recon_direction,
        "evidence_path": "evidence/poc-request.txt",
        "evidence_metrics": {
            "proof_refs": {
                "raw_request": ["evidence/poc-request.txt"],
                "raw_response": ["evidence/poc-response.txt"],
            },
        },
        "validator_result": {"certified": True, "reasons": ["请求/响应文件齐备"]},
        "quality_notes": ["Guardian 只降不升"],
    })
    store.append_jsonl("human_verdicts.jsonl", {
        "finding_id": "F-S11", "action": "accepted",
        "final_classification": "vulnerability", "final_severity": "high",
        "reason": "复现成功",
    })
    engine.cancel(run_id, "http_contract_stop_reason")
    return store


@pytest.fixture()
def empty_project(seeded_project: ProjectStore) -> ProjectStore:
    """无运行、无方向、无口令服务信号的项目（crack 等待匹配服务判定）。"""
    store = ProjectStore("s11-empty")
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized", "scope": ["fixture.invalid"],
        "targets": ["https://empty.invalid"],
    }, ensure_ascii=False))
    store.write_text("team_config.json", json.dumps(
        _seven_role_team(), ensure_ascii=False,
    ))
    return store


@pytest.fixture()
def http_server(seeded_project: ProjectStore):
    httpd = webapp_module.ControlPlaneHTTPServer(
        ("127.0.0.1", 0), webapp_module.AgentControlHandler,
    )
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def _get(base: str, path: str) -> dict:
    with urllib.request.urlopen(base + path, timeout=15) as response:
        assert response.status == 200, path
        return json.loads(response.read().decode("utf-8"))


def _post(base: str, path: str, body: dict):
    request = urllib.request.Request(
        base + path, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8") or "{}")


def _patch_engines(
    monkeypatch: pytest.MonkeyPatch,
    *,
    nuclei_available: bool,
) -> None:
    """引擎可用性固定化：测试不依赖本机是否预取了 Docker 镜像。"""
    from src.sorne.engine_adapters import fscan_adapter, nuclei_adapter

    monkeypatch.setattr(
        nuclei_adapter, "describe_status",
        lambda: (
            {"adapter": "nuclei-adapter", "available": True, "reason": ""}
            if nuclei_available else
            {"adapter": "nuclei-adapter", "available": False,
             "reason": "测试环境无 nuclei 镜像"}
        ),
    )
    monkeypatch.setattr(
        fscan_adapter, "describe_status",
        lambda: {"adapter": "fscan-adapter", "available": True, "reason": ""},
    )


# ── HTTP 契约（§11 逐条）─────────────────────────────────────────

def test_http_team_health_seven_cards_and_states(
    http_server: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_engines(monkeypatch, nuclei_available=False)
    payload = _get(http_server, "/api/team/health?vendor=s11-http")
    assert payload["ok"] is True
    assert [card["role"] for card in payload["roles"]] == SEVEN_ROLES
    assert sorted(payload["states"]) == sorted(HEALTH_STATES)
    for card in payload["roles"]:
        # 七要素齐备：职责/模型/运行时/能力/技能/当前任务/健康状态
        assert card["display_name"] and card["duty"] and card["deliverable"]
        assert set(card["member"]) >= {"name", "type", "model", "runtime_mode", "sandbox"}
        assert set(card["capabilities"]) == {"all", "effective", "missing"}
        assert isinstance(card["skills"], list)
        assert isinstance(card["current_tasks"], list)
        assert card["health"] in HEALTH_STATES
        assert card["health_reason"]
    # nuclei 引擎缺口如实落到 poc 卡（capability_missing，不伪造可用）
    poc = next(c for c in payload["roles"] if c["role"] == "poc")
    assert poc["health"] == "capability_missing"
    assert poc["engine_states"]["poc_scan"]["available"] is False
    assert "nuclei" in poc["health_reason"]


def test_http_crack_waits_for_matching_service_without_credentials_service(
    http_server: str, empty_project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_engines(monkeypatch, nuclei_available=True)
    payload = _get(http_server, "/api/team/health?vendor=s11-empty")
    crack = next(c for c in payload["roles"] if c["role"] == "crack")
    assert crack["health"] == "waiting_dependency"
    assert "等待匹配服务" in crack["health_reason"]
    assert "伪造" in crack["health_reason"]  # 明示不会用伪造调用证明上场


def test_http_plan_view_dependencies_roles_tools_and_results(http_server: str) -> None:
    payload = _get(http_server, "/api/plan?vendor=s11-http")
    assert payload["ok"] is True
    directions = {item["id"]: item for item in payload["directions"]}
    recon = next(
        d for d in directions.values() if d["assigned_role"] == "recon" and d["tool_ref"]
    )
    child = next(
        d for d in directions.values()
        if d["assigned_role"] == "poc" and d["depends_on"]
    )
    # 任务依赖：child 依赖 recon
    assert [dep["id"] for dep in child["depends_on"]] == [recon["id"]]
    assert dep_status_valid(child["depends_on"][0]["status"])
    # 委派角色 + 方法卡
    assert child["skill_ids"] == ["shiro-verification"]
    assert "shiro-verification" in payload["skill_cards"]
    # 工具调用（task_id = direction id）与结果（intent_id）挂在任务上：
    # 前端跳转（计划任务 → 工具调用与证据 → 发现）以这两组关联为数据源。
    assert recon["tool_calls"] and recon["tool_calls"][0]["tool_id"] == "dir_scan"
    assert recon["results"] and recon["results"][0]["fact_id"] == "F-S11"


def dep_status_valid(status: object) -> bool:
    return str(status) in {"open", "queued", "claimed", "waiting", "completed",
                           "dismissed", "cancelled", "failed"}


def test_http_run_tool_progress_and_cancel_reason(http_server: str) -> None:
    progress = _get(http_server, "/api/run/tools?vendor=s11-http")
    assert progress["ok"] is True
    run = progress["run"]
    assert run and run["status"] in {"stopped", "cancelled"}
    by_tool = {item["tool_id"]: item for item in progress["tools"]}
    assert by_tool["dir_scan"]["calls"] == 1
    assert by_tool["dir_scan"]["ok"] == 1
    assert by_tool["dir_scan"]["roles"] == ["recon"]
    assert "http_request" not in by_tool  # 其他 run 的调用不计入
    # 取消原因进 run.error，前端“阻塞与取消原因”面板由此渲染
    status = _get(http_server, "/api/automation/status?vendor=s11-http&compact=1")
    assert status["run"]["error"] == "http_contract_stop_reason"
    stop_events = [
        e for e in status["events"]
        if str(e.get("event_type")) in {"run_stopping", "run_stopped"}
    ]
    assert stop_events and all(
        (e.get("data") or {}).get("reason") == "http_contract_stop_reason"
        for e in stop_events
    )


def test_http_finding_chain_six_stages_with_readable_evidence(http_server: str) -> None:
    chain = _get(http_server, "/api/findings/chain?vendor=s11-http&finding_id=F-S11")
    assert chain["ok"] is True
    assert [stage["stage"] for stage in chain["chain"]] == [
        "request_response", "engine_hits", "independent_analysis",
        "reviewer", "guardian", "human_verdict",
    ]
    stages = {stage["stage"]: stage for stage in chain["chain"]}
    assert all(stage["available"] for stage in chain["chain"])
    refs = stages["request_response"]["detail"]["proof_refs"]
    assert refs["raw_request"] == ["evidence/poc-request.txt"]
    # 证据文件可读（前端内联展开读取的就是这个端点）
    content = _get(http_server, "/api/evidence/content?vendor=s11-http&path=evidence/poc-response.txt")
    assert content["ok"] is True and "other-user" in content["content"]
    assert stages["engine_hits"]["detail"]["tool_calls"][0]["tool_id"] == "dir_scan"
    analysis = stages["independent_analysis"]["detail"]["records"][0]
    assert analysis["conclusion"] and analysis["recommended_followups"]
    assert stages["reviewer"]["available"] is True
    assert stages["guardian"]["detail"]["certified"] is True
    assert stages["human_verdict"]["detail"]["action"] == "accepted"


def test_http_analysis_panel_full_elements(http_server: str) -> None:
    payload = _get(http_server, "/api/analysis?vendor=s11-http&limit=10")
    assert payload["ok"] is True
    analyzers = {a["analyzer_kind"]: a for a in payload["analyzers"]}
    assert sorted(analyzers) == ["directory", "js", "poc"]
    for analyzer in analyzers.values():
        assert "enabled_effective" in analyzer
        assert "model" in analyzer and "model_config_version" in analyzer
        assert analyzer["prompt_version"] and analyzer["schema_version"]
    poc = analyzers["poc"]
    assert poc["model"]["model"] == "deepseek-chat"
    record = payload["records"][0]
    assert record["analyzer_kind"] == "poc" and record["version"] == 1
    assert record["analysis_status"] == "completed"
    assert record["model_id"] == "deepseek-chat"
    assert record["input_hash"] and record["source_task_id"]
    assert record["record"]["conclusion"]
    assert len(record["record"]["recommended_followups"]) == 1
    # 回归：分析任务状态机是 queued→running→…，“pending”不是合法值；
    # 排队中的分析进度必须出现在面板（曾因状态值写错永远为空）。
    queued = payload["queued_jobs"]
    assert queued and all(
        job["status"] in {"queued", "running"} for job in queued
    )
    assert any(job["status"] == "queued" for job in queued)


def test_http_analysis_reanalyze_entry_roundtrip(http_server: str) -> None:
    panel = _get(http_server, "/api/analysis?vendor=s11-http&limit=10")
    record_id = panel["records"][0]["analysis_id"]
    status, result = _post(http_server, "/api/analysis/reanalyze", {
        "vendor": "s11-http", "analysis_id": record_id, "reason": "http-contract",
    })
    assert status == 200 and result["ok"] is True
    assert result["analysis_job_id"] and result["reanalysis_of"] == record_id
    # 重分析入队后面板能看见新的排队任务
    panel_after = _get(http_server, "/api/analysis?vendor=s11-http&limit=10")
    assert any(
        job["job_id"] == result["analysis_job_id"] for job in panel_after["queued_jobs"]
    )
    # 不存在的记录：如实 400，不伪造
    status, error = _post(http_server, "/api/analysis/reanalyze", {
        "vendor": "s11-http", "analysis_id": "AN-missing",
    })
    assert status == 400 and "不存在" in error["error"]


def test_http_tools_health_reports_engine_reason_not_model_error(
    http_server: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_engines(monkeypatch, nuclei_available=False)
    payload = _get(http_server, "/api/tools/health?vendor=s11-http")
    assert payload["ok"] is True
    engines = payload["engines"]
    assert engines["poc_scan"]["available"] is False
    assert engines["poc_scan"]["reason"]  # 真实缺口原因，不是“AI 出错”
    assert engines["dir_scan"]["available"] is True
    tools = {tool["id"]: tool for tool in payload["tools"]}
    assert {"url_scan", "dir_scan", "pwd_crack", "http_request"} <= set(tools)
    for tool in tools.values():
        assert "implemented" in tool and "available" in tool and "roles" in tool
    assert tools["pwd_crack"]["roles"] == ["crack"]


def test_http_skill_routing_explanation(http_server: str) -> None:
    payload = _get(
        http_server,
        "/api/skills/routing?vendor=s11-http&features=shiro&features=rememberMe",
    )
    assert payload["ok"] is True
    explanation = payload["explanation"]
    matches = {m["skill_id"]: m for m in explanation["matches"]}
    assert "shiro-verification" in matches
    shiro = matches["shiro-verification"]
    assert shiro.get("reasons") or shiro.get("matched_features")
    with_role = _get(
        http_server,
        "/api/skills/routing?vendor=s11-http&features=fastjson&role=poc",
    )
    assert with_role["ok"] is True and with_role["explanation"]["matches"]
    # 空特征：400 而不是伪造解释
    status = _get_status_error(
        http_server, "/api/skills/routing?vendor=s11-http&features="
    )
    assert status == 400


def _get_status_error(base: str, path: str) -> int:
    try:
        with urllib.request.urlopen(base + path, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


def test_http_config_preserves_custom_prompt_and_model_selection(http_server: str) -> None:
    config = _get(http_server, "/api/config?vendor=s11-http")["config"]
    planner = next(
        m for m in config["members"]
        if m["name"] == "planner-model"
    )
    assert planner["model"] == "deepseek-chat"
    assert planner["custom_prompt"].startswith("项目级专属提示词")
    # 保存后模型选择与专属 Prompt 都保留（写读回环）
    updated = json.loads(json.dumps(config))
    for member in updated["members"]:
        if member["name"] == "planner-model":
            member["custom_prompt"] = "更新后的项目级提示词：先核对授权范围。"
    status, saved = _post(http_server, "/api/config", {
        "vendor": "s11-http", "config": updated,
    })
    assert status == 200 and saved["ok"] is True
    persisted = _get(http_server, "/api/config?vendor=s11-http")["config"]
    planner_after = next(
        m for m in persisted["members"] if m["name"] == "planner-model"
    )
    assert planner_after["model"] == "deepseek-chat"
    assert planner_after["custom_prompt"] == "更新后的项目级提示词：先核对授权范围。"
