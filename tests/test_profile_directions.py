from __future__ import annotations

from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane.context_compiler import compile_worker_context
from src.agent_control_plane.database import ControlDatabase
from src.agent_control_plane.schemas import now_iso
from src.agent_control_plane.store import ProjectStore
from src.agent_control_plane.target_profile import (
    assessment_coverage,
    mark_needs_review_queued,
    needs_review_exhausted_urls,
    pending_needs_review_urls,
    profile_policy,
    record_target_assessments,
    record_target_profile,
    seed_priority_target_directions,
)


def _project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vendor: str = "profile-lab") -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore(vendor)
    store.init()
    return store


def _profile_url(store: ProjectStore, url: str, function: str = "用户登录") -> None:
    recorded = record_target_profile(store, [{"url": url, "function": function, "technology_stack": ["Vue"]}], proposed_by="test")
    assert recorded, f"画像记录失败: {url}"


def _assess(
    store: ProjectStore,
    url: str,
    profile_class: str,
    *,
    score: int | None = None,
    tests: list[str] | None = None,
    reason: str = "后台高影响入口",
    expect_recorded: bool = True,
) -> None:
    recorded = record_target_assessments(store, [{
        "url": url,
        "profile_class": profile_class,
        "target_score": score,
        "risk_tags": ["upload"],
        "score_reason": reason,
        "recommended_tests": tests or ["upload_validation"],
    }], proposed_by="test")
    if expect_recorded:
        assert recorded, "评估记录失败"


def _directions(database: ControlDatabase) -> list[dict]:
    return database.list_directions()


# ---------------------------------------------------------------------------
# 问题 1：评分语义分离与跨源排序
# ---------------------------------------------------------------------------

def test_profile_direction_does_not_derive_risk_from_priority(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin/upload"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=98)

    created = seed_priority_target_directions(store, database)

    assert created == 1
    intent = _directions(database)[0]["intent"]
    # 测试优先级字段保留；风险语义不再从优先分推导。
    assert intent["target_score"] == 98
    assert intent["priority_score"] == 0.98
    assert intent["risk_level"] == "unknown"
    assert intent["action_safety_risk"] == "unknown"
    assert intent["evidence_maturity"] == "hypothesis"
    assert intent["requires_human_confirmation"] is False


def test_direction_ordering_is_fair_across_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    # 关闭入队阈值以构造旧缺陷场景：0 分画像方向与无评分方法论方向并存。
    target = store.read_json("target.json")
    target["profile_policy"] = {"enqueue_min_score": 0}
    store.write_json("target.json", target)
    url = "https://example.com/low-value"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=0, reason="低价值但可测")
    seed_priority_target_directions(store, database)
    # 方法论方向没有 target_score / priority_score，但带有真实潜在风险。
    database.register_direction({
        "verb": "verify",
        "target": "https://example.com/",
        "hypothesis": "越权边界",
        "success_criteria": "形成对照证据",
        "risk_level": "high",
    })

    claimed = database.claim_direction("executor-1")

    assert claimed["intent"]["hypothesis"] == "越权边界"
    # 旧排序以 target_score DESC 为第二键（缺失记 -1），0 分画像方向会排在
    # 没有该字段的高价值方法论方向之前；新排序以 priority_score 为主键后
    # 由 risk_level 决胜，方法论方向胜出。


def test_high_score_profile_direction_outranks_weak_methodology_direction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=90)
    seed_priority_target_directions(store, database)
    database.register_direction({
        "verb": "inspect",
        "target": "https://example.com/",
        "hypothesis": "端口指纹",
        "success_criteria": "确认服务指纹",
        "priority_score": 0.3,
        "risk_level": "low",
    })

    claimed = database.claim_direction("executor-1")

    assert claimed["intent"]["target"] == url


def test_human_confirmation_direction_still_claimed_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=100)
    seed_priority_target_directions(store, database)
    database.register_direction({
        "verb": "verify",
        "target": "https://example.com/destructive",
        "hypothesis": "破坏性动作",
        "success_criteria": "形成证据",
        "priority_score": 0.1,
        "requires_human_confirmation": True,
    })

    claimed = database.claim_direction("executor-1")

    assert claimed["intent"]["requires_human_confirmation"] is True


# ---------------------------------------------------------------------------
# 问题 2：入队阈值与背压
# ---------------------------------------------------------------------------

def test_enqueue_threshold_boundary_and_policy_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    low = "https://example.com/low"
    edge = "https://example.com/edge"
    _profile_url(store, low)
    _profile_url(store, edge)
    _assess(store, low, "priority_target", score=39)
    _assess(store, edge, "priority_target", score=40)

    created = seed_priority_target_directions(store, database)

    assert created == 1
    targets = [item["intent"]["target"] for item in _directions(database)]
    assert targets == [edge]
    # 低于阈值的目标保留评估记录，但不入队。
    assert any(item["url"] == low for item in store.read_jsonl("target_assessments.jsonl"))
    # 阈值可按项目覆盖。
    target = store.read_json("target.json")
    target["profile_policy"] = {"enqueue_min_score": 39}
    store.write_json("target.json", target)
    assert profile_policy(store)["enqueue_min_score"] == 39
    created = seed_priority_target_directions(store, database)
    assert created == 1
    assert {item["intent"]["target"] for item in _directions(database)} == {low, edge}


def test_routine_and_needs_review_targets_never_enqueue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    routine = "https://example.com/news/1"
    review = "https://example.com/unknown-purpose"
    _profile_url(store, routine)
    _profile_url(store, review)
    _assess(store, routine, "routine_network_info")
    _assess(store, review, "needs_review")

    created = seed_priority_target_directions(store, database)

    assert created == 0
    assert _directions(database) == []


def test_backpressure_stops_profile_seeding_at_watermark(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    for index in range(12):
        database.register_direction({
            "verb": "inspect",
            "target": f"https://example.com/backlog-{index}",
            "hypothesis": "既有积压方向",
            "success_criteria": "形成证据",
        })
    url = "https://example.com/high-value"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=95)

    created = seed_priority_target_directions(store, database)

    assert created == 0
    assert all(
        item["intent"].get("target_profile_id") is None
        for item in _directions(database)
    )


# ---------------------------------------------------------------------------
# 问题 3：评估更新与方向生命周期
# ---------------------------------------------------------------------------

def test_recommended_tests_change_is_recorded_and_supersedes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    url = "https://example.com/admin/upload"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=80, tests=["upload_validation"])
    first = store.read_jsonl("target_assessments.jsonl")[-1]

    _assess(store, url, "priority_target", score=80, tests=["authorization_validation"])

    rows = store.read_jsonl("target_assessments.jsonl")
    assert len(rows) == 2
    second = rows[-1]
    assert second["recommended_tests"] == ["authorization_validation"]
    assert second["supersedes"] == first["id"]
    # 最新评估生效。
    from src.agent_control_plane.target_profile import target_assessments
    latest = target_assessments(store)
    assert latest[0]["recommended_tests"] == ["authorization_validation"]


def test_identical_resubmission_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=80)
    first = seed_priority_target_directions(store, database)
    second = seed_priority_target_directions(store, database)
    # 再重复提交一次完全相同的评估：内容级去重，不追加新记录。
    _assess(store, url, "priority_target", score=80, expect_recorded=False)

    assert first == 1
    assert second == 0
    seed_priority_target_directions(store, database)
    assert len(_directions(database)) == 1
    assert len(store.read_jsonl("target_assessments.jsonl")) == 1


