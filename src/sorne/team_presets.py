from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

from .schemas import now_iso
from .store import ROOT


TEAM_PRESET_SCHEMA_VERSION = 1
TEAM_PRESET_ROOT = ROOT / "user_presets" / "teams"
_PRESET_ID = re.compile(r"^TP-[a-f0-9]{12}$")
_LOCK = threading.RLock()


class TeamPresetError(ValueError):
    pass


class TeamPresetStore:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root is not None else TEAM_PRESET_ROOT

    def _ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def _preset_path(self, preset_id: str) -> Path:
        checked = str(preset_id or "").strip()
        if not _PRESET_ID.fullmatch(checked):
            raise TeamPresetError("团队预设 ID 非法")
        return self.root / f"{checked}.json"

    @property
    def settings_path(self) -> Path:
        return self.root / "_settings.json"

    def _read_json(self, path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise TeamPresetError(f"团队预设文件损坏: {path.name}") from exc
        if not isinstance(value, dict):
            raise TeamPresetError(f"团队预设格式错误: {path.name}")
        return value

    def _atomic_write(self, path: Path, value: dict[str, Any]) -> None:
        self._ensure_root()
        encoded = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=self.root,
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def default_id(self) -> str | None:
        if not self.settings_path.is_file():
            return None
        value = self._read_json(self.settings_path).get("default_preset_id")
        checked = str(value or "").strip()
        return checked if _PRESET_ID.fullmatch(checked) and self._preset_path(checked).is_file() else None

    def set_default(self, preset_id: str | None) -> str | None:
        with _LOCK:
            checked = str(preset_id or "").strip() or None
            if checked is not None:
                self.get(checked)
            self._atomic_write(self.settings_path, {
                "schema_version": TEAM_PRESET_SCHEMA_VERSION,
                "default_preset_id": checked,
                "updated_at": now_iso(),
            })
            return checked

    def list(self) -> list[dict[str, Any]]:
        with _LOCK:
            if not self.root.is_dir():
                return []
            default_id = self.default_id()
            presets = [
                self._read_json(path)
                for path in sorted(self.root.glob("TP-*.json"))
                if path.is_file() and not path.is_symlink()
            ]
            for item in presets:
                self._validate_document(item)
                item["is_default"] = item["id"] == default_id
            return sorted(
                presets,
                key=lambda item: (not bool(item.get("is_default")), str(item["name"]).casefold()),
            )

    def get(self, preset_id: str) -> dict[str, Any]:
        with _LOCK:
            path = self._preset_path(preset_id)
            if not path.is_file() or path.is_symlink():
                raise TeamPresetError("团队预设不存在")
            value = self._read_json(path)
            self._validate_document(value)
            if value["id"] != preset_id:
                raise TeamPresetError(f"团队预设 ID 与文件名不一致: {path.name}")
            value["is_default"] = value["id"] == self.default_id()
            return value

    def save(
        self,
        name: str,
        config: dict[str, Any],
        *,
        preset_id: str | None = None,
    ) -> dict[str, Any]:
        with _LOCK:
            checked_name = str(name or "").strip()
            if not checked_name or len(checked_name) > 80:
                raise TeamPresetError("预设名称不能为空且不能超过 80 个字符")
            now = now_iso()
            if preset_id:
                checked_id = str(preset_id).strip()
                path = self._preset_path(checked_id)
                if path.is_file():
                    existing = self.get(checked_id)
                    created_at = existing["created_at"]
                else:
                    created_at = now
            else:
                checked_id = f"TP-{uuid4().hex[:12]}"
                created_at = now
            document = {
                "schema_version": TEAM_PRESET_SCHEMA_VERSION,
                "id": checked_id,
                "name": checked_name,
                "config": json.loads(json.dumps(config, ensure_ascii=False)),
                "created_at": created_at,
                "updated_at": now,
            }
            self._validate_document(document)
            self._atomic_write(self._preset_path(checked_id), document)
            document["is_default"] = checked_id == self.default_id()
            return document

    def rename(self, preset_id: str, name: str) -> dict[str, Any]:
        current = self.get(preset_id)
        return self.save(name, current["config"], preset_id=preset_id)

    def delete(self, preset_id: str) -> None:
        with _LOCK:
            path = self._preset_path(preset_id)
            if not path.is_file():
                raise TeamPresetError("团队预设不存在")
            was_default = self.default_id() == preset_id
            path.unlink()
            if was_default:
                self.set_default(None)

    @staticmethod
    def _validate_document(value: dict[str, Any]) -> None:
        if value.get("schema_version") != TEAM_PRESET_SCHEMA_VERSION:
            raise TeamPresetError("不支持的团队预设 Schema")
        if not _PRESET_ID.fullmatch(str(value.get("id") or "")):
            raise TeamPresetError("团队预设 ID 非法")
        if not str(value.get("name") or "").strip():
            raise TeamPresetError("团队预设名称为空")
        config = value.get("config")
        if not isinstance(config, dict) or not isinstance(config.get("members"), list):
            raise TeamPresetError("团队预设缺少成员配置")


def preset_secret_scope(preset_id: str) -> str:
    if not _PRESET_ID.fullmatch(str(preset_id or "")):
        raise TeamPresetError("团队预设 ID 非法")
    return f"__team_preset__:{preset_id}"
