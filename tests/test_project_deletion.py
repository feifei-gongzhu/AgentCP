from pathlib import Path
import sys

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane import webapp as webapp_module
from src.agent_control_plane import cli as cli_module
from src.agent_control_plane.automation import AutomationEngine
from src.agent_control_plane.dashboard import render_dashboard
from src.agent_control_plane.lifecycle import ProjectLifecycleMissing, project_execution_lock
from src.agent_control_plane.metrics import collect_metrics
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.team import run_team
from src.agent_control_plane.worker import run_worker


def _projects_at(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    projects = tmp_path / "projects"
    monkeypatch.setattr(store_module, "PROJECTS", projects)
    monkeypatch.setattr(webapp_module, "PROJECTS", projects)
    return projects


def test_duplicate_deletion_is_rejected_while_first_delete_owns_marker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _projects_at(tmp_path, monkeypatch)
    store = ProjectStore("duplicate-delete")
    store.init()

    with webapp_module._project_deletion(store.vendor):
        with pytest.raises(webapp_module.WebAppError, match="删除正在进行"):
            webapp_module._delete_project(store.vendor, store.vendor)

    assert store.path.is_dir()


def test_cancelled_run_with_live_worker_lease_cannot_be_deleted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _projects_at(tmp_path, monkeypatch)
    store = ProjectStore("leased-worker")
    store.init()
    engine = AutomationEngine(store)
    run_id = engine.start(max_workers=1)
    claimed = engine.db.claim_job(run_id, "swarm", "external-worker", lease_seconds=60)
    assert claimed is not None
    engine.cancel(run_id, "test_cancel")

    with pytest.raises(webapp_module.WebAppError, match="Worker"):
        webapp_module._delete_project(store.vendor, store.vendor)

    assert store.path.is_dir()


def test_delete_cleanup_failure_restores_original_project_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = _projects_at(tmp_path, monkeypatch)
    store = ProjectStore("restore-on-failure")
    store.init()

    def fail_cleanup(path: Path) -> None:
        raise OSError(f"cannot remove {path.name}")

    monkeypatch.setattr(webapp_module.shutil, "rmtree", fail_cleanup)
    with pytest.raises(webapp_module.WebAppError, match="目录已恢复"):
        webapp_module._delete_project(store.vendor, store.vendor)

    assert store.path.is_dir()
    assert (store.path / "target.json").is_file()
    assert not list(projects.glob(".deleting-*"))


def test_activity_release_underflow_is_not_silently_ignored() -> None:
    vendor = "underflow-test"
    with pytest.raises(RuntimeError, match="计数下溢"):
        webapp_module._release_project_activity(vendor)


def test_cross_process_execution_lock_blocks_project_delete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _projects_at(tmp_path, monkeypatch)
    store = ProjectStore("locked-project")
    store.init()

    with project_execution_lock(store):
        with pytest.raises(webapp_module.WebAppError, match="另一个 Agent/CLI"):
            webapp_module._delete_project(store.vendor, store.vendor)

    assert store.path.is_dir()


def test_deleted_project_cannot_be_revived_by_execution_entrypoints(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _projects_at(tmp_path, monkeypatch)
    store = ProjectStore("deleted-entrypoint")
    store.init()
    webapp_module._delete_project(store.vendor, store.vendor)
    assert not store.path.exists()

    engine = AutomationEngine(store)
    assert not store.path.exists()
    with pytest.raises(ProjectLifecycleMissing):
        engine.status()
    with pytest.raises(ProjectLifecycleMissing):
        run_team(store, "default", dry_run=True)
    with pytest.raises(ProjectLifecycleMissing):
        run_worker(store, "reason", "codex", dry_run=True)
    with pytest.raises(ProjectLifecycleMissing):
        collect_metrics(store)
    with pytest.raises(ProjectLifecycleMissing):
        render_dashboard(store)

    assert not store.path.exists()


@pytest.mark.parametrize(
    "arguments",
    [
        ["add-hint", "deleted-cli", "--content", "stale"],
        ["add-lesson", "deleted-cli", "--pattern", "stale", "--expiry", "never"],
    ],
)
def test_local_cli_commands_cannot_revive_deleted_project(
    arguments: list[str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    projects = _projects_at(tmp_path, monkeypatch)
    monkeypatch.setattr(sys, "argv", ["agentcp", *arguments])

    with pytest.raises(ProjectLifecycleMissing):
        cli_module.main()

    assert not (projects / "deleted-cli").exists()
