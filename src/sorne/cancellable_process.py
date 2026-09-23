"""可取消/超时子进程执行的共享实现（实施规格 6.6）。

以 drivers 的 ``_run_cancellable`` 为基座：stdin 写入、stdout/stderr 双流
消费（带保留上限防大输出死锁）、超时、取消、进程树终止、返回码与诊断、
流式回调与现有平台差异（process_group_options）全部保留。

调用方把 ``ProcessCancelled``/``ProcessTimeout`` 包装成各自的业务异常
（消息前缀不同）；原始 FileNotFoundError/OSError 同样由调用方翻译为可操
作的错误信息。
"""

from __future__ import annotations

import subprocess
import threading
import time
from typing import Callable

from .platform_process import process_group_options, terminate_process_tree


class ProcessCancelled(RuntimeError):
    pass


class ProcessTimeout(RuntimeError):
    def __init__(self, timeout_seconds: int):
        super().__init__(f"subprocess timed out after {timeout_seconds}s")
        self.timeout_seconds = timeout_seconds


STDOUT_RETAIN_LIMIT = 8 * 1024 * 1024
STDERR_RETAIN_LIMIT = 1024 * 1024


def run_cancellable_process(
    cmd: list[str],
    *,
    timeout_seconds: int,
    cancel_check: Callable[[], bool],
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    input_text: str | None = None,
    line_callback: Callable[[str], None] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run one subprocess with bounded output, cancellation and tree-kill."""
    try:
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
            cwd=cwd,
            **process_group_options(),
        )
    except FileNotFoundError:
        raise
    except OSError:
        raise

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def read_stdout() -> None:
        if process.stdout is None:
            return
        retained = 0
        for line in iter(process.stdout.readline, ""):
            if retained < STDOUT_RETAIN_LIMIT:
                stdout_lines.append(line)
                retained += len(line)
            if line_callback is not None:
                try:
                    line_callback(line)
                except Exception:
                    continue

    def read_stderr() -> None:
        if process.stderr is None:
            return
        retained = 0
        for line in iter(process.stderr.readline, ""):
            if retained < STDERR_RETAIN_LIMIT:
                stderr_lines.append(line)
                retained += len(line)

    reader_threads = [
        threading.Thread(target=read_stdout, daemon=True),
        threading.Thread(target=read_stderr, daemon=True),
    ]
    for reader in reader_threads:
        reader.start()

    prompt_delivery_failed = threading.Event()
    writer: threading.Thread | None = None
    if input_text is not None and process.stdin is not None:
        def write_stdin() -> None:
            try:
                assert process.stdin is not None
                process.stdin.write(input_text)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                prompt_delivery_failed.set()
                try:
                    process.stdin.close()
                except (BrokenPipeError, OSError):
                    pass

        writer = threading.Thread(target=write_stdin, daemon=True)
        writer.start()

    deadline = time.monotonic() + timeout_seconds
    while process.poll() is None:
        if cancel_check():
            terminate_process_tree(process)
            raise ProcessCancelled("cancelled by scheduler")
        if time.monotonic() >= deadline:
            terminate_process_tree(process)
            raise ProcessTimeout(timeout_seconds)
        time.sleep(0.2)
    if writer is not None:
        writer.join(timeout=2)
    for reader in reader_threads:
        reader.join(timeout=2)
    stdout = "".join(stdout_lines)
    stderr = "".join(stderr_lines)
    if prompt_delivery_failed.is_set() and process.returncode == 0:
        return subprocess.CompletedProcess(
            cmd, 1, stdout, "模型子进程在接收 Prompt 前已退出\n" + stderr,
        )
    return subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)
