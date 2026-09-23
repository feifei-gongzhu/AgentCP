"""Docker 安全基线参数的公共构造（实施规格 6.5）。

三条容器路径（ContainerWorkerDriver、LocalDocker 主执行、compatibility
Bash）共用同一安全基线；资源参数与挂载需求由 Adapter 显式提供，每条路径
的挂载差异必须显式表达——不默认挂宿主目录、不放宽只读目标。
"""

from __future__ import annotations


def docker_base_args(
    *,
    network: str = "none",
    cpus: object = "2",
    memory: object = "2g",
    pids_limit: object = 256,
    interactive: bool = False,
) -> list[str]:
    """安全基线：--rm/--init/资源上限/no-new-privileges/cap-drop ALL。

    ``interactive=True`` 在 ``--init`` 后插入 ``-i``（local-docker 主执行
    需要向容器内 CLI 转发 stdin），保持与历史命令完全相同的参数顺序。
    """
    args = ["run", "--rm", "--init"]
    if interactive:
        args.append("-i")
    args.extend([
        "--network", str(network),
        "--cpus", str(cpus),
        "--memory", str(memory),
        "--pids-limit", str(pids_limit),
        "--security-opt", "no-new-privileges:true",
        "--cap-drop", "ALL",
    ])
    return args


def bind_mount(source: object, target: str, mode: str) -> str:
    """One explicit bind-mount spec; mode must be a conscious 'ro'/'rw'."""
    if mode not in {"ro", "rw"}:
        raise ValueError(f"非法挂载模式: {mode}")
    return f"{source}:{target}:{mode}"
