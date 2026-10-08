"""工具网关能力目录（实施方案 §6.2，契约 P0-契约设计.md §3.3）。

每个能力一条记录：类别、面向模型的用途说明、输入参数 Schema（JSON Schema
子集：type/properties/required/enum/additionalProperties）、副作用类别、
首个提供真实实现的实施阶段（``available_from_phase``）。

规则：

1. ``available_from_phase`` 晚于当前阶段的实现**不注册为模型可见工具**；
   角色调用未到阶段的能力时，网关返回 ``capability_missing`` 并说明缺口
   （方案 §6.2：不宣称当前不存在的工具）。
2. 角色白名单的单一事实源是 ``role_registry``，本目录**不**重复维护
   roles_allowed，避免双份漂移（P0-契约设计 §3.1 规则 3）。
3. 参数纪律（方案 §6.3）：批量统一 ``targets: string[]``，单请求 ``url``；
   禁止 extra_args/shell 拼接。执行侧使用结构化参数，不经过字符串命令。
4. ``implemented=False`` 的能力保留在目录中供 ``tool_query`` 说明缺口，
   但永不进入模型可见工具列表。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


# 引擎类能力的运行时可用性提供者（能力 ID → 返回 (available, reason)）。
# 适配层存在（implemented=True）不等于运行可用：Docker/镜像缺失时网关
# 返回 capability_missing 并说明缺口，不用假结果代替（方案 §6.2/§12-P2）。
ENGINE_AVAILABILITY: dict[str, Callable[[], tuple[bool, str]]] = {}

# 引擎能力 → 适配层模块（惰性导入；导入即注册 ENGINE_AVAILABILITY 提供者）。
_ENGINE_ADAPTER_MODULES = {
    "poc_scan": ".engine_adapters",
    "url_scan": ".engine_adapters",
    "ip_scan": ".engine_adapters",
    "subdomain_scan": ".engine_adapters",
    "dir_scan": ".engine_adapters",
    "js_scan": ".engine_adapters",
    "pwd_crack": ".engine_adapters",
}


def register_engine_availability(
    capability_id: str,
    provider: Callable[[], tuple[bool, str]],
) -> None:
    ENGINE_AVAILABILITY[capability_id] = provider


def _engine_availability(capability_id: str) -> tuple[bool, str] | None:
    provider = ENGINE_AVAILABILITY.get(capability_id)
    if provider is None and capability_id in _ENGINE_ADAPTER_MODULES:
        import importlib

        module_name = _ENGINE_ADAPTER_MODULES[capability_id]
        package = __name__.rsplit(".", 1)[0]
        importlib.import_module(module_name, package=package)
        provider = ENGINE_AVAILABILITY.get(capability_id)
    if provider is None:
        return None
    try:
        available, reason = provider()
        return bool(available), str(reason or "")
    except Exception as exc:  # noqa: BLE001 —— 可用性探测失败按不可用处理
        return False, f"availability check failed: {type(exc).__name__}: {exc}"


@dataclass(frozen=True)
class ToolSpec:
    id: str
    category: str
    description: str
    parameters: dict[str, Any]
    side_effects: str  # "network_readonly" | "network_mutating" | "state_mutating" | "none"
    available_from_phase: str
    implemented: bool
    # 模型可见的函数名：缺省（""）= 与 id 同名；None = 登记在目录但不直接
    # 暴露为可调用工具（compat_bash 由网关以 "Bash" 名称单独注入；
    # helper_recipe 在没有注册配方前不可见）。
    function_name: str | None = ""

    @property
    def callable_name(self) -> str:
        return self.function_name or self.id

    @property
    def engine_gap(self) -> str | None:
        """引擎能力不可用时的缺口说明；非引擎能力返回 None。"""
        if not self.implemented:
            return None
        availability = _engine_availability(self.id)
        if availability is None or availability[0]:
            return None
        return availability[1]

    @property
    def available(self) -> bool:
        """实现存在且（对引擎能力）运行环境当前可用。"""
        if not self.implemented:
            return False
        availability = _engine_availability(self.id)
        return availability is None or availability[0]

    @property
    def visible_to_model(self) -> bool:
        return self.available and self.function_name is not None


def _object_schema(
    properties: dict[str, Any],
    required: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": required or [],
    }


_FACT_FIELDS: dict[str, Any] = {
    "title": {"type": "string", "description": "简短客观的发现标题"},
    "category": {"type": "string", "description": "攻击面类别，同 fact 契约"},
    "classification": {
        "type": "string",
        "enum": ["attack_surface", "risk_lead", "vulnerability"],
        "description": "只能提交候选；vulnerability 也须过 Guardian，不可直写已确认",
    },
    "evidence": {"type": "string", "description": "执行了什么、观察到什么（必须含验证谓词）"},
    "business_impact": {"type": "string", "description": "攻击者可造成的具体业务损失"},
    "reproduction_steps": {"type": "array", "items": {"type": "string"}},
    "evidence_path": {"type": "string", "description": "项目内相对路径 evidence/..."},
    "severity": {"type": "string", "enum": ["unknown", "low", "medium", "high", "critical"]},
    "confidence": {"type": "number"},
    "assets": {"type": "array", "items": {"type": "string"}},
    "intent_id": {"type": "string", "description": "绑定的任务/方向 ID；由网关校验，可留空"},
    "hypothesis_id": {"type": "string"},
}

_NEGATIVE_FIELDS: dict[str, Any] = {
    "hypothesis": {"type": "string"},
    "target": {"type": "string"},
    "reason": {"type": "string"},
    "method": {"type": "string"},
    "outcome": {"type": "string", "enum": ["blocked", "failed", "non_exploitable"]},
    "evidence_type": {
        "type": "string",
        "enum": [
            "target_negative", "environment_blocked", "tooling_failed",
            "policy_blocked", "inconclusive",
        ],
    },
    "evidence_paths": {"type": "array", "items": {"type": "string"}},
}

TOOL_CATALOG: dict[str, ToolSpec] = {
    # ── 项目读取（P1，全部只读）────────────────────────────────────────
    "project_summary": ToolSpec(
        id="project_summary",
        category="project_read",
        description="读取当前项目状态摘要：阶段、目标、授权范围、资产/事实/漏洞计数、当前运行状态。",
        parameters=_object_schema({}),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "route_candidates": ToolSpec(
        id="route_candidates",
        category="project_read",
        description="读取待派发候选：开放任务方向、优先目标画像、风险线索事实，供编排角色决定派发顺序。",
        parameters=_object_schema({
            "limit": {"type": "integer", "description": "最多返回条数，默认 20"},
        }),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "query_results": ToolSpec(
        id="query_results",
        category="project_read",
        description="按关键词或 URL 前缀查询既有采集结果：mrecon 观察、目标画像评估、技术观察。",
        parameters=_object_schema({
            "keyword": {"type": "string", "description": "子串匹配（URL/功能/技术栈）"},
            "url": {"type": "string", "description": "URL 前缀过滤"},
            "limit": {"type": "integer"},
        }),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "query_http": ToolSpec(
        id="query_http",
        category="project_read",
        description="查询既有 HTTP 采集记录：URL、方法、状态码、内容类型与对应证据文件路径。",
        parameters=_object_schema({
            "keyword": {"type": "string"},
            "status": {"type": "integer"},
            "limit": {"type": "integer"},
        }),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "list_facts": ToolSpec(
        id="list_facts",
        category="project_read",
        description="列出项目事实（候选/风险线索/漏洞），可按 classification 过滤。",
        parameters=_object_schema({
            "classification": {"type": "string", "enum": ["attack_surface", "risk_lead", "vulnerability", "negative_evidence", "inconclusive"]},
            "limit": {"type": "integer"},
        }),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "target_profile_query": ToolSpec(
        id="target_profile_query",
        category="project_read",
        description="查询目标画像：已评估 URL 的画像类别、技术栈与优先目标分组。",
        parameters=_object_schema({
            "url": {"type": "string", "description": "URL 前缀过滤"},
            "profile_class": {"type": "string"},
            "limit": {"type": "integer"},
        }),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "query_evidence": ToolSpec(
        id="query_evidence",
        category="project_read",
        description="查询证据登记：evidence/ 下文件的相对路径、SHA-256、大小与关联事实。",
        parameters=_object_schema({
            "path_prefix": {"type": "string", "description": "例如 evidence/mrecon"},
            "limit": {"type": "integer"},
        }),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "rule_query": ToolSpec(
        id="rule_query",
        category="project_read",
        description="读取项目检查清单红线与方法包约束，用于自查动作是否越界。",
        parameters=_object_schema({}),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "analysis_query": ToolSpec(
        id="analysis_query",
        category="project_read",
        description=(
            "查询独立 AI 研判层的分析记录（POC/目录/JS）。返回记录带"
            "“模型分析”标记与版本/输入哈希，不伪装成原始事实。"
        ),
        parameters=_object_schema({
            "analyzer_kind": {"type": "string", "enum": ["poc", "directory", "js"]},
            "limit": {"type": "integer"},
        }),
        side_effects="none",
        available_from_phase="P2",
        implemented=True,
    ),
    # ── 计划协调（P1）─────────────────────────────────────────────────
    "submit_plan": ToolSpec(
        id="submit_plan",
        category="plan_coordination",
        description=(
            "提交验证计划（plan_batch：策略摘要、假设、反事实、覆盖声明）。"
            "计划经 Guardian 与提交链落库；派发由编排角色负责，本工具不派发。"
        ),
        parameters=_object_schema(
            {"plan": {"type": "object", "description": "plan_batch 载荷对象（kind=plan_batch）"}},
            required=["plan"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
    ),
    "submit_dispatch": ToolSpec(
        id="submit_dispatch",
        category="plan_coordination",
        description=(
            "对已存在任务方向声明派发：提升其优先级并记录派发原因。"
            "只激活已有任务，不创建新任务、不改写计划语义。"
        ),
        parameters=_object_schema(
            {
                "direction_id": {"type": "string"},
                "reason": {"type": "string", "description": "为什么现在派发该方向"},
            },
            required=["direction_id", "reason"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
    ),
    "query_execution": ToolSpec(
        id="query_execution",
        category="plan_coordination",
        description="查询当前运行与任务执行状态：运行阶段、波次、各任务状态与失败原因摘要。",
        parameters=_object_schema({"limit": {"type": "integer"}}),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "finish_task": ToolSpec(
        id="finish_task",
        category="plan_coordination",
        description=(
            "声明任务终态（completed/blocked）及原因。执行角色只终结本次绑定"
            "任务；编排角色可对当前运行内已认领任务（direction_id）声明终态。"
            "无命中应输出 negative_evidence 而不是 blocked。"
        ),
        parameters=_object_schema(
            {
                "outcome": {"type": "string", "enum": ["completed", "blocked"]},
                "reason": {"type": "string"},
                "direction_id": {
                    "type": "string",
                    "description": "编排角色使用：当前运行内的已认领任务 ID",
                },
            },
            required=["outcome", "reason"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
    ),
    # ── 采集扫描（引擎接入按方案 §6.6 顺序：P2 nuclei，P3 侦察/口令/目录/JS）──
    "poc_scan": ToolSpec(
        id="poc_scan",
        category="scan_collect",
        description=(
            "组件验证引擎扫描（nuclei 适配，限定模板），targets: string[]。"
            "命中只构成候选：区分引擎声称命中与证据实际支持由独立研判与复核完成。"
        ),
        parameters=_object_schema(
            {"targets": {"type": "array", "items": {"type": "string"}}, "template_ids": {"type": "array", "items": {"type": "string"}}},
            required=["targets"],
        ),
        side_effects="network_readonly",
        available_from_phase="P2",
        # 适配层已实现（engine_adapters/nuclei_adapter.py）；运行可用性
        # （Docker 守护进程 + 镜像）由 ENGINE_AVAILABILITY 动态判定。
        implemented=True,
    ),
    "url_scan": ToolSpec(
        id="url_scan",
        category="scan_collect",
        description=(
            "Web 存活/标题/指纹侦察扫描（fscan 适配，固定 argv 容器执行，"
            "禁爆破/禁 POC 的侦察模式）。命中端口/标题/指纹是采集观察，"
            "不构成漏洞结论。"
        ),
        parameters=_object_schema({"targets": {"type": "array", "items": {"type": "string"}}}, required=["targets"]),
        side_effects="network_readonly",
        available_from_phase="P3",
        # 适配层已实现（engine_adapters/fscan_adapter.py）；镜像可用性动态判定。
        implemented=True,
    ),
    "ip_scan": ToolSpec(
        id="ip_scan",
        category="scan_collect",
        description=(
            "主机/端口/服务识别侦察扫描（fscan 适配；目标须为授权范围内"
            "主机/IP/CIDR）。开放端口是采集观察，服务利用属其他工具。"
        ),
        parameters=_object_schema({"targets": {"type": "array", "items": {"type": "string"}}}, required=["targets"]),
        side_effects="network_readonly",
        available_from_phase="P3",
        implemented=True,
    ),
    "subdomain_scan": ToolSpec(
        id="subdomain_scan",
        category="scan_collect",
        description=(
            "子域名枚举（原生 DNS 字典解析；字典来自资源仓库）。只对授权"
            "根域执行；解析记录不自动扩张攻击面。"
        ),
        parameters=_object_schema({"targets": {"type": "array", "items": {"type": "string"}}}, required=["targets"]),
        side_effects="network_readonly",
        available_from_phase="P3",
        implemented=True,
    ),
    "dir_scan": ToolSpec(
        id="dir_scan",
        category="scan_collect",
        description=(
            "Web 目录采集（原生受控请求；字典来自资源仓库，逐目标带随机路径"
            "基线对照与内容指纹）。与基线同形的记录是 catch-all/统一错误页"
            "候选，判别由目录研判分析器完成。"
        ),
        parameters=_object_schema({"targets": {"type": "array", "items": {"type": "string"}}}, required=["targets"]),
        side_effects="network_readonly",
        available_from_phase="P3",
        implemented=True,
    ),
    "js_scan": ToolSpec(
        id="js_scan",
        category="scan_collect",
        description=(
            "JS 资产采集（原生受控抓取入口页脚本；按资源仓库 JS 线索规则"
            "提取端点/凭据形状/source map 线索，全部为观察值，真伪由 JS"
            "研判分析器判别）。"
        ),
        parameters=_object_schema({"targets": {"type": "array", "items": {"type": "string"}}}, required=["targets"]),
        side_effects="network_readonly",
        available_from_phase="P3",
        implemented=True,
    ),
    "pwd_crack": ToolSpec(
        id="pwd_crack",
        category="scan_collect",
        description=(
            "已授权服务上的口令验证（原生凭据验证；凭据一律 credential_ref"
            "引用，不接受明文口令参数）。命中仅构成 risk_lead 候选；证据中"
            "口令自动脱敏。"
        ),
        parameters=_object_schema(
            {"targets": {"type": "array", "items": {"type": "string"}}, "credential_ref": {"type": "string"}},
            required=["targets", "credential_ref"],
        ),
        side_effects="network_readonly",
        available_from_phase="P3",
        implemented=True,
    ),
    # ── 受控验证（P1）─────────────────────────────────────────────────
    "http_request": ToolSpec(
        id="http_request",
        category="controlled_probe",
        description=(
            "受控单次 HTTP 请求（url 单目标）。仅允许授权范围内目标；"
            "请求/响应自动落盘证据；会话凭据用 session_ref 引用，不接受明文 Cookie/密钥。"
        ),
        parameters=_object_schema(
            {
                "url": {"type": "string"},
                "method": {"type": "string", "enum": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]},
                "headers": {"type": "object", "description": "附加请求头（键值均为字符串）"},
                "body": {"type": "string", "description": "请求体原文（文本）"},
                "session_ref": {"type": "string", "description": "会话引用名，网关解析后注入，不回显明文"},
                "max_bytes": {"type": "integer", "description": "响应体读取上限，默认 262144"},
            },
            required=["url"],
        ),
        side_effects="network_readonly",
        available_from_phase="P1",
        implemented=True,
    ),
    "session_ref": ToolSpec(
        id="session_ref",
        category="controlled_probe",
        description="列出当前项目可用的会话引用名（不返回任何明文凭据）。",
        parameters=_object_schema({}),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    # ── 业务提交（P1；一律经 CommitPlan/Outbox/投影器）──────────────────
    "record_finding": ToolSpec(
        id="record_finding",
        category="business_commit",
        description=(
            "提交发现候选（fact）。只提交候选：Guardian 复核只降不升，"
            "漏洞确认仍需证据校验与人工复核，本工具不能直写已确认漏洞。"
        ),
        parameters=_object_schema(
            {key: value for key, value in _FACT_FIELDS.items() if key in {
                "title", "category", "classification", "evidence", "business_impact",
                "reproduction_steps", "evidence_path", "severity", "confidence",
                "assets", "intent_id", "hypothesis_id",
            }},
            required=["title", "evidence", "business_impact"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
    ),
    "upsert_fact": ToolSpec(
        id="upsert_fact",
        category="business_commit",
        description=(
            "提交对既有事实的更新版本（链接到原事实的追加版本记录，"
            "经统一提交链与版本检查；原记录不删除）。"
        ),
        parameters=_object_schema(
            dict(
                list(_FACT_FIELDS.items())
                + [("updates_fact_id", {"type": "string", "description": "被更新的原事实 ID"})]
            ),
            required=["updates_fact_id", "title", "evidence", "business_impact"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
    ),
    "technology_observe": ToolSpec(
        id="technology_observe",
        category="business_commit",
        description="提交技术观察（URL 与具体技术栈，必须绑定本次证据文件）。",
        parameters=_object_schema(
            {
                "observations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "url": {"type": "string"},
                            "technology": {"type": "string"},
                            "category": {"type": "string"},
                            "version": {"type": "string"},
                            "evidence_path": {"type": "string"},
                        },
                        "required": ["url", "technology", "evidence_path"],
                    },
                },
            },
            required=["observations"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
    ),
    "negative_evidence_submit": ToolSpec(
        id="negative_evidence_submit",
        category="business_commit",
        description="提交负向证据（假设被否定/阻断/不可利用的可复用结论）。",
        parameters=_object_schema(
            dict(_NEGATIVE_FIELDS),
            required=["hypothesis", "target", "reason", "method", "evidence_type"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
    ),
    "submit_review": ToolSpec(
        id="submit_review",
        category="business_commit",
        description=(
            "提交结构化 review 记录（action_review / finding_review 两模式）。"
            "action_review 输出 approve/deny/escalate 并生成绑定"
            "(task_id, tool_id, params_digest, control_version) 的审批票据；"
            "finding_review 只输出证据充分性与建议，不改 Guardian 判定。"
        ),
        parameters=_object_schema(
            {
                "mode": {"type": "string", "enum": ["action_review", "finding_review"]},
                "payload": {"type": "object"},
            },
            required=["mode", "payload"],
        ),
        side_effects="state_mutating",
        available_from_phase="P2",
        implemented=True,
    ),
    # ── 知识（P2 随技能路由；tool_query 在 P1 即可用）──────────────────
    "load_skill": ToolSpec(
        id="load_skill",
        category="knowledge",
        description="按技能 ID 加载家族卡/短卡内容（返回版本与内容哈希；角色必须在卡片白名单内）。",
        parameters=_object_schema({"skill_id": {"type": "string"}}, required=["skill_id"]),
        side_effects="none",
        available_from_phase="P2",
        implemented=True,
    ),
    "skill_query": ToolSpec(
        id="skill_query",
        category="knowledge",
        description="按特征查询候选技能卡（结构化路由；返回命中、排除与方法缺口）。",
        parameters=_object_schema({"features": {"type": "array", "items": {"type": "string"}}}, required=["features"]),
        side_effects="none",
        available_from_phase="P2",
        implemented=True,
    ),
    "tool_query": ToolSpec(
        id="tool_query",
        category="knowledge",
        description="查询工具能力目录：能力 ID、参数 Schema、当前是否可用；不可用项返回缺口说明。",
        parameters=_object_schema({
            "capability_id": {"type": "string", "description": "只查单个能力时可提供"},
        }),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    # ── 本地辅助（P1 受限）────────────────────────────────────────────
    "workspace_read": ToolSpec(
        id="workspace_read",
        category="local_aux",
        description="读取项目工作区内允许范围的文件内容（有界截断；自动脱敏）。",
        parameters=_object_schema(
            {"path": {"type": "string", "description": "项目内相对路径"}, "max_bytes": {"type": "integer"}},
            required=["path"],
        ),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "workspace_list": ToolSpec(
        id="workspace_list",
        category="local_aux",
        description="列出项目工作区内允许范围的文件。",
        parameters=_object_schema({"path": {"type": "string"}}),
        side_effects="none",
        available_from_phase="P1",
        implemented=True,
    ),
    "workspace_write": ToolSpec(
        id="workspace_write",
        category="local_aux",
        description="写入中间工作文件；只允许 .sorne-work/ 下（证据一律由工具或 evidence_sink 机制落盘）。",
        parameters=_object_schema(
            {"path": {"type": "string", "description": ".sorne-work/ 下相对路径"}, "content": {"type": "string"}},
            required=["path", "content"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
    ),
    "helper_recipe": ToolSpec(
        id="helper_recipe",
        category="local_aux",
        description="执行已注册的辅助命令配方（固定 argv，无 shell 拼接）。当前未注册任何配方。",
        parameters=_object_schema(
            {"recipe": {"type": "string"}, "arguments": {"type": "object"}},
            required=["recipe"],
        ),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
        function_name=None,  # 未注册配方前不进入模型可见列表；tool_query 可见其缺口
    ),
    # ── 旧 executor 兼容路径（迁移期专用，见 role_registry legacy 记录）──
    "compat_bash": ToolSpec(
        id="compat_bash",
        category="local_aux",
        description=(
            "迁移期兼容：旧 executor 角色在 OpenAI 工具循环中的原 Bash 通路。"
            "新七角色一律不授予；P4 迁移后移除。"
        ),
        parameters=_object_schema({"command": {"type": "string"}}, required=["command"]),
        side_effects="state_mutating",
        available_from_phase="P1",
        implemented=True,
        function_name=None,  # 由网关在旧角色会话中以 "Bash" 名称单独注入
    ),
}


def get_tool(capability_id: str) -> ToolSpec | None:
    return TOOL_CATALOG.get(str(capability_id or "").strip())


def effective_tool_spec(capability_id: str) -> ToolSpec | None:
    """与 ``get_tool`` 同源；保留独立入口供可用性判定消费（引擎能力动态可用）。"""
    return get_tool(capability_id)


def implemented_capabilities() -> frozenset[str]:
    """当前真实可用的能力集合（实现存在 ∧ 运行环境可用）。"""
    return frozenset(item.id for item in TOOL_CATALOG.values() if item.available)


def capability_gap(capability_id: str) -> str:
    """未实现/运行不可用能力的缺口说明（capability_missing 载荷）。"""
    spec = get_tool(capability_id)
    if spec is None:
        return f"capability_missing: 能力 {capability_id} 不在工具目录中"
    if not spec.implemented:
        return (
            f"capability_missing: 能力 {capability_id}（{spec.description}）"
            f"计划于 {spec.available_from_phase} 阶段提供真实实现，当前不可用；"
            "不得用其他工具或结果冒充该能力。"
        )
    engine_gap = spec.engine_gap
    if engine_gap:
        return (
            f"capability_missing: 能力 {capability_id} 的适配层已实现，"
            f"但运行环境当前不可用（{engine_gap}）。"
            "本调用被拒绝；不得用其他工具或结果冒充该能力。"
        )
    return f"capability_missing: 能力 {capability_id} 当前不可用"
