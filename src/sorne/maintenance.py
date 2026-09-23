from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import threading
import zipfile
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterator
from uuid import uuid4

from . import store as store_module
from .database import ControlDatabase, SCHEMA_VERSION
from .lifecycle import project_deletion_lock, require_initialized_project
from .platform_paths import valid_project_name
from .projector import Projector
from .store import ProjectStore


BACKUP_FORMAT_VERSION = 1
MAX_BACKUP_ENTRIES = 200_000
MAX_BACKUP_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_BACKUP_FILE_BYTES = 4 * 1024 * 1024 * 1024
MAX_BACKUP_EXPANDED_BYTES = 16 * 1024 * 1024 * 1024
MAX_BACKUP_COMPRESSION_RATIO = 500
MAX_TARGET_JSON_BYTES = 8 * 1024 * 1024
REQUIRED_BACKUP_FILES = {"project/target.json", "project/control_plane.db"}
EXCLUDED_DIRS = {
    ".sorne-runtime", ".sorne-work", ".agent-compose", "__pycache__", ".cache",
}
EXCLUDED_NAMES = {
    ".control-plane.lock", ".sorne-8765.pid", ".sorne-8765.log",
}
EXCLUDED_SUFFIXES = {"-wal", "-shm", ".tmp", ".part"}


class MaintenanceError(RuntimeError):
    pass


_MAINTENANCE_LOCK = threading.RLock()
_MAINTENANCE_PROJECTS: set[str] = set()


def maintenance_status() -> list[str]:
    """Return projects currently inside a destructive maintenance barrier."""
    with _MAINTENANCE_LOCK:
        return sorted(_MAINTENANCE_PROJECTS)


class ProjectLocator:
    @staticmethod
    def validate_vendor(value: object) -> str:
        # 统一调用 platform_paths.valid_project_name，用原始输入校验（不做
        # 预先 strip，避免尾空格等非法名称被静默改成另一个名称）；错误信息
        # 带上原名称与限制来源，不假装项目不存在。
        vendor = str(value or "")
        if not valid_project_name(vendor):
            raise MaintenanceError(
                f"非法项目名称: {vendor!r}（仅允许中文/字母/数字/点/短横线/"
                "下划线，不可含首尾空格、尾点、路径分隔符或 Windows 保留名）"
            )
        return vendor

    @classmethod
    def project_path(cls, value: object, *, must_exist: bool = True) -> Path:
        vendor = cls.validate_vendor(value)
        root = store_module.PROJECTS.resolve()
        path = (root / vendor).resolve()
        try:
            path.relative_to(root)
        except ValueError as exc:
            raise MaintenanceError("项目路径越界") from exc
        if must_exist:
            if path.is_symlink() or not path.is_dir() or not (path / "target.json").is_file():
                raise MaintenanceError(f"项目不存在或未初始化: {vendor}")
        return path


@contextmanager
def project_maintenance_barrier(store: ProjectStore) -> Iterator[None]:
    require_initialized_project(store)
    with _MAINTENANCE_LOCK:
        if store.vendor in _MAINTENANCE_PROJECTS:
            raise MaintenanceError(f"项目已处于维护模式: {store.vendor}")
        _MAINTENANCE_PROJECTS.add(store.vendor)
    try:
        with project_deletion_lock(store, wait_seconds=2.0):
            with store.locked():
                database = ControlDatabase(store.path / "control_plane.db")
                active = database.latest_resumable_run()
                if active:
                    raise MaintenanceError(
                        f"项目存在活动运行 {active['id']} ({active['status']})，不能进入维护模式"
                    )
                yield
    finally:
        with _MAINTENANCE_LOCK:
            _MAINTENANCE_PROJECTS.discard(store.vendor)


