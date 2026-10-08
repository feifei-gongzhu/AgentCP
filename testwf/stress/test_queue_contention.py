"""队列竞争：多线程并行 claim_job / claim_direction（临时 SQLite）。

断言：同一任务/方向不被双认领，无异常，耗时有界。
"""
from __future__ import annotations

import threading
from pathlib import Path

from conftest import run_threads

from src.sorne.database import ControlDatabase

JOB_COUNT = 80
DIRECTION_COUNT = 80
WORKERS = 8
TIMEOUT_SECONDS = 60.0


def test_parallel_claim_job_never_double_claims(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "queue.db")
    run_id = database.create_run("queue-vendor", "default", 30, WORKERS)
    for index in range(JOB_COUNT):
        database.enqueue_job(run_id, "swarm", f"member-{index}", "reason", {"n": index})

    claimed: list[tuple[str, str]] = []
    claimed_lock = threading.Lock()
    errors: list[BaseException] = []

    def worker(worker_id: str) -> None:
        try:
            while True:
                job = database.claim_job(run_id, "swarm", worker_id, lease_seconds=30)
                if job is None:
                    return
                with claimed_lock:
                    claimed.append((str(job["id"]), worker_id))
        except BaseException as exc:  # noqa: BLE001
            with claimed_lock:
                errors.append(exc)

    elapsed = run_threads(
        [lambda wid=f"worker-{i}": worker(wid) for i in range(WORKERS)],
        timeout=TIMEOUT_SECONDS,
    )
    assert not errors, f"claim_job 并发异常: {errors[:3]}"
    assert len(claimed) == JOB_COUNT, f"认领数不符: {len(claimed)} != {JOB_COUNT}"
    job_ids = [job_id for job_id, _ in claimed]
    assert len(set(job_ids)) == JOB_COUNT, "存在同一任务被双认领"
    with database.connect() as db:
        statuses = db.execute("SELECT status, count(*) c FROM jobs GROUP BY status").fetchall()
        rows = {row["status"]: row["c"] for row in statuses}
    assert rows == {"running": JOB_COUNT}, f"任务终态异常: {rows}"
    assert elapsed < TIMEOUT_SECONDS
    print(f"\n[队列-job] {WORKERS}线程抢 {JOB_COUNT} 任务: {elapsed:.2f}s")


def test_parallel_claim_direction_never_double_claims(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "directions.db")
    registered = set()
    for index in range(DIRECTION_COUNT):
        intent = {
            "verb": "verify",
            "target": f"https://example.com/path-{index}",
            "hypothesis": f"假设-{index}",
            "success_criteria": "形成证据",
            "risk_level": "low",
            "priority_score": 0.1,
        }
        direction_id, created = database.register_direction(intent)
        assert created
        registered.add(direction_id)

    claimed: list[tuple[str, str]] = []
    claimed_lock = threading.Lock()
    errors: list[BaseException] = []

    def worker(worker_id: str) -> None:
        try:
            while True:
                direction = database.claim_direction(worker_id, lease_seconds=60)
                if direction is None:
                    return
                with claimed_lock:
                    claimed.append((str(direction["id"]), worker_id))
        except BaseException as exc:  # noqa: BLE001
            with claimed_lock:
                errors.append(exc)

    elapsed = run_threads(
        [lambda wid=f"dir-worker-{i}": worker(wid) for i in range(WORKERS)],
        timeout=TIMEOUT_SECONDS,
    )
    assert not errors, f"claim_direction 并发异常: {errors[:3]}"
    assert len(claimed) == DIRECTION_COUNT
    direction_ids = [direction_id for direction_id, _ in claimed]
    assert len(set(direction_ids)) == DIRECTION_COUNT, "存在同一方向被双认领"
    assert set(direction_ids) == registered
    assert elapsed < TIMEOUT_SECONDS
    print(f"\n[队列-direction] {WORKERS}线程抢 {DIRECTION_COUNT} 方向: {elapsed:.2f}s")