def test_small_score_drift_does_not_churn_directions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=80)
    seed_priority_target_directions(store, database)
    direction_id = _directions(database)[0]["id"]

    _assess(store, url, "priority_target", score=88)  # 8 分波动 < 默认阈值 15
    created = seed_priority_target_directions(store, database)

    assert created == 0
    directions = _directions(database)
    assert len(directions) == 1
    assert directions[0]["id"] == direction_id
    assert directions[0]["status"] == "open"


def test_material_rescore_supersedes_pending_direction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60, tests=["upload_validation"])
    seed_priority_target_directions(store, database)
    old = _directions(database)[0]

    _assess(store, url, "priority_target", score=95, tests=["upload_validation", "auth_bypass"])
    created = seed_priority_target_directions(store, database)

    assert created == 1
    directions = _directions(database)
    assert len(directions) == 2
    by_status = {item["id"]: item for item in directions}
    assert by_status[old["id"]]["status"] == "cancelled"
    assert by_status[old["id"]]["terminal_reason"].startswith("superseded_by_assessment:")
    new_direction = next(item for item in directions if item["id"] != old["id"])
    assert new_direction["status"] == "open"
    assert new_direction["intent"]["recommended_tests"] == ["upload_validation", "auth_bypass"]


def test_downgrade_cancels_pending_but_keeps_claimed_and_completed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    pending_url = "https://example.com/pending"
    claimed_url = "https://example.com/claimed"
    done_url = "https://example.com/done"
    for url in (pending_url, claimed_url, done_url):
        _profile_url(store, url)
        _assess(store, url, "priority_target", score=80)
    seed_priority_target_directions(store, database)
    by_target = {item["intent"]["target"]: item for item in _directions(database)}
    # 手动把 claimed_url 的方向置为 claimed，模拟执行器持有租约。
    claimed_direction = by_target[claimed_url]
    with database.connect() as db:
        db.execute(
            "UPDATE directions SET status='claimed',claimed_by=?,lease_expires_at=?,updated_at=? WHERE id=?",
            ("executor-9", "2999-01-01T00:00:00+00:00", now_iso(), claimed_direction["id"]),
        )
    with database.connect() as db:
        db.execute(
            "UPDATE directions SET status='completed',updated_at=? WHERE id=?",
            (now_iso(), by_target[done_url]["id"]),
        )

    # 三个目标全部降级为常规信息。
    for url in (pending_url, claimed_url, done_url):
        _assess(store, url, "routine_network_info")
    created = seed_priority_target_directions(store, database)

    assert created == 0
    statuses = {item["intent"]["target"]: item["status"] for item in _directions(database)}
    assert statuses[pending_url] == "cancelled"
    # 执行中方向尊重租约，不被降级打断；已完成方向及历史保留。
    assert statuses[claimed_url] == "claimed"
    assert statuses[done_url] == "completed"


def test_completed_direction_not_retriggered_without_material_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=80)
    seed_priority_target_directions(store, database)
    direction_id = _directions(database)[0]["id"]
    with database.connect() as db:
        db.execute("UPDATE directions SET status='completed',updated_at=? WHERE id=?", (now_iso(), direction_id))

    # 重新评分（小幅波动）后不再重复触发相同测试。
    _assess(store, url, "priority_target", score=85)
    created = seed_priority_target_directions(store, database)

    assert created == 0
    # 建议专项实质变化时会为已完成目标安排新的验证方向。
    _assess(store, url, "priority_target", score=85, tests=["ssrf_validation"])
    created = seed_priority_target_directions(store, database)
    assert created == 1


def test_below_threshold_after_rescore_cancels_pending_direction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=80)
    seed_priority_target_directions(store, database)
    direction_id = _directions(database)[0]["id"]

    _assess(store, url, "priority_target", score=20, tests=["upload_validation", "extra_probe"])
    created = seed_priority_target_directions(store, database)

    assert created == 0
    direction = next(item for item in _directions(database) if item["id"] == direction_id)
    assert direction["status"] == "cancelled"
    assert direction["terminal_reason"].startswith("profile_below_enqueue_threshold:")


# ---------------------------------------------------------------------------
# 问题 4：needs_review 与尚未评估的区分
# ---------------------------------------------------------------------------

def test_needs_review_is_distinct_from_unassessed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    reviewed = "https://example.com/reviewed"
    fresh = "https://example.com/fresh"
    _profile_url(store, reviewed)
    _profile_url(store, fresh, function="未知功能页面")
    _assess(store, reviewed, "needs_review")

    coverage = assessment_coverage(store)

    assert coverage["profiled_urls"] == 2
    assert coverage["assessed"] == 1
    assert coverage["unassessed"] == 1
    assert coverage["by_class"]["needs_review"] == 1
    assert pending_needs_review_urls(store) == [reviewed]

    # 未评估 URL 不会进入复核队列。
    queued = mark_needs_review_queued(store, pending_needs_review_urls(store))
    assert queued == [reviewed]
    # 复核上限（默认 2）耗尽后进入失败终态，不再重试。
    mark_needs_review_queued(store, [reviewed])
    assert needs_review_exhausted_urls(store) == [reviewed]
    assert pending_needs_review_urls(store) == []


