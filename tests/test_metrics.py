from pathlib import Path

import pytest

from src.agent_control_plane import store as store_module
from src.agent_control_plane.metrics import collect_metrics
from src.agent_control_plane.worker import apply_worker_output
from src.agent_control_plane.store import ProjectStore


def test_empty_project_metrics_are_stable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    metrics = collect_metrics(store)
    assert metrics["coverage"]["dimensions"] == 10
    assert metrics["coverage"]["coverage_rate"] == 0
    assert metrics["quality"]["validation_rate"] == 0
    assert metrics["automation"]["job_success_rate"] == 0


def test_assets_are_real_deduplicated_inventory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    store = ProjectStore("vendor")
    store.init()
    target = store.read_json("target.json")
    target["targets"] = ["https://example.com/", "example.com", "api.example.com"]
    store.write_json("target.json", target)

    apply_worker_output(store, {
        "kind": "fact",
        "title": "证书 SAN 资产",
        "category": "asset",
        "assets": ["api.example.com", "admin.example.com"],
        "evidence": "运行证书检查后返回 SAN：admin.example.com，并观察到解析成功。",
        "business_impact": "攻击者可扩展已授权测试面的资产枚举范围。",
        "reproduction_steps": ["读取证书", "提取 SAN"],
        "evidence_path": "evidence/assets.txt",
        "severity": "unknown",
        "confidence": 0.7,
    })

    metrics = collect_metrics(store)
    assert metrics["assets"]["declared"] == 2
    assert metrics["assets"]["discovered"] == 1
    assert metrics["assets"]["total"] == 3
    assert store.load_state().asset_count == 3
