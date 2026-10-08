"""正式压力测试（方案 §13.2 压力场景；全本地夹具 + tmp 目录，不碰公网）。

六类场景与量化指标（打印 STRESS-METRIC 行，供证据采集）：

1. 多 worker 并发认领同一批任务 —— 无重复执行、无丢任务（directions 与
   jobs 两条队列，8 worker 屏障同步起跑）。
2. 大批量 Direction/Intent（数百条）—— 注册吞吐、逐条认领时延分布
   （p50/p95/max）、open_direction_count/list_directions 开销与内存峰值。
3. 取消风暴 —— 批量取消后运行中子任务退出（真实 _worker_loop + 遵守
   cancel_check 的驱动）、迟到写回被 fencing 拒绝（complete_job /
   heartbeat / finish_direction / finish_analysis_job 四路）。
4. 模拟服务重启恢复 —— 已完成不重扫、未完成（过期租约）可恢复、
   投影事件幂等补写、ScanBatch 把崩溃时 running 的目标记为
   unknown_outcome 且 completed 目标不重扫。
5. 重复 dispatch/提交幂等 —— 方向工作指纹并发去重、研判任务
   (analyzer_kind, input_hash) 幂等复用、CommitPlan 幂等键去重、
   已终态方向不因重复 dispatch 复活。
6. 研判任务与执行任务并行 —— 两条队列互不串道、并行_wall_clock 与
   串行之和对比、Run 停止时两条队列同时收敛。
"""

from __future__ import annotations

import json
import threading
import time
import tracemalloc
from collections import Counter
from dataclasses import asdict
from pathlib import Path
from statistics import median

import pytest

from src.sorne import store as store_module
from src.sorne.database import ControlDatabase
from src.sorne.store import ProjectStore
from src.sorne.team import TeamMember


def _metric(name: str, **values: object) -> None:
    """打印一行量化指标（pytest -s 时进入测试输出）。"""
    parts = " ".join(f"{key}={value}" for key, value in values.items())
    print(f"STRESS-METRIC {name} {parts}")


def _direction_intent(index: int, *, priority: bool = True) -> dict:
    intent = {
        "id": f"I-stress-{index}",
        "verb": "verify",
        "target": f"https://stress-{index}.invalid/api/v{index}",
        "hypothesis": f"假设 {index}",
        "success_criteria": "可复核证据",
        "chain_id": f"CHAIN-{index % 8}",
        "sequence": index % 4,
    }
    if priority:
        intent["priority_score"] = (index % 10) / 10.0
        intent["risk_level"] = ("low", "medium", "high", "critical")[index % 4]
    return intent


def _expire_all_leases(database: ControlDatabase, table: str) -> None:
    with database.connect() as db:
        db.execute(
            f"UPDATE {table} SET lease_expires_at='2000-01-01T00:00:00+00:00' "  # noqa: S608
            "WHERE lease_expires_at IS NOT NULL"
        )


# ── ① 多 worker 并发认领竞态 ─────────────────────────────────────────


