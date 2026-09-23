"""补修 B：迁移完整性（用户复核问题 1/2/6 的失败复现）。

问题 1：旧库只有 V6 SQLite profile_tasks 待办（无 JSON pending）时，
迁移宣布完成但待办不在新调度器视野；资产来源文件已导入过时，
_import_rows 直接 duplicate 返回不补建工作项。
问题 2：裸 IP（canonical_url 为 None）无法进入新画像队列。
问题 6：损坏的 profile_state.json 被当作空数据仍标记迁移成功。
"""

from __future__ import annotations

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
    return store


def _items(store: ProjectStore) -> dict[str, dict]:
    with ControlDatabase(store.path / "control_plane.db").connect() as db:
        rows = db.execute(
            "SELECT * FROM profile_work_items WHERE purpose='collect'",
        ).fetchall()
    return {str(row["canonical_url"]): dict(row) for row in rows}


# 问题 1：旧库只有 SQLite 待办、没有 JSON pending。
def test_sqlite_only_legacy_tasks_are_backfilled(project: ProjectStore) -> None:
    target = project.read_json("target.json")
    target["targets"] = ["https://example.com"]
    project.write_json("target.json", target)
    # 模拟 V6 时代的首次导入（此时会创建工作项——先让代码跑一次再手工
    # 删除工作项，模拟“V6 库里只有端点任务”的历史状态）。
    inventory = AssetInventory(project)
    inventory.sync_declared_targets()
    with inventory.database.connect() as db:
        db.execute("DELETE FROM profile_work_items")
        db.execute("DELETE FROM profile_dispatches")
        # 端点任务保持 pending（V6 未完成画像）。
        db.execute("UPDATE profile_tasks SET status='pending', attempts=0")
        db.execute("DELETE FROM profile_migration_meta")
    # 旧 JSON 队列为空（文件不存在）。
    assert not (project.path / "profile_state.json").exists()

    report = AssetInventory(project).migrate_legacy_profile_state()

    assert report.get("imported_sqlite_pending") == 1, report
    items = _items(project)
    assert "https://example.com/" in items
    assert items["https://example.com/"]["status"] == "pending"
    # 迁移后可被新调度器选中。
    schedulable = [
        item["canonical_url"]
        for item in AssetInventory(project).pending_collect_work_items()
    ]
    assert "https://example.com/" in schedulable


# 问题 2：裸 IP 目标（IPv4/IPv6/显式端口）进入新画像队列。
@pytest.mark.parametrize(
    ("raw", "expected_seed"),
    [
        ("192.0.2.10", "https://192.0.2.10/"),
        ("192.0.2.10:8443", "https://192.0.2.10:8443/"),
        ("2001:db8::1", "https://[2001:db8::1]/"),
    ],
)
def test_bare_ip_targets_get_work_items(
    project: ProjectStore, raw: str, expected_seed: str,
) -> None:
    target = project.read_json("target.json")
    target["targets"] = [raw]
    project.write_json("target.json", target)
    inventory = AssetInventory(project)
    inventory.sync_declared_targets()

    with inventory.database.connect() as db:
        task_count = db.execute(
            "SELECT count(*) AS c FROM profile_tasks",
        ).fetchone()["c"]
        asset_row = db.execute(
            "SELECT canonical_url FROM enterprise_assets",
        ).fetchone()
    assert task_count == 1
    assert asset_row["canonical_url"] is None  # 裸 IP 无 canonical_url

    items = _items(project)
    assert expected_seed in items, items
    assert items[expected_seed]["status"] == "pending"
    schedulable = [
        item["canonical_url"]
        for item in inventory.pending_collect_work_items()
    ]
    assert expected_seed in schedulable


# 问题 6：损坏的旧 JSON 中止迁移，不写完成标记。
def test_corrupted_legacy_json_aborts_migration(project: ProjectStore) -> None:
    target = project.read_json("target.json")
    target["targets"] = ["https://example.com"]
    project.write_json("target.json", target)
    AssetInventory(project).sync_declared_targets()
    # 复位到“迁移尚未执行”的 V6 升级现场，再放一个截断的 JSON。
    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        db.execute("DELETE FROM profile_migration_meta")
    (project.path / "profile_state.json").write_text(
        '{"pending_seed_urls": ["https://example.com/broken', encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="profile_state.json"):
        AssetInventory(project).migrate_legacy_profile_state()
    with ControlDatabase(project.path / "control_plane.db").connect() as db:
        marker = db.execute(
            "SELECT count(*) AS c FROM profile_migration_meta",
        ).fetchone()["c"]
        broken_item = db.execute(
            "SELECT count(*) AS c FROM profile_work_items WHERE canonical_url LIKE '%broken%'",
        ).fetchone()["c"]
    assert marker == 0  # 未写完成标记
    assert broken_item == 0  # 未导入半截数据
    # 派发门禁保持关闭状态。
    from src.sorne.database import ControlDatabase as DB

    database = DB(project.path / "control_plane.db")
    with database.connect() as conn:
        ids = [
            str(row["id"]) for row in conn.execute(
                "SELECT id FROM profile_work_items LIMIT 1",
            ).fetchall()
        ]
    if ids:
        run_id = database.create_run(project.vendor, "default", 600, 1)
        with pytest.raises(RuntimeError, match="迁移未完成"):
            database.enqueue_profile_job_atomic(
                run_id, "profile", "m", "profile_mapper", {}, ids,
            )
