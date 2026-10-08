from __future__ import annotations

"""投影补写与收敛幂等回归。

历史问题族：
- 调度器注册方向后直写 intents.jsonl，磁盘故障会中断播种（或静默丢方向），
  修复后 SQLite 为权威、文件是投影，由 Projector 按幂等回执补写
  （drain_direction_intent_projection 的 OSError 分支静默延迟）；
- 提交事件的"回执窗口"（动作已执行、回执未落盘 / 回执已落盘、事件未
  完成）中进程中断后重放，曾把计数或文件行双计。

tests/test_cli_commit_paths.py 已覆盖 fact 动作在 before_projection_receipt
窗口的回执重放；tests/test_profile_directions.py 已覆盖 supersede 路径的
纯写失败补写。本文件换新角度：全新播种路径的真实 OSError 端到端补写、
方向投影"文件已写、回执丢失"窗口的重放不双计、以及 fact 动作在
after_projection_receipt（回执已写、事件未完成）窗口的重放。
"""

from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.database import ControlDatabase
from src.sorne.projector import Projector
from src.sorne.store import ProjectStore
from src.sorne.target_profile import (
    record_target_assessments,
    record_target_profile,
    seed_priority_target_directions,
)


def _project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vendor: str) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore(vendor)
    store.init()
    return store


def _profile_and_assess(store: ProjectStore, url: str, score: int, tests=None, *, ensure_profile: bool = True) -> None:
    if ensure_profile:
        recorded = record_target_profile(
            store, [{"url": url, "function": "后台上传入口", "technology_stack": ["Spring Boot"]}],
            proposed_by="test",
        )
        assert recorded
    recorded = record_target_assessments(store, [{
        "url": url,
        "profile_class": "priority_target",
        "target_score": score,
        "risk_tags": ["upload"],
        "score_reason": "后台高影响入口",
        "recommended_tests": tests or ["upload_validation"],
    }], proposed_by="test")
    assert recorded


def _open_intents(database: ControlDatabase, url: str) -> list[dict]:
    return [
        item for item in database.list_directions()
        if item["status"] == "open"
        and str((item.get("intent") or {}).get("target") or "") == url
    ]


def _direction_events(database: ControlDatabase) -> list[dict]:
    with database.connect() as db:
        return [
            dict(row) for row in db.execute(
                "SELECT * FROM commit_events WHERE event_type='record_direction_intent'"
            ).fetchall()
        ]


def _fast_forward_backoff(database: ControlDatabase) -> None:
    with database.connect() as db:
        db.execute(
            "UPDATE commit_events SET available_at='2000-01-01T00:00:00+00:00' "
            "WHERE status IN ('pending','retry_wait')"
        )


# ---------------------------------------------------------------------------
# 角度一：全新播种路径 + 真实 OSError：静默延迟 + Projector 幂等补写。
# ---------------------------------------------------------------------------