def test_concurrent_direction_claims_no_duplicate_no_loss(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    total = 200
    for index in range(total):
        database.register_direction(_direction_intent(index))
    workers = 8
    barrier = threading.Barrier(workers)
    claims: list[list[str]] = [[] for _ in range(workers)]
    errors: list[Exception] = []

    def claim_loop(slot: int) -> None:
        try:
            barrier.wait(timeout=10)
            while True:
                direction = database.claim_direction(f"stress-w{slot}", lease_seconds=60)
                if direction is None:
                    return
                claims[slot].append(str(direction["id"]))
        except Exception as exc:  # noqa: BLE001 —— 竞态异常必须暴露为失败
            errors.append(exc)

    started = time.monotonic()
    threads = [threading.Thread(target=claim_loop, args=(slot,)) for slot in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    elapsed = time.monotonic() - started

    assert not errors, errors
    counter = Counter(item for batch in claims for item in batch)
    duplicates = {key: value for key, value in counter.items() if value > 1}
    claimed_ids = set(counter)
    lost = total - len(claimed_ids)
    assert not duplicates, f"重复认领: {duplicates}"
    assert lost == 0, f"丢失任务: {lost}"
    assert all(
        item["status"] == "claimed" for item in database.list_directions()
    ), "认领后状态必须一致为 claimed"
    _metric(
        "concurrent_direction_claims",
        total=total, workers=workers, elapsed_s=round(elapsed, 3),
        throughput_per_s=round(total / elapsed, 1),
        duplicate_count=len(duplicates), lost_count=lost,
    )


def test_concurrent_job_claims_no_duplicate_no_loss(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("stress-vendor", "default", 120, 4)
    total = 300
    for index in range(total):
        database.enqueue_job(run_id, "swarm", f"m-{index}", "recon", {"seq": index})
    workers = 8
    barrier = threading.Barrier(workers)
    claims: list[list[str]] = [[] for _ in range(workers)]
    errors: list[Exception] = []

    def claim_loop(slot: int) -> None:
        try:
            barrier.wait(timeout=10)
            while True:
                job = database.claim_job(run_id, "swarm", f"stress-w{slot}", lease_seconds=60)
                if job is None:
                    return
                claims[slot].append(str(job["id"]))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    started = time.monotonic()
    threads = [threading.Thread(target=claim_loop, args=(slot,)) for slot in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    elapsed = time.monotonic() - started

    assert not errors, errors
    counter = Counter(item for batch in claims for item in batch)
    duplicates = {key: value for key, value in counter.items() if value > 1}
    lost = total - len(set(counter))
    assert not duplicates, f"重复认领: {duplicates}"
    assert lost == 0, f"丢失任务: {lost}"
    attempts = {item["id"]: item["attempts"] for item in database.list_jobs(run_id)}
    assert all(value == 1 for value in attempts.values()), "并发认领后 attempts 必须恰好为 1"
    _metric(
        "concurrent_job_claims",
        total=total, workers=workers, elapsed_s=round(elapsed, 3),
        throughput_per_s=round(total / elapsed, 1),
        duplicate_count=len(duplicates), lost_count=lost,
    )


# ── ② 大批量 Direction/Intent 队列调度与资源占用 ─────────────────────


def test_large_batch_direction_scheduling_cost(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    total = 400

    started = time.monotonic()
    for index in range(total):
        database.register_direction(_direction_intent(index))
    register_elapsed = time.monotonic() - started

    count_started = time.monotonic()
    for _ in range(50):
        assert database.open_direction_count() == total
    count_elapsed = (time.monotonic() - count_started) / 50

    latencies: list[float] = []
    drained = 0
    while True:
        claim_started = time.monotonic()
        direction = database.claim_direction("stress-batch", lease_seconds=60)
        latencies.append(time.monotonic() - claim_started)
        if direction is None:
            break
        drained += 1
    latencies.sort()
    p95 = latencies[max(0, int(len(latencies) * 0.95) - 1)]
    _metric(
        "large_batch_directions",
        total=total,
        register_throughput_per_s=round(total / register_elapsed, 1),
        open_count_latency_ms=round(count_elapsed * 1000, 2),
        claim_p50_ms=round(median(latencies) * 1000, 2),
        claim_p95_ms=round(p95 * 1000, 2),
        claim_max_ms=round(max(latencies) * 1000, 2),
        drained=drained,
    )
    assert drained == total, f"大批量认领丢任务: {drained}/{total}"
    assert sum(1 for item in database.list_directions()) == total

    # 内存峰值与磁盘占用（独立批次重测，避免 tracemalloc 影响计时数字）。
    tracemalloc.start()
    for index in range(200):
        database.register_direction(_direction_intent(10_000 + index))
    listing = database.list_directions()
    _ = [item["intent"] for item in listing]
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    db_mb = (tmp_path / "control.db").stat().st_size / 1024 / 1024
    _metric(
        "large_batch_resources",
        listed_directions=len(listing),
        traced_current_mb=round(current / 1024 / 1024, 2),
        traced_peak_mb=round(peak / 1024 / 1024, 2),
        sqlite_file_mb=round(db_mb, 2),
    )
    # 队列在数百规模必须保持秒级可调度（防 O(N²) 退化的回归护栏）。
    assert max(latencies) < 2.0, f"单次认领时延退化: {max(latencies):.3f}s"
    assert register_elapsed < 30.0


def test_large_batch_job_queue_throughput(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("stress-vendor", "default", 120, 4)
    total = 400
    started = time.monotonic()
    for index in range(total):
        database.enqueue_job(run_id, "swarm", f"m-{index % 8}", "recon", {"seq": index})
    enqueue_elapsed = time.monotonic() - started

    started = time.monotonic()
    completed = 0
    while True:
        job = database.claim_job(run_id, "swarm", "stress-batch", lease_seconds=60)
        if job is None:
            break
        database.complete_job(job["id"], "stress-batch", {"payload": {"kind": "none"}})
        completed += 1
    drain_elapsed = time.monotonic() - started
    jobs = database.list_jobs(run_id)
    assert completed == total, f"完成数 {completed}/{total}"
    assert all(item["status"] == "completed" for item in jobs)
    _metric(
        "large_batch_jobs",
        total=total,
        enqueue_throughput_per_s=round(total / enqueue_elapsed, 1),
        claim_complete_throughput_per_s=round(total / drain_elapsed, 1),
        drain_elapsed_s=round(drain_elapsed, 3),
    )


# ── ③ 取消风暴 ────────────────────────────────────────────────────────


class _CancelAwareDriver:
    """遵守 cancel_check 的假模型驱动：运行中反复查询取消，取消即抛错退出。"""

    calls = 0
    lock = threading.Lock()

    @classmethod
    def run(cls, config, prompt, timeout=300, cancel_check=None, progress_callback=None):
        with cls.lock:
            cls.calls += 1
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            if cancel_check is not None and cancel_check():
                raise RuntimeError("cancelled_by_storm: 模型调用按取消信号退出")
            time.sleep(0.005)
        raise RuntimeError("cancelled_by_storm: 驱动等待超时")


def _storm_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("stress-storm")
    store.init()
    store.write_json("target.json", {
        "authorization": "authorized",
        "scope": ["stress.invalid"],
        "out_of_scope": [],
        "targets": ["https://stress.invalid"],
    })
    return store


def test_cancel_storm_stops_subtasks_and_fences_late_writes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.sorne import automation as automation_module
    from src.sorne import execution as execution_module

    store = _storm_project(tmp_path, monkeypatch)
    monkeypatch.setattr(execution_module, "run_driver", _CancelAwareDriver.run)
    database = ControlDatabase(store.path / "control_plane.db")
    run_id = database.create_run(store.vendor, "default", 60, 6)
    run = database.get_run(run_id)
    control_version = int(run["control_version"])

    member = asdict(TeamMember(
        name="storm-exec", type="mock", role="recon", max_running=1,
        extra={"payload": {"kind": "none", "reason": "storm"}},
    ))
    total_jobs = 48
    for index in range(total_jobs):
        database.enqueue_job(run_id, "swarm", "storm-exec", "recon", {"member": member})

    # 风暴前的在途占用：两个迟写 Job、12 个 run 绑定方向、2 个研判任务。
    late_jobs = [
        database.claim_job(run_id, "swarm", "late-job-a", lease_seconds=300),
        database.claim_job(run_id, "swarm", "late-job-b", lease_seconds=300),
    ]
    assert all(late_jobs)
    direction_ids = []
    for index in range(12):
        direction_id, created = database.register_direction(_direction_intent(50_000 + index))
        assert created
        direction_ids.append(direction_id)
        assert database.claim_direction(f"{run_id}:storm-exec", lease_seconds=300)
    analysis_jobs = []
    for index in range(2):
        job, created = database.enqueue_analysis_job(
            "poc", {"input": index}, f"hash-storm-{index}", run_id=run_id,
        )
        assert created
        analysis_jobs.append(
            database.claim_analysis_job(f"late-an-{index}", lease_seconds=300),
        )
    assert all(analysis_jobs)

    engine = automation_module.AutomationEngine(store)
    engine_results: list[str] = []
    engine_error: list[Exception] = []

    def run_stage() -> None:
        try:
            engine_results.extend(engine._execute_stage(run, "swarm"))
        except Exception as exc:  # noqa: BLE001
            engine_error.append(exc)

    stage_thread = threading.Thread(target=run_stage)
    stage_thread.start()
    # 等真实引擎 Worker（worker_id 以 local- 开头）进入在途状态再触发风暴。
    inflight_deadline = time.monotonic() + 10.0
    while time.monotonic() < inflight_deadline:
        running = sum(
            item["status"] == "running"
            and str(item.get("worker_id") or "").startswith("local-")
            for item in database.list_jobs(run_id, "swarm")
        )
        if running >= 6:
            break
        time.sleep(0.01)
    storm_started = time.monotonic()
    # 并发取消风暴：4 个线程同时取消同一 Run。
    cancel_errors: list[Exception] = []

    def cancel_once() -> None:
        try:
            database.stop_run(run_id, "cancel_storm")
        except Exception as exc:  # noqa: BLE001
            cancel_errors.append(exc)

    cancel_threads = [threading.Thread(target=cancel_once) for _ in range(4)]
    for thread in cancel_threads:
        thread.start()
    for thread in cancel_threads:
        thread.join(timeout=30)
    storm_elapsed = time.monotonic() - storm_started
    stage_thread.join(timeout=60)
    assert not stage_thread.is_alive(), "取消风暴后执行线程必须退出"
    assert not engine_error, engine_error
    assert not cancel_errors, cancel_errors

    # 子任务退出后：真实 Worker 持有的 Job 全部收敛为 cancelled；
    # 仅两个迟到写回者（无 Worker 运行）按设计停留在 cancelling，
    # 等待其 fail_job——期间任何写回都会被 fencing 拒绝（见下）。
    jobs = database.list_jobs(run_id, "swarm")
    statuses = Counter(item["status"] for item in jobs)
    assert statuses.get("running", 0) == 0, "风暴后仍有 running 子任务"
    assert statuses.get("cancelling", 0) == len(late_jobs), (
        f"cancelling 只应是迟到写回者的 Job: {statuses}"
    )
    assert statuses.get("cancelled", 0) == total_jobs - len(late_jobs)
    assert sum(statuses.values()) == total_jobs
    assert database.get_run(run_id)["status"] == "stopped"

    # run 绑定方向被批量取消。
    cancelled_directions = sum(
        1 for item in database.list_directions() if item["status"] == "cancelled"
    )
    assert cancelled_directions == 12

    # ── 迟到写回全部被 fencing 拒绝 ──
    fenced = 0
    for job in late_jobs:
        with pytest.raises(RuntimeError):
            database.complete_job(
                job["id"], "late-job-a" if job is late_jobs[0] else "late-job-b",
                {"payload": {"kind": "none"}},
                control_version=control_version,
            )
        fenced += 1
        assert not database.heartbeat(
            job["id"], "late-job-a" if job is late_jobs[0] else "late-job-b",
            control_version=control_version,
        )
    assert database.event_count("stale_write_rejected") >= 2
    assert not database.finish_direction(
        direction_ids[0], f"{run_id}:storm-exec",
        outcome="completed", reason="late write",
    ), "迟到方向完成必须被拒"
    for analysis_job in analysis_jobs:
        assert database.finish_analysis_job(
            analysis_job["id"], analysis_job["worker_id"], status="completed",
        ) == "fenced", "迟到研判写回必须被租约 fencing 拒绝"
    assert all(
        database.get_analysis_job(job["id"])["status"] == "cancelled"
        for job in analysis_jobs
    )
    _metric(
        "cancel_storm",
        jobs=total_jobs, directions=12, analysis_jobs=2,
        storm_latency_s=round(storm_elapsed, 3),
        driver_calls=_CancelAwareDriver.calls,
        job_statuses=dict(statuses),
        late_write_rejections=fenced + 1 + len(analysis_jobs),
    )


# ── ④ 模拟服务重启恢复 ────────────────────────────────────────────────


def test_restart_recovery_requeues_incomplete_and_keeps_completed(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("stress-vendor", "default", 120, 4)
    total = 120
    for index in range(total):
        database.enqueue_job(run_id, "swarm", f"m-{index}", "recon", {"seq": index})
    completed_ids: set[str] = set()
    for index in range(60):
        job = database.claim_job(run_id, "swarm", "pre-crash", lease_seconds=60)
        assert job
        database.complete_job(job["id"], "pre-crash", {"payload": {"kind": "none"}})
        completed_ids.add(str(job["id"]))
    crashed = [
        database.claim_job(run_id, "swarm", f"crash-{index}", lease_seconds=60)
        for index in range(20)
    ]
    assert all(crashed)

    direction_plan = [(60, "completed"), (30, "claimed"), (30, "open")]
    completed_directions: set[str] = set()
    index = 0
    for count, status in direction_plan:
        for _ in range(count):
            direction_id, _ = database.register_direction(_direction_intent(70_000 + index))
            index += 1
            if status == "completed":
                database.claim_direction("pre-crash-exec", lease_seconds=60)
                assert database.finish_direction(direction_id, "pre-crash-exec", success=True)
                completed_directions.add(direction_id)
            elif status == "claimed":
                assert database.claim_direction(f"crash-exec-{index}", lease_seconds=60)

    # ── 模拟进程死亡后重启：租约视为过期 ──
    restarted = ControlDatabase(tmp_path / "control.db")
    resumable = restarted.latest_resumable_run()
    assert resumable and resumable["id"] == run_id and resumable["status"] == "running"
    recovery_started = time.monotonic()
    _expire_all_leases(restarted, "jobs")
    _expire_all_leases(restarted, "directions")
    reclaimed_jobs: list[str] = []
    reclaimed_attempts: dict[str, int] = {}
    while True:
        job = restarted.claim_job(run_id, "swarm", "post-restart", lease_seconds=60)
        if job is None:
            break
        reclaimed_jobs.append(str(job["id"]))
        reclaimed_attempts[str(job["id"])] = int(job["attempts"])
    job_recovery_elapsed = time.monotonic() - recovery_started
    expected_incomplete = total - len(completed_ids)
    assert len(reclaimed_jobs) == expected_incomplete, (
        f"重启后应恢复全部未完成 Job: {len(reclaimed_jobs)}/{expected_incomplete}"
    )
    assert not (set(reclaimed_jobs) & completed_ids), "已完成 Job 不得重扫"
    crashed_ids = {str(job["id"]) for job in crashed if job}
    attempts_hist = Counter(reclaimed_attempts.values())
    assert attempts_hist == {2: len(crashed_ids), 1: expected_incomplete - len(crashed_ids)}, (
        "崩溃前被认领过的 Job 恢复后 attempts 必须递增（可追溯重试），"
        "从未被认领的 Job 保持 attempts=1"
    )

    reclaimed_directions: list[str] = []
    while True:
        direction = restarted.claim_direction("post-restart-exec", lease_seconds=60)
        if direction is None:
            break
        reclaimed_directions.append(str(direction["id"]))
    assert len(reclaimed_directions) == 60, "30 open + 30 过期 claimed 方向必须全部可恢复"
    assert not (set(reclaimed_directions) & completed_directions), "已完成方向不得重扫"
    _metric(
        "restart_recovery",
        jobs_total=total, jobs_completed=len(completed_ids),
        jobs_recovered=len(reclaimed_jobs),
        directions_recovered=len(reclaimed_directions),
        directions_completed_kept=len(completed_directions),
        job_recovery_s=round(job_recovery_elapsed, 3),
    )


def test_restart_projection_recovery_is_idempotent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.sorne.projector import Projector

    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("stress-restart-proj")
    store.init()
    database = ControlDatabase(store.path / "control_plane.db")
    total = 100
    for index in range(total):
        _, created = database.register_direction(
            _direction_intent(80_000 + index),
            record_intent_projection=True,
        )
        assert created
    # 崩溃遗留：一个事件卡在 projecting 且租约过期。
    claimed = database.claim_next_commit("crashed-projector", lease_seconds=60)
    assert claimed is not None
    with database.connect() as db:
        db.execute(
            "UPDATE commit_events SET lease_expires_at='2000-01-01T00:00:00+00:00' "
            "WHERE event_id=?",
            (claimed["event_id"],),
        )
    counts_before = database.commit_event_counts()

    projector = Projector(store, database, worker_id="restart-projector")
    started = time.monotonic()
    projected = projector.recover()
    elapsed = time.monotonic() - started
    intents_first = store.read_jsonl("intents.jsonl")

    # 幂等：同批事件二次恢复不产生重复投影。
    second = Projector(store, database, worker_id="restart-projector-2").recover()
    intents_second = store.read_jsonl("intents.jsonl")

    assert projected == total, f"应恢复全部事件（含 1 个过期 projecting）: {projected}"
    assert second == 0
    assert len(intents_first) == total and intents_second == intents_first
    assert database.commit_event_counts().get("committed", 0) == total
    assert counts_before.get("projecting", 0) == 1 and counts_before.get("pending", 0) == total - 1
    _metric(
        "restart_projection_recovery",
        events=total, projected=projected, second_pass=second,
        recovery_s=round(elapsed, 3),
        throughput_per_s=round(total / elapsed, 1),
    )


def test_restart_scan_batch_marks_unknown_outcome(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.sorne.engine_adapters.batch_state import ScanBatch, arguments_digest

    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("stress-scanbatch")
    store.init()
    targets = [f"https://batch-{index}.invalid/" for index in range(60)]
    digest = arguments_digest("dir_scan", {"targets": targets})
    batch = ScanBatch(store, "dir_scan", digest, targets)
    for target in targets[:35]:
        batch.mark(target, "completed")
    batch.mark(targets[35], "failed")
    batch.mark(targets[36], "running")  # 崩溃时在途
    batch.mark(targets[37], "running")  # 崩溃时在途
    batch.save()

    restarted = ScanBatch(store, "dir_scan", digest, targets)
    summary = restarted.summary()
    remaining = restarted.remaining_targets()
    assert restarted.status_of(targets[36]) == "unknown_outcome"
    assert restarted.status_of(targets[37]) == "unknown_outcome"
    assert summary["unknown_outcome"] == 2
    assert summary["completed"] == 35
    assert len(remaining) == 60 - 35 - 1, "剩余 = pending + unknown_outcome，failed 不重试"
    for target in targets[:35]:
        assert target not in remaining, "已完成目标不得重扫"
    assert restarted.status_of(targets[35]) == "failed"
    _metric(
        "restart_scan_batch",
        targets=60, completed_kept=35, unknown_outcome=summary["unknown_outcome"],
        remaining_retried=len(remaining),
    )


# ── ⑤ 重复 dispatch / 提交幂等（工作指纹抑制重复）────────────────────


def test_duplicate_dispatch_suppressed_by_work_fingerprint(tmp_path: Path) -> None:
    database = ControlDatabase(tmp_path / "control.db")
    intent = _direction_intent(1)
    rounds = 8
    barrier = threading.Barrier(rounds)
    results: list[tuple[str, bool]] = []
    errors: list[Exception] = []
    lock = threading.Lock()

    def register_once() -> None:
        try:
            barrier.wait(timeout=10)
            outcome = database.register_direction(dict(intent, id=f"I-race-{threading.get_ident()}"))
            with lock:
                results.append(outcome)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=register_once) for _ in range(rounds)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not errors, errors
    created_count = sum(1 for _, created in results if created)
    distinct_ids = {direction_id for direction_id, _ in results}
    assert created_count == 1, f"并发重复 dispatch 必须只创建 1 条: {created_count}"
    assert len(distinct_ids) == 1
    assert database.event_count("direction_duplicate") == rounds - 1
    assert len(database.list_directions()) == 1

    # 已终态方向不因重复 dispatch 复活：完成同语义 Intent 后再次注册。
    direction_id = distinct_ids.pop()
    assert database.claim_direction("idem-exec") is not None
    assert database.finish_direction(direction_id, "idem-exec", success=True)
    again_id, again_created = database.register_direction(dict(intent, id="I-resurrect"))
    assert not again_created and again_id == direction_id
    assert database.get_direction(direction_id)["status"] == "completed"
    assert database.open_direction_count() == 0

    # submit_dispatch（prioritize_direction）对已终态方向不产生新任务。
    assert not database.prioritize_direction(direction_id, 999.0, reason="late dispatch")
    assert len(database.list_directions()) == 1
    duplicate_rate = (rounds - created_count) / rounds
    _metric(
        "dispatch_idempotency",
        concurrent_rounds=rounds, created=created_count,
        duplicate_events=database.event_count("direction_duplicate"),
        duplicate_suppression_rate=round(duplicate_rate, 3),
    )


def test_analysis_and_commit_idempotency_under_repeats(tmp_path: Path) -> None:
    from src.sorne.commits import CommitPlanner

    database = ControlDatabase(tmp_path / "control.db")
    run_id = database.create_run("stress-vendor", "default", 120, 2)
    # 研判任务：(analyzer_kind, input_hash) 重复入队只保留一条。
    created_flags = []
    for round_index in range(6):
        job, created = database.enqueue_analysis_job(
            "poc", {"round": round_index}, "identical-input-hash", run_id=run_id,
        )
        created_flags.append(created)
        assert job["id"]
    jobs = database.list_analysis_jobs(run_id)
    assert created_flags.count(True) == 1
    assert len(jobs) == 1

    # 并发重复入队同样只有一条。
    barrier = threading.Barrier(4)
    concurrent: list[bool] = []
    errors: list[Exception] = []
    lock = threading.Lock()

    def enqueue_once() -> None:
        try:
            barrier.wait(timeout=10)
            job, created = database.enqueue_analysis_job(
                "poc", {"concurrent": True}, "concurrent-hash", run_id=run_id,
            )
            with lock:
                concurrent.append((job["id"], created))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=enqueue_once) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not errors, errors
    assert sum(1 for _, created in concurrent if created) == 1
    assert len({job_id for job_id, _ in concurrent}) == 1

    # CommitPlan：同幂等键重复提交返回同一事件，不产生第二个。
    plan = CommitPlanner().freeze_action(
        kind="record_direction_intent",
        payload={"intent": _direction_intent(99_000), "hypothesis": None},
        source_type="stress_test",
        source_id="stress-1",
        idempotency_key="stress:repeat-key",
        aggregate_type="direction_intent",
        aggregate_id="stress-agg",
    )
    first = database.accept_commit_plan(
        event=plan.database_event(), plan=plan.database_plan(),
    )
    second = database.accept_commit_plan(
        event=plan.database_event(), plan=plan.database_plan(),
    )
    assert first["event_id"] == second["event_id"]
    with database.connect() as db:
        rows = db.execute(
            "SELECT count(*) AS count FROM commit_events WHERE idempotency_key='stress:repeat-key'"
        ).fetchone()
    assert rows["count"] == 1
    _metric(
        "submit_idempotency",
        analysis_repeat_enqueues=6, analysis_rows=len(jobs),
        analysis_concurrent_created=sum(1 for _, c in concurrent if c),
        commit_plan_replays=2, commit_event_rows=rows["count"],
    )


# ── ⑥ 研判任务与执行任务并行：资源隔离与排队 ─────────────────────────


def test_analysis_and_execution_lanes_run_in_parallel_isolated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _storm_project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    run_id = database.create_run(store.vendor, "default", 120, 4)
    exec_total, analysis_total = 80, 40
    for index in range(exec_total):
        database.enqueue_job(run_id, "swarm", f"m-{index % 4}", "recon", {"seq": index})
    for index in range(analysis_total):
        database.enqueue_analysis_job(
            "poc", {"input": index}, f"parallel-hash-{index}", run_id=run_id,
        )

    exec_done: list[str] = []
    analysis_done: list[str] = []
    errors: list[Exception] = []
    exec_workers, analysis_workers = 4, 2
    barrier = threading.Barrier(exec_workers + analysis_workers)

    def exec_loop(slot: int) -> None:
        try:
            barrier.wait(timeout=10)
            while True:
                job = database.claim_job(run_id, "swarm", f"parallel-exec-{slot}", lease_seconds=60)
                if job is None:
                    return
                time.sleep(0.002)  # 模拟执行占用
                database.complete_job(
                    job["id"], f"parallel-exec-{slot}", {"payload": {"kind": "none"}},
                )
                exec_done.append(str(job["id"]))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    def analysis_loop(slot: int) -> None:
        try:
            barrier.wait(timeout=10)
            while True:
                job = database.claim_analysis_job(f"parallel-an-{slot}", lease_seconds=60)
                if job is None:
                    return
                time.sleep(0.002)  # 模拟研判占用
                status = database.finish_analysis_job(
                    job["id"], f"parallel-an-{slot}", status="completed", record_id="AN-x",
                )
                assert status == "completed", status
                analysis_done.append(str(job["id"]))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    started = time.monotonic()
    threads = [
        *(threading.Thread(target=exec_loop, args=(slot,)) for slot in range(exec_workers)),
        *(threading.Thread(target=analysis_loop, args=(slot,)) for slot in range(analysis_workers)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)
    parallel_elapsed = time.monotonic() - started
    assert not errors, errors
    assert len(exec_done) == exec_total, "执行队列无丢任务"
    assert len(analysis_done) == analysis_total, "研判队列无丢任务"
    assert len(set(exec_done)) == exec_total and len(set(analysis_done)) == analysis_total
    assert not (set(exec_done) & set(analysis_done)), "两条队列不得互相串道"

    # 串行基线（同一库规模重新灌入后单线程跑），量化并行收益。
    # 单项目同时只允许一个活动 Run：基线前先收敛上一 Run。
    database.stop_run(run_id, "baseline_reset")
    run2 = database.create_run(store.vendor, "default", 120, 1)
    for index in range(exec_total):
        database.enqueue_job(run2, "swarm", f"m2-{index % 4}", "recon", {"seq": index})
    for index in range(analysis_total):
        database.enqueue_analysis_job(
            "poc", {"input": index}, f"serial-hash-{index}", run_id=run2,
        )
    started = time.monotonic()
    serial_done = 0
    while True:
        job = database.claim_job(run2, "swarm", "serial", lease_seconds=60)
        if job is None:
            break
        time.sleep(0.002)
        database.complete_job(job["id"], "serial", {"payload": {"kind": "none"}})
        serial_done += 1
    while True:
        job = database.claim_analysis_job("serial-an", lease_seconds=60)
        if job is None:
            break
        time.sleep(0.002)
        assert database.finish_analysis_job(
            job["id"], "serial-an", status="completed", record_id="AN-y",
        ) == "completed"
        serial_done += 1
    serial_elapsed = time.monotonic() - started
    assert serial_done == exec_total + analysis_total

    # Run 停止时两条队列同时收敛（隔离下的统一取消语义）。
    database.stop_run(run2, "baseline_reset")
    run3 = database.create_run(store.vendor, "default", 120, 2)
    for index in range(10):
        database.enqueue_job(run3, "swarm", f"m3-{index}", "recon", {"seq": index})
    for index in range(6):
        database.enqueue_analysis_job(
            "poc", {"input": index}, f"cancel-hash-{index}", run_id=run3,
        )
    cancelled = database.cancel_analysis_jobs_for_run(run3, "run_stop")
    database.stop_run(run3, "run_stop")
    assert cancelled == 6
    assert all(item["status"] == "cancelled" for item in database.list_analysis_jobs(run3))
    assert all(
        item["status"] == "cancelled" for item in database.list_jobs(run3, "swarm")
    )
    _metric(
        "parallel_lanes",
        exec_jobs=exec_total, analysis_jobs=analysis_total,
        parallel_elapsed_s=round(parallel_elapsed, 3),
        serial_elapsed_s=round(serial_elapsed, 3),
        speedup=round(serial_elapsed / parallel_elapsed, 2),
        exec_throughput_per_s=round(exec_total / parallel_elapsed, 1),
        analysis_throughput_per_s=round(analysis_total / parallel_elapsed, 1),
        cancel_together="jobs+analysis_cancelled",
    )
