"""Projector 压力：构造 400 个合成提交事件后 drain，断言全部 committed、投影计数一致。"""
from __future__ import annotations

import time

from src.sorne.database import ControlDatabase
from src.sorne.projector import Projector
from src.sorne.store import ProjectStore

EVENT_COUNT = 400
TIMEOUT_SECONDS = 180.0


def test_projector_drains_400_synthetic_commit_events() -> None:
    store = ProjectStore("stress-projector")
    store.init()
    database = ControlDatabase(store.path / "control_plane.db")

    seed_started = time.monotonic()
    registered: set[str] = set()
    for index in range(EVENT_COUNT):
        intent = {
            "verb": "verify",
            "target": f"https://example.com/target-{index}",
            "hypothesis": f"合成假设-{index}",
            "success_criteria": "合成成功标准",
            "risk_level": "medium",
            "priority_score": round((index % 10) / 10, 1),
        }
        direction_id, created = database.register_direction(
            intent,
            record_intent_projection=True,
            hypothesis_payload={"hypothesis_id": f"H-{index}", "statement": f"合成-{index}"},
        )
        assert created, f"方向 {index} 应新建，却被去重"
        registered.add(direction_id)
    seed_seconds = time.monotonic() - seed_started

    counts_before = database.commit_event_counts()
    assert counts_before.get("pending", 0) == EVENT_COUNT, counts_before
    assert set(counts_before) == {"pending"}, counts_before

    drain_started = time.monotonic()
    projected = Projector(store, database).recover()
    drain_seconds = time.monotonic() - drain_started

    counts = database.commit_event_counts()
    assert counts.get("committed") == EVENT_COUNT, f"事件未全部 committed: {counts}"
    assert set(counts) == {"committed"}, f"存在未完成/失败事件: {counts}"
    assert projected == EVENT_COUNT

    intents = store.read_jsonl("intents.jsonl")
    hypotheses = store.read_jsonl("hypotheses.jsonl")
    assert len(intents) == EVENT_COUNT, f"intents.jsonl 投影行数不符: {len(intents)}"
    assert len(hypotheses) == EVENT_COUNT, f"hypotheses.jsonl 投影行数不符: {len(hypotheses)}"
    intent_targets = {row.get("target") for row in intents}
    assert len(intent_targets) == EVENT_COUNT, "投影内容存在重复或缺失"
    hypothesis_ids = {row.get("hypothesis_id") for row in hypotheses}
    assert len(hypothesis_ids) == EVENT_COUNT, "hypotheses 投影存在重复或缺失"

    # 幂等：再 drain 一次不得重复投影。
    again = Projector(store, database).recover()
    assert again == 0
    assert len(store.read_jsonl("intents.jsonl")) == EVENT_COUNT
    assert len(store.read_jsonl("hypotheses.jsonl")) == EVENT_COUNT

    assert drain_seconds < TIMEOUT_SECONDS
    print(
        f"\n[Projector] {EVENT_COUNT} 事件 seed={seed_seconds:.2f}s drain={drain_seconds:.2f}s "
        f"({EVENT_COUNT / drain_seconds:.0f} events/s)"
    )