def test_fresh_seed_projection_oserror_backfilled_by_projector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史坑：intents.jsonl 写失败曾中断播种（方向看似注册、文件缺失，
    或直接抛错丢失方向）。

    既有反例在 supersede 替代路径注入失败；本角度走**首次播种**路径
    （_register_or_version → 同步 drain），且用真实 store.append_jsonl
    抛 OSError（而非 mock drain_until），端到端验证三件事：
    ① 播种不被磁盘故障中断（created==1，SQLite 权威）；
    ② OSError 分支静默延迟（不写排障事件），事件保留错误与退避；
    ③ 故障恢复后 Projector 补写且幂等（补一次、内容与 SQLite 一致）。
    """
    store = _project(tmp_path, monkeypatch, vendor="reg-proj-oserror")
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/fresh-seed"
    _profile_and_assess(store, url, 85)

    original_append = store.append_jsonl

    def disk_full(name, item):
        if name == "intents.jsonl":
            raise OSError("disk full")
        return original_append(name, item)

    monkeypatch.setattr(store, "append_jsonl", disk_full)
    created = seed_priority_target_directions(store, database)
    monkeypatch.undo()

    # ① 播种成功，方向在 SQLite 中可认领。
    assert created == 1
    open_items = _open_intents(database, url)
    assert len(open_items) == 1
    assert store.read_jsonl("intents.jsonl") == [], "前提：投影文件确实没写进去"

    # ② OSError 静默延迟：无排障事件；事件进入退避且带错误信息。
    assert database.event_count("direction_intent_projection_deferred") == 0
    events = _direction_events(database)
    assert len(events) == 1
    assert events[0]["status"] == "retry_wait"
    assert "disk full" in str(events[0]["last_error"])

    # ③ 恢复写入后由 Projector 补写，且重复恢复不双计。
    _fast_forward_backoff(database)
    assert Projector(store, database).recover() >= 1
    records = store.read_jsonl("intents.jsonl")
    assert len(records) == 1
    backfilled = dict(records[0])
    backfilled.pop("_projection", None)
    assert backfilled == open_items[0]["intent"], "补写内容必须与 SQLite 完全一致"
    Projector(store, database).recover()
    assert len(store.read_jsonl("intents.jsonl")) == 1
    assert _direction_events(database)[0]["status"] == "committed"


# ---------------------------------------------------------------------------
# 角度二：方向投影的"文件已写、回执丢失"窗口：重放不得双计文件行。
# ---------------------------------------------------------------------------

def test_direction_intent_receipt_window_replay_keeps_single_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史坑：回执窗口（动作已执行、回执未写）中断后重放曾造成双计。

    test_cli_commit_paths.py 的既有场景针对 fact 计数；本角度针对方向投影：
    注入"先写文件、再抛错"（模拟写成功后、回执落盘前进程中断），
    事件重放时必须依赖文件级幂等标记或回执去重，保证 intents.jsonl
    中同一方向永远只有一行。
    """
    store = _project(tmp_path, monkeypatch, vendor="reg-receipt-window")
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/window"
    _profile_and_assess(store, url, 60)
    assert seed_priority_target_directions(store, database) == 1
    first_direction = _open_intents(database, url)[0]

    # 注入：文件写入成功后进程中断（回执未写、事件未完成）。
    original_append = store.append_jsonl
    fail = {"on": True}

    def write_then_crash(name, item):
        result = original_append(name, item)
        if fail["on"] and name == "intents.jsonl":
            raise OSError("crash after write, before receipt")
        return result

    monkeypatch.setattr(store, "append_jsonl", write_then_crash)
    _profile_and_assess(store, url, 95, tests=["auth_bypass"], ensure_profile=False)  # 实质变化触发替代
    created = seed_priority_target_directions(store, database)
    monkeypatch.undo()
    fail["on"] = False

    assert created == 1
    open_items = _open_intents(database, url)
    assert len(open_items) == 1 and open_items[0]["id"] != first_direction["id"]
    # 文件里新方向已落盘一行（写成功），但事件未完成、回执缺失。
    assert len(store.read_jsonl("intents.jsonl")) == 2
    event = _direction_events(database)[-1]
    assert event["status"] != "committed"

    # 恢复后重放：动作重执行，但文件幂等标记挡住重复追加——只有一行。
    _fast_forward_backoff(database)
    Projector(store, database).recover()
    records = store.read_jsonl("intents.jsonl")
    assert len(records) == 2, "重放不得向 intents.jsonl 追加重复行"
    new_records = [r for r in records if r.get("target_score") == 95]
    assert len(new_records) == 1
    content = dict(new_records[0])
    content.pop("_projection", None)
    assert content == open_items[0]["intent"]
    # 事件收敛为 committed；再次恢复仍不双计。
    assert _direction_events(database)[-1]["status"] == "committed"
    Projector(store, database).recover()
    assert len(store.read_jsonl("intents.jsonl")) == 2


# ---------------------------------------------------------------------------
# 角度三：fact 动作在 after_projection_receipt 窗口的重放不双计。
# ---------------------------------------------------------------------------

def test_fact_replay_after_receipt_window_does_not_double_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史坑：回执已写入但事件未完成的窗口中中断，恢复重放时
    不得重复执行动作、不得重复累计计数，也不得重复写回执。

    与既有 before_projection_receipt 场景互补：本窗口里回执已存在，
    重放必须靠 projection_receipt_exists 跳过动作直达完成。
    """
    from src.sorne.worker import submit_payload

    store = _project(tmp_path, monkeypatch, vendor="reg-fact-after-receipt")

    def crash_after_receipt(point: str) -> None:
        if point == "after_projection_receipt":
            raise RuntimeError("simulated crash after receipt, before event commit")

    with pytest.raises(RuntimeError):
        submit_payload(
            store,
            {
                "kind": "fact",
                "title": "回执已写事件未完成",
                "category": "other",
                "evidence": "回执已持久化、提交事件尚未完成时进程中断的长证据描述。",
                "business_impact": "验证重放不重复执行动作。",
                "reproduction_steps": ["注入故障", "恢复投影"],
                "evidence_path": "",
            },
            source_type="manual_cli_fact",
            gate_required=False,
            fault_hook=crash_after_receipt,
        )

    Projector(store).recover()

    # 退避到期后重放：回执已存在，动作被跳过直达完成，不重复执行。
    database = ControlDatabase(store.path / "control_plane.db")
    _fast_forward_backoff(database)
    Projector(store).recover()

    rows = store.read_jsonl("facts.jsonl")
    assert len(rows) == 1
    assert store.load_state().fact_count == 1
    with database.connect() as db:
        receipts = [
            (str(r["event_id"]), str(r["action_key"]))
            for r in db.execute(
                "SELECT event_id,action_key FROM projection_receipts"
            ).fetchall()
        ]
        events = [
            dict(r) for r in db.execute(
                "SELECT * FROM commit_events WHERE source_type='manual_cli_fact'"
            ).fetchall()
        ]
    assert len(events) == 1
    assert events[0]["status"] == "committed"
    assert receipts.count((events[0]["event_id"], "apply_worker_output:0")) == 1, (
        "重放不得产生重复回执"
    )

    # 二次恢复：完全幂等。
    Projector(store).recover()
    assert len(store.read_jsonl("facts.jsonl")) == 1
    assert store.load_state().fact_count == 1
