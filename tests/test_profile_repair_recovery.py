"""补修 A：恢复过滤与派发事务条件校验（用户复核问题 5/7 的失败复现）。

问题 5：recover_profile_postprocess 以 committed_at 非空为依据，会把被
人工指令栅栏拒绝（mark_job_committed 无 commit event）的候选重新应用；
且读取原始 Job 结果而非已过滤的提交载荷。
问题 7：enqueue_profile_job_atomic 每次新 Job ID + 无条件更新，两次派发
同一工作项会重复扣预算。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.asset_inventory import AssetInventory
from src.sorne.database import ControlDatabase
from src.sorne.schemas import Hint
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


def _items(store: ProjectStore, purpose: str = "collect") -> dict[str, dict]:
    with ControlDatabase(store.path / "control_plane.db").connect() as db:
        rows = db.execute(
            "SELECT * FROM profile_work_items WHERE purpose=?", (purpose,),
        ).fetchall()
    return {str(row["canonical_url"]): dict(row) for row in rows}


def _select_item(store: ProjectStore, url: str) -> dict:
    inventory = AssetInventory(store)
    matches = [
        item for item in inventory.pending_collect_work_items(limit=1000)
        if item["canonical_url"] == url
    ]
    assert matches, f"工作项不可调度: {url}"
    return matches[0]


def _dispatch(
    store: ProjectStore, run_id: str, url: str, *, member_name: str = "m",
) -> str:
    inventory = AssetInventory(store)
    item = _select_item(store, url)
    return ControlDatabase(store.path / "control_plane.db").enqueue_profile_job_atomic(
        run_id, "profile", member_name, "profile_mapper",
        {
            "profile_assignments": AssetInventory.work_item_assignments([item]),
            "profile_seed_urls": [url],
        },
        [item["id"]],
    )


def _complete_job_with_result(
    store: ProjectStore, run_id: str, job_id: str, *, url: str, function: str,
    observed_directive_ids: list[str],
) -> None:
    database = ControlDatabase(store.path / "control_plane.db")
    claimed = database.claim_job(run_id, "profile", "local-0")
    assert claimed is not None and claimed["id"] == job_id
    database.complete_job(job_id, "local-0", {
        "payload": {
            "kind": "target_profile_batch",
            "records": [{"url": url, "function": function}],
            "exploration_complete": True,
        },
        "control_context": {"human_directive_ids": observed_directive_ids},
    })


def test_rejected_candidate_is_not_resurrected_by_recovery(
    project: ProjectStore,
) -> None:
    """真实业务流：候选被人工指令栅栏拒绝后，恢复不得重新生效。"""
    from src.sorne.automation import AutomationEngine

    inventory = AssetInventory(project)
    inventory.sync_declared_targets()
    url = "https://example.com/rejected"
    inventory.add_work_items([url])
    engine = AutomationEngine(project)
    run_id = engine.db.create_run(project.vendor, "default", 600, 1)
    job_id = _dispatch(project, run_id, url, member_name="profile_mapper")

    # 执行期间项目所有者提交了新指令（候选上下文里没有它）。
    project.append_jsonl("hints.jsonl", Hint(
        content="停止该路径，优先其他目标", intervention_type="redirect", priority=10,
    ))
    _complete_job_with_result(
        project, run_id, job_id, url=url,
        function="被拒绝的采集结果", observed_directive_ids=[],
    )
    summaries = engine._commit_candidates(run_id)
    assert any("结果已丢弃" in line for line in summaries), summaries

    with engine.db.connect() as db:
        job_row = db.execute(
            "SELECT committed_at, commit_event_id FROM jobs WHERE id=?", (job_id,),
        ).fetchone()
    assert job_row["committed_at"] is not None
    assert job_row["commit_event_id"] is None  # 被拒候选没有提交事件

    # 恢复不得把被拒结果重新生效（不写 profile_urls、不改工作项为 completed）。
    recovered = AssetInventory(project).recover_profile_postprocess(engine.db)
    assert recovered == 0
    assert _items(project)[url]["status"] != "completed"
    with engine.db.connect() as db:
        rows = db.execute(
            "SELECT count(*) AS c FROM profile_urls WHERE url=?", (url,),
        ).fetchone()
    assert rows["c"] == 0


def test_recovery_uses_committed_event_payload_not_raw_result(
    project: ProjectStore,
) -> None:
    """成功路径的恢复必须使用已接受、已过滤的提交数据（commit event 载荷）。"""
    from src.sorne.worker import submit_payload

    inventory = AssetInventory(project)
    inventory.sync_declared_targets()
    url = "https://example.com/accepted"
    inventory.add_work_items([url])
    database = ControlDatabase(project.path / "control_plane.db")
    run_id = database.create_run(project.vendor, "default", 600, 1)
    job_id = _dispatch(project, run_id, url)
    _complete_job_with_result(
        project, run_id, job_id, url=url,
        function="原始未过滤记录", observed_directive_ids=[],
    )
    # 正常提交路径冻结的是过滤后的载荷（这里是“已过滤后的记录”）。
    run = database.get_run(run_id)
    submit_payload(
        project,
        {
            "kind": "target_profile_batch",
            "records": [{"url": url, "function": "已过滤后的记录"}],
            "exploration_complete": True,
        },
        source_type="automation_job",
        source_id=job_id,
        idempotency_key=f"job:{job_id}:target_profile_batch",
        run_id=run_id, job_id=job_id,
        control_version=int(run["control_version"]), gate_required=True,
    )
    database.mark_job_committed(job_id)
    # 模拟“业务已投影、画像后处理未落账”的中断窗口。
    with database.connect() as db:
        db.execute(
            "DELETE FROM profile_postprocess_receipts WHERE job_id=?", (job_id,),
        )

    recovered = AssetInventory(project).recover_profile_postprocess(database)
    assert recovered == 1
    assert _items(project)[url]["status"] == "completed"
    with database.connect() as db:
        row = db.execute(
            "SELECT function FROM profile_urls WHERE url=? ORDER BY created_at DESC LIMIT 1",
            (url,),
        ).fetchone()
    # 使用提交载荷（已过滤），而不是 Job 原始结果。
    assert row is not None and row["function"] == "已过滤后的记录"


def test_dispatch_rejects_stale_work_item_double_dispatch(
    project: ProjectStore,
) -> None:
    """同一工作项用旧查询结果派发两次：第二次必须整体拒绝且不重复扣预算。"""
    inventory = AssetInventory(project)
    inventory.sync_declared_targets()
    url = "https://example.com/double"
    inventory.add_work_items([url])
    database = ControlDatabase(project.path / "control_plane.db")
    run_id = database.create_run(project.vendor, "default", 600, 1)
    selected = inventory.pending_collect_work_items()
    item = next(i for i in selected if i["canonical_url"] == url)

    first_job = database.enqueue_profile_job_atomic(
        run_id, "profile", "m1", "profile_mapper", {}, [item["id"]],
    )
    assert first_job
    # 第二次使用同一（已过期的）选择结果派发同一工作项。
    with pytest.raises(RuntimeError):
        database.enqueue_profile_job_atomic(
            run_id, "profile", "m2", "profile_mapper", {}, [item["id"]],
        )
    with database.connect() as db:
        jobs = db.execute(
            "SELECT count(*) AS c FROM jobs WHERE stage='profile'",
        ).fetchone()["c"]
        attempts = db.execute(
            "SELECT attempts FROM profile_work_items WHERE id=?", (item["id"],),
        ).fetchone()["attempts"]
        dispatches = db.execute(
            "SELECT count(*) AS c FROM profile_dispatches WHERE work_item_id=?",
            (item["id"],),
        ).fetchone()["c"]
    assert jobs == 1  # 第二个 Job 未创建（事务回滚）
    assert attempts == 1  # 预算只扣一次
    assert dispatches == 1
