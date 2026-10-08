"""引擎适配层（实施方案 §6.5-6.6）。

每个引擎一个适配模块：固定 argv 执行（无 shell 拼接）、结构化结果解析、
请求/响应证据落盘、取消与超时。导入本包即向 ``tool_registry`` 登记各引擎
能力的运行时可用性提供者（Docker/镜像缺失 → capability_missing）。

- ``nuclei_adapter``：poc_scan（P2，docker 镜像）。
- ``fscan_adapter``：url_scan / ip_scan（P3，docker 镜像；侦察用途固定
  ``-nobr -nopoc``，不越权执行 crack/poc 类动作）。
- ``web_collect``：dir_scan / js_scan / subdomain_scan（P3，原生受控
  HTTP/DNS 实现——字典与 JS 线索规则来自资源仓库 §7.2）。
- ``pwdcrack_adapter``：pwd_crack（P3，原生凭据验证；凭据走秘密引用，
  明文不落任何记录）。
"""

from __future__ import annotations

from ..tool_registry import register_engine_availability
from . import fscan_adapter, nuclei_adapter, pwdcrack_adapter, web_collect

register_engine_availability("poc_scan", nuclei_adapter.availability_status)
register_engine_availability("url_scan", fscan_adapter.availability_status)
register_engine_availability("ip_scan", fscan_adapter.availability_status)
register_engine_availability("subdomain_scan", web_collect.native_availability)
register_engine_availability("dir_scan", web_collect.native_availability)
register_engine_availability("js_scan", web_collect.native_availability)
register_engine_availability("pwd_crack", pwdcrack_adapter.native_availability)


def engine_adapter_status() -> dict:
    """全部引擎适配器的可用性快照（诊断/UI 用）。"""
    return {
        "poc_scan": nuclei_adapter.describe_status(),
        "url_scan": fscan_adapter.describe_status(),
        "ip_scan": fscan_adapter.describe_status(),
        "subdomain_scan": {
            "adapter": "sorne-native-dns-subdomain",
            "available": True,
            "reason": "",
        },
        "dir_scan": {
            "adapter": "sorne-native-dir-collect",
            "available": True,
            "reason": "",
        },
        "js_scan": {
            "adapter": "sorne-native-js-collect",
            "available": True,
            "reason": "",
        },
        "pwd_crack": {
            "adapter": "sorne-native-credential-check",
            "available": True,
            "reason": "",
        },
    }
