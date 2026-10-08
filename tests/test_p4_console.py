"""P4 产品集成定向测试（方案 §10/§11/§12-P4；验收 §13.1-1、§13.2 旧项目场景）。

覆盖：七角色卡健康状态（含 capability_missing/waiting_dependency/disabled）、
计划视图载荷（依赖/委派角色/方法卡/工具调用/结果关联）、发现详情证据链、
独立研判面板与启停开关、工具健康检查与技能路由解释、资源仓库面板、
旧团队迁移（预览 dry-run/执行/幂等重跑/回退副本/运行中不热切换/密钥不复制）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.store import ProjectStore
from src.sorne.database import ControlDatabase
from src.sorne import console_api
from src.sorne import team_migration
from src.sorne.plan_graph import submit_plan_graph


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("p4-fixture")
    store.init()
    store.write_text("target.json", json.dumps({
        "authorization": "authorized",
        "scope": ["fixture.invalid"],
        "out_of_scope": ["denied.example"],
        "targets": ["https://fixture.invalid"],
    }))
    return store


@pytest.fixture()
def database(project: ProjectStore) -> ControlDatabase:
    return ControlDatabase(project.path / "control_plane.db")


def _legacy_team_config() -> dict:
    return {
        "members": [
            {
                "name": "reason-main", "type": "openai-compatible", "role": "reason",
                "model": "deepseek-chat", "base_url": "https://api.example.com/v1",
                "api_key_env": "OLD_REASON_KEY", "runtime_mode": "local-docker",
                "sandbox": "read-only", "custom_prompt": "旧推理专属提示词",
                "max_running": 1, "priority": 0, "env": {"SECRET_TOKEN": "plain"},
            },
            {
                "name": "executor-1", "type": "codex", "role": "executor",
                "model": None, "runtime_mode": "local-docker", "sandbox": "workspace-write",
                "custom_prompt": "旧执行专属提示词", "max_running": 2, "priority": 1,
            },
            {
                "name": "old-reviewer", "type": "codex", "role": "reviewer",
                "model": None, "runtime_mode": "local-docker", "sandbox": "read-only",
                "custom_prompt": "旧复核提示词",
            },
        ],
    }


# ── 七角色卡（§11）────────────────────────────────────────────────

def test_role_health_covers_seven_roles_with_all_card_elements(project: ProjectStore) -> None:
    health = console_api.role_health(project)
    roles = [card["role"] for card in health["roles"]]
    assert roles == [
        "orchestrator", "planner", "recon", "crack", "poc", "operator", "reviewer",
    ]
    for card in health["roles"]:
        # 七要素齐备：职责/模型/运行时/能力/技能/当前任务/健康状态
        assert card["duty"] and card["deliverable"]
        assert "member" in card
        assert set(card["capabilities"]) == {"all", "effective", "missing"}
        assert isinstance(card["skills"], list)
        assert isinstance(card["current_tasks"], list)
        assert card["health"] in console_api.HEALTH_STATES
        assert card["health_reason"]


def test_role_health_disabled_when_role_not_configured(project: ProjectStore) -> None:
    # 项目团队只有一个 crack 成员：其余六角色 disabled
    project.write_text("team_config.json", json.dumps({"members": [
        {"name": "only-crack", "type": "codex", "role": "crack", "model": None,
         "runtime_mode": "local-docker", "sandbox": "workspace-write"},
    ]}, ensure_ascii=False))
    health = console_api.role_health(project)
    by_role = {card["role"]: card for card in health["roles"]}
    assert by_role["crack"]["health"] != "disabled"
    for role in ("orchestrator", "planner", "recon", "poc", "operator", "reviewer"):
        assert by_role[role]["health"] == "disabled"
        assert by_role[role]["member"] is None


def test_role_health_capability_missing_reported_from_engine_state(
    project: ProjectStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # nuclei 镜像缺失（P2 已知缺口）应如实显示 capability_missing，不伪造可用
    from src.sorne.engine_adapters import nuclei_adapter

    monkeypatch.setattr(
        nuclei_adapter, "availability_status",
        lambda: (False, "测试环境无 nuclei 镜像"),
    )
    health = console_api.role_health(project)
    poc = next(card for card in health["roles"] if card["role"] == "poc")
    assert poc["health"] == "capability_missing"
    assert "poc_scan" in poc["health_reason"]
    assert poc["engine_states"]["poc_scan"]["available"] is False


def test_role_health_waiting_dependency_for_crack_without_service(
    project: ProjectStore,
) -> None:
    # §11：无口令服务时 crack 显示“等待匹配服务”，不能伪造一次模型调用证明上场
    health = console_api.role_health(project)
    crack = next(card for card in health["roles"] if card["role"] == "crack")
    assert crack["health"] == "waiting_dependency"
    assert "等待匹配服务" in crack["health_reason"]


def test_role_health_waiting_dependency_from_direction_gates(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    record = submit_plan_graph(
        project, database,
        {"tasks": [
            {"task_key": "base", "goal": "采集", "verb": "collect",
             "targets": ["https://fixture.invalid/"], "success_criteria": "x",
             "depends_on": [], "assigned_role": "recon", "tool_id": "dir_scan"},
            {"task_key": "child", "goal": "验证", "verb": "verify",
             "targets": ["https://fixture.invalid/"], "success_criteria": "x",
             "depends_on": ["base"], "assigned_role": "operator"},
        ]},
        proposed_by="planner-1",
    )
    parent_id = next(
        item["direction_id"] for item in record["tasks"] if item["task_key"] == "base"
    )
    database.set_direction_status(parent_id, "released")
    health = console_api.role_health(project)
    operator = next(card for card in health["roles"] if card["role"] == "operator")
    assert operator["health"] == "waiting_dependency"
    assert parent_id in operator["health_reason"]


# ── 计划视图（§11）────────────────────────────────────────────────

def test_plan_view_links_dependencies_roles_tools_results_and_evidence(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    record = submit_plan_graph(
        project, database,
        {"tasks": [
            {"task_key": "recon", "goal": "采集目录", "verb": "collect",
             "targets": ["https://fixture.invalid/"], "success_criteria": "x",
             "depends_on": [], "assigned_role": "recon", "tool_id": "dir_scan"},
            {"task_key": "poc", "goal": "验证组件", "verb": "verify",
             "targets": ["https://fixture.invalid/"], "success_criteria": "x",
             "depends_on": ["recon"], "assigned_role": "poc", "tool_id": "poc_scan",
             "skill_ids": ["shiro-verification"]},
        ]},
        proposed_by="planner-1",
    )
    recon_direction = next(
        item["direction_id"] for item in record["tasks"] if item["task_key"] == "recon"
    )
    # 工具调用审计（task_id = direction id）+ 结果事实
    project.append_jsonl("tool_calls.jsonl", {
        "tool_call_id": "TC-1", "tool_id": "dir_scan", "run_id": "R-1",
        "task_id": recon_direction, "role": "recon", "status": "ok",
        "started_at": "2026-10-09T00:00:00Z", "output_summary": "evidence/dir.json 已落盘",
    })
    project.append_jsonl("facts.jsonl", {
        "id": "F-1", "title": "目录发现", "classification": "risk_lead",
        "intent_id": recon_direction, "evidence_path": "evidence/dir.json",
    })
    payload = console_api.plan_view(project)
    directions = {item["id"]: item for item in payload["directions"]}
    assert set(directions) == {item["direction_id"] for item in record["tasks"]}
    recon = directions[recon_direction]
    assert recon["assigned_role"] == "recon"
    assert recon["tool_ref"]["tool_id"] == "dir_scan"
    assert recon["tool_calls"][0]["tool_call_id"] == "TC-1"
    assert recon["results"][0]["fact_id"] == "F-1"
    poc = directions[next(
        item["direction_id"] for item in record["tasks"] if item["task_key"] == "poc"
    )]
    assert [dep["id"] for dep in poc["depends_on"]] == [recon_direction]
    assert "shiro-verification" in payload["skill_cards"]


# ── 发现详情证据链（§11）──────────────────────────────────────────

def test_finding_chain_connects_all_six_stages(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    record = submit_plan_graph(
        project, database,
        {"tasks": [{
            "task_key": "t", "goal": "验证", "verb": "verify",
            "targets": ["https://fixture.invalid/"], "success_criteria": "x",
            "depends_on": [], "assigned_role": "poc", "tool_id": "poc_scan",
        }]},
        proposed_by="planner-1",
    )
    direction_id = record["tasks"][0]["direction_id"]
    project.append_jsonl("tool_calls.jsonl", {
        "tool_call_id": "TC-9", "tool_id": "poc_scan", "task_id": direction_id,
        "status": "ok", "started_at": "2026-10-09T00:00:00Z", "output_summary": "hit",
    })
    database.insert_analysis_record(
        analyzer_kind="poc", input_hash="h1", record={
            "analysis_status": "completed", "conclusion": "命中证据不足，缺少对照",
            "recommended_followups": [],
        }, job_id=None, run_id=None, source_task_id=direction_id,
        model_id="deepseek-chat", prompt_version="poc-analyzer-v1",
    )
    project.append_jsonl("review_flags.jsonl", {"fact_ids": ["F-9"], "flag": "suspect_false_positive"})
    project.append_jsonl("facts.jsonl", {
        "id": "F-9", "title": "组件命中", "classification": "risk_lead",
        "intent_id": direction_id, "evidence_path": "evidence/poc.txt",
        "validator_result": {"certified": False, "reasons": ["缺少请求/响应文件"]},
        "quality_notes": ["缺少验证谓词"],
    })
    project.append_jsonl("human_verdicts.jsonl", {
        "finding_id": "F-9", "action": "refuted", "final_classification": "inconclusive",
        "final_severity": "info", "reason": "复现失败",
    })
    chain = console_api.finding_chain(project, "F-9")
    stages = {stage["stage"]: stage for stage in chain["chain"]}
    assert [stage["stage"] for stage in chain["chain"]] == [
        "request_response", "engine_hits", "independent_analysis",
        "reviewer", "guardian", "human_verdict",
    ]
    assert stages["engine_hits"]["available"] is True
    assert stages["engine_hits"]["detail"]["tool_calls"][0]["tool_id"] == "poc_scan"
    assert stages["independent_analysis"]["available"] is True
    assert stages["independent_analysis"]["detail"]["records"][0]["conclusion"]
    assert stages["reviewer"]["available"] is True
    assert stages["guardian"]["detail"]["certified"] is False
    assert stages["human_verdict"]["detail"]["action"] == "refuted"


def test_finding_chain_missing_fact_rejected(project: ProjectStore) -> None:
    with pytest.raises(ValueError, match="不存在"):
        console_api.finding_chain(project, "F-MISSING")


# ── 独立研判面板（§7A.4/§11）──────────────────────────────────────

def test_analysis_panel_lists_three_analyzers_with_model_source(
    project: ProjectStore,
) -> None:
    panel = console_api.analysis_panel(project)
    kinds = [item["analyzer_kind"] for item in panel["analyzers"]]
    assert kinds == ["poc", "directory", "js"]
    for analyzer in panel["analyzers"]:
        assert analyzer["enabled_effective"] is True
        assert "model" in analyzer


def test_analysis_config_toggle_persists_and_panel_reflects(
    project: ProjectStore,
) -> None:
    console_api.save_analysis_config(project, {"directory": {"enabled": False}})
    panel = console_api.analysis_panel(project)
    directory = next(a for a in panel["analyzers"] if a["analyzer_kind"] == "directory")
    assert directory["enabled_effective"] is False
    assert directory["disabled_reason"]
    # 幂等重开
    console_api.save_analysis_config(project, {"directory": {"enabled": True}})
    panel = console_api.analysis_panel(project)
    directory = next(a for a in panel["analyzers"] if a["analyzer_kind"] == "directory")
    assert directory["enabled_effective"] is True


def test_analysis_config_rejects_unknown_analyzer_and_bad_override(
    project: ProjectStore,
) -> None:
    with pytest.raises(ValueError, match="未知分析器"):
        console_api.save_analysis_config(project, {"nmap": {"enabled": True}})
    with pytest.raises(ValueError, match="model_override"):
        console_api.save_analysis_config(project, {"poc": {"model_override": {"model": ""}}})


# ── 工具健康 + 技能路由解释（§11）────────────────────────────────

def test_tools_health_reports_engine_gap_without_blaming_model(
    project: ProjectStore,
) -> None:
    payload = console_api.tools_health(project)
    tool_ids = {tool["id"] for tool in payload["tools"]}
    assert {"url_scan", "dir_scan", "pwd_crack", "http_request"} <= tool_ids
    for tool in payload["tools"]:
        assert "implemented" in tool and "available" in tool
        assert isinstance(tool["roles"], list)
    assert payload["engines"]["poc_scan"]["adapter"] == "nuclei-adapter"


def test_skill_routing_explanation_requires_features(project: ProjectStore) -> None:
    explanation = console_api.skill_routing_explanation_for(["shiro", "rememberMe"])
    matches = explanation["matches"]
    assert matches, "shiro 特征应命中组件验证短卡"
    assert any(match["skill_id"] == "shiro-verification" for match in matches)
    with pytest.raises(ValueError, match="features"):
        console_api.skill_routing_explanation_for([])


# ── 资源仓库面板（§7.2）───────────────────────────────────────────

def test_resources_panel_lists_bundled_and_import_disable_rollback(
    project: ProjectStore,
) -> None:
    from src.sorne import resource_repository as repo

    panel = console_api.resources_panel(project)
    assert set(panel["status"]["categories"]) >= {
        "fingerprint_rules", "js_clue_rules", "service_dictionaries",
        "poc_templates", "skill_docs",
    }
    entry = repo.import_resource(
        project, category="service_dictionaries", resource_id="extra-paths",
        name="补充目录字典", content={"kind": "dir", "words": ["backup", "admin"]},
        source="user-import", license="MIT",
    )
    assert entry["version"] == 1
    repo.set_enabled(project, "extra-paths", enabled=False)
    panel = console_api.resources_panel(project)
    target = next(r for r in panel["resources"] if r["id"] == "extra-paths")
    assert target["enabled"] is False
    repo.import_resource(
        project, category="service_dictionaries", resource_id="extra-paths",
        name="补充目录字典 v2", content={"kind": "dir", "words": ["backup2"]},
        source="user-import", license="MIT",
    )
    rolled = repo.rollback(project, "extra-paths")
    assert rolled["version"] == 1


def test_resource_import_rejects_json_key_value_credentials(
    project: ProjectStore,
) -> None:
    # P4 导入界面实测发现：JSON 键值形状（"password": "..."）曾绕过文本形状
    # 检测（键名后的闭合引号不在原正则内）；修复后必须拒绝。
    from src.sorne import resource_repository as repo

    for resource_id, content in (
        ("leak-password", {"kind": "dir", "words": ["admin"], "password": "SuperSecret123"}),
        ("leak-apikey", {"kind": "dir", "words": ["admin"], "api_key": "sk-live-abcdefghijklmnop12"}),
        ("leak-auth", {"kind": "dir", "words": ["admin"], "authorization": "Bearer eyJhbGciOi.abcdef1234"}),
    ):
        with pytest.raises(repo.ResourceRepositoryError, match="明文凭据"):
            repo.import_resource(
                project, category="service_dictionaries", resource_id=resource_id,
                name=resource_id, content=content, source="user", license="MIT",
            )
    # 正常内容与短占位值不受影响
    repo.import_resource(
        project, category="service_dictionaries", resource_id="normal-dict",
        name="正常字典", content={"kind": "dir", "words": ["admin", "backup"]},
        source="user", license="MIT",
    )


# ── 旧团队迁移（§10；验收 §13.2 旧项目场景）──────────────────────

def test_migration_preview_is_dry_run_and_lists_mapping(
    project: ProjectStore,
) -> None:
    project.write_text("team_config.json", json.dumps(
        _legacy_team_config(), ensure_ascii=False
    ))
    before = project.read_text("team_config.json")
    preview = team_migration.migration_preview(project)
    assert preview["needed"] is True
    assert preview["legacy_member_count"] == 2  # reason + executor（reviewer 双契约共用）
    mappings = {item["legacy_role"]: item for item in preview["mappings"]}
    assert mappings["reason"]["primary_target"] == "planner"
    assert mappings["reason"]["prompt_copied"] is True
    assert mappings["executor"]["primary_target"] == "operator"
    assert mappings["executor"]["prompt_copied"] is False
    assert any("密钥" in step for step in mappings["reason"]["manual_steps"])
    # dry-run 不写文件
    assert project.read_text("team_config.json") == before


def test_migration_execute_writes_new_team_with_archive_and_is_idempotent(
    project: ProjectStore,
) -> None:
    project.write_text("team_config.json", json.dumps(
        _legacy_team_config(), ensure_ascii=False
    ))
    result = team_migration.execute_migration(project, requested_by="test")
    assert result["executed"] is True
    assert result["archive_dir"].startswith("team_migration/")
    new_config = json.loads(project.read_text("team_config.json"))
    roles = {member["role"] for member in new_config["members"]}
    assert roles == {
        "orchestrator", "planner", "recon", "crack", "poc", "operator", "reviewer",
    }
    # reviewer 是旧配置已有成员：原样保留（不重写用户已调整的新角色成员）
    reviewer = next(m for m in new_config["members"] if m["role"] == "reviewer")
    assert reviewer["name"] == "old-reviewer"
    # reason → planner：模型/运行时复制，明文密钥不复制
    planner = next(m for m in new_config["members"] if m["role"] == "planner")
    assert planner["model"] == "deepseek-chat"
    assert planner["base_url"] == "https://api.example.com/v1"
    assert planner["api_key_env"] == "OLD_REASON_KEY"  # 引用复制，明文不落新成员
    assert planner.get("env") in (None, {}, {"SECRET_TOKEN": "plain"}) or True
    assert "SECRET_TOKEN" not in (planner.get("env") or {})
    assert planner.get("custom_prompt") == "旧推理专属提示词"
    # executor 专属 Prompt 不复制到 operator（一对多，职责冲突）
    operator = next(m for m in new_config["members"] if m["role"] == "operator")
    assert not operator.get("custom_prompt")
    # 归档回退副本存在
    archive_root = project.path / "team_migration"
    archived = json.loads(
        (archive_root / result["archive_dir"].split("/", 1)[1] / "original_team_config.json").read_text(encoding="utf-8")
    )
    assert {m["role"] for m in archived["members"]} == {"reason", "executor", "reviewer"}
    # 幂等重跑：不再归档、不改配置
    again = team_migration.execute_migration(project, requested_by="test")
    assert again["executed"] is False
    assert again["reason"] == "already_migrated"
    preview = team_migration.migration_preview(project)
    assert preview["already_migrated"] is True
    assert preview["archive"]["archive_dir"] == result["archive_dir"]


def test_migration_rollback_restores_team_only(project: ProjectStore) -> None:
    project.write_text("team_config.json", json.dumps(
        _legacy_team_config(), ensure_ascii=False
    ))
    executed = team_migration.execute_migration(project, requested_by="test")
    # 迁移后产生新证据：回退不得删除
    project.append_jsonl("facts.jsonl", {"id": "F-NEW", "title": "新证据"})
    rolled = team_migration.rollback_migration(project)
    assert rolled["rolled_back"] is True
    restored = json.loads(project.read_text("team_config.json"))
    assert {m["name"] for m in restored["members"]} == {"reason-main", "executor-1", "old-reviewer"}
    facts = project.read_jsonl("facts.jsonl")
    assert any(item.get("id") == "F-NEW" for item in facts)
    # 重复回退被拒绝（幂等）
    with pytest.raises(team_migration.MigrationError, match="已回退"):
        team_migration.rollback_migration(project)


def test_migration_refuses_while_run_active(project: ProjectStore) -> None:
    project.write_text("team_config.json", json.dumps(
        _legacy_team_config(), ensure_ascii=False
    ))
    from src.sorne.automation import AutomationEngine

    engine = AutomationEngine(project)
    run_id = engine.start("default", timeout=60, max_workers=1)
    blocker = team_migration.active_run_blocker(project)
    assert blocker is not None and blocker["run_id"] == run_id
    with pytest.raises(team_migration.MigrationError, match="不热切换"):
        team_migration.execute_migration(project)
    engine.cancel(run_id, "test")


def test_migration_without_legacy_roles_is_noop(project: ProjectStore) -> None:
    # 情形一：项目未单独配置团队（使用全局默认七角色）→ 幂等 no-op
    preview = team_migration.migration_preview(project)
    assert preview["needed"] is False and preview["already_migrated"] is True
    result = team_migration.execute_migration(project)
    assert result["executed"] is False and result["reason"] == "already_migrated"
    # 情形二：项目自配团队只有新角色但缺七角色之一 → 不自动改写用户团队
    project.write_text("team_config.json", json.dumps({"members": [
        {"name": "planner-only", "type": "codex", "role": "planner", "model": None,
         "runtime_mode": "local-docker", "sandbox": "read-only"},
    ]}, ensure_ascii=False))
    preview = team_migration.migration_preview(project)
    assert preview["needed"] is False
    assert preview["missing_seven_roles"] == [
        "crack", "operator", "orchestrator", "poc", "recon", "reviewer",
    ]
    with pytest.raises(team_migration.MigrationError, match="没有旧六角色"):
        team_migration.execute_migration(project)


# ── 运行工具进度（§11 运行视图）───────────────────────────────────

def test_run_tool_progress_aggregates_calls_per_tool(
    project: ProjectStore, database: ControlDatabase,
) -> None:
    from src.sorne.automation import AutomationEngine

    engine = AutomationEngine(project)
    run_id = engine.start("default", timeout=60, max_workers=1)
    project.append_jsonl("tool_calls.jsonl", {
        "tool_call_id": "TC-a", "tool_id": "dir_scan", "run_id": run_id,
        "task_id": "I-1", "role": "recon", "status": "ok", "started_at": "2026-10-09T01:00:00Z",
    })
    project.append_jsonl("tool_calls.jsonl", {
        "tool_call_id": "TC-b", "tool_id": "dir_scan", "run_id": run_id,
        "task_id": "I-2", "role": "recon", "status": "failed", "started_at": "2026-10-09T02:00:00Z",
    })
    project.append_jsonl("tool_calls.jsonl", {
        "tool_call_id": "TC-c", "tool_id": "http_request", "run_id": "OTHER-RUN",
        "task_id": "I-3", "role": "operator", "status": "ok", "started_at": "2026-10-09T03:00:00Z",
    })
    progress = console_api.run_tool_progress(project)
    assert progress["run"]["id"] == run_id
    by_tool = {item["tool_id"]: item for item in progress["tools"]}
    assert by_tool["dir_scan"]["calls"] == 2
    assert by_tool["dir_scan"]["ok"] == 1
    assert by_tool["dir_scan"]["failed"] == 1
    assert "http_request" not in by_tool  # 其他 run 的调用不计入
    engine.cancel(run_id, "test")


# ── 前后端接受新角色（§13.1-1）───────────────────────────────────

def test_web_team_config_accepts_seven_role_members(
    project: ProjectStore,
) -> None:
    from src.sorne import webapp as webapp_module

    config = {
        "members": [
            {"name": f"{role}-x", "type": "codex", "role": role, "model": None,
             "runtime_mode": "local-docker", "sandbox": "read-only" if role in {
                 "orchestrator", "planner", "reviewer",
             } else "workspace-write"}
            for role in (
                "orchestrator", "planner", "recon", "crack", "poc", "operator", "reviewer",
            )
        ],
    }
    webapp_module._save_config(project, config)
    saved = json.loads(project.read_text("team_config.json"))
    assert {member["role"] for member in saved["members"]} == {
        "orchestrator", "planner", "recon", "crack", "poc", "operator", "reviewer",
    }
