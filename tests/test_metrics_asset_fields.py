"""资产指标分口径契约测试（实施规格 5.4/5.5）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne.asset_inventory import AssetInventory
from src.sorne.metrics import collect_metrics, project_asset_inventory, refresh_asset_count
from src.sorne.store import ProjectStore


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    return store


def test_metric_fields_have_explicit_scope(project: ProjectStore) -> None:
    target = project.read_json("target.json")
    target["targets"] = ["https://example.com"]
    project.write_json("target.json", target)

    inventory = AssetInventory(project)
    inventory.sync_declared_targets()
    inventory.add_work_items(["https://example.com/new-path"])

    # 构造分状态资产：一个 stale、一个 out_of_scope。
    with inventory.database.connect() as db:
        db.execute(
            """
            INSERT INTO enterprise_assets(
                id,asset_type,endpoint_key,status,source_count,official_source,
                first_seen_at,last_seen_at,metadata_json
            ) VALUES ('EA-STALE','url','web:https://stale.example.com:443','stale',0,0,?,?,'{}')
            """,
            ("2026-01-01T00:00:00", "2026-01-01T00:00:00"),
        )
        db.execute(
            """
            INSERT INTO enterprise_assets(
                id,asset_type,endpoint_key,status,source_count,official_source,
                first_seen_at,last_seen_at,metadata_json
            ) VALUES ('EA-OOS','url','web:https://oos.example.com:443','out_of_scope',0,0,?,?,'{}')
            """,
            ("2026-01-01T00:00:00", "2026-01-01T00:00:00"),
        )

    metrics = collect_metrics(project)
    assets = metrics["assets"]
    # 新字段：每个数字有明确单位与过滤条件。
    assert assets["active_scope_endpoint_count"] == 1  # example.com（stale/oos 排除）
    assert assets["inventory_record_count"] == 3  # 底座全记录（含 stale/oos）
    assert assets["stale_asset_count"] == 1
    assert assets["out_of_scope_asset_count"] == 1
    assert assets["declared_target_count"] == 1
    assert assets["local_artifact_count"] == 0
    # 待画像工作项数 ≠ 资产数：declared 根 + new-path 两个 collect 工作项。
    assert assets["profile_pending_work_count"] == 2
    # 兼容字段保留原义。
    assert assets["total"] == len(assets["items"]) >= 1
    assert assets["declared"] == 1

    summary = AssetInventory(project).summary()
    assert summary["inventory_record_count"] == summary["total"] == 3
    assert summary["active_scope_endpoint_count"] == 1
    assert summary["profile_pending_work_count"] == 2


def test_local_artifact_count_for_file_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("files")
    store.init()
    target = store.read_json("target.json")
    target["project_type"] = "客户端 APK 审计"
    target["target_path"] = str(tmp_path / "uploads")
    target["uploaded_artifact"] = {"name": "app.apk", "path": "/x", "size": 1, "sha256": "0"}
    store.write_json("target.json", target)

    metrics = collect_metrics(store)
    assert metrics["assets"]["local_artifact_count"] == 2  # 上传制品 + 本地目录


def test_state_asset_count_keeps_legacy_semantics(project: ProjectStore) -> None:
    # 兼容口径：state.asset_count 仍由同一公共函数（合并清单）维护，
    # 阶段判断（asset_count>0 → recon）语义不变。
    target = project.read_json("target.json")
    target["targets"] = ["https://example.com"]
    project.write_json("target.json", target)
    AssetInventory(project).sync_declared_targets()

    refresh_asset_count(project)
    assert project.load_state().asset_count == len(project_asset_inventory(project))
    assert project.load_state().asset_count > 0

    from src.sorne.phase import reconcile_phase

    assert reconcile_phase(project, "test") in {"recon", "probe"}
