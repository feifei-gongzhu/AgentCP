"""补修 C：基础画像派发保持 URL 粒度 + 同 Run 多轮真实流程（问题 3/测试质量）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.asset_inventory import AssetInventory
from src.sorne.database import ControlDatabase
from src.sorne.schemas import normalize_role
from src.sorne.store import ProjectStore
from src.sorne.team import TeamMember


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    target = store.read_json("target.json")
    target["targets"] = ["https://example.com"]
    store.write_json("target.json", target)
    return store


def _profile_member() -> TeamMember:
    return TeamMember(
        name="profile_mapper", type="mock", role="profile_mapper", max_running=1,
        extra={"payload": {"kind": "none", "reason": "unused"}},
    )


def _engine(store: ProjectStore):
    from src.sorne.automation import AutomationEngine

    return AutomationEngine(store)


def _items(store: ProjectStore) -> dict[str, dict]:
    with ControlDatabase(store.path / "control_plane.db").connect() as db:
        rows = db.execute(
            "SELECT * FROM profile_work_items WHERE purpose='collect'",
        ).fetchall()
    return {str(row["canonical_url"]): dict(row) for row in rows}


# 问题 3：同一资产的多个路径在基础画像派发时被合并成一个目标。
def test_baseline_dispatch_keeps_all_urls_in_job_payload(
    project: ProjectStore,
) -> None:
    inventory = AssetInventory(project)
    inventory.sync_declared_targets()
    inventory.add_work_items([
        "https://example.com/a",
        "https://example.com/b",
    ])
    engine = _engine(project)
    run_id = engine.db.create_run(project.vendor, "default", 600, 1)

    scheduled = engine._schedule_profile_job(
        run_id, _profile_member(), mode="baseline",
        work_items=inventory.pending_collect_work_items(),
    )
    assert scheduled is True

    jobs = engine.db.list_jobs(run_id, "profile")
    assert len(jobs) == 1
    payload = jobs[0]["payload"]
    # 完整 URL 列表始终作为任务清单——同资产的 /a 与 /b 都必须原样交给
    # Worker（端点归并不吞 URL；sync 生成的根 URL 项也在清单中）。
    assert "https://example.com/a" in payload["profile_seed_urls"]
    assert "https://example.com/b" in payload["profile_seed_urls"]
    context = json.loads(payload["context_suffix"])
    assert "https://example.com/a" in context["本分片唯一目标"]
    assert "https://example.com/b" in context["本分片唯一目标"]
    # 端点 assignment 仅用于身份与范围约束（每资产一份），不吞 URL 粒度。
    assert len(payload["profile_assignments"]) == 1


# baseline 多轮：真实流程——第一轮只完成一个 URL，同 Run 内第二轮补齐剩余。
def test_baseline_multiple_passes_within_same_run_real_flow(
    project: ProjectStore,
) -> None:
    inventory = AssetInventory(project)
    inventory.sync_declared_targets()
    url_a = "https://example.com/a"
    url_b = "https://example.com/b"
    inventory.add_work_items([url_a, url_b])
    engine = _engine(project)
    run_id = engine.db.create_run(project.vendor, "default", 600, 1)

    # 第一轮：派发两个 URL；Worker 只返回 a 的记录，批次未完成。
    first = engine._schedule_profile_job(
        run_id, _profile_member(), mode="baseline",
        work_items=inventory.pending_collect_work_items(),
    )
    assert first is True
    first_job = engine.db.list_jobs(run_id, "profile")[0]
    claimed = engine.db.claim_job(run_id, "profile", "local-0")
    assert claimed is not None and claimed["id"] == first_job["id"]
    engine.db.complete_job(first_job["id"], "local-0", {
        "payload": {
            "kind": "target_profile_batch",
            "records": [{"url": url_a, "function": "第一轮完成"}],
            "exploration_complete": False,
        },
        "control_context": {"human_directive_ids": []},
    })
    engine.db.mark_job_committed(first_job["id"])
    assert AssetInventory(project).record_job_profile_result(
        engine.db.list_jobs(run_id, "profile")[0],
        [{"url": url_a, "function": "第一轮完成"}], complete=False,
    ) is True
    items = _items(project)
    assert items[url_a]["status"] == "completed"
    assert items[url_b]["status"] == "partial"

    # 同 Run 第二轮：b 仍可被基础画像选中并派发（无 Run 栅栏）。
    remaining = [
        item for item in AssetInventory(project).pending_collect_work_items()
        if item["canonical_url"] == url_b
    ]
    assert remaining, "同一 Run 内剩余 URL 必须仍可被基础画像调度"
    second = engine._schedule_profile_job(
        run_id, _profile_member(), mode="baseline", work_items=remaining,
    )
    assert second is True
    second_jobs = [j for j in engine.db.list_jobs(run_id, "profile")
                   if j["id"] != first_job["id"]]
    assert len(second_jobs) == 1
    assert second_jobs[0]["payload"]["profile_seed_urls"] == [url_b]

    # 第二轮回写后两个 URL 全部完成。
    engine.db.claim_job(run_id, "profile", "local-1")
    engine.db.complete_job(second_jobs[0]["id"], "local-1", {
        "payload": {
            "kind": "target_profile_batch",
            "records": [{"url": url_b, "function": "第二轮补齐"}],
            "exploration_complete": True,
        },
        "control_context": {"human_directive_ids": []},
    })
    engine.db.mark_job_committed(second_jobs[0]["id"])
    assert AssetInventory(project).record_job_profile_result(
        second_jobs[0],
        [{"url": url_b, "function": "第二轮补齐"}], complete=True,
    ) is True
    items = _items(project)
    assert items[url_a]["status"] == "completed"
    assert items[url_b]["status"] == "completed"
