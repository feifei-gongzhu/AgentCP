from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane import webapp as webapp_module
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.automation import AutomationEngine
from src.agent_control_plane.scheduler import Scheduler


def test_project_listing_only_returns_initialized_projects(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    ProjectStore("production-security").init()
    (projects / "unrelated").mkdir()

    assert webapp_module._project_names() == ["production-security"]


def test_waf_analyst_role_can_be_saved_from_web_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    store = ProjectStore("waf-config")
    store.init()
    config = {
        "members": [{
            "name": "waf-adaptive",
            "role": "waf_analyst",
            "type": "codex",
            "model": None,
            "base_url": None,
            "api_key_env": None,
            "auth_mode": "auto",
            "sandbox": "read-only",
            "max_running": 1,
            "priority": 2,
            "env": {},
            "dangerously_bypass_sandbox": False,
        }],
    }

    webapp_module._save_config(store, config)

    assert store.read_json("team_config.json")["members"][0]["role"] == "waf_analyst"
    assert store.read_json("team_config.json")["members"][0]["runtime_mode"] == "local-docker"


def test_web_team_config_accepts_local_cli_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("local-cli")
    store.init()
    config = {
        "members": [{
            "name": "reason-local",
            "role": "reason",
            "type": "claude-cli",
            "runtime_mode": "local-cli",
            "model": "model-id",
            "sandbox": "read-only",
            "max_running": 1,
            "priority": 0,
            "env": {},
        }],
    }

    webapp_module._save_config(store, config)

    assert store.read_json("team_config.json")["members"][0]["runtime_mode"] == "local-cli"


def test_web_team_config_rejects_local_cli_container(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("invalid-runtime")
    store.init()
    config = {
        "members": [{
            "name": "container-local",
            "role": "executor",
            "type": "container",
            "runtime_mode": "local-cli",
            "sandbox": "workspace-write",
            "max_running": 1,
            "env": {},
        }],
    }

    with pytest.raises(webapp_module.WebAppError, match="不能选择 Container Worker"):
        webapp_module._save_config(store, config)


def test_web_team_config_accepts_optional_agent_compose_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("compose-optional")
    store.init()
    config = {
        "members": [{
            "name": "reason-compose",
            "role": "reason",
            "type": "claude-cli",
            "runtime_mode": "agent-compose",
            "model": "model-id",
            "sandbox": "read-only",
            "max_running": 1,
            "priority": 0,
            "env": {},
        }],
    }

    webapp_module._save_config(store, config)

    assert store.read_json("team_config.json")["members"][0]["runtime_mode"] == "agent-compose"


def test_frontend_assets_are_wired_to_control_api() -> None:
    root = Path(__file__).resolve().parents[1]
    index = (root / "frontend" / "index.html").read_text(encoding="utf-8")
    script = (root / "frontend" / "app.js").read_text(encoding="utf-8")

    assert "AgentCP" in index
    assert "/api/automation/launch" in script
    assert "/api/projects" in script
    assert "/api/evidence" in script
    assert 'id="roleConfigBody"' in index
    assert 'id="rolePromptMember"' in index
    assert 'id="rolePromptText"' in index
    assert "custom_prompt" in script
    assert 'id="saveTeamButton"' in index
    assert 'post("/api/config"' in script
    assert 'id="targetTargets"' in index
    assert 'id="createProjectButton"' in index
    assert 'post("/api/target"' in script
    assert 'api("/api/projects"' in script
    assert "auth_mode" in script
    assert 'id="deleteProjectButton"' in index
    assert 'api("/api/projects/delete"' in script
    assert index.index('<section id="target-setup"') < index.index('<section id="project-configuration"')
    assert index.index('id="project-blackboard"') < index.index('<section id="overview"')
    assert index.index('<section id="project-configuration"') < index.index('<section id="overview"')
    assert "renderEmptyWorkspace" in script
    assert "requestGeneration" in script
    assert "location.reload()" not in script
    assert 'data-view="hub"' in index
    assert index.count('data-view="config"') == 2
    assert index.count('data-view="run"') == 5
    assert 'data-route-link="hub"' in index
    assert 'data-route-link="config"' in index
    assert 'data-route-link="run"' in index
    assert 'id="projectCards"' in index
    assert 'id="hubFalsePositiveRate"' in index
    assert "project-card-quality" in script
    assert "quality_summary" in script
    assert 'id="startAuditButton"' in index
    assert 'id="interventionType"' in index
    assert "项目所有者指令" in index
    assert "scope:\"project\"" in script
    assert "controller_intervention_added" in (root / "src" / "agent_control_plane" / "webapp.py").read_text(encoding="utf-8")
    assert 'id="viewRunButton"' in index
    assert 'new Set(["hub","config","run"])' in script
    assert "renderProjectCards" in script
    assert "launchAudit" in script
    assert "当前在做什么" in index
    assert "调度心跳只证明 AgentCP Worker 存活" in index
    assert "等待 Claude CLI 返回" in script
    assert "model_tool_started" in script
    assert "正在执行工具" in script
    assert "Claude stream-json" in index
    assert 'id="assetMetricNote"' in index
    assert 'id="jobMetricNote"' in index
    assert "pending_facts" in script
    assert "当前运行" in index
    assert 'id="submitFindingReview"' in index
    assert 'post("/api/findings/review"' in script
    assert 'post("/api/directions/dismiss"' in script
    assert "删除方向" in script
    assert "长期误报率" in index
    assert 'id="wafAssessmentsBody"' in index
    for action_id in (
        "deleteProjectButton", "saveTargetButton", "launchButton", "cancelButton",
        "hintButton", "addRoleButton", "saveTeamButton", "copyBoard",
        "gateContinueButton", "gateStopButton",
        "submitFindingReview",
    ):
        assert f'"{action_id}"' in script


def test_web_team_config_persists_per_agent_custom_prompt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("custom-prompts")
    store.init()
    config = {
        "members": [{
            "name": "reason-main",
            "role": "reason",
            "type": "codex",
            "runtime_mode": "local-cli",
            "custom_prompt": "先检查负向证据，再生成新方向。",
            "sandbox": "read-only",
            "max_running": 1,
            "priority": 0,
            "env": {},
        }],
    }

    webapp_module._save_config(store, config)

    assert store.read_json("team_config.json")["members"][0]["custom_prompt"] == "先检查负向证据，再生成新方向。"


def test_web_team_config_rejects_oversized_custom_prompt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("oversized-prompt")
    store.init()
    config = {
        "members": [{
            "name": "reason-main",
            "role": "reason",
            "type": "codex",
            "runtime_mode": "local-cli",
            "custom_prompt": "x" * 30001,
            "sandbox": "read-only",
            "max_running": 1,
            "priority": 0,
            "env": {},
        }],
    }

    with pytest.raises(webapp_module.WebAppError, match="30000"):
        webapp_module._save_config(store, config)


def test_evidence_path_cannot_escape_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    store = ProjectStore("production-security")
    store.init()
    evidence = store.path / "evidence" / "result.txt"
    evidence.write_text("verified", encoding="utf-8")

    assert webapp_module._safe_evidence_file(store, "evidence/result.txt") == evidence.resolve()
    with pytest.raises(webapp_module.WebAppError, match="越界"):
        webapp_module._safe_evidence_file(store, "../target.json")


def test_project_delete_requires_exact_name_and_removes_only_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("client-security")
    store.init()
    (store.path / "evidence" / "proof.txt").write_text("proof", encoding="utf-8")
    other = ProjectStore("keep-me")
    other.init()

    with pytest.raises(webapp_module.WebAppError, match="确认不匹配"):
        webapp_module._delete_project("client-security", "wrong")

    remaining = webapp_module._delete_project("client-security", "client-security")
    assert not store.path.exists()
    assert other.path.exists()
    assert remaining == ["keep-me"]


def test_project_delete_rejects_running_automation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("active-project")
    store.init()
    run_id = AutomationEngine(store).start(max_workers=1)

    with pytest.raises(webapp_module.WebAppError, match="运行中或暂停"):
        webapp_module._delete_project("active-project", "active-project")

    AutomationEngine(store).cancel(run_id, "test_cleanup")


def test_missing_project_is_not_recreated_by_safe_lookup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)

    with pytest.raises(webapp_module.ProjectNotFound, match="项目不存在"):
        webapp_module._safe_project("deleted-project")

    assert not (projects / "deleted-project").exists()


def test_project_delete_rejects_symlink_without_touching_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    projects.mkdir()
    outside = tmp_path / "outside-project"
    outside.mkdir()
    (outside / "target.json").write_text("{}", encoding="utf-8")
    (projects / "linked-project").symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)

    assert webapp_module._project_names() == []
    with pytest.raises(webapp_module.WebAppError, match="符号链接"):
        webapp_module._delete_project("linked-project", "linked-project")

    assert outside.is_dir()
    assert (outside / "target.json").is_file()


