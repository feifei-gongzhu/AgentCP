"""批处理扫描的逐目标状态账本（实施方案 §8.3 恢复语义）。

引擎不支持续跑时（fscan/nuclei 均如此），适配层按**目标粒度**持久化完成
状态：崩溃/取消后重启，只对未完成且可安全重试的目标重跑（restart_remaining），
已完成目标不因 UI 重开而重扫。目标内执行到一半被打断的（外部请求是否
生效不明）按 unknown_outcome 处理——只读动作允许重试，但重试会被显式
记录在批次账本里，不冒充 exactly-once。

状态文件在项目 ``.sorne-work/scan_batches/<tool>/<digest>.json``；同一
参数摘要（tool_id + 规范化参数）复用同一批次。文件写入原子（临时文件 +
rename），并发同批次由调用方（网关单线程执行）保证。
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from ..schemas import now_iso


def arguments_digest(tool_id: str, arguments: dict[str, Any]) -> str:
    payload = json.dumps(
        {"tool": tool_id, "args": arguments}, ensure_ascii=False, sort_keys=True, default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


class ScanBatch:
    """一次批处理扫描的逐目标状态（§8.3：批处理保存逐目标完成状态）。"""

    def __init__(self, store, tool_id: str, digest: str, targets: list[str]) -> None:
        self.store = store
        self.tool_id = tool_id
        self.digest = digest
        path = store.path / ".sorne-work" / "scan_batches" / tool_id / f"{digest}.json"
        self.path = path
        self.record: dict[str, Any] = self._load()
        self.record.setdefault("tool_id", tool_id)
        self.record.setdefault("targets", {str(t): "pending" for t in targets})
        self.record.setdefault("target_summaries", {})
        self.record.setdefault("runs", [])
        self.record.setdefault("created_at", now_iso())
        # 崩溃恢复（§8.3）：账本由网关单线程驱动，加载时仍处于 running 的
        # 目标说明上一个进程中途死亡（正常取消/中断路径都会先改状态）——
        # 归为 unknown_outcome，只读动作允许重试。
        self.record["targets"] = {
            target: ("unknown_outcome" if status == "running" else status)
            for target, status in self.record["targets"].items()
        }

    def _load(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(self.record, handle, ensure_ascii=False, indent=1)
            os.replace(tmp_name, self.path)
        except OSError:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
            raise

    def status_of(self, target: str) -> str:
        return str(self.record["targets"].get(str(target)) or "pending")

    def remaining_targets(self) -> list[str]:
        """未完成且可安全重试的目标（§8.3 restart_remaining）。

        ``unknown_outcome``（目标执行中途被打断，外部请求是否生效不明）也
        返回重试：本仓库的采集类工具全部是只读探测（GET/HEAD/DNS 解析），
        只读动作按策略允许重试；有副作用的口令验证类工具由自身适配层在
        逐凭据粒度上另行处理，不进入本通用路径。
        """
        return [
            target for target, status in self.record["targets"].items()
            if status in {"pending", "unknown_outcome"}
        ]

    def mark(self, target: str, status: str, summary: dict[str, Any] | None = None) -> None:
        if status not in {"pending", "running", "completed", "failed", "cancelled", "unknown_outcome"}:
            raise ValueError(f"非法批次状态: {status}")
        self.record["targets"][str(target)] = status
        if summary is not None:
            self.record["target_summaries"][str(target)] = summary
        self.record["updated_at"] = now_iso()
        self.save()

    def begin_run(self, note: str) -> None:
        self.record["runs"].append({"started_at": now_iso(), "note": note[:300]})
        self.save()

    def note_interrupted(self, running_targets: list[str]) -> None:
        """进程被取消/崩溃时把执行中的目标标为 unknown_outcome。"""
        for target in running_targets:
            if self.status_of(target) == "running":
                self.record["targets"][str(target)] = "unknown_outcome"
        self.save()

    def summary(self) -> dict[str, Any]:
        targets = self.record["targets"]
        return {
            "batch_id": self.digest,
            "batch_path": self.path.relative_to(self.store.path).as_posix(),
            "total": len(targets),
            "completed": sum(1 for s in targets.values() if s == "completed"),
            "failed": sum(1 for s in targets.values() if s == "failed"),
            "unknown_outcome": sum(1 for s in targets.values() if s == "unknown_outcome"),
            "pending": sum(1 for s in targets.values() if s == "pending"),
        }