def test_enriched_profile_keeps_unassessed_distinct(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.agent_control_plane.technologies import enriched_target_profile

    store = _project(tmp_path, monkeypatch)
    reviewed = "https://example.com/reviewed"
    fresh = "https://example.com/fresh"
    _profile_url(store, reviewed)
    _profile_url(store, fresh, function="未知功能页面")
    _assess(store, reviewed, "needs_review")

    enriched = {item["url"]: item for item in enriched_target_profile(store)}

    assert enriched[reviewed]["profile_class"] == "needs_review"
    # 尚未评估的 URL 不再被默认成 needs_review。
    assert enriched[fresh]["profile_class"] is None


# ---------------------------------------------------------------------------
# 问题 5：mrecon 来源标注与上下文覆盖
# ---------------------------------------------------------------------------

def test_mrecon_observation_kind_distinguishes_sources() -> None:
    from src.agent_control_plane.mrecon import _observation_kind

    assert _observation_kind("http_crawl", 200) == "requested"
    assert _observation_kind("browser_xhr", 200) == "requested"
    assert _observation_kind("js_bundle", None) == "inferred"
    assert _observation_kind("html_form", None) == "observed_not_requested"
    assert _observation_kind("browser_dom", None) == "observed_not_requested"


def test_compact_mrecon_rows_expose_observation_kind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    rows = [
        {"url": "https://example.com/page", "source": "http_crawl", "status": 200,
         "observation_kind": "requested"},
        {"url": "https://example.com/api/orders.view", "source": "js_bundle", "status": None,
         "observation_kind": "inferred"},
        {"url": "https://example.com/submit", "source": "html_form", "status": None,
         "observation_kind": "observed_not_requested"},
    ]
    with store.locked():
        for index, row in enumerate(rows):
            store.append_jsonl("mrecon_observations.jsonl", {
                "id": f"MR-{index}", "method": "GET", "function": "功能", **row,
            })

    from src.agent_control_plane.mrecon import compact_mrecon_rows

    compact = {item["url"]: item for item in compact_mrecon_rows(store)}
    assert compact["https://example.com/page"]["observation_kind"] == "requested"
    assert compact["https://example.com/api/orders.view"]["observation_kind"] == "inferred"
    assert compact["https://example.com/submit"]["observation_kind"] == "observed_not_requested"


def _seed_mrecon_rows(store: ProjectStore, count: int) -> None:
    """count 条待评估记录 + 1 条已评估记录，全部属于 example.com。"""
    with store.locked():
        for index in range(count):
            url = f"https://example.com/{index:02d}-fresh"
            record_target_profile(store, [{
                "url": url, "function": f"待评估功能 {index}", "technology_stack": [],
            }], proposed_by="test")
            store.append_jsonl("mrecon_observations.jsonl", {
                "id": f"MR-{index}", "url": url, "method": "GET", "status": 200,
                "function": f"待评估功能 {index}", "source": "http_crawl",
                "observation_kind": "requested",
            })
    assessed = "https://example.com/a-assessed"
    record_target_profile(store, [{
        "url": assessed, "function": "已评估功能", "technology_stack": [],
    }], proposed_by="test")
    with store.locked():
        store.append_jsonl("mrecon_observations.jsonl", {
            "id": "MR-assessed", "url": assessed, "method": "GET", "status": 200,
            "function": "已评估功能", "source": "http_crawl",
            "observation_kind": "requested",
        })
    _assess(store, assessed, "priority_target", score=50)


def test_context_compiler_prioritizes_unassessed_mrecon_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _project(tmp_path, monkeypatch)
    _seed_mrecon_rows(store, 20)
    task = {"本分片唯一目标": ["https://example.com"]}

    compiled = compile_worker_context(
        store, "profile_mapper", task_context=task, budget_chars=4_000,
    )

    rows = compiled.context["mrecon_observations"]
    row_urls = [item["url"] for item in rows]
    # 预算触发的截断必须发生在待评估尾部；已评估记录不得挤占待评估记录。
    assert "https://example.com/a-assessed" not in row_urls
    assert row_urls[0] == "https://example.com/00-fresh"
    manifest = compiled.manifest
    assert manifest["mrecon_coverage"]["assigned_rows"] == 21
    assert manifest["mrecon_coverage"]["unassessed_rows"] == 20
    assert manifest["mrecon_coverage"]["omitted_rows"] >= 1
    assert manifest["mrecon_coverage"]["included_rows"] == len(row_urls)


def test_second_pass_advances_after_first_rows_assessed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """未评估优先 + 覆盖追踪：第一轮评估头部后，第二轮必须推进到尾部记录。"""
    store = _project(tmp_path, monkeypatch)
    _seed_mrecon_rows(store, 20)
    task = {"本分片唯一目标": ["https://example.com"]}

    first = compile_worker_context(store, "profile_mapper", task_context=task, budget_chars=4_000)
    first_urls = [item["url"] for item in first.context["mrecon_observations"]]
    assert 0 < len(first_urls) < 20, "预算应只容纳部分记录"
    # 模拟第一轮已完成对头部记录的评估。
    for url in first_urls:
        _assess(store, url, "routine_network_info")

    second = compile_worker_context(store, "profile_mapper", task_context=task, budget_chars=4_000)
    second_urls = [item["url"] for item in second.context["mrecon_observations"]]

    assert second_urls, "第二轮不应为空"
    not_yet_assessed = {
        f"https://example.com/{index:02d}-fresh" for index in range(20)
    } - set(first_urls)
    # 分片必须向前推进：所有仍未评估的记录都要进入第二轮上下文，
    # 且整体排在已评估记录之前（剩余预算可附带已评估记录，但不得挤占待评估）。
    assert not_yet_assessed <= set(second_urls), (
        "待评估尾部记录被静默遗漏：" + str(sorted(not_yet_assessed - set(second_urls)))
    )
    head = second_urls[: len(not_yet_assessed)]
    assert set(head) == not_yet_assessed, "待评估记录必须排在已评估记录之前"


# ---------------------------------------------------------------------------
# 恢复/幂等：投影重放不重复生成方向、不重复记录评估
# ---------------------------------------------------------------------------

def test_worker_output_replay_does_not_duplicate_assessments_or_directions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.agent_control_plane.worker import apply_worker_output

    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin/upload"
    payload = {
        "kind": "target_profile_batch",
        "records": [{"url": url, "function": "后台文件上传", "technology_stack": ["Spring Boot"]}],
        "assessments": [{
            "url": url, "profile_class": "priority_target", "target_score": 85,
            "risk_tags": ["upload"], "score_reason": "后台高影响入口",
            "recommended_tests": ["upload_validation"],
        }],
        "routine_groups": [],
        "exploration_complete": True,
    }

    # 相同内容经两条不同幂等键提交（模拟原始提交 + 恢复重放）。
    apply_worker_output(store, dict(payload), source_type="automation_job", source_id="J-1", idempotency_key="job:J-1:profile")
    apply_worker_output(store, dict(payload), source_type="automation_job", source_id="J-1-replay", idempotency_key="job:J-1-replay:profile")

    assessments = store.read_jsonl("target_assessments.jsonl")
    assert len(assessments) == 1  # 内容级去重，重放不追加
    created_first = seed_priority_target_directions(store, database)
    created_again = seed_priority_target_directions(store, database)
    assert created_first == 1
    assert created_again == 0
    assert len(_directions(database)) == 1


# ===========================================================================
# 第二轮反例：以下测试先于实现修复编写，用于独立复现审查发现的生命周期缺陷。
# 注意：分数类反例只改分数，不同时修改建议专项。
# ===========================================================================

def _open_directions(database: ControlDatabase, url: str) -> list[dict]:
    return [
        item for item in _directions(database)
        if item["status"] in {"open", "released"}
        and str(item["intent"].get("target") or "").casefold() == url.casefold()
    ]


def test_counterexample_score_only_rescore_replaces_direction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 仅大幅调整分数（60→95，其余不变）必须完成替代，不得让方向消失。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1

    _assess(store, url, "priority_target", score=95)  # 只改分数
    created = seed_priority_target_directions(store, database)

    assert created == 1
    open_items = _open_directions(database, url)
    assert len(open_items) == 1
    assert open_items[0]["intent"]["target_score"] == 95


def test_counterexample_threshold_crossing_beats_drift_debounce(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 40→39 跨越入队阈值必须立即生效，不能被“变化不足 15 分”防抖吞掉。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=40)
    assert seed_priority_target_directions(store, database) == 1

    _assess(store, url, "priority_target", score=39)  # 只降 1 分，但跌破阈值
    created = seed_priority_target_directions(store, database)

    assert created == 0
    assert _open_directions(database, url) == []
    cancelled = [item for item in _directions(database) if item["status"] == "cancelled"]
    assert len(cancelled) == 1
    assert cancelled[0]["terminal_reason"].startswith("profile_below_enqueue_threshold:")


def test_counterexample_downgrade_cancels_at_backlog_watermark(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 队列达到高水位时，降级清理仍必须执行；背压只能限制新增。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    for index in range(11):
        database.register_direction({
            "verb": "inspect",
            "target": f"https://example.com/other-{index}",
            "hypothesis": "既有方向",
            "success_criteria": "形成证据",
        })
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=80)
    assert seed_priority_target_directions(store, database) == 1
    assert database.open_direction_count() == 12

    _assess(store, url, "routine_network_info")
    created = seed_priority_target_directions(store, database)

    assert created == 0
    assert _open_directions(database, url) == []
    assert database.open_direction_count() == 11  # 其余方向不受影响


def test_counterexample_assessment_can_revert_to_historical_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 优先 A → 常规 B → 再次提交相同 A：最新评估必须恢复为 A，方向可复活。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=80)
    assert seed_priority_target_directions(store, database) == 1
    _assess(store, url, "routine_network_info")
    assert seed_priority_target_directions(store, database) == 0
    assert _open_directions(database, url) == []

    # 与第一次 A 完全相同的内容：这是“新的判断恢复旧结论”，不是同一次提交重放。
    _assess(store, url, "priority_target", score=80)

    from src.agent_control_plane.target_profile import target_assessments
    latest = target_assessments(store)
    assert latest[0]["profile_class"] == "priority_target"
    assert latest[0]["target_score"] == 80
    assert latest[0]["supersedes"] is not None  # 指向 B 版本

    created = seed_priority_target_directions(store, database)
    assert created == 1
    open_items = _open_directions(database, url)
    assert len(open_items) == 1
    assert open_items[0]["intent"]["target_score"] == 80


