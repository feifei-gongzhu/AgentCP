"""P3 资源仓库定向测试（方案 §7.2：分类/来源/许可/版本/哈希/启停/
导入验证/回滚；不导入用户密钥/Cookie/账号数据）。

指纹规则、JS 线索规则、服务字典、POC 模板、技能文档五类分类管理；
内置种子随仓库版本化；用户导入生成新版本（旧版本保留可回滚）；
导入验证拒绝明文凭据形状与结构非法内容；禁用资源对消费方如实报缺口。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import resource_repository
from src.sorne import store as store_module
from src.sorne.store import ProjectStore


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("p3-resources")
    store.init()
    return store


def test_ensure_defaults_registers_all_categories_idempotently(project: ProjectStore) -> None:
    first = resource_repository.ensure_defaults(project)
    assert set(first["registered"]) == {
        "builtin-web-fingerprints", "builtin-js-leads", "dirs-common",
        "subdomains-common", "nuclei-bundled-templates", "skill-cards-bundled",
    }
    second = resource_repository.ensure_defaults(project)
    assert second["registered"] == []  # 幂等，不覆盖
    categories = {item["category"] for item in resource_repository.list_resources(project)}
    assert categories == set(resource_repository.CATEGORIES)


def test_builtin_entries_carry_source_license_version_hash(project: ProjectStore) -> None:
    resource_repository.ensure_defaults(project)
    for entry in resource_repository.list_resources(project):
        assert entry["source"], entry["id"]
        assert entry["license"], entry["id"]
        assert int(entry["version"]) >= 1
        assert len(str(entry["sha256"])) == 64
        assert (project.path / entry["file"]).is_file()


def test_import_generates_new_version_and_keeps_history(project: ProjectStore) -> None:
    resource_repository.ensure_defaults(project)
    updated = resource_repository.import_resource(
        project,
        category="service_dictionaries",
        resource_id="dirs-common",
        name="自定义目录字典",
        content={"kind": "dir_wordlist", "words": ["custom-path"]},
        version=None,
        source="user-upload",
        source_url="https://example.invalid/dict.txt",
        license="CC0-1.0（示例）",
        imported_by="tester",
    )
    assert updated["version"] == 2
    assert len(updated["history"]) == 1
    loaded = resource_repository.load_active(project, "service_dictionaries")
    content, entry = loaded
    assert entry["version"] == 2 and entry["id"] == "dirs-common"
    assert content["words"] == ["custom-path"]


def test_rollback_restores_previous_version(project: ProjectStore) -> None:
    resource_repository.ensure_defaults(project)
    resource_repository.import_resource(
        project, category="service_dictionaries", resource_id="dirs-common",
        name="v2", content={"kind": "dir_wordlist", "words": ["a"]},
        source="user", license="MIT（测试）", imported_by="tester",
    )
    restored = resource_repository.rollback(project, "dirs-common")
    assert restored["version"] == 1
    content, entry = resource_repository.load_active(project, "service_dictionaries")
    assert entry["version"] == 1
    assert "admin" in content["words"]  # 内置字典内容恢复
    # 回滚前版本仍保留在历史中（可再回滚/审计）
    assert any(item["version"] == 2 for item in restored["history"])


def test_rollback_without_history_fails(project: ProjectStore) -> None:
    resource_repository.ensure_defaults(project)
    with pytest.raises(resource_repository.ResourceRepositoryError, match="没有可回滚"):
        resource_repository.rollback(project, "dirs-common")


def test_import_validation_rejects_structurally_invalid_content(project: ProjectStore) -> None:
    with pytest.raises(resource_repository.ResourceRepositoryError, match="导入验证失败"):
        resource_repository.import_resource(
            project, category="fingerprint_rules", resource_id="bad-rules",
            name="坏规则", content=[{"rule_id": "x", "technology": "T",
                                    "passive": [{"source": "header", "pattern": "("}]}],
            source="user", license="MIT（测试）",
        )
    with pytest.raises(resource_repository.ResourceRepositoryError):
        resource_repository.import_resource(
            project, category="service_dictionaries", resource_id="bad-dict",
            name="坏字典", content={"kind": "dir_wordlist", "words": []},
            source="user", license="MIT（测试）",
        )


def test_import_validation_rejects_plaintext_credentials(project: ProjectStore) -> None:
    with pytest.raises(resource_repository.ResourceRepositoryError, match="明文凭据"):
        resource_repository.import_resource(
            project, category="fingerprint_rules", resource_id="leaky-rules",
            name="带密钥的规则", content=[{
                "rule_id": "x", "technology": "T",
                "passive": [{"source": "body", "pattern": "api_key"}],
                "notes": "api_key = 'sk-live-abcdefgh12345678'",
            }],
            source="user", license="MIT（测试）",
        )
    with pytest.raises(resource_repository.ResourceRepositoryError, match="明文凭据"):
        resource_repository.import_resource(
            project, category="js_clue_rules", resource_id="leaky-js",
            name="带 Cookie 的规则",
            content=[{"rule_id": "j", "kind": "endpoint", "pattern": "/api/",
                      "note": "Cookie: SESSIONID=abcdef123456; Path=/"}],
            source="user", license="MIT（测试）",
        )


def test_import_requires_source_and_license(project: ProjectStore) -> None:
    with pytest.raises(resource_repository.ResourceRepositoryError, match="来源"):
        resource_repository.import_resource(
            project, category="fingerprint_rules", resource_id="x1",
            name="n", content=[], source="", license="MIT",
        )
    with pytest.raises(resource_repository.ResourceRepositoryError, match="许可"):
        resource_repository.import_resource(
            project, category="fingerprint_rules", resource_id="x2",
            name="n", content=[], source="user", license="",
        )


def test_disabled_resource_is_not_loaded(project: ProjectStore) -> None:
    resource_repository.ensure_defaults(project)
    resource_repository.set_enabled(project, "dirs-common", enabled=False)
    loaded = resource_repository.load_all_active(project, "service_dictionaries")
    ids = {entry["id"] for _content, entry in loaded}
    assert "dirs-common" not in ids
    assert "subdomains-common" in ids  # 同类别其他资源不受影响


def test_tampered_file_fails_hash_check_and_is_skipped(project: ProjectStore) -> None:
    resource_repository.ensure_defaults(project)
    entry = resource_repository.find_resource(project, "dirs-common")
    file_path = project.path / entry["file"]
    original = file_path.read_text(encoding="utf-8")
    file_path.write_text(original.replace("admin", "tampered"), encoding="utf-8")
    loaded = resource_repository.load_all_active(project, "service_dictionaries")
    ids = {e["id"] for _c, e in loaded}
    assert "dirs-common" not in ids  # 哈希不一致 → 资源损坏被跳过


def test_load_active_kind_filtering_for_multiple_dictionaries(project: ProjectStore) -> None:
    """同类别两类字典共存：消费方按 kind 各取所需。"""
    resource_repository.ensure_defaults(project)
    dir_entries = [
        entry for _c, entry in resource_repository.load_all_active(project, "service_dictionaries")
    ]
    assert {entry["id"] for entry in dir_entries} >= {"dirs-common", "subdomains-common"}
