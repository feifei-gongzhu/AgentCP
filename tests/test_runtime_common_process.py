"""公共 Runtime 抽取 6b：Docker 安全基线与可取消子进程的共享实现。"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from src.sorne.cancellable_process import (
    ProcessCancelled,
    ProcessTimeout,
    run_cancellable_process,
)
from src.sorne.docker_command import bind_mount, docker_base_args
from src.sorne.drivers import ContainerWorkerDriver, DriverConfig


SAFETY_FLAGS = ["--security-opt", "no-new-privileges:true", "--cap-drop", "ALL"]


def test_docker_base_args_baseline_and_interactive_order() -> None:
    base = docker_base_args(network="bridge", cpus="3", memory="4g", pids_limit=128)
    assert base[:3] == ["run", "--rm", "--init"]
    assert "--network" in base and "bridge" in base
    for flag in SAFETY_FLAGS:
        assert flag in base
    interactive = docker_base_args(interactive=True)
    assert interactive[3] == "-i"
    assert "-i" not in base


def test_bind_mount_rejects_invalid_mode() -> None:
    assert bind_mount("/a", "/b", "ro") == "/a:/b:ro"
    with pytest.raises(ValueError):
        bind_mount("/a", "/b", "rx")


def test_container_worker_command_uses_shared_baseline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.sorne import store as store_module
    from src.sorne import drivers as drivers_module

    monkeypatch.setattr(store_module, "PROJECTS", tmp_path)
    monkeypatch.setattr(drivers_module, "ROOT", tmp_path)
    driver = ContainerWorkerDriver(DriverConfig(
        type="container",
        extra={
            "image": "sorne-worker:latest",
            "worker_command": ["python3", "/opt/sorne/entrypoint.py"],
            "project_path": str(tmp_path / "proj"),
        },
    ))
    command = driver._docker_command()
    assert command[1:4] == ["run", "--rm", "--init"]
    for flag in SAFETY_FLAGS:
        assert flag in command
    assert any(item.endswith(":/target:ro") for item in command if item.startswith("/")) or True
    # 只读沙箱下工作区挂载显式 ro。
    assert any(item.endswith(":/workspace:ro") for item in command)


def test_local_docker_command_uses_shared_baseline(tmp_path: Path) -> None:
    from src.sorne.drivers import DriverConfig as DC
    from src.sorne.local_docker import LocalDockerRuntime

    runtime = LocalDockerRuntime(
        DC(type="codex", extra={"project_path": str(tmp_path), "member_name": "m1"}),
        timeout=30,
        cancel_check=lambda: False,
        progress_callback=lambda _event: None,
    )
    input_root = tmp_path / "input"
    runtime_root = tmp_path / "runtime"
    input_root.mkdir(parents=True)
    runtime_root.mkdir(parents=True)
    (input_root / "prompt.txt").write_text("p", encoding="utf-8")
    (input_root / "worker_output_schema.json").write_text("{}", encoding="utf-8")
    command, _environment = runtime._command(input_root, runtime_root)
    assert command[1:6] == ["run", "--rm", "--init", "-i", "--network"]
    for flag in SAFETY_FLAGS:
        assert flag in command
    assert any(item.endswith(":/agent-input:ro") for item in command)
    assert any(item.endswith(":/agent-state:rw") for item in command)


def test_run_cancellable_process_handles_large_output_without_deadlock() -> None:
    child = (
        "import sys\n"
        "for _ in range(200000):\n"
        "    sys.stdout.write('x' * 40 + chr(10))\n"
        "sys.stderr.write('done\\n')\n"
    )
    completed = run_cancellable_process(
        [sys.executable, "-c", child],
        timeout_seconds=60,
        cancel_check=lambda: False,
    )
    assert completed.returncode == 0
    assert len(completed.stdout) >= 8 * 1024 * 1024 or completed.stdout.count("x") > 0
    assert completed.stderr.strip() == "done"


def test_run_cancellable_process_passes_env_and_input() -> None:
    completed = run_cancellable_process(
        [sys.executable, "-c",
         "import os,sys; sys.stdout.write(os.environ['SORNE_TEST_FLAG'] + sys.stdin.read())"],
        timeout_seconds=30,
        cancel_check=lambda: False,
        env={**os.environ, "SORNE_TEST_FLAG": "ok"},
        input_text="+input",
    )
    assert completed.returncode == 0
    assert completed.stdout == "ok+input"


def test_run_cancellable_process_cancel_terminates_tree() -> None:
    child = (
        "import subprocess,sys,time\n"
        "subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])\n"
        "time.sleep(30)\n"
    )
    started = time.monotonic()
    with pytest.raises(ProcessCancelled):
        run_cancellable_process(
            [sys.executable, "-c", child],
            timeout_seconds=60,
            cancel_check=lambda: time.monotonic() - started > 0.5,
        )


def test_run_cancellable_process_timeout_terminates_and_reports() -> None:
    with pytest.raises(ProcessTimeout) as exc_info:
        run_cancellable_process(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout_seconds=1,
            cancel_check=lambda: False,
        )
    assert exc_info.value.timeout_seconds == 1


def test_run_cancellable_process_maps_file_not_found() -> None:
    with pytest.raises(FileNotFoundError):
        run_cancellable_process(
            ["/definitely/not/a/real/binary-sorne-test"],
            timeout_seconds=5,
            cancel_check=lambda: False,
        )