def test_counterexample_watermark_caps_total_open_directions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P2] 高水位限制的是开放方向总量，不是单次新增量。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    for index in range(11):
        database.register_direction({
            "verb": "inspect",
            "target": f"https://example.com/other-{index}",
            "hypothesis": "既有方向",
            "success_criteria": "形成证据",
        })
    for index in range(5):
        url = f"https://example.com/target-{index}"
        _profile_url(store, url)
        _assess(store, url, "priority_target", score=85)

    created = seed_priority_target_directions(store, database)

    assert created == 1
    assert database.open_direction_count() == 12


def test_pending_needs_review_excludes_current_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """复核每 Run 至多一批：已在本 Run 排队过的 URL 不再重复进入。"""
    store = _project(tmp_path, monkeypatch)
    url = "https://example.com/reviewed"
    _profile_url(store, url)
    _assess(store, url, "needs_review")

    assert pending_needs_review_urls(store, exclude_run_id="R-run-1") == [url]
    mark_needs_review_queued(store, [url], run_id="R-run-1")

    assert pending_needs_review_urls(store, exclude_run_id="R-run-1") == []
    assert pending_needs_review_urls(store, exclude_run_id="R-run-2") == [url]
    # 未消耗完全额时，换 Run 后仍可复核。
    assert needs_review_exhausted_urls(store) == []


def test_counterexample_needs_review_counts_only_scheduled_urls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """已有 100+ 其他待画像 URL 时，复核 URL 未进入 Job 不得消耗复核次数。"""
    from src.agent_control_plane.automation import AutomationEngine
    from src.agent_control_plane.target_profile import queue_incremental_profile_urls, load_profile_state

    store = _project(tmp_path, monkeypatch, vendor="review-counting")
    target = store.read_json("target.json")
    target["targets"] = ["https://example.com"]
    store.write_json("target.json", target)
    from src.agent_control_plane.asset_inventory import AssetInventory
    AssetInventory(store).sync_declared_targets()  # 提供 example.com 资产分派底座
    queue_incremental_profile_urls(
        store, [f"https://example.com/legacy/{index}" for index in range(105)]
    )
    reviewed = "https://example.com/reviewed"
    _profile_url(store, reviewed)
    _assess(store, reviewed, "needs_review")

    engine = AutomationEngine(store)
    run_id = engine.db.create_run(store.vendor, "default", 600, 3)
    run = engine.db.get_run(run_id)

    scheduled = engine._schedule_pending_incremental_profile(run)

    assert scheduled is True
    jobs = engine.db.list_jobs(run_id, "profile_incremental")
    assert jobs, "应当产生增量画像 Job"
    job_seeds = jobs[0]["payload"].get("profile_seed_urls") or []
    assert reviewed not in job_seeds
    state = load_profile_state(store)
    assert state.get("needs_review_attempts", {}) == {}, (
        "未进入 Job 的复核 URL 不得消耗复核次数"
    )


# ===========================================================================
# 第三轮反例：人工否决 / 过期租约 / 双源一致性。
# ===========================================================================

