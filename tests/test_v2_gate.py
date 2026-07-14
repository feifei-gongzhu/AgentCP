from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane.scheduler import Scheduler
from src.agent_control_plane.schemas import GateStatus
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.worker import WorkerError, apply_worker_output


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
