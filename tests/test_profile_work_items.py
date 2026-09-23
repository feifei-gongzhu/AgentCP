"""V7 画像工作项：按实施规格 4.11 的 14 条必须通过的行为测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.asset_inventory import AssetInventory
from src.sorne.database import ControlDatabase
from src.sorne.store import ProjectStore


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    target = store.read_json("target.json")
    target["targets"] = ["https://example.com"]
    store.write_json("target.json", target)
    return store


def _inventory(store: ProjectStore) -> AssetInventory:
    return AssetInventory(store)


def _items(store: ProjectStore, purpose: str = "collect") -> dict[str, dict]:
    with ControlDatabase(store.path / "control_plane.db").connect() as db:
        rows = db.execute(
            "SELECT * FROM profile_work_items WHERE purpose=?", (purpose,),
        ).fetchall()
    return {str(row["canonical_url"]): dict(row) for row in rows}


def _legacy_state(store: ProjectStore, **fields: object) -> None:
    store.write_json(
        "profile_state.json",
        {
            "target_fingerprint": "legacy-fixture",
            "baseline_status": "partial",
            **fields,
        },
    )


# 1. 一个端点有两个不同路径，迁移后两个 URL 都保留。
def test_two_paths_on_one_endpoint_both_preserved(project: ProjectStore) -> None:
    _legacy_state(
        project,
        pending_seed_urls=[
            "https://example.com/a",
            "https://example.com/b",
        ],
    )
    report = _inventory(project).migrate_legacy_profile_state()
    assert report["imported_pending"] == 2
    items = _items(project)
    assert "https://example.com/a" in items
    assert "https://example.com/b" in items


# 2. 同 URL 多来源不会重复排队。
def test_same_url_multiple_sources_single_item(project: ProjectStore) -> None:
    _inventory(project).sync_declared_targets()
    # 同一 URL（声明目标根地址）再经增量通道入队：只保留一份同用途待办，
    # 两个来源都记录在子表。
    _inventory(project).add_work_items(
        ["https://example.com/"], purpose="collect", source_reason="incremental",
    )
    canonical = "https://example.com/"
    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        count = db.execute(
            "SELECT count(*) AS c FROM profile_work_items WHERE canonical_url=?",
            (canonical,),
        ).fetchone()["c"]
        reasons = db.execute(
            "SELECT s.source_reason AS source_reason FROM profile_work_item_sources s "
            "JOIN profile_work_items i ON i.id=s.work_item_id "
            "WHERE i.canonical_url=?",
            (canonical,),
        ).fetchall()
    assert count == 1
    assert {str(row["source_reason"]) for row in reasons} == {"baseline", "incremental"}


# 3. 同 URL 采集和复核预算独立。
def test_collect_and_review_budgets_independent(project: ProjectStore) -> None:
    inventory = _inventory(project)
    url = "https://example.com/reviewed"
    from src.sorne.target_profile import record_target_profile, record_target_assessments

    record_target_profile(project, [{"url": url, "function": "登录入口"}], proposed_by="m")
    record_target_assessments(project, [{"url": url, "profile_class": "needs_review"}], proposed_by="m")
    inventory.sync_needs_review_work_items()
    # 采集侧消耗 3 次预算耗尽。
    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        db.execute(
            "UPDATE profile_work_items SET attempts=3,status='exhausted' "
            "WHERE canonical_url=? AND purpose='collect'",
            (url,),
        )
    review = inventory.pending_review_work_items(run_id=None, limit=10, cap=2)
    assert [item["canonical_url"] for item in review] == [url]
    collect = inventory.pending_collect_work_items()
    assert url not in [item["canonical_url"] for item in collect]


# 4. 旧 completed 无实际记录时不被计为成功（consumed，不计成功）。
def test_legacy_completed_without_results_is_consumed(project: ProjectStore) -> None:
    _legacy_state(
        project,
        completed_seed_urls=["https://example.com/consumed", "https://example.com/real"],
    )
    from src.sorne.target_profile import record_target_profile

    record_target_profile(
        project, [{"url": "https://example.com/real", "function": "真实采集"}],
        proposed_by="m",
    )
    report = _inventory(project).migrate_legacy_profile_state()
    assert report["imported_consumed"] == 1
    assert report["imported_completed"] == 1
    items = _items(project)
    assert items["https://example.com/consumed"]["status"] == "consumed"
    assert items["https://example.com/real"]["status"] == "completed"


# 5. 重复迁移不增加任务、原因或次数。
def test_repeated_migration_is_idempotent(project: ProjectStore) -> None:
    _legacy_state(
        project,
        pending_seed_urls=["https://example.com/p"],
        needs_review_attempts={"https://example.com/r": 1},
    )
    first = _inventory(project).migrate_legacy_profile_state()
    second = _inventory(project).migrate_legacy_profile_state()
    assert second == first
    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        total = db.execute("SELECT count(*) AS c FROM profile_work_items").fetchone()["c"]
        sources = db.execute("SELECT count(*) AS c FROM profile_work_item_sources").fetchone()["c"]
        review_attempts = db.execute(
            "SELECT attempts FROM profile_work_items WHERE canonical_url=? AND purpose='review'",
            ("https://example.com/r",),
        ).fetchone()["attempts"]
    assert total == 2
    assert sources == 2
    assert review_attempts == 1


# 6. 迁移中断后重跑可完成（事务回滚→无标记无数据→修复后重跑成功）。
def test_migration_interruption_reruns_cleanly(
    project: ProjectStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _legacy_state(project, pending_seed_urls=["https://example.com/x"])
    import src.sorne.asset_inventory as asset_inventory_module

    original_id = asset_inventory_module._id
    calls = {"n": 0}

    def flaky_id(prefix: str) -> str:
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("simulated crash mid migration")
        return original_id(prefix)

    monkeypatch.setattr(asset_inventory_module, "_id", flaky_id)
    with pytest.raises(RuntimeError):
        _inventory(project).migrate_legacy_profile_state()
    monkeypatch.setattr(asset_inventory_module, "_id", original_id)

    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        assert db.execute("SELECT count(*) AS c FROM profile_work_items").fetchone()["c"] == 0
        assert db.execute(
            "SELECT count(*) AS c FROM profile_migration_meta",
        ).fetchone()["c"] == 0
    report = _inventory(project).migrate_legacy_profile_state()
    assert report["imported_pending"] == 1


# 7. 基础画像同 Run 内仍能执行下一轮（run 栅栏不适用于 baseline）。
def test_baseline_allows_multiple_passes_within_same_run(
    project: ProjectStore,
) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    db = ControlDatabase(project.path / "control_plane.db")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    items = inventory.pending_collect_work_items(run_id=None)
    assert items
    db.enqueue_profile_job_atomic(
        run_id, "profile", "m", "profile_mapper", {}, [str(item["id"]) for item in items],
    )
    # 同一 Run：基础（run_id=None）仍可取到 partial 项继续下一轮，
    # 而增量（run_id=run）被栅栏排除。
    after = inventory.pending_collect_work_items(run_id=None)
    assert after == [] or all(
        str(item["last_dispatch_run_id"]) != run_id for item in after
    )
    fenced = inventory.pending_collect_work_items(run_id=run_id)
    assert fenced == []


# 8. 增量和 needs-review 不突破各自 Run 限流。
def test_incremental_and_review_run_fences(project: ProjectStore) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    inventory.add_work_items(["https://example.com/inc/1"])
    db = ControlDatabase(project.path / "control_plane.db")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    items = inventory.pending_collect_work_items(run_id=run_id)
    db.enqueue_profile_job_atomic(
        run_id, "profile_incremental", "m", "profile_mapper", {},
        [str(item["id"]) for item in items],
    )
    assert inventory.pending_collect_work_items(run_id=run_id) == []

    from src.sorne.target_profile import record_target_profile, record_target_assessments

    url = "https://example.com/rev"
    record_target_profile(project, [{"url": url, "function": "复核目标"}], proposed_by="m")
    record_target_assessments(project, [{"url": url, "profile_class": "needs_review"}], proposed_by="m")
    review = inventory.pending_review_work_items(run_id=run_id, limit=10, cap=2)
    db.enqueue_profile_job_atomic(
        run_id, "profile_incremental", "m", "profile_mapper", {},
        [str(item["id"]) for item in review],
    )
    assert inventory.pending_review_work_items(run_id=run_id, limit=10, cap=2) == []


# 9. 分片容量不足，未入队 URL 不扣预算。
def test_capacity_shortfall_does_not_consume_budget(
    project: ProjectStore,
) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    urls = [f"https://example.com/cap/{index}" for index in range(5)]
    inventory.add_work_items(urls)
    selected = inventory.pending_collect_work_items(limit=2)
    assert len(selected) == 2
    items = _items(project)
    for url in urls:
        assert items[url]["attempts"] == 0


# 10. Job 重试和结果重放不重复扣预算。
def test_job_retry_and_replay_do_not_double_charge(
    project: ProjectStore,
) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    url = "https://example.com/replay"
    inventory.add_work_items([url])
    db = ControlDatabase(project.path / "control_plane.db")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    item = next(
        i for i in inventory.pending_collect_work_items()
        if i["canonical_url"] == url
    )
    payload = {
        "profile_assignments": AssetInventory.work_item_assignments([item]),
        "profile_seed_urls": [url],
    }
    job_id = db.enqueue_profile_job_atomic(
        run_id, "profile", "m", "profile_mapper", payload, [item["id"]],
    )
    # 同一 job 的重复派发调用不重复计数。
    with db.connect() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO profile_dispatches(id,work_item_id,run_id,job_id,dispatched_at)
            VALUES ('PD-fix',?,?,?,datetime('now'))
            """,
            (item["id"], run_id, job_id),
        )
    assert _items(project)[url]["attempts"] == 1
    # 结果重放只应用一次。
    job = db.list_jobs(run_id)[0]
    record = {"url": url, "function": "登录入口"}
    assert inventory.record_job_profile_result(job, [record], complete=True) is True
    assert inventory.record_job_profile_result(job, [record], complete=True) is False
    items = _items(project)
    assert items[url]["status"] == "completed"
    with db.connect() as conn:
        attempts = conn.execute(
            "SELECT p.attempts AS attempts FROM profile_tasks p JOIN profile_work_items w "
            "ON w.profile_task_id=p.id WHERE w.canonical_url=?",
            (url,),
        ).fetchone()["attempts"]
    assert attempts == 1


