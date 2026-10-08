"""旧角色团队迁移（实施方案 §10，P4 交付）。

迁移只做三件事：预览（dry-run）、执行（写新团队 + 归档回退副本）、回退
（仅恢复团队配置，不动数据库与新证据）。运行中的旧 Run 不热切换——存在
活动 Run 时执行与回退都会被拒绝，等运行完成/停止后下次 Run 使用新团队。

映射表（§10 表格 + §10-3 默认迁移映射）：

| 旧角色 | 主要继承者 | 专属 Prompt |
|---|---|---|
| reason | planner | 复制（planner 是主要继承者） |
| metacog | planner（反事实/盲区检查阶段） | 归档不复制（与 reason 合并到同一职责） |
| executor / pentester | operator（主要）/recon/crack/poc | 归档不复制（一对多，职责冲突） |
| waf_analyst | operator（专项技能）＋planner 重规划 | 归档不复制 |
| profile_mapper | recon（资产/指纹采集；画像服务已内置） | 归档不复制 |
| reviewer | reviewer（新语义：action/finding review） | 复制（同一职责域） |

新角色复制模型/运行时配置，不复制明文密钥（秘密按成员名存于
RuntimeSecretStore，新成员名不同即不继承；预览明确列为人工步骤）。
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import role_registry
from .schemas import normalize_role

MIGRATION_DIR = "team_migration"

# 旧角色 → (主要继承者, 完整衍生集合, 专属 Prompt 是否复制)
# Prompt 只在一对一且职责同域时复制（§10-5：衍生多个新角色时不把旧专属
# Prompt 原样复制到职责冲突的角色）。
LEGACY_MIGRATION_MAP: dict[str, tuple[str, tuple[str, ...], bool]] = {
    "reason": ("planner", ("planner",), True),
    "metacog": ("planner", ("planner",), False),
    "executor": ("operator", ("operator", "recon", "crack", "poc"), False),
    "waf_analyst": ("operator", ("operator", "planner"), False),
    "profile_mapper": ("recon", ("recon",), False),
    "reviewer": ("reviewer", ("reviewer",), True),
}

# 执行类新角色（§10-4 能力兼容性逐项检测用）
EXECUTION_TARGETS = frozenset({"operator", "recon", "crack", "poc"})


class MigrationError(RuntimeError):
    pass


def _now_tag() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _team_config_path(store) -> Path:
    return store.path / "team_config.json"


def load_raw_team_config(store) -> dict[str, Any]:
    path = _team_config_path(store)
    if not path.is_file():
        raise MigrationError("项目尚无团队配置文件，无需迁移")
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MigrationError(f"团队配置不可读: {exc}") from exc
    if not isinstance(config, dict) or not isinstance(config.get("members"), list):
        raise MigrationError("团队配置格式非法（缺少 members 数组）")
    return config


def _normalized_members(config: dict[str, Any]) -> list[dict[str, Any]]:
    members: list[dict[str, Any]] = []
    for raw in config["members"]:
        if not isinstance(raw, dict):
            continue
        try:
            role = normalize_role(raw.get("role"))
        except ValueError:
            role = str(raw.get("role") or "")
        members.append({**raw, "role": role})
    return members


def _archive_dir(store, tag: str | None = None) -> Path:
    return store.path / MIGRATION_DIR / (tag or _now_tag())


def _latest_archive(store) -> Path | None:
    root = store.path / MIGRATION_DIR
    if not root.is_dir():
        return None
    candidates = sorted(
        (item for item in root.iterdir() if item.is_dir() and (item / "manifest.json").is_file()),
        key=lambda item: item.name,
    )
    return candidates[-1] if candidates else None


def active_run_blocker(store) -> dict[str, Any] | None:
    """活动 Run 检测（§10-6：运行中的旧 Run 不热切换角色）。"""
    from .database import ControlDatabase

    database_path = store.path / "control_plane.db"
    if not database_path.is_file():
        return None
    database = ControlDatabase(database_path)
    run = database.latest_resumable_run() or database.latest_run()
    if run and str(run.get("status")) in {"running", "paused", "stopping"}:
        return {
            "run_id": run.get("id"),
            "status": run.get("status"),
            "reason": "运行中的旧 Run 不热切换团队；请先完成或停止该运行，下次 Run 使用新团队",
        }
    return None


def _model_config_of(member: dict[str, Any]) -> dict[str, Any]:
    """复制模型/运行时配置（不含 env、custom_prompt 与任何明文秘密）。"""
    keys = (
        "type", "model", "base_url", "api_key_env", "auth_mode",
        "runtime_mode", "sandbox", "priority", "max_running", "profile",
    )
    return {key: member.get(key) for key in keys if member.get(key) is not None}


def _capability_advisories(member: dict[str, Any], targets: tuple[str, ...]) -> list[str]:
    """§10-4 能力兼容性逐项检测的预览提示。"""
    notes: list[str] = []
    backend = str(member.get("type") or member.get("backend") or "codex")
    model = str(member.get("model") or "").strip()
    sandbox = str(member.get("sandbox") or "read-only")
    if EXECUTION_TARGETS.intersection(targets):
        if sandbox == "read-only":
            notes.append(
                "旧角色为只读沙箱；执行类新角色默认 workspace-write，"
                "迁移按新角色默认值设置，旧沙箱值保留在档案中"
            )
        if backend in {"codex", "claude-cli"} and not model:
            notes.append(
                f"{backend} 后端未显式配置模型；执行前请在角色卡确认模型可完成工具循环"
            )
    return notes


def migration_preview(store) -> dict[str, Any]:
    """迁移预览（dry-run，不写任何文件）。"""
    if not _team_config_path(store).is_file():
        # 项目级团队配置不存在 → 使用全局默认（已是七角色），无需迁移。
        return {
            "needed": False,
            "already_migrated": True,
            "legacy_member_count": 0,
            "seven_roles_present": list(role_registry.SEVEN_ROLES),
            "missing_seven_roles": [],
            "mappings": [],
            "kept_members": [],
            "archive": None,
            "active_run": active_run_blocker(store),
            "notes": ["项目未单独配置团队，使用全局默认七角色团队"],
        }
    config = load_raw_team_config(store)
    members = _normalized_members(config)
    legacy_members = [member for member in members if _is_legacy_role(member["role"])]
    seven_present = {
        member["role"] for member in members
        if member["role"] in role_registry.SEVEN_ROLES
    }
    mappings: list[dict[str, Any]] = []
    for member in legacy_members:
        role = member["role"]
        primary, targets, copy_prompt = LEGACY_MIGRATION_MAP.get(
            role, ("operator", ("operator",), False)
        )
        mappings.append({
            "member_name": str(member.get("name") or ""),
            "legacy_role": role,
            "primary_target": primary,
            "target_roles": list(dict.fromkeys((primary, *targets))),
            "copied_config": _model_config_of(member),
            "prompt_copied": copy_prompt,
            "prompt_note": (
                "专属 Prompt 复制到主要继承者" if copy_prompt
                else "专属 Prompt 归档不复制（衍生多个新角色或职责合并，需人工改写）"
            ),
            "manual_steps": [
                "密钥不随迁移复制：新成员需在钥匙串重新登记运行密钥",
                *_capability_advisories(member, tuple(dict.fromkeys((primary, *targets)))),
            ],
        })
    kept_members = [
        {"name": str(member.get("name") or ""), "role": member["role"]}
        for member in members
        if member["role"] in role_registry.SEVEN_ROLES
    ]
    archive = _latest_archive(store)
    archive_info = None
    if archive is not None:
        try:
            manifest = json.loads((archive / "manifest.json").read_text(encoding="utf-8"))
            archive_info = {
                "archive_dir": f"{MIGRATION_DIR}/{archive.name}",
                "migrated_at": manifest.get("migrated_at"),
                "rolled_back": bool(manifest.get("rolled_back")),
            }
        except (OSError, json.JSONDecodeError):
            archive_info = {"archive_dir": f"{MIGRATION_DIR}/{archive.name}", "rolled_back": False}
    already_migrated = not legacy_members and len(seven_present) == len(role_registry.SEVEN_ROLES)
    return {
        "needed": bool(legacy_members),
        "already_migrated": already_migrated,
        "legacy_member_count": len(legacy_members),
        "seven_roles_present": sorted(seven_present),
        "missing_seven_roles": sorted(set(role_registry.SEVEN_ROLES) - seven_present),
        "mappings": mappings,
        "kept_members": kept_members,
        "archive": archive_info,
        "active_run": active_run_blocker(store),
        "notes": [
            "新角色复制模型/运行时配置，不复制明文密钥（§10-3）",
            "运行中的旧 Run 不热切换；完成/停止后下次 Run 使用新团队（§10-6）",
            "回退只恢复团队配置；数据库与迁移后产生的新证据保持可读（§10-7）",
        ],
    }


def _is_legacy_role(role: str) -> bool:
    record = role_registry.get_role(role)
    return record is not None and record.origin == "legacy"


def _default_seven_template() -> list[dict[str, Any]]:
    """七角色默认模板（与 teams/default.json 同源；避免文件缺失时迁移失败）。"""
    from .store import ROOT

    path = ROOT / "teams" / "default.json"
    members: list[dict[str, Any]] = []
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            raw = data.get("members") if isinstance(data, dict) else None
            if isinstance(raw, list):
                members = [dict(item) for item in raw if isinstance(item, dict)]
        except (OSError, json.JSONDecodeError):
            members = []
    if {str(item.get("role")) for item in members} >= set(role_registry.SEVEN_ROLES):
        return members
    raise MigrationError(
        f"默认七角色模板不完整: {path}（缺少 {sorted(set(role_registry.SEVEN_ROLES) - {str(i.get('role')) for i in members})}）"
    )


def execute_migration(store, *, requested_by: str = "user") -> dict[str, Any]:
    """执行迁移（幂等：已迁移时返回 no-op 摘要，不重复归档）。"""
    preview = migration_preview(store)
    if preview["already_migrated"]:
        return {
            "executed": False,
            "reason": "already_migrated",
            "preview": preview,
        }
    if not preview["needed"]:
        # 有旧角色才迁；仅缺新角色但没有旧角色时不自动补齐（避免改写用户团队）
        raise MigrationError(
            "团队中没有旧六角色成员；如需补齐七角色请在团队编辑器手动添加"
        )
    blocker = active_run_blocker(store)
    if blocker is not None:
        raise MigrationError(
            f"运行 {blocker['run_id']} 处于 {blocker['status']} 状态：{blocker['reason']}"
        )

    config = load_raw_team_config(store)
    members = _normalized_members(config)
    legacy_by_role: dict[str, dict[str, Any]] = {}
    for member in members:
        if _is_legacy_role(member["role"]):
            legacy_by_role.setdefault(member["role"], member)

    template = _default_seven_template()
    new_members: list[dict[str, Any]] = []
    # 保留现有七角色成员（不重写用户已调整的新角色配置）
    for member in members:
        if member["role"] in role_registry.SEVEN_ROLES:
            new_members.append({key: value for key, value in member.items() if key != "backend"})
    present_roles = {member["role"] for member in new_members}

    inheritance: list[dict[str, Any]] = []
    for template_member in template:
        role = str(template_member.get("role") or "")
        if role in present_roles:
            continue
        created = dict(template_member)
        # 模型/运行时配置继承：找映射到该角色的旧角色（主要继承者优先）
        source = None
        for legacy_role, (primary, _targets, _copy_prompt) in LEGACY_MIGRATION_MAP.items():
            if primary == role and legacy_role in legacy_by_role:
                source = legacy_by_role[legacy_role]
                break
        prompt_from = None
        if source is not None:
            copied = _model_config_of(source)
            copied.pop("sandbox", None)  # 沙箱按新角色默认（预览已提示）
            created.update(copied)
            legacy_role = source["role"]
            _primary, _targets, copy_prompt = LEGACY_MIGRATION_MAP[legacy_role]
            if copy_prompt and str(source.get("custom_prompt") or "").strip():
                created["custom_prompt"] = str(source["custom_prompt"])
                prompt_from = legacy_role
        new_members.append(created)
        inheritance.append({
            "role": role,
            "member_name": str(created.get("name") or ""),
            "inherited_from": source["role"] if source else None,
            "prompt_from": prompt_from,
        })

    # 归档回退副本 + 迁移档案（含全部旧配置与决策，§10-5/§10-7）
    tag = _now_tag()
    archive = _archive_dir(store, tag)
    archive.mkdir(parents=True, exist_ok=True)
    shutil.copy2(_team_config_path(store), archive / "original_team_config.json")
    manifest = {
        "migrated_at": datetime.now(timezone.utc).isoformat(),
        "requested_by": requested_by,
        "original_members": [
            {"name": str(m.get("name") or ""), "role": m["role"]} for m in members
        ],
        "mappings": preview["mappings"],
        "inheritance": inheritance,
        "rolled_back": False,
    }
    (archive / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    # 稳定指针：回退总是取最近一次成功迁移的档案
    (store.path / MIGRATION_DIR / "latest.json").write_text(
        json.dumps({"archive": archive.name}, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    new_config = {key: value for key, value in config.items() if key != "members"}
    new_config["members"] = new_members
    _team_config_path(store).write_text(
        json.dumps(new_config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {
        "executed": True,
        "archive_dir": f"{MIGRATION_DIR}/{archive.name}",
        "new_members": [
            {"name": str(m.get("name") or ""), "role": m["role"]} for m in new_members
        ],
        "inheritance": inheritance,
        "preview": migration_preview(store),
    }


def rollback_migration(store) -> dict[str, Any]:
    """回退：仅恢复团队配置文件；不动数据库与迁移后的新证据（§10-7）。"""
    archive = _latest_archive(store)
    if archive is None:
        raise MigrationError("没有可回退的迁移档案")
    manifest_path = archive / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MigrationError(f"迁移档案不可读: {exc}") from exc
    if bool(manifest.get("rolled_back")):
        raise MigrationError("该迁移已回退过；重复回退被拒绝（幂等）")
    blocker = active_run_blocker(store)
    if blocker is not None:
        raise MigrationError(
            f"运行 {blocker['run_id']} 处于 {blocker['status']} 状态：运行中不切换团队"
        )
    original = archive / "original_team_config.json"
    if not original.is_file():
        raise MigrationError("迁移档案缺少 original_team_config.json，无法回退")
    shutil.copy2(original, _team_config_path(store))
    manifest["rolled_back"] = True
    manifest["rolled_back_at"] = datetime.now(timezone.utc).isoformat()
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {
        "rolled_back": True,
        "archive_dir": f"{MIGRATION_DIR}/{archive.name}",
        "restored_members": [
            {"name": str(m.get("name") or ""), "role": str(m.get("role") or "")}
            for m in json.loads(original.read_text(encoding="utf-8")).get("members", [])
        ],
        "note": "只恢复了团队配置；迁移期间产生的新证据与数据库保持原样",
    }
