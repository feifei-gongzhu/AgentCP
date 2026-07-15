from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane.scheduler import Scheduler
from src.agent_control_plane.schemas import GateStatus, Hint
from src.agent_control_plane.directives import authoritative_directives
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.worker import WorkerError, apply_worker_output, build_worker_prompt


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    return store


def test_fifteen_minute_tick_requires_user_approval(project: ProjectStore) -> None:
    output = Scheduler(project).tick(15)
    state = project.load_state()
    assert state.gate_status == GateStatus.AWAITING_APPROVAL.value
    assert state.current_decision == "request_confirmation"
    assert "请求用户确认" in output

    with pytest.raises(RuntimeError):
        Scheduler(project).tick(1)


def test_approval_reopens_execution(project: ProjectStore) -> None:
    scheduler = Scheduler(project)
    scheduler.complete_subtask("完成资产去重")
    scheduler.approve("switch_phase", "用户确认进入侦察阶段")
    assert project.load_state().gate_status == GateStatus.RUNNING.value


def test_worker_write_is_rejected_while_gate_waits(project: ProjectStore) -> None:
    Scheduler(project).complete_subtask("完成子任务")
    with pytest.raises(WorkerError):
        apply_worker_output(project, {"kind": "none", "reason": "done"})


def test_blackboard_uses_chinese_two_tier_filename(project: ProjectStore) -> None:
    board = project.path / "项目黑板_知识库.md"
    text = board.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    assert "## 当前测试路径" in text


def test_human_controller_intervention_is_injected_by_priority(project: ProjectStore) -> None:
    project.append_jsonl("hints.jsonl", Hint(
        content="普通补充",
        priority=2,
        intervention_type="supplement",
    ))
    project.append_jsonl("hints.jsonl", Hint(
        content="停止重复枚举，优先核对鉴权边界",
        target="认证模块",
        priority=10,
        intervention_type="redirect",
        applies_to_run_id="R-current",
    ))

    prompt = build_worker_prompt(project, "reason")

    assert "项目所有者指令（AgentCP 内部最高控制优先级）" in prompt
    assert prompt.index("停止重复枚举") < prompt.index("普通补充")
    assert '"intervention_type": "redirect"' in prompt


def test_project_owner_directive_is_carried_forward_to_new_run(project: ProjectStore) -> None:
    project.append_jsonl("hints.jsonl", Hint(
        content="黑板初始化，全部重新测试",
        priority=10,
        intervention_type="redirect",
        applies_to_run_id="R-old",
    ))
    state = project.load_state()
    state.active_run_id = "R-current"
    project.save_state(state)

    directives = authoritative_directives(project)
    prompt = build_worker_prompt(project, "reason", directives)

    assert directives[0]["origin_run_id"] == "R-old"
    assert directives[0]["effective_run_id"] == "R-current"
    assert directives[0]["carried_forward"] is True
    assert directives[0]["must_follow"] is True
    assert "绝不能以 Run ID 不一致为由判定失效" in prompt


def test_human_dismissed_direction_is_removed_from_worker_context(project: ProjectStore) -> None:
    intent = {
        "id": "I-wrong",
        "verb": "inspect",
        "target": "wrong.example",
        "hypothesis": "不正确假设",
        "success_criteria": "错误成功条件",
    }
    project.append_jsonl("intents.jsonl", intent)
    from src.agent_control_plane.database import ControlDatabase
    database = ControlDatabase(project.path / "control_plane.db")
    database.register_direction(intent)
    database.dismiss_direction("I-wrong", "人工确认方向错误")

    prompt = build_worker_prompt(project, "reason")

    recent_context = prompt.split('"recent_intents":', 1)[1].split(
        '"human_dismissed_directions":', 1
    )[0]
    assert "wrong.example" not in recent_context
    assert "human_dismissed:人工确认方向错误" in prompt
