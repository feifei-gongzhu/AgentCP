"""已知产品缺陷：ControlDatabase 并发冷初始化会把 schema_meta 写出重复行。

缺陷：src/sorne/database.py initialize() 的 `SELECT schema_meta` -> `INSERT`
处于自动提交、非原子窗口；多个线程对一个尚无 control_plane.db 的项目
并发首次构造 ControlDatabase 时（webapp 下多个请求同时命中 fresh 项目，
如 /api/projects 每项目构造一次），会出现两行 schema_meta。此后该库
每次 initialize 都抛 RuntimeError("schema_meta 必须且只能包含一条版本记录")，
项目控制库永久损坏，只能手工修复。

复现率：本机 16 线程 x 30 轮命中 6 轮（约 20%/轮）。
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from conftest import run_threads

from src.sorne.database import ControlDatabase

THREADS = 16
ROUNDS = 12
TIMEOUT_SECONDS = 60.0


def test_concurrent_cold_init_keeps_single_schema_meta_row(tmp_path: Path) -> None:
    for round_no in range(ROUNDS):
        db_path = tmp_path / f"round-{round_no}" / "control_plane.db"
        db_path.parent.mkdir(parents=True)
        barrier = threading.Barrier(THREADS)
        errors: list[str] = []
        lock = threading.Lock()

        def worker() -> None:
            barrier.wait()
            try:
                ControlDatabase(db_path)
            except Exception as exc:  # noqa: BLE001
                with lock:
                    errors.append(f"{type(exc).__name__}: {exc}")

        elapsed = run_threads([worker] * THREADS, timeout=TIMEOUT_SECONDS)

        assert not errors, f"第 {round_no} 轮并发初始化抛错（连瞬时锁错误也不应出现）: {errors[:3]}"
        with sqlite3.connect(db_path) as conn:
            rows = conn.execute("SELECT count(*) FROM schema_meta").fetchone()[0]
        assert rows == 1, f"第 {round_no} 轮 schema_meta 出现 {rows} 行，控制库已被竞态损坏"
        # 损坏是永久的：风暴之后任何一次新初始化都必须正常。
        ControlDatabase(db_path)
        assert elapsed < TIMEOUT_SECONDS


def test_sequential_cold_init_is_stable(tmp_path: Path) -> None:
    db_path = tmp_path / "seq" / "control_plane.db"
    for _ in range(5):
        ControlDatabase(db_path)
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute("SELECT count(*) FROM schema_meta").fetchone()[0]
    assert rows == 1