# 11. 已完成端点出现新 URL，仍能生成新工作项。
def test_completed_endpoint_still_gets_new_work_items(
    project: ProjectStore,
) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    inventory.add_work_items(["https://example.com/first"])
    db = ControlDatabase(project.path / "control_plane.db")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    item = next(
        i for i in inventory.pending_collect_work_items()
        if i["canonical_url"] == "https://example.com/first"
    )
    job_id = db.enqueue_profile_job_atomic(
        run_id, "profile", "m", "profile_mapper", {}, [item["id"]],
    )
    job = next(j for j in db.list_jobs(run_id) if j["id"] == job_id)
    inventory.record_job_profile_result(
        job, [{"url": item["canonical_url"], "function": "首采"}], complete=True,
    )
    assert _items(project)["https://example.com/first"]["status"] == "completed"

    added = inventory.add_work_items(["https://example.com/second"])
    assert added == ["https://example.com/second"]
    new_urls = [str(i["canonical_url"]) for i in inventory.pending_collect_work_items()]
    assert "https://example.com/second" in new_urls
    assert "https://example.com/first" not in new_urls


# 12. 范围外、失效资产不执行。
def test_out_of_scope_and_stale_assets_do_not_execute(
    project: ProjectStore,
) -> None:
    target = project.read_json("target.json")
    target["out_of_scope"] = ["forbidden.example.org"]
    project.write_json("target.json", target)
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    # 已有资产被标记 stale 后，其工作项不再可调度。
    inventory.add_work_items(["https://example.com/stale-target"])
    db = ControlDatabase(project.path / "control_plane.db")
    with db.connect() as conn:
        conn.execute(
            "UPDATE enterprise_assets SET status='stale' WHERE hostname='example.com'"
        )
    assert inventory.pending_collect_work_items() == []