def test_project_delete_checks_all_runs_including_paused_older_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("multi-run-project")
    store.init()
    engine = AutomationEngine(store)
    paused_run = engine.start(max_workers=1)
    engine.cancel(paused_run, "prepare_legacy_state")
    newer_run = engine.start(max_workers=1)
    engine.cancel(newer_run, "test")
    # Simulate a V2/early-V3 database that already contains an older paused
    # run. New starts now reject this state, but deletion must still detect it.
    with engine.db.connect() as database:
        database.execute(
            "UPDATE automation_runs SET status='paused',error='legacy' WHERE id=?",
            (paused_run,),
        )

    with pytest.raises(webapp_module.WebAppError, match=paused_run):
        webapp_module._delete_project("multi-run-project", "multi-run-project")

    engine.cancel(paused_run, "test_cleanup")


def test_project_delete_rejects_reserved_background_activity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("busy-project")
    store.init()
    vendor = webapp_module._reserve_project_activity(store.vendor)
    ticks = iter((0.0, 2.0))
    monkeypatch.setattr(webapp_module.time, "monotonic", lambda: next(ticks))
    try:
        with pytest.raises(webapp_module.WebAppError, match="请求或模型任务"):
            webapp_module._delete_project("busy-project", "busy-project")
    finally:
        webapp_module._release_project_activity(vendor)

    assert store.path.is_dir()


