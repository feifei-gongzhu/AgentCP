"""引擎适配层（实施方案 §6.5-6.6）。

每个引擎一个适配模块：固定 argv 执行（无 shell 拼接）、结构化结果解析、
请求/响应证据落盘、取消与超时。导入本包即向 ``tool_registry`` 登记各引擎
能力的运行时可用性提供者（Docker/镜像缺失 → capability_missing）。
"""

from __future__ import annotations

from ..tool_registry import register_engine_availability
from . import nuclei_adapter

register_engine_availability("poc_scan", nuclei_adapter.availability_status)


def engine_adapter_status() -> dict:
    """全部引擎适配器的可用性快照（诊断/UI 用）。"""
    return {
        "poc_scan": nuclei_adapter.describe_status(),
    }
