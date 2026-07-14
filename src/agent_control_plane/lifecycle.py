from __future__ import annotations

import hashlib
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator

from .store import ProjectStore


_WINDOWS_EXECUTION_SLOTS = 256


class ProjectLifecycleBusy(RuntimeError):
    """Raised when a project is still owned by an active execution process."""


class ProjectLifecycleMissing(RuntimeError):
    """Raised when an execution targets a project that was never created or was deleted."""


def require_initialized_project(store: ProjectStore) -> None:
    vendor = str(store.vendor or "")
    path = store.path
    invalid_vendor = (
        not vendor
        or len(vendor) > 80
        or vendor in {".", ".."}
        or vendor.startswith(".")
        or any(char in vendor for char in ("/", "\\", "\0"))
        or not all(char.isalnum() or char in {"-", "_", "."} for char in vendor)
    )
    target = path / "target.json"
    if (
        invalid_vendor
        or path.is_symlink()
        or not path.is_dir()
        or target.is_symlink()
        or not target.is_file()
    ):
        raise ProjectLifecycleMissing(f"项目不存在或尚未初始化: {vendor}")


def _lock_path(store: ProjectStore) -> Path:
    lock_root = store.path.parent / ".lifecycle-locks"
    lock_root.mkdir(parents=True, exist_ok=True)
    identity = hashlib.sha256(str(store.path.resolve()).encode("utf-8")).hexdigest()
    return lock_root / f"{identity}.lock"


def _prepare_windows_lock_file(file: BinaryIO) -> None:
    file.seek(0, os.SEEK_END)
    missing = (_WINDOWS_EXECUTION_SLOTS + 1) - file.tell()
    if missing > 0:
        file.write(b"\0" * missing)
        file.flush()


def _acquire(file: BinaryIO, *, exclusive: bool, blocking: bool) -> tuple[int, int]:
    if os.name == "nt":
        import msvcrt

        _prepare_windows_lock_file(file)
        if exclusive:
            file.seek(1)
            mode = msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK
            msvcrt.locking(file.fileno(), mode, _WINDOWS_EXECUTION_SLOTS)
            return (1, _WINDOWS_EXECUTION_SLOTS)

        while True:
            for offset in range(1, _WINDOWS_EXECUTION_SLOTS + 1):
                file.seek(offset)
                try:
                    msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                    return (offset, 1)
                except OSError:
                    continue
            if not blocking:
                raise BlockingIOError("没有可用的项目执行锁槽位")
            time.sleep(0.05)

    import fcntl

    mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    if not blocking:
        mode |= fcntl.LOCK_NB
    fcntl.flock(file.fileno(), mode)
    return (0, 0)


def _release(file: BinaryIO, token: tuple[int, int]) -> None:
    if os.name == "nt":
        import msvcrt

        offset, length = token
        file.seek(offset)
        msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, length)
        return

    import fcntl

    fcntl.flock(file.fileno(), fcntl.LOCK_UN)


@contextmanager
def project_execution_lock(store: ProjectStore) -> Iterator[None]:
    """Hold a cross-process execution lease while agents can touch the project."""

    path = _lock_path(store)
    with path.open("a+b") as file:
        token = _acquire(file, exclusive=False, blocking=True)
        try:
            yield
        finally:
            _release(file, token)


@contextmanager
def project_deletion_lock(store: ProjectStore) -> Iterator[None]:
    """Acquire exclusive ownership without waiting for external workers."""

    path = _lock_path(store)
    with path.open("a+b") as file:
        try:
            token = _acquire(file, exclusive=True, blocking=False)
        except (BlockingIOError, OSError) as exc:
            raise ProjectLifecycleBusy("项目仍被另一个 Agent/CLI 进程使用") from exc
        try:
            yield
        finally:
            _release(file, token)