def test_counterexample_human_dismissal_not_bypassed_by_rescore(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 人工否决只能由人工恢复；仅重新评分（只改分数）不得绕过。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    direction_id = _directions(database)[0]["id"]

    dismissed = database.dismiss_direction(direction_id, "人工判断该目标不值得继续验证")
    assert dismissed["status"] == "cancelled"
    assert str(dismissed["terminal_reason"]).startswith("human_dismissed:")

    _assess(store, url, "priority_target", score=95)  # 只改分数
    created = seed_priority_target_directions(store, database)
    assert created == 0, "重新评分不得绕过人工否决"
    assert _open_directions(database, url) == []

    # 显式人工恢复后，方向才允许重新入队。
    restored = database.restore_direction(direction_id, "复核后确认恢复该目标测试")
    assert str(restored["terminal_reason"]).startswith("human_restored:")
    created = seed_priority_target_directions(store, database)
    assert created == 1
    open_items = _open_directions(database, url)
    assert len(open_items) == 1
    assert open_items[0]["intent"]["target_score"] == 95


def test_counterexample_expired_lease_downgraded_direction_not_reclaimed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 降级方向：有效租约保留；租约过期后必须被取消，不得重新认领。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    valid_url = "https://example.com/valid-lease"
    expired_url = "https://example.com/expired-lease"
    for url in (valid_url, expired_url):
        _profile_url(store, url)
        _assess(store, url, "priority_target", score=80)
    assert seed_priority_target_directions(store, database) == 2
    by_target = {item["intent"]["target"]: item for item in _directions(database)}
    with database.connect() as db:
        db.execute(
            "UPDATE directions SET status='claimed',claimed_by=?,lease_expires_at=?,updated_at=? WHERE id=?",
            ("executor-a", "2999-01-01T00:00:00+00:00", now_iso(), by_target[valid_url]["id"]),
        )
        db.execute(
            "UPDATE directions SET status='claimed',claimed_by=?,lease_expires_at=?,updated_at=? WHERE id=?",
            ("executor-b", "2000-01-01T00:00:00+00:00", now_iso(), by_target[expired_url]["id"]),
        )

    # 两个目标都降级为常规信息。
    for url in (valid_url, expired_url):
        _assess(store, url, "routine_network_info")
    assert seed_priority_target_directions(store, database) == 0

    statuses = {item["intent"]["target"]: item["status"] for item in _directions(database)}
    assert statuses[valid_url] == "claimed", "有效租约的执行中方向保留"
    assert statuses[expired_url] == "cancelled", "租约已过期的降级方向必须被取消"
    # 过期租约的降级方向不得被新 Worker 重新认领；有效租约方向他人也不可认领。
    assert database.claim_direction("executor-new") is None


def test_counterexample_sqlite_and_jsonl_intents_match(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P2] 版本化注册后，SQLite 与 intents.jsonl 中同一 direction 的完整 Intent 一致。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    _assess(store, url, "priority_target", score=95)  # 只改分数，触发版本化注册
    assert seed_priority_target_directions(store, database) == 1

    open_items = _open_directions(database, url)
    assert len(open_items) == 1
    direction = open_items[0]
    assert "#" in str(direction["intent"].get("chain_id")), "应走版本化注册路径"
    record = next(
        item for item in store.read_jsonl("intents.jsonl")
        if item.get("id") == direction["id"]
    )
    record.pop("_projection", None)
    assert record == direction["intent"], (
        "SQLite 与 JSONL 必须持久化同一个注册对象（含 chain_id）"
    )


# ===========================================================================
# 第四轮反例：恢复机制闭环与租约资格统一判定。
# ===========================================================================

def test_counterexample_second_dismiss_restore_cycle_and_seed_replay_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 同一评估下连续两轮否决/恢复都必须有效；播种函数重放不得重复入队。

    （恢复请求自身的重放幂等由独立测试覆盖。）"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    first_direction = _directions(database)[0]

    # 循环一：否决 → 只调分数到 95 → 播种被挡 → 人工恢复 → 重新入队。
    database.dismiss_direction(first_direction["id"], "第一轮否决")
    _assess(store, url, "priority_target", score=95)
    assert seed_priority_target_directions(store, database) == 0
    database.restore_direction(first_direction["id"], "第一轮恢复")
    assert seed_priority_target_directions(store, database) == 1
    open_items = _open_directions(database, url)
    assert len(open_items) == 1
    assert open_items[0]["intent"]["target_score"] == 95
    second_direction = open_items[0]

    # 循环二：完全不改评估，再次否决 → 再次恢复。
    database.dismiss_direction(second_direction["id"], "第二轮否决")
    database.restore_direction(second_direction["id"], "第二轮恢复")
    created = seed_priority_target_directions(store, database)

    open_items = _open_directions(database, url)
    assert len(open_items) == 1, "第二次恢复后必须仍有一个开放方向"
    assert open_items[0]["id"] == second_direction["id"], "无实质变化时应原地保留，不重复建方向"

    # 同一恢复事件重放（再播种一次，无新评估、无新事件）：不得重复入队。
    replayed = seed_priority_target_directions(store, database)
    assert replayed == 0
    assert len(_open_directions(database, url)) == 1
    total = [
        item for item in _directions(database)
        if str(item["intent"].get("target") or "").casefold() == url.casefold()
    ]
    assert len(total) == 2, "重放不得追加新方向记录"
    assert created == 0  # 原地恢复，无新建


def test_counterexample_plain_direction_restore_makes_claimable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 非画像方向的人工恢复必须打通到可认领状态，不能只改终止原因。"""
    database = ControlDatabase(tmp_path / "plain-restore.db")
    direction_id, _ = database.register_direction({
        "verb": "inspect",
        "target": "https://example.com/methodology-target",
        "hypothesis": "方法论方向的假设",
        "success_criteria": "形成可复核证据",
        "priority_score": 0.7,
    })
    dismissed = database.dismiss_direction(direction_id, "人工停止该方向")
    assert dismissed["status"] == "cancelled"

    restored = database.restore_direction(direction_id, "人工恢复执行")

    assert restored["status"] == "open", "恢复后必须重新开放调度"
    assert str(restored["terminal_reason"]).startswith("human_restored:")
    claimed = database.claim_direction("executor-1")
    assert claimed is not None
    assert claimed["id"] == direction_id


def test_counterexample_expired_lease_below_threshold_not_reclaimed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 分类不变但跌破入队阈值：过期租约方向必须取消，不得重新认领。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    direction_id = _directions(database)[0]["id"]
    claimed = database.claim_direction("executor-a", lease_seconds=30)
    assert claimed is not None and claimed["id"] == direction_id
    with database.connect() as db:  # 把租约置为已过期
        db.execute(
            "UPDATE directions SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (direction_id,),
        )

    _assess(store, url, "priority_target", score=39)  # 仍为 priority_target，只跌破阈值
    assert seed_priority_target_directions(store, database) == 0

    direction = next(item for item in _directions(database) if item["id"] == direction_id)
    assert direction["status"] == "cancelled", "跌破阈值的过期租约方向必须取消"
    assert str(direction["terminal_reason"]).startswith("profile_below_enqueue_threshold:")
    assert database.claim_direction("executor-new") is None


# ===========================================================================
# 第五轮反例：认领版本隔离（旧 Worker 回调）与历史方向恢复。
# ===========================================================================

def test_counterexample_stale_worker_callback_cannot_affect_restored_claim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 同一 Run 同一成员名：旧 Worker 的完成/取消/心跳不得影响恢复后的新认领。"""
    database = ControlDatabase(tmp_path / "claim-version.db")
    direction_id, _ = database.register_direction({
        "verb": "verify",
        "target": "https://example.com/admin",
        "hypothesis": "同一逻辑方向的假设",
        "success_criteria": "形成可复核证据",
        "priority_score": 0.8,
    })
    worker = "R-run-1:executor-primary"  # 调度器跨波次复用同一认领者名称
    first = database.claim_direction(worker, lease_seconds=30)
    assert first is not None and first["id"] == direction_id

    database.dismiss_direction(direction_id, "人工停止")
    database.restore_direction(direction_id, "人工恢复")
    second = database.claim_direction(worker, lease_seconds=30)
    assert second is not None and second["id"] == direction_id
    assert second["claim_version"] != first["claim_version"], "每次认领必须有独立版本"

    # 旧 Worker 持有旧版本回调：心跳、取消、完成全部不得影响新认领。
    assert not database.heartbeat_direction(
        direction_id, worker, lease_seconds=30, claim_version=first["claim_version"],
    )
    assert not database.finish_direction(
        direction_id, worker, outcome="cancelled",
        reason="旧 Worker 退出清理", claim_version=first["claim_version"],
    )
    current = database.get_direction(direction_id)
    assert current["status"] == "claimed"
    assert current["claimed_by"] == worker

    # 新认领持有的版本：心跳与完成照常生效。
    assert database.heartbeat_direction(
        direction_id, worker, lease_seconds=30, claim_version=second["claim_version"],
    )
    assert database.finish_direction(
        direction_id, worker, outcome="completed",
        claim_version=second["claim_version"],
    )
    assert database.get_direction(direction_id)["status"] == "completed"


def test_counterexample_restoring_superseded_direction_keeps_single_claimable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 历史方向恢复后，同一目标最多保留一个可认领版本（新版本胜出）。"""
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    old_direction = _directions(database)[0]
    _assess(store, url, "priority_target", score=95)  # 只调分数，替代为 95 分方向
    assert seed_priority_target_directions(store, database) == 1
    open_items = _open_directions(database, url)
    assert len(open_items) == 1 and open_items[0]["intent"]["target_score"] == 95

    # 绕过校验直接用底层原语恢复历史方向（模拟旧客户端/竞态）产生双 open
    # 脏状态；下一次同步必须坍缩为一个可认领版本（最新者胜出）。
    database.dismiss_direction(old_direction["id"], "停止历史方向")
    database.restore_direction(old_direction["id"], "绕过校验恢复旧版本")
    assert len(_open_directions(database, url)) == 2
    created = seed_priority_target_directions(store, database)
    assert created == 0
    open_items = _open_directions(database, url)
    assert len(open_items) == 1, "同步后同一目标只能有一个可认领版本"
    assert open_items[0]["intent"]["target_score"] == 95, "最新版本胜出"

    # 恢复入口的前置校验：有有效后继时必须拒绝恢复过期版本。
    from src.agent_control_plane.target_profile import ensure_profile_direction_restorable
    latest_open = open_items[0]
    database.dismiss_direction(old_direction["id"], "再次停止历史方向")
    with pytest.raises(ValueError, match="已有更新的有效方向"):
        ensure_profile_direction_restorable(store, database, old_direction["id"])
    # 无后继时不拒绝：停止唯一 open 方向后，恢复校验通过并可正常恢复。
    database.dismiss_direction(latest_open["id"], "停止当前方向")
    ensure_profile_direction_restorable(store, database, latest_open["id"])
    database.restore_direction(latest_open["id"], "恢复当前方向")
    assert len(_open_directions(database, url)) == 1


def test_restore_request_replay_is_rejected_without_side_effect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """恢复请求自身的重放：第二次调用必须被安全拒绝，不产生二次状态变更。

    与播种函数的重放幂等是两件事，分开验证。
    """
    store = _project(tmp_path, monkeypatch)
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=80)
    assert seed_priority_target_directions(store, database) == 1
    direction_id = _directions(database)[0]["id"]
    database.dismiss_direction(direction_id, "停止")

    first = database.restore_direction(direction_id, "恢复理由")
    assert first["status"] == "open"

    # 同一恢复请求重放：状态机已离开 human_dismissed，必须拒绝且无副作用。
    with pytest.raises(RuntimeError, match="不处于人工否决状态"):
        database.restore_direction(direction_id, "恢复理由")
    replayed = database.get_direction(direction_id)
    assert replayed["status"] == "open"
    assert str(replayed["terminal_reason"]).startswith("human_restored:")


# ===========================================================================
# 第六轮反例：升级前旧任务的版本授权与 claimed+open 存量归并。
# ===========================================================================

def test_counterexample_legacy_job_cannot_modify_restored_claim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 缺少 claim_version 的升级前任务，不得修改被重新认领的方向。"""
    from src.agent_control_plane.automation import AutomationEngine

    store = _project(tmp_path, monkeypatch, vendor="legacy-bound")
    engine = AutomationEngine(store)
    database = engine.db
    direction_id, _ = database.register_direction({
        "verb": "verify",
        "target": "https://example.com/admin",
        "hypothesis": "同一逻辑方向的假设",
        "success_criteria": "形成可复核证据",
        "priority_score": 0.8,
    })
    worker = "R-run-1:executor-primary"
    database.claim_direction(worker, lease_seconds=30)      # 新代码认领（版本 1）
    database.dismiss_direction(direction_id, "人工停止")
    database.restore_direction(direction_id, "人工恢复")
    database.claim_direction(worker, lease_seconds=30)      # 重新认领（版本 2）
    assert int(database.get_direction(direction_id)["claim_version"]) == 2

    # 模拟升级前持久化的任务绑定：有认领者名称、无 claim_version。
    legacy_bound = {"id": direction_id, "claimed_by": worker, "intent": {}}
    engine._finish_bound_direction(legacy_bound, payload={"kind": "fact"})

    current = database.get_direction(direction_id)
    assert current["status"] == "claimed", "旧任务不得终结重新认领后的方向"
    assert int(current["claim_version"]) == 2
    assert current["claimed_by"] == worker

    # 对照：从未被新代码认领（claim_version==0）的旧任务仍按旧语义完成。
    second_id, _ = database.register_direction({
        "verb": "verify",
        "target": "https://example.com/other",
        "hypothesis": "升级前认领的方向",
        "success_criteria": "形成可复核证据",
    })
    with database.connect() as db:
        db.execute(
            "UPDATE directions SET status='claimed',claimed_by=?,lease_expires_at=?,"
            "claim_version=0 WHERE id=?",
            (worker, "2999-01-01T00:00:00+00:00", second_id),
        )
    engine._finish_bound_direction({"id": second_id, "claimed_by": worker}, payload={"kind": "fact"})
    assert database.get_direction(second_id)["status"] == "completed"


def test_counterexample_claimed_plus_open_single_claimable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 同目标一个 claimed 一个 open：同步后不得形成两个并行执行。"""
    store = _project(tmp_path, monkeypatch, vendor="dup-claimable")
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    old_id = _directions(database)[0]["id"]
    _assess(store, url, "priority_target", score=95)
    assert seed_priority_target_directions(store, database) == 1
    new_id = next(item["id"] for item in _open_directions(database, url))

    # 情形 A（有效租约）：绕过校验恢复旧版本形成双 open，再认领新版本。
    database.dismiss_direction(old_id, "停止")
    database.restore_direction(old_id, "绕过校验恢复")  # 模拟存量脏状态
    claimed = database.claim_direction("executor-a", lease_seconds=30)
    assert claimed is not None and claimed["id"] == new_id
    assert seed_priority_target_directions(store, database) == 0
    assert database.get_direction(old_id)["status"] == "cancelled", "其他版本必须暂不可认领"
    assert database.get_direction(new_id)["status"] == "claimed"
    assert database.claim_direction("executor-b") is None, "不得形成第二个可执行版本"

    # 情形 B（过期租约）：再次制造 claimed+open，租约过期后同步必须归并。
    database.dismiss_direction(old_id, "再次停止")
    database.restore_direction(old_id, "再次绕过恢复")
    with database.connect() as db:
        db.execute(
            "UPDATE directions SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (new_id,),
        )
    assert seed_priority_target_directions(store, database) == 0
    statuses = {
        database.get_direction(old_id)["status"],
        database.get_direction(new_id)["status"],
    }
    first_claim = database.claim_direction("executor-b")
    second_claim = database.claim_direction("executor-c")
    claimable_ids = {item["id"] for item in (first_claim, second_claim) if item}
    assert len(claimable_ids) <= 1, "同步后同一目标只能有一个可认领版本"
    assert "open" not in statuses or statuses == {"cancelled", "claimed"}, (
        f"归并后不应残留 open 旧版本：{statuses}"
    )
    if first_claim:
        assert first_claim["id"] == new_id, "最新版本参与归并并胜出"
    assert second_claim is None or second_claim["id"] == first_claim["id"]


# ===========================================================================
# 第七轮反例：检查-变更窗口（确定性交错）。
# ===========================================================================

def test_counterexample_legacy_window_between_check_and_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 旧任务授权在"检查通过后、写回前"发生重领，不得影响新认领。

    用伪造的 V0 快照注入检查时刻的状态（真实库中方向已是 V2），
    确定性模拟并发窗口。
    """
    from src.agent_control_plane.automation import AutomationEngine

    store = _project(tmp_path, monkeypatch, vendor="legacy-window")
    engine = AutomationEngine(store)
    database = engine.db
    direction_id, _ = database.register_direction({
        "verb": "verify",
        "target": "https://example.com/admin",
        "hypothesis": "同一逻辑方向的假设",
        "success_criteria": "形成可复核证据",
        "priority_score": 0.8,
    })
    worker = "R-run-1:executor-primary"
    database.claim_direction(worker, lease_seconds=30)
    database.dismiss_direction(direction_id, "人工停止")
    database.restore_direction(direction_id, "人工恢复")
    database.claim_direction(worker, lease_seconds=30)  # 真实状态：V2
    assert int(database.get_direction(direction_id)["claim_version"]) == 2

    # 检查时刻的伪造快照：方向仍是升级前的 V0 认领（读两次以覆盖
    # 回调内的状态检查与授权检查），之后的读取恢复真实状态。
    real_get_direction = database.get_direction
    stale_snapshots = iter([
        {"id": direction_id, "status": "claimed", "claimed_by": worker, "claim_version": 0},
        {"id": direction_id, "status": "claimed", "claimed_by": worker, "claim_version": 0},
    ])

    def interleaved_get(direction_id_arg):
        snapshot = next(stale_snapshots, None)
        return snapshot if snapshot is not None else real_get_direction(direction_id_arg)

    monkeypatch.setattr(database, "get_direction", interleaved_get)
    legacy_bound = {"id": direction_id, "claimed_by": worker, "intent": {}}
    engine._finish_bound_direction(legacy_bound, payload={"kind": "fact"})
    monkeypatch.undo()

    current = real_get_direction(direction_id)
    assert current["status"] == "claimed", "检查通过后的状态变化不得让旧任务改写新认领"
    assert int(current["claim_version"]) == 2
    assert current["claimed_by"] == worker


def test_counterexample_cancel_failure_forbids_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 旧版本条件取消失败（被抢先重领）时，禁止创建替代版本。"""
    store = _project(tmp_path, monkeypatch, vendor="cancel-race")
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    old_id = _directions(database)[0]["id"]
    database.claim_direction("executor-a", lease_seconds=30)
    with database.connect() as db:  # 租约过期：同步会读到"可认领"快照
        db.execute(
            "UPDATE directions SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (old_id,),
        )
    _assess(store, url, "priority_target", score=95, tests=["authorization_validation"])

    # 确定性交错：同步读到过期认领快照后、取消/替代事务执行前，
    # 另一个 Worker 抢先重新认领（租约恢复有效）。覆盖新旧两条实现路径
    # 各自的必经点，只注入一次。
    interleaved = {"done": False}

    def steal_claim_once() -> None:
        if not interleaved["done"]:
            interleaved["done"] = True
            database.claim_direction("executor-b", lease_seconds=30)

    original_cancel = database.cancel_expired_claimed_direction

    def racing_cancel(direction_id, reason):
        steal_claim_once()
        return original_cancel(direction_id, reason)

    monkeypatch.setattr(database, "cancel_expired_claimed_direction", racing_cancel)
    original_atomic = getattr(database, "supersede_and_register_direction", None)
    if original_atomic is not None:
        def racing_atomic(payload, **kwargs):
            steal_claim_once()
            return original_atomic(payload, **kwargs)
        monkeypatch.setattr(database, "supersede_and_register_direction", racing_atomic)

    created = seed_priority_target_directions(store, database)
    monkeypatch.undo()

    assert created == 0, "取消失败说明快照已失效，本轮禁止创建替代版本"
    assert len(_directions(database)) == 1, "不得出现第二个可认领版本"
    current = database.get_direction(old_id)
    assert current["status"] == "claimed"
    assert current["claimed_by"] == "executor-b"
    assert database.claim_direction("executor-c") is None, "第二个 Worker 不得再认领新版本"


# ===========================================================================
# 第八轮反例：投影可恢复与策略冷却继承。
# ===========================================================================

def test_counterexample_jsonl_failure_backfills_via_projection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 替代事务提交成功、JSONL 写入失败后，既有投影机制必须幂等补齐。"""
    store = _project(tmp_path, monkeypatch, vendor="jsonl-recover")
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    assert len(store.read_jsonl("intents.jsonl")) == 1

    # 注入：替代事务成功提交后，intents.jsonl 写入失败（磁盘异常）。
    _assess(store, url, "priority_target", score=95)  # 只调分数，触发替代
    original_append = store.append_jsonl
    fail = {"on": True}

    def flaky_append(name, item):
        if fail["on"] and name == "intents.jsonl":
            raise OSError("disk full")
        return original_append(name, item)

    monkeypatch.setattr(store, "append_jsonl", flaky_append)
    try:
        seed_priority_target_directions(store, database)
    except OSError:
        pass  # 旧实现直接抛出；新实现应吞掉投影失败并保持事件待投影
    monkeypatch.undo()
    fail["on"] = False

    # SQLite 已提交新方向；JSONL 暂缺该记录。
    open_items = _open_directions(database, url)
    assert len(open_items) == 1
    assert open_items[0]["intent"]["target_score"] == 95
    assert len(store.read_jsonl("intents.jsonl")) == 1, "前提：新记录暂未落盘"

    # 恢复写入后：由既有投影机制自动补齐（不需要重新评估或手工修复）。
    # 投影失败按指数退避重试；把退避拨到期，模拟 ProjectorManager 周期
    # 轮询兜底（生产中该补写无需任何人工动作）。
    from src.agent_control_plane.projector import Projector
    with database.connect() as db:
        db.execute(
            "UPDATE commit_events SET available_at='2000-01-01T00:00:00+00:00' "
            "WHERE status IN ('pending','retry_wait')"
        )
    Projector(store, database).recover()
    records = store.read_jsonl("intents.jsonl")
    assert len(records) == 2, "投影机制必须补写缺失的方向记录"
    backfilled = dict(records[-1])
    backfilled.pop("_projection", None)
    assert backfilled == open_items[0]["intent"], "补写内容必须与 SQLite 完全一致"
    # 再次恢复不重复补写。
    Projector(store, database).recover()
    assert len(store.read_jsonl("intents.jsonl")) == 2


def test_counterexample_rescore_does_not_clear_policy_cooldown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P2] 仅重新评分不得清除同一测试的策略冷却；更换建议专项不继承冷却。"""
    from datetime import datetime, timedelta, timezone

    store = _project(tmp_path, monkeypatch, vendor="cooldown-keep")
    database = ControlDatabase(store.path / "control_plane.db")
    url = "https://example.com/admin"
    _profile_url(store, url)
    _assess(store, url, "priority_target", score=60)
    assert seed_priority_target_directions(store, database) == 1
    direction_id = _directions(database)[0]["id"]
    database.claim_direction("executor-a", lease_seconds=30)
    cooldown_until = (
        datetime.now(timezone.utc) + timedelta(hours=6)
    ).isoformat()
    assert database.finish_direction(
        direction_id, "executor-a", outcome="released",
        reason=f"policy_blocked_until:{cooldown_until}",
    )
    assert database.claim_direction("executor-b") is None  # 冷却中不可认领

    _assess(store, url, "priority_target", score=95)  # 只调分数，专项不变
    created = seed_priority_target_directions(store, database)
    assert created == 1
    open_items = _open_directions(database, url)
    assert len(open_items) == 1
    replacement = open_items[0]
    assert replacement["status"] == "released", "新版本必须继承冷却（released）"
    assert str(replacement["terminal_reason"]).startswith("policy_blocked_until:")
    assert database.claim_direction("executor-b") is None, "冷却期内仍不可认领"

    # 冷却到期后恢复可认领（既有 claim 语义）。
    with database.connect() as db:
        db.execute(
            "UPDATE directions SET terminal_reason='policy_blocked_until:2000-01-01T00:00:00+00:00' WHERE id=?",
            (replacement["id"],),
        )
    assert database.claim_direction("executor-b") is not None


# ===========================================================================
# 第九轮反例：自查发现——methodology 播种路径未纳入投影机制等。
# ===========================================================================

def _methodology_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vendor: str):
    from src.agent_control_plane.methodology import method_pack_for_target
    store = _project(tmp_path, monkeypatch, vendor)
    target = store.read_json("target.json")
    target["targets"] = ["https://example.com"]
    store.write_json("target.json", target)
    database = ControlDatabase(store.path / "control_plane.db")
    return store, database, method_pack_for_target(target)


def _fast_forward_projection_backoff(database) -> None:
    with database.connect() as db:
        db.execute(
            "UPDATE commit_events SET available_at='2000-01-01T00:00:00+00:00' "
            "WHERE status IN ('pending','retry_wait')"
        )


def test_counterexample_methodology_seed_survives_jsonl_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] Method Pack 播种：JSONL 写失败不得静默丢失攻击面维度。"""
    from src.agent_control_plane.methodology import seed_portfolio
    from src.agent_control_plane.projector import Projector

    store, database, pack = _methodology_project(tmp_path, monkeypatch, "method-recover")
    original_append = store.append_jsonl

    def flaky(name, item):
        if name == "intents.jsonl":
            raise OSError("disk full")
        return original_append(name, item)

    monkeypatch.setattr(store, "append_jsonl", flaky)
    try:
        seed_portfolio(store, pack, database)
    except OSError:
        pass  # 旧实现中断并抛出
    monkeypatch.undo()

    # 恢复写入后由既有投影机制补齐：十个维度一个都不能少。
    _fast_forward_projection_backoff(database)
    Projector(store, database).recover()
    created = seed_portfolio(store, pack, database)
    directions = database.list_directions()
    assert len(directions) == len(pack.dimensions), (
        f"十个攻击面维度必须全部有方向：{len(directions)}/{len(pack.dimensions)}"
    )
    assert len(store.read_jsonl("hypotheses.jsonl")) == len(pack.dimensions)
    assert len(store.read_jsonl("intents.jsonl")) == len(pack.dimensions)
    assert created == 0, "恢复后重播种必须幂等（DB 去重）"


