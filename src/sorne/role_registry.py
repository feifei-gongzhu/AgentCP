"""角色注册表（实施方案 §3/§6.1，契约 P0-契约设计.md §3.1）。

七角色 + 迁移期旧六角色的唯一事实源。其他模块的角色白名单
（``schemas.SUPPORTED_ROLES``、``cli.py`` choices、webapp ``allowed_roles``、
前端角色下拉、``automation.ROLE_ACTIVITIES``、``context_compiler`` 预算键）
一律从本注册表派生，消除多处漂移（P0-契约设计 §3.1 规则 3）。

与 P0 文档的一处实现偏差（记录在案）：P0 §3.1 规则 4 写“旧六角色 kind 标
legacy”。若旧角色 kind 全部为 ``legacy``，调度器无法再按 kind 派生
planning/execution 分组。因此本注册表对每个角色同时给出**功能性 kind**
（planning/execution/orchestration/review）与 ``origin`` 标记
（"seven_role" | "legacy"）：功能性 kind 驱动调度，``origin=legacy``
标记迁移期待遇（compat_bash 兼容通路等），语义与 P0 意图一致。

能力白名单规则：

1. 网关有效权限 = 角色白名单 ∩ 任务授权能力 ∩ 部署策略（方案 §6.4）。
   本表只维护角色白名单；交集判定在 ``tool_gateway``。
2. 白名单仅引用 ``tool_registry.TOOL_CATALOG`` 中存在的能力 ID，无通配符。
3. 未实现能力（引擎未接入）保留在白名单中：它们是角色契约的一部分，
   但在实现落地前不会进入模型可见工具列表；命中即 ``capability_missing``。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .tool_registry import TOOL_CATALOG, implemented_capabilities


KIND_EXECUTION = "execution"
KIND_PLANNING = "planning"
KIND_ORCHESTRATION = "orchestration"
KIND_REVIEW = "review"

ROLE_KINDS = frozenset({KIND_EXECUTION, KIND_PLANNING, KIND_ORCHESTRATION, KIND_REVIEW})

SEVEN_ROLES = ("orchestrator", "planner", "recon", "crack", "poc", "operator", "reviewer")
LEGACY_ROLES = ("reason", "metacog", "executor", "waf_analyst", "profile_mapper")


@dataclass(frozen=True)
class RoleSpec:
    id: str
    display_name: str
    kind: str
    origin: str  # "seven_role" | "legacy"
    context_profile: str
    prompt_file: str
    worker_kinds: tuple[str, ...]
    capabilities: frozenset[str]
    default_sandbox: str
    activity: tuple[str, str]
    # 认领顺序：数值小者优先（专兵先于 operator，方案 §3.1）。
    claim_priority: int = 50

    def __post_init__(self) -> None:
        unknown = set(self.capabilities) - set(TOOL_CATALOG)
        if unknown:
            raise ValueError(f"角色 {self.id} 引用了工具目录中不存在的能力: {sorted(unknown)}")
        if self.kind not in ROLE_KINDS:
            raise ValueError(f"角色 {self.id} kind 非法: {self.kind}")

    @property
    def is_legacy(self) -> bool:
        return self.origin == "legacy"

    def effective_capabilities(self) -> frozenset[str]:
        """角色白名单 ∩ 当前已实现能力（未实现项在网关返回 capability_missing）。"""
        return self.capabilities & implemented_capabilities()


_ROLE_RECORDS: tuple[RoleSpec, ...] = (
    # ── 七角色（方案 §3 表格）──────────────────────────────────────────
    RoleSpec(
        id="orchestrator",
        display_name="编排",
        kind=KIND_ORCHESTRATION,
        origin="seven_role",
        context_profile="orchestrator",
        prompt_file="prompts/orchestrator.md",
        worker_kinds=("decision", "none"),
        capabilities=frozenset({
            "project_summary", "list_facts", "query_results", "query_http",
            "route_candidates", "submit_dispatch", "query_execution", "finish_task",
        }),
        default_sandbox="read-only",
        activity=("读取项目状态并请求规划、派发已验证任务", "产出派发记录与阻塞/完成摘要"),
        claim_priority=90,
    ),
    RoleSpec(
        id="planner",
        display_name="规划",
        kind=KIND_PLANNING,
        origin="seven_role",
        context_profile="planner",
        prompt_file="prompts/planner.md",
        worker_kinds=("plan_batch", "none"),
        capabilities=frozenset({
            "project_summary", "list_facts", "query_results", "query_http",
            "analysis_query", "target_profile_query", "load_skill", "skill_query",
            "tool_query", "submit_plan",
        }),
        default_sandbox="read-only",
        activity=("画像驱动的验证计划与重规划", "产出带前置条件与依赖的计划"),
        claim_priority=90,
    ),
    RoleSpec(
        id="recon",
        display_name="侦察",
        kind=KIND_EXECUTION,
        origin="seven_role",
        context_profile="recon",
        prompt_file="prompts/recon.md",
        worker_kinds=("fact", "negative_evidence", "none"),
        capabilities=frozenset({
            "url_scan", "ip_scan", "subdomain_scan", "dir_scan", "js_scan",
            "query_results", "query_http", "analysis_query", "record_finding",
            "upsert_fact", "negative_evidence_submit", "technology_observe",
            "workspace_read", "workspace_list",
        }),
        default_sandbox="workspace-write",
        activity=("资产、服务、目录、JS 线索与指纹采集", "产出新资产、技术观察与采集证据"),
        claim_priority=10,
    ),
    RoleSpec(
        id="crack",
        display_name="口令验证",
        kind=KIND_EXECUTION,
        origin="seven_role",
        context_profile="crack",
        prompt_file="prompts/crack.md",
        worker_kinds=("fact", "negative_evidence", "none"),
        capabilities=frozenset({
            "pwd_crack", "query_results", "query_http", "list_facts",
            "record_finding", "upsert_fact", "negative_evidence_submit",
            "workspace_read", "workspace_list",
        }),
        default_sandbox="workspace-write",
        activity=("已授权服务上的口令验证", "产出尝试状态、凭据引用与验证证据"),
        claim_priority=10,
    ),
    RoleSpec(
        id="poc",
        display_name="组件验证",
        kind=KIND_EXECUTION,
        origin="seven_role",
        context_profile="poc",
        prompt_file="prompts/poc.md",
        worker_kinds=("fact", "negative_evidence", "none"),
        capabilities=frozenset({
            "poc_scan", "load_skill", "http_request", "query_results", "query_http",
            "query_evidence", "analysis_query", "record_finding", "upsert_fact",
            "negative_evidence_submit", "workspace_read", "workspace_list",
        }),
        default_sandbox="workspace-write",
        activity=("指纹对应的组件验证", "产出组件验证候选、排除或阻塞证据"),
        claim_priority=10,
    ),
    RoleSpec(
        id="operator",
        display_name="综合执行",
        kind=KIND_EXECUTION,
        origin="seven_role",
        context_profile="operator",
        prompt_file="prompts/operator.md",
        worker_kinds=("fact", "negative_evidence", "none"),
        capabilities=frozenset({
            "http_request", "session_ref", "load_skill", "query_results",
            "query_http", "query_evidence", "analysis_query", "record_finding",
            "upsert_fact", "negative_evidence_submit", "technology_observe",
            "workspace_read", "workspace_list", "workspace_write", "helper_recipe",
        }),
        default_sandbox="workspace-write",
        activity=("Web 主验证、认证/API/业务逻辑与专项执行", "产出请求对照、发现候选与负向证据"),
        # operator 默认不与专兵抢任务（方案 §3.1），认领顺序排在专兵之后；
        # 专兵不可用且能力允许时才接手（capability 匹配自然放行）。
        claim_priority=40,
    ),
    RoleSpec(
        id="reviewer",
        display_name="复核",
        kind=KIND_REVIEW,
        origin="seven_role",
        context_profile="reviewer",
        prompt_file="prompts/reviewer.md",
        worker_kinds=("decision", "review_record", "fact", "none"),
        capabilities=frozenset({
            "project_summary", "list_facts", "query_results", "query_http",
            "query_evidence", "query_execution", "rule_query", "analysis_query",
            "submit_review",
        }),
        default_sandbox="read-only",
        activity=("动作审批与发现质量复核", "输出结构化 review 与裁决建议"),
        claim_priority=90,
    ),
    # ── 迁移期旧六角色（方案 §10；P4 迁移工具处理后退出默认团队）────────
    RoleSpec(
        id="reason",
        display_name="推理规划（旧）",
        kind=KIND_PLANNING,
        origin="legacy",
        context_profile="reason",
        prompt_file="prompts/reason.md",
        worker_kinds=("plan_batch", "intent", "decision", "fact", "none"),
        # 旧角色保留 OpenAI 工具循环的原 Bash 通路（compat_bash），
        # 保证迁移期旧项目行为不变；新七角色一律无此能力。
        capabilities=frozenset({"compat_bash"}),
        default_sandbox="read-only",
        activity=("分析黑板并生成审计方向", "产出可执行 Intent 或有证据的 Fact"),
    ),
    RoleSpec(
        id="metacog",
        display_name="盲点检查（旧）",
        kind=KIND_PLANNING,
        origin="legacy",
        context_profile="metacog",
        prompt_file="prompts/metacog.md",
        worker_kinds=("plan_batch", "intent", "decision", "fact", "none"),
        capabilities=frozenset({"compat_bash"}),
        default_sandbox="read-only",
        activity=("检查盲点、反例与高价值路径", "补充或修正当前审计方向"),
    ),
    RoleSpec(
        id="executor",
        display_name="执行（旧）",
        kind=KIND_EXECUTION,
        origin="legacy",
        context_profile="executor",
        prompt_file="prompts/executor.md",
        worker_kinds=("fact", "negative_evidence", "none"),
        # 迁移映射：executor → operator（主要继承者，P0-契约设计 §4.1）。
        # 因此能力取 operator 集合 + 兼容 Bash 通路，旧项目继续可运行。
        capabilities=frozenset({
            "compat_bash", "http_request", "session_ref", "query_results",
            "query_http", "query_evidence", "record_finding", "upsert_fact",
            "negative_evidence_submit", "technology_observe", "workspace_read",
            "workspace_list", "workspace_write",
        }),
        default_sandbox="workspace-write",
        activity=("执行已认领 Intent 的验证动作", "产出 Fact 或 NegativeEvidence"),
        claim_priority=40,
    ),
    RoleSpec(
        id="waf_analyst",
        display_name="WAF 对抗（旧）",
        kind=KIND_PLANNING,
        origin="legacy",
        context_profile="waf_analyst",
        prompt_file="prompts/waf_analyst.md",
        worker_kinds=("fact", "negative_evidence", "decision", "none"),
        capabilities=frozenset({"compat_bash"}),
        default_sandbox="read-only",
        activity=("刻画已确认的 WAF 干扰分支", "产出受预算约束的等价差异验证 Intent"),
    ),
    RoleSpec(
        id="profile_mapper",
        display_name="画像服务（旧）",
        kind=KIND_PLANNING,
        origin="legacy",
        context_profile="profile_mapper",
        prompt_file="prompts/profile_mapper.md",
        worker_kinds=("target_profile_batch", "none"),
        capabilities=frozenset({"compat_bash"}),
        default_sandbox="read-only",
        activity=("遍历目标可点击功能并识别技术栈", "产出 URL、功能、技术栈画像"),
    ),
)

ROLE_REGISTRY: dict[str, RoleSpec] = {record.id: record for record in _ROLE_RECORDS}

# context_compiler 的预算表键（context_profile），供预算派生校验使用。
CONTEXT_PROFILES = tuple(
    dict.fromkeys(record.context_profile for record in _ROLE_RECORDS)
)


def get_role(role_id: str) -> RoleSpec | None:
    return ROLE_REGISTRY.get(str(role_id or "").strip())


def role_ids(*, origin: str | None = None) -> tuple[str, ...]:
    return tuple(
        record.id
        for record in _ROLE_RECORDS
        if origin is None or record.origin == origin
    )


def supported_roles() -> frozenset[str]:
    """schemas.SUPPORTED_ROLES 的数据源（旧 6 + 新 7 双契约，方案 §10-1）。"""
    return frozenset(ROLE_REGISTRY)


def role_kind(role_id: str) -> str:
    record = get_role(role_id)
    if record is None:
        raise ValueError(f"未知角色: {role_id}")
    return record.kind


def is_execution_role(role_id: str) -> bool:
    record = get_role(role_id)
    return record is not None and record.kind == KIND_EXECUTION


def role_capabilities(role_id: str) -> frozenset[str]:
    record = get_role(role_id)
    if record is None:
        raise ValueError(f"未知角色: {role_id}")
    return record.capabilities


def role_allows_kind(role_id: str, kind: str) -> bool:
    record = get_role(role_id)
    return record is not None and str(kind) in record.worker_kinds


def role_activity(role_id: str) -> tuple[str, str]:
    record = get_role(role_id)
    if record is not None:
        return record.activity
    return (f"执行 {role_id} 角色任务", "返回结构化候选结果")


# ── 任务认领：kind × 能力匹配（方案 §12-P1；替代 role == "executor" 硬编码）──

# Intent.verb → 执行该方向所需的最低能力。缺省按网络验证处理（保守）：
# 执行类意图默认需要 http_request；未实现引擎的专兵能力（pwd_crack 等）
# 在意图显式点名时也会形成 capability_missing 缺口，而不是静默换人执行。
VERB_REQUIRED_CAPABILITIES: dict[str, frozenset[str]] = {
    "verify": frozenset({"http_request"}),
    "mutate": frozenset({"http_request"}),
    "replay": frozenset({"http_request"}),
    "fuzz": frozenset({"http_request"}),
    "inject": frozenset({"http_request"}),
    "forge": frozenset({"http_request"}),
    "bypass": frozenset({"http_request"}),
    "execute": frozenset({"http_request"}),
    "waf_characterize": frozenset({"http_request"}),
    "inspect": frozenset({"workspace_read"}),
    "collect": frozenset({"query_results"}),
    "profile": frozenset({"query_results"}),
}
DEFAULT_REQUIRED_CAPABILITIES = frozenset({"http_request"})


def required_capabilities_for_intent(intent: dict[str, Any]) -> frozenset[str]:
    verb = str((intent or {}).get("verb") or "").strip().casefold()
    return VERB_REQUIRED_CAPABILITIES.get(verb, DEFAULT_REQUIRED_CAPABILITIES)


def member_can_claim(role_id: str, intent: dict[str, Any]) -> bool:
    """认领资格 = 执行类 kind ∧ 所需能力 ⊆（角色白名单 ∩ 已实现能力）。

    未实现引擎所需的方向不会有人认领；调用方应把这类方向显式记录为
    capability_missing（no_matching_task），而不是让其他角色顶替执行。
    """
    record = get_role(role_id)
    if record is None or record.kind != KIND_EXECUTION:
        return False
    required = required_capabilities_for_intent(intent)
    return required.issubset(record.effective_capabilities())


def claim_blockers(
    intents: Iterable[dict[str, Any]],
    role_ids: Iterable[str],
) -> list[dict[str, Any]]:
    """对一批开放方向，列出每个方向无人可认领时缺失的能力。

    供调度事件 capability_missing 使用（方案 §11 状态区分；
    “工具缺失项目：显示 capability_missing，可用能力继续”）。
    """
    execution_roles = [
        get_role(role_id)
        for role_id in role_ids
        if get_role(role_id) is not None and get_role(role_id).kind == KIND_EXECUTION
    ]
    blockers: list[dict[str, Any]] = []
    for intent in intents:
        required = required_capabilities_for_intent(intent)
        satisfied = any(required.issubset(record.effective_capabilities()) for record in execution_roles)
        if satisfied:
            continue
        blockers.append({
            "direction_id": str((intent or {}).get("id") or ""),
            "verb": str((intent or {}).get("verb") or ""),
            "required_capabilities": sorted(required),
            "missing": sorted(
                required - {
                    capability
                    for record in execution_roles
                    for capability in record.effective_capabilities()
                }
            ),
        })
    return blockers