def _excluded(relative: Path) -> bool:
    if any(part in EXCLUDED_DIRS for part in relative.parts):
        return True
    if relative.name in EXCLUDED_NAMES:
        return True
    name = relative.name
    return any(name.endswith(suffix) for suffix in EXCLUDED_SUFFIXES)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_archive_path(value: str) -> PurePosixPath:
    if not value or "\0" in value or "\\" in value:
        raise MaintenanceError("备份包含非法路径")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise MaintenanceError(f"备份路径越界: {value}")
    if any(":" in part for part in path.parts):
        raise MaintenanceError(f"备份路径包含不兼容的盘符或冒号: {value}")
    if path.parts[0] != "project":
        raise MaintenanceError(f"备份载荷必须位于 project/: {value}")
    return path


def _verify_sqlite(path: Path, *, allow_migration: bool = False) -> int:
    if allow_migration:
        ControlDatabase(path)
    uri = f"file:{path.resolve().as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        quick = connection.execute("PRAGMA quick_check").fetchone()
        if quick is None or quick[0] != "ok":
            raise MaintenanceError(f"SQLite quick_check 失败: {quick}")
        foreign = connection.execute("PRAGMA foreign_key_check").fetchall()
        if foreign:
            raise MaintenanceError(f"SQLite 外键检查失败: {len(foreign)}")
        versions = connection.execute("SELECT version FROM schema_meta").fetchall()
        if len(versions) != 1 or int(versions[0][0]) > SCHEMA_VERSION:
            raise MaintenanceError(f"不支持的备份 Schema: {versions}")
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if {"commit_events", "commit_plans"} <= tables:
            for row in connection.execute(
                """
                SELECT e.event_id,e.payload_json,e.payload_sha256,
                       p.plan_json,p.plan_sha256,p.action_count
                FROM commit_events e JOIN commit_plans p ON p.event_id=e.event_id
                """
            ):
                if hashlib.sha256(str(row[1]).encode()).hexdigest() != str(row[2]):
                    raise MaintenanceError(f"提交事件载荷摘要失败: {row[0]}")
                if hashlib.sha256(str(row[3]).encode()).hexdigest() != str(row[4]):
                    raise MaintenanceError(f"提交计划摘要失败: {row[0]}")
                try:
                    action_count = len(json.loads(str(row[3])).get("actions") or [])
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise MaintenanceError(f"提交计划 JSON 损坏: {row[0]}") from exc
                if action_count != int(row[5]):
                    raise MaintenanceError(f"提交计划动作数量不一致: {row[0]}")
        return int(versions[0][0])
    finally:
        connection.close()


def _backup_output_paths(store: ProjectStore, output: Path) -> tuple[Path, Path]:
    output = output.expanduser().resolve()
    try:
        output.relative_to(store.path.resolve())
    except ValueError:
        pass
    else:
        raise MaintenanceError("备份输出不能位于源项目目录内")
    if output.exists():
        raise MaintenanceError(f"备份输出已存在，拒绝覆盖: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_name(f".{output.name}.{uuid4().hex}.tmp")
    return output, temporary_output


def _write_backup_archive(store: ProjectStore, temporary_output: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="sorne-backup-") as temporary:
        staging = Path(temporary) / "project"
        staging.mkdir()
        database_source = store.path / "control_plane.db"
        ControlDatabase(database_source)
        database_target = staging / "control_plane.db"
        source = sqlite3.connect(database_source)
        destination = sqlite3.connect(database_target)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        for source_path in sorted(store.path.rglob("*")):
            relative = source_path.relative_to(store.path)
            if _excluded(relative) or relative == Path("control_plane.db"):
                continue
            if source_path.is_symlink():
                raise MaintenanceError(f"项目包含不允许备份的符号链接: {relative}")
            destination_path = staging / relative
            if source_path.is_dir():
                destination_path.mkdir(parents=True, exist_ok=True)
            elif source_path.is_file():
                destination_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, destination_path)
        files = []
        for path in sorted(item for item in staging.rglob("*") if item.is_file()):
            relative = Path("project") / path.relative_to(staging)
            files.append({
                "path": relative.as_posix(),
                "size": path.stat().st_size,
                "sha256": _sha256_file(path),
            })
        schema_version = _verify_sqlite(database_target)
        snapshot_db = ControlDatabase(database_target)
        event_counts = snapshot_db.commit_event_counts()
        with snapshot_db.connect() as db:
            projector_row = db.execute(
                "SELECT last_projected_sequence FROM projector_meta WHERE id=1"
            ).fetchone()
        manifest = {
            "format": "sorne-backup",
            "format_version": BACKUP_FORMAT_VERSION,
            "vendor": store.vendor,
            "schema_version": schema_version,
            "last_projected_sequence": int(projector_row[0]) if projector_row else 0,
            "commit_event_counts": event_counts,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "files": files,
        }
        with zipfile.ZipFile(temporary_output, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            )
            for entry in files:
                source_path = staging / PurePosixPath(entry["path"]).relative_to("project")
                archive.write(source_path, entry["path"])
        return manifest


