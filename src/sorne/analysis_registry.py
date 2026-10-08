"""独立 AI 研判层注册表（实施方案 §7A.1-7A.2；P0-契约设计 §3.5）。

三个分析器（POC/目录/JS）各自具有独立的 Prompt、输入输出 Schema、版本、
配置与运行状态。研判层是独立服务能力，不是第八个团队角色，也不冒用
reviewer 提示词（方案 §7A.1）。

P2 交付范围：服务骨架 + POC 分析器真实运行；目录/JS 分析器的注册项与
Prompt 已就位，但它们的触发源（dir_scan/js_scan 引擎）在 P3 接入——
在此之前 enqueue 会明确说明“暂无触发源”，不伪造分析结果。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .schemas import now_iso


ANALYZER_PROMPTS_DIR = Path(__file__).resolve().parent / "analyzer_prompts"

ANALYZER_KINDS = ("poc", "directory", "js")

ANALYSIS_SCHEMA_VERSION = 1

# 候选判断状态（与 confirmed 漏洞状态严格分开，方案 §7A.2 硬规则 2）
CANDIDATE_ASSESSMENTS = (
    "supported", "suspected_false_positive", "insufficient_evidence",
)

ANALYSIS_JOB_STATUSES = ("queued", "running", "completed", "failed", "cancelled")


@dataclass(frozen=True)
class AnalyzerSpec:
    kind: str
    title: str
    prompt_file: str
    prompt_version: str
    enabled: bool
    description: str
    trigger_tools: tuple[str, ...]  # 结果落盘后自动入队的来源工具
    available_from_phase: str

    def prompt_text(self) -> str:
        path = ANALYZER_PROMPTS_DIR / self.prompt_file
        if not path.is_file():
            raise FileNotFoundError(f"分析器 Prompt 缺失: {path}")
        return path.read_text(encoding="utf-8")

    def meta(self) -> dict[str, Any]:
        return {
            "analyzer_kind": self.kind,
            "title": self.title,
            "prompt_version": self.prompt_version,
            "schema_version": ANALYSIS_SCHEMA_VERSION,
            "enabled": self.enabled,
            "trigger_tools": list(self.trigger_tools),
            "available_from_phase": self.available_from_phase,
            "description": self.description,
        }


ANALYZERS: dict[str, AnalyzerSpec] = {
    spec.kind: spec
    for spec in (
        AnalyzerSpec(
            kind="poc",
            title="POC 研判",
            prompt_file="poc.md",
            prompt_version="poc-analyzer-v1",
            enabled=True,
            description=(
                "区分引擎声称命中与证据实际支持：解释命中、指出缺失的对照、"
                "环境不匹配、疑似误报与下一步补证据项。"
            ),
            trigger_tools=("poc_scan",),
            available_from_phase="P2",
        ),
        AnalyzerSpec(
            kind="directory",
            title="目录研判",
            prompt_file="directory.md",
            prompt_version="directory-analyzer-v1",
            enabled=True,
            description=(
                "分辨真实入口、统一错误页、登录跳转、catch-all 与重复内容；"
                "给出入口用途与值得验证的线索。"
            ),
            trigger_tools=("dir_scan",),  # dir_scan 引擎 P3 接入
            available_from_phase="P3",
        ),
        AnalyzerSpec(
            kind="js",
            title="JS 研判",
            prompt_file="js.md",
            prompt_version="js-analyzer-v1",
            enabled=True,
            description=(
                "区分实际观察与推断的 API、认证线索、疑似敏感信息与来源映射；"
                "每条结论引用具体文件位置或证据片段。"
            ),
            trigger_tools=("js_scan",),  # js_scan 引擎 P3 接入
            available_from_phase="P3",
        ),
    )
}


def get_analyzer(kind: str) -> AnalyzerSpec | None:
    return ANALYZERS.get(str(kind or "").strip().casefold())


def analyzer_status() -> list[dict[str, Any]]:
    return [spec.meta() for spec in ANALYZERS.values()]


def build_domain_input(
    kind: str,
    tool_result: dict[str, Any],
    *,
    evidence_loader=None,
    profile_loader=None,
) -> dict[str, Any]:
    """按 §7A.1 表组装分析器的领域输入（POC/目录/JS 各自的字段）。

    ``evidence_loader(path) -> str`` 读取证据文件内容（有界）；缺省用
    简单文件读取并截断。输入只含引用与节选，不含明文凭据。
    """
    if kind == "poc":
        def _load(path: str) -> str:
            if evidence_loader is not None:
                return evidence_loader(path)
            return ""

        hit_evidence = [
            {"path": path, "excerpt": _load(path)[:4_000]}
            for path in (tool_result.get("hit_evidence_paths") or [])[:16]
        ]
        return {
            "engine": tool_result.get("engine"),
            "engine_version": tool_result.get("engine_version"),
            "image_ref": tool_result.get("image_ref"),
            "template_ids": tool_result.get("template_ids") or [],
            "targets": tool_result.get("targets") or [],
            "hits": (tool_result.get("hits") or [])[:32],
            "raw_output_ref": tool_result.get("evidence_path"),
            "hit_evidence": hit_evidence,
            "target_profiles": (profile_loader or (lambda: []))(),
            "captured_at": now_iso(),
        }
    if kind == "directory":
        return {
            "records": (tool_result.get("records") or [])[:64],
            "raw_output_ref": tool_result.get("evidence_path"),
            "target_profiles": (profile_loader or (lambda: []))(),
            "captured_at": now_iso(),
        }
    if kind == "js":
        return {
            "files": (tool_result.get("files") or [])[:64],
            "raw_output_ref": tool_result.get("evidence_path"),
            "target_profiles": (profile_loader or (lambda: []))(),
            "captured_at": now_iso(),
        }
    raise ValueError(f"未知分析器: {kind}")


def validate_model_output(kind: str, payload: dict[str, Any]) -> list[str]:
    """§7A.2 契约字段校验（模型侧输出；服务端字段另由服务补齐）。"""
    problems: list[str] = []
    if not isinstance(payload, dict):
        return ["分析输出必须是对象"]
    if str(payload.get("kind") or "") != "analysis_record":
        problems.append("kind 必须是 analysis_record")
    if str(payload.get("analyzer_kind") or "") != kind:
        problems.append(f"analyzer_kind 必须是 {kind}")
    observations = payload.get("observations")
    if not isinstance(observations, list) or not observations:
        problems.append("observations 必须是非空数组（每条结论必须绑定证据）")
    else:
        for index, item in enumerate(observations):
            if not isinstance(item, dict) or not str(item.get("text") or "").strip():
                problems.append(f"observations[{index}] 缺少 text")
            elif not str(item.get("evidence_ref") or "").strip():
                problems.append(f"observations[{index}] 缺少 evidence_ref（结论必须绑定输入证据）")
            elif str(item.get("kind") or "") not in {"observed", "inferred"}:
                problems.append(f"observations[{index}].kind 必须是 observed|inferred")
    assessments = payload.get("candidate_assessments")
    if not isinstance(assessments, list):
        problems.append("candidate_assessments 必须是数组")
    else:
        for index, item in enumerate(assessments):
            if not isinstance(item, dict):
                problems.append(f"candidate_assessments[{index}] 必须是对象")
                continue
            if str(item.get("assessment") or "") not in CANDIDATE_ASSESSMENTS:
                problems.append(
                    f"candidate_assessments[{index}].assessment 只能取 "
                    f"{'/'.join(CANDIDATE_ASSESSMENTS)}（与 confirmed 严格分开）"
                )
            if not str(item.get("rationale") or "").strip():
                problems.append(f"candidate_assessments[{index}] 缺少 rationale")
    for field in ("recommended_followups", "uncertainties"):
        if field in payload and not isinstance(payload[field], list):
            problems.append(f"{field} 必须是数组")
    return problems
