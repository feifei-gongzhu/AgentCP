from pathlib import Path

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
    assert database.get_run(run_id)["status"] == "cancelled"
    assert database.list_jobs(run_id)[0]["status"] == "cancelled"


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