def test_gate_continue_resumes_paused_run_in_background(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("gate-project")
    store.init()
    engine = AutomationEngine(store)
    run_id = engine.start(max_workers=1)
    engine.db.set_run_status(run_id, "paused", "awaiting_user_approval")
    Scheduler(store).complete_subtask("测试门禁")
    Scheduler(store).approve("continue", "批准继续测试")
    started: list[str] = []
    monkeypatch.setattr(
        webapp_module,
        "_start_background_run",
        lambda _store, _engine, resumed_run_id: started.append(resumed_run_id),
    )

    result = webapp_module._apply_gate_run_action(store, "continue", run_id)

    assert result["run_id"] == run_id
    assert result["previous_run_id"] == run_id
    assert result["run_status"] == "running"
    assert result["transition"] == "resumed"
    assert result["resumed"] is True
    assert result["started"] is False
    assert result["cancelled"] is False
    assert started == [run_id]
    assert engine.db.get_run(run_id)["status"] == "running"
    engine.cancel(run_id, "test_cleanup")


def test_gate_stop_loss_cancels_paused_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("stop-loss-project")
    store.init()
    engine = AutomationEngine(store)
    run_id = engine.start(max_workers=1)
    engine.db.set_run_status(run_id, "paused", "awaiting_user_approval")
    Scheduler(store).complete_subtask("测试止损")
    Scheduler(store).approve("stop_loss", "批准止损测试")

    result = webapp_module._apply_gate_run_action(store, "stop_loss", run_id)

    assert result["cancelled"] is True
    assert result["run_status"] == "stopped"
    assert engine.db.get_run(run_id)["status"] == "stopped"


def test_gate_continue_starts_next_iteration_after_completed_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("next-iteration-project")
    store.init()
    engine = AutomationEngine(store)
    completed_run_id = engine.start(max_workers=2, timeout=321)
    engine.db.finish_run(completed_run_id, "completed")
    Scheduler(store).complete_subtask("本轮已经完成")
    started: list[str] = []
    monkeypatch.setattr(
        webapp_module,
        "_start_background_run",
        lambda _store, _engine, new_run_id: started.append(new_run_id),
    )

    _, result = webapp_module._approve_gate_and_transition(
        store,
        "continue",
        "批准进入下一轮",
        completed_run_id,
    )

    assert result["transition"] == "started_next_iteration"
    assert result["started"] is True
    assert result["previous_run_id"] == completed_run_id
    assert result["run_id"] != completed_run_id
    new_run = engine.db.get_run(str(result["run_id"]))
    assert new_run["status"] == "running"
    assert new_run["timeout_seconds"] == 321
    assert new_run["max_workers"] == 2
    assert started == [result["run_id"]]
    assert store.load_state().gate_status == "running"
    engine.cancel(str(result["run_id"]), "test_cleanup")


def test_failed_gate_transition_restores_approval_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    store = ProjectStore("gate-rollback-project")
    store.init()
    Scheduler(store).complete_subtask("需要用户批准")
    monkeypatch.setattr(
        webapp_module,
        "_apply_gate_run_action",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("resume failed")),
    )

    with pytest.raises(RuntimeError, match="resume failed"):
        webapp_module._approve_gate_and_transition(store, "continue", "批准", None)

    state = store.load_state()
    assert state.gate_status == "awaiting_approval"
    assert state.current_decision == "request_confirmation"
    assert "审批动作执行失败" in str(state.gate_reason)