def test_counterexample_follow_up_survives_jsonl_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P1] 相邻边界假设（derive_bounded_follow_up）同样不得因文件失败丢方向。"""
    from src.agent_control_plane.methodology import derive_bounded_follow_up, ensure_methodology
    from src.agent_control_plane.projector import Projector
    from src.agent_control_plane.schemas import Fact

    store, database, _pack = _methodology_project(tmp_path, monkeypatch, "followup-recover")
    ensure_methodology(store, database, seed=False)
    fact = Fact(
        title="上传入口",
        category="parser_target",
        evidence="观察到上传接口并可提交文件。",
        assets=["https://example.com/upload"],
    )
    original_append = store.append_jsonl

    def flaky(name, item):
        if name == "intents.jsonl":
            raise OSError("disk full")
        return original_append(name, item)

    monkeypatch.setattr(store, "append_jsonl", flaky)
    try:
        derive_bounded_follow_up(store, fact, database)
    except OSError:
        pass
    monkeypatch.undo()

    _fast_forward_projection_backoff(database)
    Projector(store, database).recover()
    again = derive_bounded_follow_up(store, fact, database)

    profile_dirs = [
        item for item in database.list_directions()
        if str((item.get("intent") or {}).get("target") or "") == "https://example.com/upload"
    ]
    assert len(profile_dirs) == 1, "相邻边界假设方向必须存在且唯一"
    assert again is None, "恢复后文件去重生效，不重复派生（幂等）"
    assert len(store.read_jsonl("hypotheses.jsonl")) >= 1
    assert len(store.read_jsonl("intents.jsonl")) >= 1


def test_drain_classifies_projection_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P2] drain 静默吞 OSError（磁盘），但非 OSError 异常必须留下排障事件。"""
    from src.agent_control_plane import target_profile as target_profile_module
    from src.agent_control_plane.projector import Projector

    store, database, _pack = _methodology_project(tmp_path, monkeypatch, "drain-audit")
    drain = target_profile_module._drain_direction_intent_projection

    def raise_runtime(*_args, **_kwargs):
        raise RuntimeError("projection bug")

    monkeypatch.setattr(Projector, "drain_until", raise_runtime)
    drain(store, database, "EV-TEST-1")
    assert database.event_count("direction_intent_projection_deferred") == 1, (
        "非 OSError 异常必须记录排障事件"
    )

    def raise_os(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(Projector, "drain_until", raise_os)
    drain(store, database, "EV-TEST-2")
    assert database.event_count("direction_intent_projection_deferred") == 1, (
        "磁盘类失败保持静默（由 commit_events.last_error 与退避机制承载）"
    )


def test_cooldown_fresh_registration_does_not_consume_capacity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[P3] 继承冷却的 fresh 注册（released，不计入开放数）不应消耗容量。"""
    store = _project(tmp_path, monkeypatch, vendor="cooldown-capacity")
    database = ControlDatabase(store.path / "control_plane.db")
    for index in range(10):  # 容量 = 12 - 10 = 2
        database.register_direction({
            "verb": "inspect",
            "target": f"https://example.com/other-{index}",
            "hypothesis": "既有方向",
            "success_criteria": "形成证据",
        })
    first, second = "https://example.com/a", "https://example.com/b"
    for url in (first, second):
        _profile_url(store, url)
        _assess(store, url, "priority_target", score=80)
        assert seed_priority_target_directions(store, database) == 1
        direction_id = next(
            item["id"] for item in _directions(database)
            if item["intent"].get("target") == url
        )
        database.claim_direction("executor-a", lease_seconds=30)
        # 两个目标各自进入策略冷却（同专项、未到期）。
        database.finish_direction(
            direction_id, "executor-a", outcome="released",
            reason="policy_blocked_until:2999-01-01T00:00:00+00:00",
        )

    # 触发两个目标的 fresh 重入队（终态化冷却方向后实质变化）。
    for url in (first, second):
        direction_id = next(
            item["id"] for item in _directions(database)
            if item["intent"].get("target") == url
        )
        database.set_direction_status(
            direction_id, "cancelled", "policy_blocked_until:2999-01-01T00:00:00+00:00",
        )
        _assess(store, url, "priority_target", score=95)

    created = seed_priority_target_directions(store, database)

    assert created == 2, "冷却态注册不计入开放数，也不应消耗播种容量"
    cooled = [item for item in _directions(database) if item["status"] == "released"]
    assert len(cooled) == 2
    assert all(
        str(item["terminal_reason"]).startswith("policy_blocked_until:") for item in cooled
    )
    claimed = database.claim_direction("executor-b")
    assert claimed is None or str(claimed["intent"].get("target") or "") not in {first, second}, (
        "冷却期内不得认领 a/b 两个冷却方向（其他无冷却方向不受影响）"
    )
