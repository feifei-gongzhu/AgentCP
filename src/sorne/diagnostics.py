"""诊断文本截断（head+tail 保尾）的共享实现。

模型 CLI 常在真正的传输/运行时错误前打印很长的工具转录；只保留头部会
掩盖可定位原因。统一保留头部一小段 + 省略标记 + 尾部（ actionable 原因
通常在末尾）。
"""

from __future__ import annotations


def compact_diagnostic(text: str, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    # 统一标记采用双语（历史上 automation 用中文、local-docker 用英文，
    # 两处持久化错误都有消费方按各自文案识别）。
    marker = f"\n... [omitted {len(text) - limit} diagnostic characters | 省略 {len(text) - limit} 个诊断字符] ...\n"
    head_size = min(900, max(0, limit - len(marker)))
    tail_size = max(0, limit - len(marker) - head_size)
    return text[:head_size] + marker + text[-tail_size:]
