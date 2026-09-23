"""补修 D：needs-review 复核完成条件依据评估结果（用户复核问题 4）。

record_job_profile_result 原以“exploration_complete 且记录含该 URL”把
review 工作项标 completed——评估仍是 needs_review 时第二次复核机会被吞。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.asset_inventory import AssetInventory
from src.sorne.database import ControlDatabase
from src.sorne.store import ProjectStore
from src.sorne.target_profile import record_target_assessments, record_target_profile


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    target = store.read_json("target.json")
    target["targets"] = ["https://example.com"]
    store.write_json("target.json", target)
    return store


def _items(store: ProjectStore, purpose: str = "review") -> dict[str, dict]:
    with ControlDatabase(store.path / "control_plane.db").connect() as db:
        rows = db.execute(
            "SELECT * FROM profile_work_items WHERE purpose=?", (purpose,),
        ).fetchall()
    return {str(row["canonical_url"]): dict(row) for row in rows}


def _prepare_review_job(project: ProjectStore, url: str) -> tuple:
    inventory = AssetInventory(project)
    inventory.sync_declared_targets()  # 触发迁移标记（派发门禁要求）
    record_target_profile(project, [{"url": url, "function": "复核目标"}], proposed_by="m")
    record_target_assessments(
        project, [{"url": url, "profile_class": "needs_review"}], proposed_by="m",
    )
    inventory.sync_needs_review_work_items()
    review = inventory.pending_review_work_items(run_id=None, limit=10, cap=2)
    assert [item["canonical_url"] for item in review] == [url]

    database = ControlDatabase(project.path / "control_plane.db")
    run_id = database.create_run(project.vendor, "default", 600, 1)
    item = review[0]
    job_id = database.enqueue_profile_job_atomic(
        run_id, "profile_incremental", "m", "profile_mapper",
        {"profile_assignments": AssetInventory.work_item_assignments([item]),
         "profile_seed_urls": [url]},
        [item["id"]], run_fence=True, review_cap=2,
    )
    claimed = database.claim_job(run_id, "profile_incremental", "local-0")
    assert claimed is not None and claimed["id"] == job_id
    database.complete_job(job_id, "local-0", {
        "payload": {
            "kind": "target_profile_batch",
            "records": [{"url": url, "function": "复核采集"}],
            "exploration_complete": True,
        },
        "control_context": {"human_directive_ids": []},
    })
    database.mark_job_committed(job_id)
    job = next(j for j in database.list_jobs(run_id) if j["id"] == job_id)
    return inventory, database, job


def test_review_item_not_completed_while_assessment_still_needs_review(
    project: ProjectStore,
) -> None:
    url = "https://example.com/review"
    inventory, database, job = _prepare_review_job(project, url)

    # 第一次复核回写：记录含 URL + exploration_complete=true，
    # 但最新评估仍是 needs_review → 不得标 completed。
    assert inventory.record_job_profile_result(
        job, [{"url": url, "function": "复核采集"}], complete=True,
    ) is True
    item = _items(project)[url]
    assert item["status"] != "completed", (
        "评估仍是 needs_review 时复核工作项不得完成"
    )
    assert item["attempts"] == 1  # 已消耗一次复核预算（上限 2）
    # 下一 Run 的复核待办仍包含该 URL（第二次复核机会保留）。
    remaining = inventory.pending_review_work_items(run_id="R-next", limit=10, cap=2)
    assert url in [i["canonical_url"] for i in remaining]


def test_review_item_completes_when_assessment_moves_off_needs_review(
    project: ProjectStore,
) -> None:
    url = "https://example.com/review-ok"
    inventory, database, job = _prepare_review_job(project, url)

    # 复核后评估收敛为 routine_network_info → 回写应完成复核工作项。
    record_target_assessments(
        project,
        [{"url": url, "profile_class": "routine_network_info"}],
        proposed_by="m",
    )
    assert inventory.record_job_profile_result(
        job, [{"url": url, "function": "复核采集"}], complete=True,
    ) is True
    item = _items(project)[url]
    assert item["status"] == "completed"
    remaining = inventory.pending_review_work_items(run_id="R-next", limit=10, cap=2)
    assert url not in [i["canonical_url"] for i in remaining]


def test_review_item_exhausts_after_budget_without_convergence(
    project: ProjectStore,
) -> None:
    url = "https://example.com/review-exhaust"
    inventory, database, job = _prepare_review_job(project, url)
    # 第一次复核（未收敛）。
    inventory.record_job_profile_result(
        job, [{"url": url, "function": "复核采集"}], complete=True,
    )
    # 第二次派发 + 回写仍未收敛 → 预算耗尽进入 exhausted 终态。
    review = inventory.pending_review_work_items(run_id="R-two", limit=10, cap=2)
    assert [i["canonical_url"] for i in review] == [url]
    database = ControlDatabase(project.path / "control_plane.db")
    run2 = database.create_run(project.vendor, "default", 600, 1) \
        if False else None
    item = review[0]
    with database.connect() as db:
        db.execute(
            "UPDATE profile_work_items SET attempts=attempts+1 WHERE id=?",
            (item["id"],),
        )
        db.execute(
            "UPDATE profile_work_items SET status='partial' WHERE id=?",
            (item["id"],),
        )
    job2 = {
        "id": "J-manual-2", "payload": {
            "profile_assignments": AssetInventory.work_item_assignments([item]),
        },
    }
    with database.connect() as db:
        db.execute(
            "INSERT OR IGNORE INTO profile_dispatches(id,work_item_id,run_id,job_id,dispatched_at)"
            " VALUES ('PD-manual-2',?,NULL,?,datetime('now'))",
            (item["id"], "J-manual-2"),
        )
    assert inventory.record_job_profile_result(
        job2, [{"url": url, "function": "第二次复核仍未收敛"}], complete=True,
    ) is True
    item_row = _items(project)[url]
    assert item_row["status"] == "exhausted"
    remaining = inventory.pending_review_work_items(run_id="R-three", limit=10, cap=2)
    assert url not in [i["canonical_url"] for i in remaining]
