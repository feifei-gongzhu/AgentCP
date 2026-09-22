"""JEV（TypeSafe jev-1.13，System One 判断模型）分类旁路适配器。

定位（与产品特点对齐）：
- 只回答少量原子化、字面化的结构化问题（入口类型 / 是否涉及权限边界 /
  信息是否足以分类 / 是否需要补充证据），不做功能解释、技术信息提取、
  自由文本理由或专项规划——那些仍由 profile_mapper 等 Agent 承担。
- 影子模式（shadow）：答案只写入评估记录的 classification_provenance
  （键 ``influences_scheduling=False``），不参与任何调度决策；待旁路对比
  评测后再决定是否影响调度。
- 不是团队角色，不复用 Chat Completions 驱动；独立 transport 接口，
  默认禁用（未配置 AGENTCP_JEV_ENDPOINT 时 classify/shadow 直接返回
  None，零行为差异）。

调用时序约束：JEV 调用必须发生在提交计划冻结之前（自动化 commit 路径）；
提交后载荷冻结持久化，投影重放只读取载荷、绝不重新调用模型。

锯齿（jaggedness）规避：
- 问题原子且字面化（无双重否定、无多跳推理）；
- 状态字段白名单过滤、单批有界（context rot）；
- 数学/日期/比较一律在代码中完成；
- confidence 三段划分（high/medium/low）为保守默认值，尚未按本产品
  数据校准，仅用于记录与后续评测，不用于行动决策。

配置（均未设置时 JEV 完全禁用）：
- ``AGENTCP_JEV_ENDPOINT``：System One HTTP 端点（当前为临时线格式，
  官方 REST 契约确认后替换；typesafe SDK 适配为后续项）；
- ``AGENTCP_JEV_API_KEY``：Bearer 凭据；
- ``AGENTCP_JEV_MODEL``：默认 ``jev-1.13``。
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

JEV_MODEL_DEFAULT = "jev-1.13"
JEV_QUESTION_SET_VERSION = "jev-target-classification-v1"
# 单次 System One 调用的目标数上限：状态过滤后的保守界（context rot）。
JEV_MAX_TARGETS_PER_CALL = 20
# confidence 三段默认阈值：按官方指引保守起步，尚未用本产品数据校准。
CONFIDENCE_HIGH = 0.8
CONFIDENCE_LOW = 0.5

# transport 注入点：测试与未来 SDK 适配的唯一边界。
# 签名 transport(state, questions) -> {"answers": {name: {...}}, "model": str}
JEVTransport = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]

ENTRY_TYPE_OPTIONS = (
    "authentication",
    "file_upload",
    "user_data",
    "admin_console",
    "public_content",
    "unknown",
)


class JEVDisabled(RuntimeError):
    """未配置 AGENTCP_JEV_ENDPOINT：JEV 旁路关闭。"""


class JEVError(RuntimeError):
    """transport 调用或应答解析失败。"""


def jev_configured() -> bool:
    return bool(os.environ.get("AGENTCP_JEV_ENDPOINT", "").strip())


def confidence_band(value: float | None) -> str:
    """三段式 confidence 划分（默认阈值未校准，仅记录用）。"""
    if value is None:
        return "unknown"
    if value >= CONFIDENCE_HIGH:
        return "high"
    if value >= CONFIDENCE_LOW:
        return "medium"
    return "low"


def build_state_entry(row: dict[str, Any]) -> dict[str, Any]:
    """单个评估目标的过滤后状态（白名单字段，防 context rot）。"""
    return {
        "url": str(row.get("url") or "")[:300],
        "function": str(row.get("function") or "")[:200],
        "observation_kind": str(row.get("observation_kind") or "")[:40],
        "http_status": row.get("status") if isinstance(row.get("status"), int) else None,
        "parameter_names": [str(item)[:60] for item in (row.get("parameter_names") or [])[:10]],
        "technologies": [str(item)[:60] for item in (row.get("technology_stack") or [])[:10]],
        "profile_class": str(row.get("profile_class") or "")[:40] or None,
        "score_reason": str(row.get("score_reason") or "")[:200] or None,
    }


def merge_collection_context(
    assessments: list[dict[str, Any]],
    records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """把同一批次的采集观察（records）按 URL 合并进评估行副本。

    评估行只有分类结论；mrecon 的 observation_kind/status/参数名/技术栈
    在 records 行里。合并进**副本**后作为 JEV 状态，不修改提交载荷本体。
    """
    by_url: dict[str, dict[str, Any]] = {}
    for row in records:
        if isinstance(row, dict) and row.get("url"):
            by_url.setdefault(str(row["url"]), row if isinstance(row, dict) else {})
    enriched: list[dict[str, Any]] = []
    for row in assessments:
        if not isinstance(row, dict):
            continue
        merged = dict(row)
        source = by_url.get(str(row.get("url") or ""))
        if source:
            for key in ("observation_kind", "status", "parameter_names", "technology_stack"):
                if key in source and key not in merged:
                    merged[key] = source[key]
        enriched.append(merged)
    return enriched


def build_questions(index: int) -> dict[str, dict[str, Any]]:
    """一批次中第 ``index`` 个目标的原子问题集（字面化、单判断）。"""
    prefix = f"t{index}_"
    return {
        f"{prefix}entry_type": {
            "primitive": "choice",
            "options": list(ENTRY_TYPE_OPTIONS),
            "instructions": (
                "看 targets 中下标为该序号的条目，按 url 与 function 字段的字面含义选择入口类型："
                "authentication 表示登录、注册、找回密码、会话签发；"
                "file_upload 表示文件上传、导入、附件提交；"
                "user_data 表示查看或修改用户资料、订单、消息等业务数据；"
                "admin_console 表示后台管理、运维、系统配置入口；"
                "public_content 表示纯展示内容，例如新闻、公告、产品介绍；"
                "unknown 表示按字面含义无法归入以上任何一类。只按字面判断，不要推测。"
            ),
        },
        f"{prefix}has_privilege_boundary": {
            "primitive": "noul",
            "instructions": (
                "该条目的 url 与 function 字面含义是否涉及认证、权限、"
                "文件上传下载或用户数据的读写边界。"
            ),
        },
        f"{prefix}information_sufficient": {
            "primitive": "noul",
            "instructions": (
                "仅凭该条目现有字段（url、function、observation_kind、参数名、技术栈），"
                "是否足以在 优先目标 / 常规信息 / 待复核 三类之间做出分类。"
            ),
        },
        f"{prefix}needs_more_evidence": {
            "primitive": "noul",
            "instructions": "该条目是否需要补充采集（更多请求或页面证据）后才能分类。",
        },
    }


def state_fingerprint(state: dict[str, Any]) -> str:
    material = json.dumps(
        {"question_set_version": JEV_QUESTION_SET_VERSION, "state": state},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def default_transport(state: dict[str, Any], questions: dict[str, Any]) -> dict[str, Any]:
    """官方 typesafe SDK 缺席时的临时 HTTP transport（线格式待官方确认）。"""
    endpoint = os.environ.get("AGENTCP_JEV_ENDPOINT", "").strip()
    if not endpoint:
        raise JEVDisabled("AGENTCP_JEV_ENDPOINT 未配置，JEV 旁路关闭")
    api_key = os.environ.get("AGENTCP_JEV_API_KEY", "").strip()
    model = os.environ.get("AGENTCP_JEV_MODEL", "").strip() or JEV_MODEL_DEFAULT
    body = {
        "model": model,
        "state": state,
        "questions": questions,
    }
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/system_one",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise JEVError(f"JEV transport 失败: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("answers"), dict):
        raise JEVError("JEV 应答缺少 answers 对象")
    payload.setdefault("model", model)
    return payload


@dataclass
class JEVBulkClassification:
    """一次批量调用的解析结果（逐目标答案 + 审计元数据）。"""

    model: str
    question_set_version: str
    state_fingerprint: str
    answers_by_url: dict[str, dict[str, dict[str, Any]]]
    skipped: int = 0

    def provenance_for(self, url: str) -> dict[str, Any] | None:
        answers = self.answers_by_url.get(url)
        if not answers:
            return None
        return {
            "model": self.model,
            "question_set_version": self.question_set_version,
            "state_fingerprint": self.state_fingerprint,
            "answers": answers,
            "influences_scheduling": False,
        }


def _parse_answer(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    parsed: dict[str, Any] = {}
    for key in ("choice", "noul", "score", "confidence", "probabilities"):
        if raw.get(key) is not None:
            parsed[key] = raw[key]
    return parsed or None


def classify_targets(
    rows: list[dict[str, Any]],
    *,
    transport: JEVTransport | None = None,
) -> JEVBulkClassification | None:
    """对一批画像目标运行一次 System One 批量分类（影子数据）。

    未配置端点且未注入 transport 时返回 None（调用方零处理）。
    返回结果只用于旁路记录，不参与调度。
    """
    if transport is None:
        if not jev_configured():
            return None
        transport = default_transport
    batch = [build_state_entry(row) for row in rows[:JEV_MAX_TARGETS_PER_CALL]]
    if not batch:
        return None
    state = {"targets": batch}
    questions: dict[str, dict[str, Any]] = {}
    for index in range(len(batch)):
        questions.update(build_questions(index))
    result = transport(state, questions)
    model = str(result.get("model") or os.environ.get("AGENTCP_JEV_MODEL", "").strip() or JEV_MODEL_DEFAULT)
    answers_raw = result.get("answers") or {}
    answers_by_url: dict[str, dict[str, dict[str, Any]]] = {}
    for index, row in enumerate(rows[:JEV_MAX_TARGETS_PER_CALL]):
        url = str(row.get("url") or "")
        if not url:
            continue
        prefix = f"t{index}_"
        answers: dict[str, dict[str, Any]] = {}
        for logical in ("entry_type", "has_privilege_boundary", "information_sufficient", "needs_more_evidence"):
            parsed = _parse_answer(answers_raw.get(f"{prefix}{logical}"))
            if parsed:
                answers[logical] = parsed
        if answers:
            answers_by_url[url] = answers
    return JEVBulkClassification(
        model=model,
        question_set_version=JEV_QUESTION_SET_VERSION,
        state_fingerprint=state_fingerprint(state),
        answers_by_url=answers_by_url,
        skipped=max(0, len(rows) - JEV_MAX_TARGETS_PER_CALL),
    )