# 13. 部分分片失败不会重置成功分片。
def test_failed_shard_does_not_reset_successful_shard(
    project: ProjectStore,
) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    ok_url = "https://example.com/ok"
    bad_url = "https://example.com/bad"
    inventory.add_work_items([ok_url, bad_url])
    db = ControlDatabase(project.path / "control_plane.db")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    by_url = {
        i["canonical_url"]: i for i in inventory.pending_collect_work_items()
    }
    ok_item, bad_item = by_url[ok_url], by_url[bad_url]
    ok_job = db.enqueue_profile_job_atomic(
        run_id, "profile", "m1", "profile_mapper", {}, [ok_item["id"]],
    )
    bad_job = db.enqueue_profile_job_atomic(
        run_id, "profile", "m2", "profile_mapper", {}, [bad_item["id"]],
    )
    jobs = {job["id"]: job for job in db.list_jobs(run_id)}
    inventory.record_job_profile_result(
        jobs[ok_job], [{"url": ok_url, "function": "成功分片"}], complete=True,
    )
    inventory.record_job_profile_result(
        jobs[bad_job], [], complete=False, error="上游模型超时",
    )
    items = _items(project)
    assert items[ok_url]["status"] == "completed"
    assert items[bad_url]["status"] == "partial"
    assert items[bad_url]["last_error"] == "上游模型超时"