def backup_project(vendor: str, output: Path) -> dict[str, Any]:
    vendor = ProjectLocator.validate_vendor(vendor)
    store = ProjectStore(vendor)
    require_initialized_project(store)
    output, temporary_output = _backup_output_paths(store, output)
    try:
        with project_maintenance_barrier(store):
            manifest = _write_backup_archive(store, temporary_output)
        verify_backup(temporary_output)
        os.replace(temporary_output, output)
        return manifest
    finally:
        temporary_output.unlink(missing_ok=True)


def verify_backup(path: Path) -> dict[str, Any]:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise MaintenanceError(f"备份不存在: {path}")
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_BACKUP_ENTRIES:
            raise MaintenanceError("备份文件条目过多")
        names = [info.filename for info in infos]
        if names.count("manifest.json") != 1 or len(names) != len(set(names)):
            raise MaintenanceError("备份 manifest 缺失或存在重复路径")
        manifest_info = next(info for info in infos if info.filename == "manifest.json")
        if manifest_info.is_dir() or manifest_info.file_size > MAX_BACKUP_MANIFEST_BYTES:
            raise MaintenanceError("备份 manifest 类型或体积异常")
        manifest_mode = (manifest_info.external_attr >> 16) & 0xFFFF
        manifest_type = stat.S_IFMT(manifest_mode)
        if manifest_type and manifest_type != stat.S_IFREG:
            raise MaintenanceError("备份 manifest 不是普通文件")
        if (
            manifest_info.compress_size
            and manifest_info.file_size / manifest_info.compress_size > MAX_BACKUP_COMPRESSION_RATIO
        ):
            raise MaintenanceError("备份 manifest 压缩比异常")
        try:
            manifest = json.loads(archive.read(manifest_info))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise MaintenanceError("备份 manifest JSON 损坏") from exc
        if not isinstance(manifest, dict):
            raise MaintenanceError("备份 manifest 必须是对象")
        format_version = manifest.get("format_version")
        if (
            manifest.get("format") != "sorne-backup"
            or isinstance(format_version, bool)
            or not isinstance(format_version, int)
            or format_version != BACKUP_FORMAT_VERSION
        ):
            raise MaintenanceError("不支持的备份格式")
        vendor = ProjectLocator.validate_vendor(manifest.get("vendor"))
        file_rows = manifest.get("files")
        if not isinstance(file_rows, list) or not file_rows:
            raise MaintenanceError("备份 manifest files 必须是非空数组")
        expected: dict[str, dict[str, Any]] = {}
        for item in file_rows:
            if not isinstance(item, dict):
                raise MaintenanceError("备份 manifest 文件记录必须是对象")
            raw_path = item.get("path")
            if not isinstance(raw_path, str):
                raise MaintenanceError("备份 manifest 文件路径非法")
            archive_path = _safe_archive_path(raw_path)
            normalized = archive_path.as_posix()
            if normalized != raw_path or normalized in expected:
                raise MaintenanceError(f"备份 manifest 包含重复或非规范路径: {raw_path}")
            size = item.get("size")
            if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                raise MaintenanceError(f"备份 manifest 文件大小非法: {raw_path}")
            digest = item.get("sha256")
            if not isinstance(digest, str) or len(digest) != 64:
                raise MaintenanceError(f"备份 manifest SHA-256 非法: {raw_path}")
            try:
                int(digest, 16)
            except ValueError as exc:
                raise MaintenanceError(f"备份 manifest SHA-256 非法: {raw_path}") from exc
            expected[normalized] = {**item, "sha256": digest.casefold()}
        missing_required = sorted(REQUIRED_BACKUP_FILES - set(expected))
        if missing_required:
            raise MaintenanceError(f"备份缺少必需文件: {', '.join(missing_required)}")
        payload_names = {name for name in names if name != "manifest.json" and not name.endswith("/")}
        if payload_names != set(expected):
            raise MaintenanceError("备份 manifest 与载荷文件不一致")

        total = manifest_info.file_size
        normalized_paths: set[str] = set()
        target_json = bytearray()
        with tempfile.TemporaryDirectory(prefix="sorne-verify-") as temporary:
            database_copy = Path(temporary) / "control_plane.db"
            for info in infos:
                if info.filename == "manifest.json" or info.is_dir():
                    continue
                archive_path = _safe_archive_path(info.filename)
                normalized = archive_path.as_posix()
                if normalized != info.filename or normalized in normalized_paths:
                    raise MaintenanceError(f"备份包含重复或非规范路径: {archive_path}")
                normalized_paths.add(normalized)
                mode = (info.external_attr >> 16) & 0xFFFF
                file_type = stat.S_IFMT(mode)
                if file_type and file_type != stat.S_IFREG:
                    raise MaintenanceError(f"备份包含非普通文件: {archive_path}")
                if info.file_size > MAX_BACKUP_FILE_BYTES:
                    raise MaintenanceError(f"备份单文件过大: {archive_path}")
                if info.compress_size and info.file_size / info.compress_size > MAX_BACKUP_COMPRESSION_RATIO:
                    raise MaintenanceError(f"备份压缩比异常: {archive_path}")
                total += info.file_size
                if total > MAX_BACKUP_EXPANDED_BYTES:
                    raise MaintenanceError("备份展开体积超过限制")
                entry = expected[normalized]
                if info.file_size != int(entry["size"]):
                    raise MaintenanceError(f"备份文件体积与 manifest 不一致: {archive_path}")
                database_sink = (
                    database_copy.open("xb")
                    if normalized == "project/control_plane.db"
                    else nullcontext()
                )
                digest = hashlib.sha256()
                count = 0
                with database_sink as sink, archive.open(info) as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        count += len(chunk)
                        if count > info.file_size or count > MAX_BACKUP_FILE_BYTES:
                            raise MaintenanceError(f"备份文件体积异常: {archive_path}")
                        digest.update(chunk)
                        if sink is not None:
                            sink.write(chunk)
                        if normalized == "project/target.json":
                            if count > MAX_TARGET_JSON_BYTES:
                                raise MaintenanceError("备份 target.json 体积异常")
                            target_json.extend(chunk)
                if count != int(entry["size"]) or digest.hexdigest() != str(entry["sha256"]):
                    raise MaintenanceError(f"备份摘要校验失败: {archive_path}")
            try:
                target = json.loads(target_json.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise MaintenanceError("备份 target.json 损坏") from exc
            if not isinstance(target, dict) or str(target.get("vendor") or "") != vendor:
                raise MaintenanceError("备份 target.json 与 manifest 项目不一致")
            schema_version = _verify_sqlite(database_copy)
            manifest_schema = manifest.get("schema_version")
            if (
                isinstance(manifest_schema, bool)
                or not isinstance(manifest_schema, int)
                or manifest_schema != schema_version
            ):
                raise MaintenanceError("备份 manifest 与 SQLite Schema 不一致")
        return manifest


def restore_backup(path: Path, *, confirm_vendor: str, replace: bool = False) -> Path:
    manifest = verify_backup(path)
    vendor = ProjectLocator.validate_vendor(manifest.get("vendor"))
    if ProjectLocator.validate_vendor(confirm_vendor) != vendor:
        raise MaintenanceError("恢复确认名称与备份项目不一致")
    root = store_module.PROJECTS.resolve()
    root.mkdir(parents=True, exist_ok=True)
    target = root / vendor
    if target.exists() and not replace:
        raise MaintenanceError("项目已存在；替换恢复必须显式使用 --replace")
    staging = root / f".restoring-{vendor}-{uuid4().hex}"
    quarantine = root / f".restore-old-{vendor}-{uuid4().hex}"
    staging.mkdir()
    try:
        with zipfile.ZipFile(path) as archive:
            expected = {str(item["path"]): item for item in manifest["files"]}
            for info in archive.infolist():
                if info.filename == "manifest.json" or info.is_dir():
                    continue
                safe = _safe_archive_path(info.filename)
                relative = Path(*safe.parts[1:])
                destination = staging / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                count = 0
                with archive.open(info) as source, destination.open("xb") as sink:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        count += len(chunk)
                        if count > int(expected[info.filename]["size"]):
                            raise MaintenanceError(f"恢复文件体积异常: {safe}")
                        digest.update(chunk)
                        sink.write(chunk)
                    sink.flush()
                    os.fsync(sink.fileno())
                if digest.hexdigest() != expected[info.filename]["sha256"]:
                    raise MaintenanceError(f"恢复文件摘要异常: {safe}")
        database_path = staging / "control_plane.db"
        target_path = staging / "target.json"
        if not database_path.is_file() or not target_path.is_file():
            raise MaintenanceError("恢复载荷缺少 target.json 或 control_plane.db")
        _verify_sqlite(database_path, allow_migration=True)
        for json_file in staging.rglob("*.json"):
            json.loads(json_file.read_text(encoding="utf-8"))
        for jsonl_file in staging.rglob("*.jsonl"):
            for number, line in enumerate(jsonl_file.read_text(encoding="utf-8").splitlines(), 1):
                if line.strip():
                    try:
                        json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise MaintenanceError(f"JSONL 损坏: {jsonl_file.name}:{number}") from exc
        if target.exists():
            store = ProjectStore(vendor)
            barrier = project_maintenance_barrier(store)
        else:
            barrier = nullcontext()
        with barrier:
            if target.exists():
                target.rename(quarantine)
            try:
                staging.rename(target)
            except Exception:
                if quarantine.exists() and not target.exists():
                    quarantine.rename(target)
                raise
            if quarantine.exists():
                shutil.rmtree(quarantine)
            directory_fd = os.open(root, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        return target
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        if quarantine.exists() and not target.exists():
            quarantine.rename(target)
        raise


def rebuild_projections(vendor: str) -> int:
    vendor = ProjectLocator.validate_vendor(vendor)
    store = ProjectStore(vendor)
    require_initialized_project(store)
    with project_maintenance_barrier(store):
        projected = Projector(store).recover()
        from .dashboard import render_dashboard

        render_dashboard(store)
        return projected


def archive_project(vendor: str, output: Path, *, confirm_vendor: str) -> dict[str, Any]:
    vendor = ProjectLocator.validate_vendor(vendor)
    if ProjectLocator.validate_vendor(confirm_vendor) != vendor:
        raise MaintenanceError("归档确认名称不匹配")
    store = ProjectStore(vendor)
    require_initialized_project(store)
    output, temporary_output = _backup_output_paths(store, output)
    try:
        with project_maintenance_barrier(store):
            manifest = _write_backup_archive(store, temporary_output)
            verify_backup(temporary_output)
            os.replace(temporary_output, output)
            shutil.rmtree(store.path)
        return manifest
    finally:
        temporary_output.unlink(missing_ok=True)