def test_web_team_config_rejects_sandbox_bypass(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("production-security")
    store.init()
    config = {
        "members": [{
            "name": "executor",
            "type": "codex",
            "role": "executor",
            "sandbox": "workspace-write",
            "max_running": 1,
            "dangerously_bypass_sandbox": True,
            "env": {},
        }]
    }
    with pytest.raises(webapp_module.WebAppError, match="禁止绕过沙箱"):
        webapp_module._save_config(store, config)


def test_web_team_config_saves_and_reloads_project_roles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("production-security")
    store.init()
    config = {
        "name": "project",
        "members": [
            {
                "name": "reason-primary",
                "type": "codex",
                "role": "reason",
                "model": None,
                "sandbox": "read-only",
                "max_running": 1,
                "priority": 10,
                "env": {},
                "dangerously_bypass_sandbox": False,
            },
            {
                "name": "executor-pool",
                "type": "container",
                "role": "executor",
                "model": None,
                "sandbox": "workspace-write",
                "max_running": 4,
                    "priority": 20,
                    "env": {},
                    "extra": {
                        "image": "agentcp-worker:test",
                        "worker_command": ["python3", "/app/entrypoint.py"],
                    },
                    "dangerously_bypass_sandbox": False,
            },
        ],
    }

    webapp_module._save_config(store, config)

    assert webapp_module._load_config(store) == config
    assert (store.path / "team_config.json").exists()


def test_web_team_config_rejects_literal_api_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("production-security")
    store.init()
    config = {
        "members": [{
            "name": "reason-claude",
            "type": "claude-cli",
            "role": "reason",
            "model": "model-id",
            "base_url": "https://relay.example/anthropic",
            "api_key_env": "literal-secret-value",
            "auth_mode": "bearer",
            "sandbox": "read-only",
            "max_running": 1,
            "env": {},
        }]
    }
    with pytest.raises(webapp_module.WebAppError, match="不能填写真实 API Key"):
        webapp_module._save_config(store, config)


def test_runtime_secret_trims_outer_whitespace() -> None:
    assert webapp_module._normalize_runtime_secrets({"reason": " \nsk-valid-key\t "}) == {
        "reason": "sk-valid-key"
    }


@pytest.mark.parametrize("secret", ["sk key", "sk\nkey", "sk\rkey", "sk\u200bkey"])
def test_runtime_secret_rejects_invalid_header_characters(secret: str) -> None:
    with pytest.raises(webapp_module.WebAppError, match="ASCII"):
        webapp_module._normalize_runtime_secrets({"reason": secret})


def test_frontend_target_save_keeps_authorization_policy_locked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("client-security")
    store.init()

    target = webapp_module._save_target(store, {
        "targets": ["https://app.example.test", "api.example.test"],
        "target_path": "/workspace/client-source",
        "project_type": "Web + API + source review",
        "goal": "验证高价值业务链路",
        "out_of_scope": ["third-party.example.test"],
        "success_criteria": ["形成可复现证据链"],
        "notes": "测试环境",
        "authorization": "unauthorized",
        "authorization_mode": "user_controlled",
        "scope": ["attacker-supplied.example"],
    })

    assert target["authorization"] == "authorized"
    assert target["authorization_mode"] == "owner_asserted_all_targets"
    assert target["scope"] == ["*"]
    assert target["targets"] == ["https://app.example.test", "api.example.test"]
    assert store.read_json("target.json") == target
    target_markdown = store.read_text("目标信息.md")
    assert "https://app.example.test" in target_markdown
    assert "third-party.example.test" in target_markdown


def test_target_requires_address_or_local_path() -> None:
    with pytest.raises(webapp_module.WebAppError, match="至少填写一个目标地址"):
        webapp_module._normalize_target("client-security", {"targets": []}, {})


@pytest.mark.parametrize("vendor", ["../escape", ".hidden", "bad/name", "bad name"])
def test_frontend_project_name_rejects_unsafe_paths(vendor: str) -> None:
    with pytest.raises(webapp_module.WebAppError, match="项目名只能包含"):
        webapp_module._validate_vendor(vendor)