# 14. 暂停、取消和恢复不会留下永久占用任务。
def test_cancelled_job_releases_dispatched_items(project: ProjectStore) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    url = "https://example.com/cancelled"
    inventory.add_work_items([url])
    db = ControlDatabase(project.path / "control_plane.db")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    item = next(
        i for i in inventory.pending_collect_work_items()
        if i["canonical_url"] == url
    )
    job_id = db.enqueue_profile_job_atomic(
        run_id, "profile", "m", "profile_mapper", {}, [item["id"]],
    )
    assert _items(project)[url]["status"] == "dispatched"
    # Run 停止后 Job 进入终态；下一次 Run 的 prepare_run 回收 dispatched。
    db.stop_run(run_id, "用户停止")
    inventory.prepare_run()
    assert _items(project)[url]["status"] == "partial"
    again = inventory.pending_collect_work_items()
    assert url in [str(i["canonical_url"]) for i in again]


# 附加：迁移未完成时派发被拒绝（调度门禁）。
def test_dispatch_requires_migration_marker(project: ProjectStore) -> None:
    _inventory(project).sync_declared_targets()
    db = ControlDatabase(project.path / "control_plane.db")
    with db.connect() as conn:
        conn.execute("DELETE FROM profile_migration_meta")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    item = next(
        i for i in _inventory(project).pending_collect_work_items()
        if i["canonical_url"] == "https://example.com/"
    )
    with pytest.raises(RuntimeError, match="迁移未完成"):
        db.enqueue_profile_job_atomic(
            run_id, "profile", "m", "profile_mapper", {}, [item["id"]],
        )


# 附加：kind=none / exploration_complete 无匹配记录不标成功。
def test_none_payload_and_unmatched_complete_not_success(
    project: ProjectStore,
) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    url = "https://example.com/none"
    inventory.add_work_items([url])
    db = ControlDatabase(project.path / "control_plane.db")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    item = next(
        i for i in inventory.pending_collect_work_items()
        if i["canonical_url"] == url
    )
    job_id = db.enqueue_profile_job_atomic(
        run_id, "profile", "m", "profile_mapper", {}, [item["id"]],
    )
    job = next(j for j in db.list_jobs(run_id) if j["id"] == job_id)
    inventory.record_job_profile_result(job, [], complete=True)
    assert _items(project)[url]["status"] == "partial"


# 附加：后处理恢复覆盖“业务已投影、任务状态未更新”的中断窗口。
def test_recover_profile_postprocess_backfills_missing_receipts(
    project: ProjectStore,
) -> None:
    inventory = _inventory(project)
    inventory.sync_declared_targets()
    url = "https://example.com/recover"
    inventory.add_work_items([url])
    db = ControlDatabase(project.path / "control_plane.db")
    run_id = db.create_run(project.vendor, "default", 600, 1)
    item = next(
        i for i in inventory.pending_collect_work_items()
        if i["canonical_url"] == url
    )
    job_id = db.enqueue_profile_job_atomic(
        run_id, "profile", "m", "profile_mapper", {}, [item["id"]],
    )
    job = next(j for j in db.list_jobs(run_id) if j["id"] == job_id)
    # 模拟：Worker 认领并完成、候选已提交（committed_at 已写）但后处理未执行。
    claimed = db.claim_job(run_id, "profile", "local-0")
    assert claimed is not None and claimed["id"] == job_id
    db.complete_job(job_id, "local-0", {
        "payload": {
            "kind": "target_profile_batch",
            "records": [{"url": url, "function": "恢复补齐"}],
            "exploration_complete": True,
        },
    })
    db.mark_job_committed(job_id)
    with db.connect() as conn:
        conn.execute("DELETE FROM profile_postprocess_receipts WHERE job_id=?", (job_id,))
    recovered = inventory.recover_profile_postprocess(db)
    assert recovered >= 1
    assert _items(project)[url]["status"] == "completed"
