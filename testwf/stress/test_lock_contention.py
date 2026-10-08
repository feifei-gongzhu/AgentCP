"""并发锁竞争：多线程对同一项目并行 append_jsonl / save_state（经 store.locked）。

断言：行数精确、无异常、耗时有界（防死锁）。
"""
from __future__ import annotations

import threading

from conftest import run_threads

from src.sorne.store import ProjectStore

THREADS = 16
APPENDS_PER_THREAD = 25
SAVES_PER_THREAD = 4
TIMEOUT_SECONDS = 120.0


def test_parallel_append_and_save_state_exact_counts() -> None:
    store = ProjectStore("stress-lock")
    store.init()

    errors: list[BaseException] = []
    errors_lock = threading.Lock()

    def worker(thread_index: int) -> None:
        try:
            for i in range(APPENDS_PER_THREAD):
                store.append_jsonl("hints.jsonl", {
                    "id": f"t{thread_index}-{i}",
                    "content": f"压测提示 {thread_index}-{i}",
                })
            for i in range(SAVES_PER_THREAD):
                state = store.load_state()
                state.current_task = f"压测-{thread_index}-{i}"
                store.save_state(state)
        except BaseException as exc:  # noqa: BLE001 - 压力测试需要捕获一切
            with errors_lock:
                errors.append(exc)

    elapsed = run_threads(
        [lambda index=index: worker(index) for index in range(THREADS)],
        timeout=TIMEOUT_SECONDS,
    )

    assert not errors, f"并发写入抛出异常: {errors[:3]}"
    rows = store.read_jsonl("hints.jsonl")
    expected = THREADS * APPENDS_PER_THREAD
    assert len(rows) == expected, f"行数不精确: {len(rows)} != {expected}"
    ids = [row["id"] for row in rows]
    assert len(set(ids)) == expected, "存在重复写入（幂等标记误判或丢写）"

    state = store.load_state()
    assert state.vendor == "stress-lock"
    # state.json 是完整覆盖写，并发后必须是合法 JSON 且 current_task 为其中一次写入。
    assert state.current_task.startswith("压测-")

    assert elapsed < TIMEOUT_SECONDS
    print(f"\n[锁竞争] {THREADS}线程 x {APPENDS_PER_THREAD}append + {SAVES_PER_THREAD}save: {elapsed:.2f}s")


def test_parallel_reads_during_writes_do_not_corrupt() -> None:
    store = ProjectStore("stress-mixed")
    store.init()

    stop = threading.Event()
    errors: list[BaseException] = []
    errors_lock = threading.Lock()

    def writer() -> None:
        try:
            for i in range(120):
                store.append_jsonl("hints.jsonl", {"id": f"w-{i}", "content": "写"})
        except BaseException as exc:  # noqa: BLE001
            with errors_lock:
                errors.append(exc)
        finally:
            stop.set()

    def reader() -> None:
        try:
            while not stop.is_set():
                rows = store.read_jsonl("hints.jsonl")
                assert all(row.get("id") for row in rows)
        except BaseException as exc:  # noqa: BLE001
            with errors_lock:
                errors.append(exc)

    elapsed = run_threads([writer] + [reader] * 4, timeout=TIMEOUT_SECONDS)
    assert not errors, f"读写并发异常: {errors[:3]}"
    assert len(store.read_jsonl("hints.jsonl")) == 120
    assert elapsed < TIMEOUT_SECONDS
    print(f"\n[锁竞争-读写混合] 120写+4读循环: {elapsed:.2f}s")
