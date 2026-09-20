from __future__ import annotations

import ctypes
import os
import signal
import subprocess
from pathlib import Path
from typing import Any


def process_group_options() -> dict[str, Any]:
    """Return Popen flags for a process tree AgentCP can later terminate."""

    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def terminate_process_tree(process: subprocess.Popen[Any], timeout: float = 3.0) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=max(1.0, timeout),
                check=False,
            )
        else:
            os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=timeout)
    except (OSError, ProcessLookupError, PermissionError):
        return


def windows_process_image(pid: int) -> Path | None:
    """Resolve a Windows process executable without shelling out to WMIC/ps."""

    if os.name != "nt" or pid <= 0:
        return None
    process_query_limited_information = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(
        process_query_limited_information, False, pid,
    )
    if not handle:
        return None
    try:
        capacity = 32768
        buffer = ctypes.create_unicode_buffer(capacity)
        size = ctypes.c_ulong(capacity)
        if not ctypes.windll.kernel32.QueryFullProcessImageNameW(
            handle, 0, buffer, ctypes.byref(size),
        ):
            return None
        return Path(buffer.value)
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def process_matches_executable(pid: int, executable: Path) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        image = windows_process_image(pid)
        if image is None:
            return False
        try:
            return image.resolve() == executable.resolve()
        except OSError:
            return str(image).casefold() == str(executable).casefold()
    try:
        os.kill(pid, 0)
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            text=True,
            capture_output=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return str(executable) in result.stdout.strip()


def terminate_pid_tree(pid: int, executable: Path) -> None:
    if not process_matches_executable(pid, executable):
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        return
