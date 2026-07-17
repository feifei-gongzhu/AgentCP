from pathlib import Path

import pytest

from src.agent_control_plane.database import ControlDatabase


def test_expired_lease_can_be_reclaimed(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("vendor", "default", 30, 2)
    job_id = database.enqueue_job(run_id, "swarm", "reason", "reason", {"member": {}})
    claimed = database.claim_job(run_id, "swarm", "worker-a", lease_seconds=30)
    assert claimed and claimed["id"] == job_id

    with database.connect() as connection:
        connection.execute(
            "UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (job_id,),
        )

    reclaimed = database.claim_job(run_id, "swarm", "worker-b", lease_seconds=30)
    assert reclaimed and reclaimed["worker_id"] == "worker-b"
    assert reclaimed["attempts"] == 2


def test_project_cannot_start_two_active_runs(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    first = database.create_run("vendor", "default", 30, 1)

    with pytest.raises(RuntimeError, match=first):
        database.create_run("vendor", "default", 30, 1)

    database.stop_run(first, "test cleanup")
    second = database.create_run("vendor", "default", 30, 1)
    assert second != first


def test_failed_job_retries_until_max_attempts(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("vendor", "default", 30, 1)
    database.enqueue_job(run_id, "swarm", "reason", "reason", {}, max_attempts=2)

    first = database.claim_job(run_id, "swarm", "worker-a")
    assert first
    assert database.fail_job(first["id"], "worker-a", "temporary") == "queued"

    second = database.claim_job(run_id, "swarm", "worker-b")
    assert second
    assert database.fail_job(second["id"], "worker-b", "permanent") == "failed"


def test_non_retryable_job_fails_on_first_attempt(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("vendor", "default", 30, 1)
    database.enqueue_job(run_id, "swarm", "reason", "reason", {}, max_attempts=3)

    claimed = database.claim_job(run_id, "swarm", "worker-a")
    assert claimed
    assert database.fail_job(
        claimed["id"], "worker-a", "invalid channel", retryable=False,
    ) == "failed"
    assert database.list_jobs(run_id)[0]["attempts"] == 1


def test_cancelled_run_stops_queued_jobs(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("vendor", "default", 30, 1)
    database.enqueue_job(run_id, "swarm", "reason", "reason", {})
    database.cancel_run(run_id, "user requested")
    assert database.get_run(run_id)["status"] == "stopped"
    assert database.list_jobs(run_id)[0]["status"] == "cancelled"


def test_stale_worker_write_is_rejected_after_stop_loss(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("vendor", "default", 30, 1)
    database.enqueue_job(run_id, "swarm", "reason", "reason", {})
    claimed = database.claim_job(run_id, "swarm", "worker-a")
    assert claimed
    database.stop_run(run_id, "user stop loss")
    with pytest.raises(RuntimeError, match="控制版本"):
        database.complete_job(
            claimed["id"], "worker-a", {"payload": {"kind": "none"}},
            control_version=claimed["control_version"],
        )
    assert database.event_count("stale_write_rejected") == 1


def test_direction_is_deduplicated_and_leased(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    intent = {
        "id": "I-1",
        "verb": "verify",
        "target": "ipc://pushUpdate",
        "success_criteria": "观察到可复核命令执行",
        "chain_id": "CHAIN-1",
        "sequence": 1,
    }
    direction_id, created = database.register_direction(intent)
    assert created
    duplicate_id, duplicate_created = database.register_direction(dict(intent, id="I-2"))
    assert not duplicate_created
    assert duplicate_id == direction_id

    claimed = database.claim_direction("reason-worker", lease_seconds=30)
    assert claimed and claimed["id"] == direction_id
    assert database.heartbeat_direction(direction_id, "reason-worker", lease_seconds=30)
    database.finish_direction(direction_id, "reason-worker", success=True)
    assert database.list_directions()[0]["status"] == "completed"


def test_human_dismissal_cancels_direction_and_bound_running_job(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    intent = {
        "id": "I-human-dismiss",
        "verb": "inspect",
        "target": "https://example.com/wrong-path",
        "hypothesis": "错误方向",
        "success_criteria": "不应继续",
    }
    direction_id, _ = database.register_direction(intent)
    claimed_direction = database.claim_direction("R-human:executor")
    run_id = database.create_run("vendor", "default", 60, 1)
    job_id = database.enqueue_job(
        run_id,
        "swarm",
        "executor",
        "executor",
        {"member": {}, "direction": claimed_direction},
    )
    claimed_job = database.claim_job(run_id, "swarm", "worker-1")
    assert claimed_job is not None

    dismissed = database.dismiss_direction(direction_id, "人工判断该假设不成立")

    assert dismissed["status"] == "cancelled"
    assert dismissed["terminal_reason"].startswith("human_dismissed:")
    assert database.job_status(job_id) == "cancelling"
    assert database.claim_direction("another-worker") is None
    status = database.fail_job(
        job_id,
        "worker-1",
        "human dismissed",
        control_version=int(claimed_job["control_version"]),
    )
    assert status == "cancelled"
    assert database.job_status(job_id) == "cancelled"
