"""P1 七角色骨架定向测试：注册表契约、默认团队、双契约兼容（方案 §12-P1）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.sorne import store as store_module
from src.sorne import role_registry
from src.sorne.role_registry import (
    ROLE_REGISTRY,
    claim_blockers,
    get_role,
    member_can_claim,
    role_ids,
)
from src.sorne.schemas import SUPPORTED_ROLES, normalize_role
from src.sorne.store import ProjectStore
from src.sorne.team import load_team
from src.sorne.tool_registry import TOOL_CATALOG


SEVEN = ("orchestrator", "planner", "recon", "crack", "poc", "operator", "reviewer")
LEGACY = ("reason", "metacog", "executor", "waf_analyst", "profile_mapper")


def test_registry_covers_dual_contract() -> None:
    assert set(SEVEN) == set(role_ids(origin="seven_role"))
    assert set(LEGACY) == set(role_ids(origin="legacy"))
    assert SUPPORTED_ROLES == frozenset(ROLE_REGISTRY)
    for role_id in SEVEN:
        assert get_role(role_id).origin == "seven_role"
        assert normalize_role(role_id) == role_id
    # 旧别名语义保留（方案 §10）。
    assert normalize_role("pentester") == "executor"


def test_registry_kinds() -> None:
    assert get_role("orchestrator").kind == role_registry.KIND_ORCHESTRATION
    assert get_role("planner").kind == role_registry.KIND_PLANNING
    for role_id in ("recon", "crack", "poc", "operator", "executor"):
        assert get_role(role_id).kind == role_registry.KIND_EXECUTION
    assert get_role("reviewer").kind == role_registry.KIND_REVIEW


def test_role_capabilities_reference_catalog_only_and_no_wildcard() -> None:
    for record in ROLE_REGISTRY.values():
        assert record.capabilities, f"{record.id} 能力白名单为空"
        assert "*" not in record.capabilities
        unknown = set(record.capabilities) - set(TOOL_CATALOG)
        assert not unknown, f"{record.id} 引用未登记能力: {unknown}"


@pytest.mark.parametrize("role_id", ["orchestrator", "planner", "reviewer"])
def test_non_execution_roles_have_no_bash_or_network(role_id: str) -> None:
    """方案 §6.4：orchestrator/planner/reviewer 默认无 Bash/扫描/网络。"""
    capabilities = get_role(role_id).capabilities
    for forbidden in ("compat_bash", "http_request", "pwd_crack", "poc_scan",
                      "url_scan", "ip_scan", "subdomain_scan", "dir_scan", "js_scan"):
        assert forbidden not in capabilities, f"{role_id} 不应持有 {forbidden}"


def test_specialists_keep_scan_capabilities_and_operator_yields() -> None:
    assert "pwd_crack" in get_role("crack").capabilities
    assert "poc_scan" in get_role("poc").capabilities
    assert {"url_scan", "dir_scan", "js_scan"} <= get_role("recon").capabilities
    # 扫描引擎不在 operator 白名单：operator 默认不与专兵抢任务（§3.1），
    # 只有显式委派/专兵不可用等条件（后续阶段网关逐调用校验）才可能放行。
    assert "pwd_crack" not in get_role("operator").capabilities
    assert get_role("operator").claim_priority > get_role("poc").claim_priority


def test_legacy_roles_keep_compat_bash_and_new_roles_do_not() -> None:
    for role_id in LEGACY:
        assert "compat_bash" in get_role(role_id).capabilities, f"旧角色 {role_id} 须保留兼容通路"
    for role_id in SEVEN:
        assert "compat_bash" not in get_role(role_id).capabilities


def test_prompt_files_exist_for_every_role() -> None:
    prompt_dir = Path(__file__).resolve().parents[1] / "src" / "sorne" / "prompts"
    for record in ROLE_REGISTRY.values():
        assert (prompt_dir / Path(record.prompt_file).name).is_file(), record.prompt_file


def test_context_budgets_cover_all_registry_roles() -> None:
    from src.sorne.context_compiler import ROLE_CONTEXT_BUDGETS

    missing = set(ROLE_REGISTRY) - set(ROLE_CONTEXT_BUDGETS)
    assert not missing, f"预算表缺少角色: {missing}"
    for role_id, budget in ROLE_CONTEXT_BUDGETS.items():
        assert role_id in ROLE_REGISTRY, f"预算表含未知角色: {role_id}"
        assert budget >= 4_000


def test_member_can_claim_by_capability() -> None:
    verify = {"verb": "verify", "target": "https://t.example"}
    inspect_intent = {"verb": "inspect", "target": "https://t.example"}
    # poc/operator 有受控 HTTP；recon/crack 无（其引擎 P2/P3 接入）。
    assert member_can_claim("operator", verify)
    assert member_can_claim("poc", verify)
    assert member_can_claim("executor", verify)  # 旧 executor 继承 operator 集
    assert not member_can_claim("recon", verify)
    assert not member_can_claim("crack", verify)
    assert member_can_claim("recon", inspect_intent)
    # 非执行类 kind 一律不能认领。
    for role_id in ("planner", "orchestrator", "reviewer", "reason", "profile_mapper"):
        assert not member_can_claim(role_id, verify)


def test_claim_blockers_report_capability_missing() -> None:
    blockers = claim_blockers(
        [{"id": "I-1", "verb": "verify", "target": "t"}],
        ["planner", "recon"],  # recon 无 http_request
    )
    assert blockers and blockers[0]["direction_id"] == "I-1"
    assert "http_request" in blockers[0]["missing"]
    # 有 operator 在队则不构成缺口。
    assert claim_blockers([{"id": "I-1", "verb": "verify"}], ["operator"]) == []


@pytest.fixture()
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    monkeypatch.setattr(store_module, "PROJECTS", tmp_path / "projects")
    store = ProjectStore("vendor")
    store.init()
    return store


def test_default_team_is_seven_roles_out_of_the_box(project: ProjectStore) -> None:
    """新项目无 team_config.json 时回退仓库默认团队：开箱即七角色（§13.1-1）。"""
    members = load_team("default", project)
    assert [item.role for item in members] == [
        "planner", "orchestrator", "recon", "crack", "poc", "operator", "reviewer",
    ]
    assert all(item.type == "codex" for item in members)
    # 无角色丢失、无未知字段错误。
    assert len({item.name for item in members}) == 7


def test_webapp_accepts_seven_roles_and_strips_unknown_fields(project: ProjectStore) -> None:
    from src.sorne.webapp import _normalize_team_config

    normalized = _normalize_team_config({"members": [
        {
            "name": "op", "type": "codex", "role": "operator",
            "runtime_mode": "local-docker", "sandbox": "workspace-write",
            # 未来扩展键：归一化必须剔除，否则严格 dataclass 构造抛 TypeError。
            "capabilities": ["http_request"], "future_field": {"x": 1},
        },
        {"name": "pl", "type": "codex", "role": "planner"},
    ]})
    op = normalized["members"][0]
    assert op["role"] == "operator"
    assert "capabilities" not in op and "future_field" not in op
    # 旧别名仍在保存入口规范化。
    legacy = _normalize_team_config({"members": [{"name": "p", "type": "codex", "role": "pentester"}]})
    assert legacy["members"][0]["role"] == "executor"


def test_legacy_six_role_team_config_still_loads(project: ProjectStore) -> None:
    """旧项目兼容（§13.1-14）：旧六角色 + pentster 别名团队可加载。"""
    (project.path / "team_config.json").write_text(json.dumps({"members": [
        {"name": "r", "type": "mock", "role": "reason"},
        {"name": "m", "type": "mock", "role": "metacog"},
        {"name": "e", "type": "mock", "role": "pentester"},
        {"name": "v", "type": "mock", "role": "reviewer"},
        {"name": "w", "type": "mock", "role": "waf_analyst"},
        {"name": "p", "type": "mock", "role": "profile_mapper"},
    ]}, ensure_ascii=False), encoding="utf-8")
    members = load_team("default", project)
    assert [item.role for item in members] == [
        "reason", "metacog", "executor", "reviewer", "waf_analyst", "profile_mapper",
    ]
    # 未知字段不阻塞加载（被剔除而不是 TypeError）。
    (project.path / "team_config.json").write_text(json.dumps({"members": [
        {"name": "r", "type": "mock", "role": "reason", "unknown_new_field": 1},
    ]}, ensure_ascii=False), encoding="utf-8")
    assert [item.role for item in load_team("default", project)] == ["reason"]


def test_execution_kind_roles_require_task_in_batch(project: ProjectStore) -> None:
    """run_team 对执行类角色（不只 executor）要求 --task（§1.2 D-2）。"""
    from src.sorne.team import run_team
    from src.sorne.worker import WorkerError

    (project.path / "team_config.json").write_text(json.dumps({"members": [
        {"name": "op", "type": "mock", "role": "operator"},
    ]}, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(WorkerError, match="--task"):
        run_team(project, "default", dry_run=True)
    output = run_team(project, "default", dry_run=True, task="验证 https://t.example 的 X")
    assert "op" in output


def test_cli_role_choices_derive_from_registry() -> None:
    from src.sorne.cli import build_parser

    parser = build_parser()
    subparsers = next(
        item for item in parser._actions
        if item.__class__.__name__ == "_SubParsersAction"
    )
    worker = subparsers.choices["run-worker"]
    action = next(item for item in worker._actions if "--role" in item.option_strings)
    assert set(SEVEN) <= set(action.choices)
    assert set(LEGACY) <= set(action.choices)
    assert "pentester" in action.choices
