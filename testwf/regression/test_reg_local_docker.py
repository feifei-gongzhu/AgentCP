from __future__ import annotations

"""已知未修缺陷的回归用例：local_docker OpenAI 工具兼容执行路径。

历史问题：src/sorne/local_docker.py:_run_compatibility_bash 在构造返回值时
引用了未定义变量 ``process``（正确变量名是 ``completed``，见函数内
``completed = run_cancellable_process(...)``）。一旦 Grok 兼容模式的
Worker 调用 bash 工具并成功拿到容器输出，最后一行 ``process.returncode``
就会抛 NameError，把一次正常的工具执行变成调度器眼中的模型运行时故障。
"""

import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.sorne import local_docker as local_docker_module
from src.sorne.local_docker import LocalDockerRuntime


def _bare_runtime(project_root: Path) -> LocalDockerRuntime:
    """绕过 __init__ 的配置解析，直接装配 _run_compatibility_bash 需要的属性。"""
    runtime = object.__new__(LocalDockerRuntime)
    runtime.profile = SimpleNamespace(
        sandbox="read-only",
        project_path=project_root,
        api_key="sk-test-only-key",
        target_path=None,
    )
    runtime.config = SimpleNamespace(extra={})
    runtime.timeout = 60
    runtime.cancel_check = lambda: False
    runtime.progress_callback = lambda event: None
    return runtime


@pytest.mark.parametrize("returncode", [0, 3])
def test_run_compatibility_bash_maps_returncode_to_is_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    returncode: int,
) -> None:
    """守护点：bash 工具执行完成后必须正常返回 (output, is_error)。

    直接调用 _run_compatibility_bash，mock run_cancellable_process 返回
    假 CompletedProcess：is_error 必须由真实容器退出码推导（0→False，
    非 0→True），输出必须包含退出码与 stdout/stderr。当前实现最后一行
    引用未定义变量 process，抛 NameError——本用例固化该缺陷，修复后应转绿。
    """
    project_root = tmp_path / "proj"
    project_root.mkdir(parents=True)
    runtime = _bare_runtime(project_root)

    # 不依赖本机是否安装 Docker：CLI 路径解析与容器执行全部 mock。
    monkeypatch.setattr(local_docker_module, "find_docker_binary", lambda: "/usr/bin/docker")
    fake_completed = subprocess.CompletedProcess(
        args=["docker"],
        returncode=returncode,
        stdout="probe-result-line\n",
        stderr="warn-line\n",
    )
    observed: dict = {}

    def fake_run_cancellable_process(command, **kwargs):
        observed["command"] = list(command)
        return fake_completed

    monkeypatch.setattr(
        local_docker_module, "run_cancellable_process", fake_run_cancellable_process,
    )

    output, is_error = runtime._run_compatibility_bash(
        "nmap -sV https://example.com",
        image="sorne-guest:latest",
        runtime_root=tmp_path / "runtime",
        deadline=time.monotonic() + 30,
    )

    # 命令确实是 docker run 兼容执行（--entrypoint /bin/sh）。
    assert observed["command"][:1] == ["/usr/bin/docker"]
    assert "--entrypoint" in observed["command"]
    assert observed["command"][observed["command"].index("--entrypoint") + 1] == "/bin/sh"
    # 输出包含退出码与两侧流，且不泄露 API Key。
    assert f"exit_code={returncode}" in output
    assert "probe-result-line" in output
    assert "warn-line" in output
    assert "sk-test-only-key" not in output
    # 核心守护语义：错误标志跟随真实退出码，而不是抛 NameError。
    assert is_error is (returncode != 0)
