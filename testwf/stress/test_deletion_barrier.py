"""项目删除屏障与活动计数的并发正确性。

断言：
- 活动计数在并发 reserve/release 下永不变负、无泄漏；
- 有活动请求时删除被屏障拦截（等待上限后报错），目录完好；
- 并发重复删除只有一个成功，标记最终清理；
- 删除成功后目录消失。
"""
from __future__ import annotations

import threading
import time

import pytest

from conftest import run_threads

from src.sorne import webapp as webapp_module
from src.sorne.store import ProjectStore

TIMEOUT_SECONDS = 30.0
HAMMER_THREADS = 16
HAMMER_ROUNDS = 200


def test_concurrent_activity_counter_never_negative_or_leaky() -> None:
    vendor = "activity-hammer"
    negative_seen: list[int] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def hammer(worker_index: int) -> None:
        try:
            for _ in range(HAMMER_ROUNDS):
                with webapp_module._project_activity(vendor):
                    current = webapp_module._PROJECT_ACTIVITY.get(vendor, 0)
                    if current <= 0:
                        with lock:
                            negative_seen.append(current)
        except BaseException as exc:  # noqa: BLE001
            with lock:
                errors.append(exc)

    elapsed = run_threads(
        [lambda index=index: hammer(index) for index in range(HAMMER_THREADS)],
        timeout=TIMEOUT_SECONDS,
    )
    assert not errors, f"活动计数并发异常: {errors[:3]}"
    assert not negative_seen, "活动计数出现过 <=0 的在册值"
    assert vendor not in webapp_module._PROJECT_ACTIVITY, "活动计数泄漏（未归零清理）"
    assert elapsed < TIMEOUT_SECONDS
    print(f"\n[活动计数] {HAMMER_THREADS}线程 x {HAMMER_ROUNDS} reserve/release: {elapsed:.2f}s")


def test_deletion_blocked_while_activity_held_then_recovers_marker() -> None:
    vendor = "deletion-blocked"
    store = ProjectStore(vendor)
    store.init()

    release = threading.Event()
    deletion_outcome: list[str] = []

    def hold_activity() -> None:
        # 持有活动 >1.5s 屏障等待上限，删除必须放弃而不是强删。
        with webapp_module._project_activity(vendor):
            release.wait(timeout=5.0)

    holder = threading.Thread(target=hold_activity)
    holder.start()
    time.sleep(0.2)

    started = time.monotonic()
    try:
        webapp_module._delete_project(vendor, vendor)
        deletion_outcome.append("deleted")
    except webapp_module.WebAppError as exc:
        deletion_outcome.append(str(exc))
    blocked_seconds = time.monotonic() - started
    release.set()
    holder.join(timeout=5.0)

    assert deletion_outcome and "仍有请求" in deletion_outcome[0], deletion_outcome
    assert 1.0 <= blocked_seconds <= 6.0, f"屏障等待时长异常: {blocked_seconds:.2f}s"
    assert store.path.is_dir(), "存在活动请求时项目目录被强删"
    assert vendor not in webapp_module._PROJECTS_BEING_DELETED, "失败的删除未清理删除标记"


def test_concurrent_deletes_exactly_one_wins_and_project_removed() -> None:
    vendor = "deletion-storm"
    ProjectStore(vendor).init()

    outcomes: dict[str, int] = {"ok": 0, "busy": 0, "other": 0}
    messages: list[str] = []
    lock = threading.Lock()

    def deleter() -> None:
        try:
            webapp_module._delete_project(vendor, vendor)
            with lock:
                outcomes["ok"] += 1
        except webapp_module.WebAppError as exc:
            with lock:
                messages.append(str(exc))
                if "删除正在进行" in str(exc) or "项目正在删除" in str(exc) or "不存在" in str(exc):
                    outcomes["busy"] += 1
                else:
                    outcomes["other"] += 1
        except BaseException as exc:  # noqa: BLE001
            with lock:
                messages.append(f"unexpected:{exc!r}")
                outcomes["other"] += 1

    started = time.monotonic()
    elapsed = run_threads([deleter] * 8, timeout=TIMEOUT_SECONDS)

    assert outcomes["ok"] == 1, f"并发删除应有且仅有一个成功: {outcomes} {messages[:3]}"
    assert outcomes["other"] == 0, f"出现预期外的删除错误: {messages[:3]}"
    assert not (ProjectStore(vendor).path).exists(), "删除成功后项目目录仍存在"
    assert vendor not in webapp_module._PROJECTS_BEING_DELETED
    assert vendor not in webapp_module._PROJECT_ACTIVITY
    assert elapsed < TIMEOUT_SECONDS
    print(f"\n[删除风暴] 8 并发删除（1 成功 {outcomes['busy']} 拒绝）: {elapsed:.2f}s")


def test_activity_release_underflow_is_raised_not_silent() -> None:
    vendor = "underflow-probe"
    with pytest.raises(RuntimeError, match="下溢"):
        webapp_module._release_project_activity(vendor)
    assert vendor not in webapp_module._PROJECT_ACTIVITY
