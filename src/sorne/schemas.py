from __future__ import annotations

import hashlib
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4


_GENERATION_CONTEXT = threading.local()


@contextmanager
def deterministic_generation(event_id: str, occurred_at: str):
    previous = getattr(_GENERATION_CONTEXT, "value", None)
    _GENERATION_CONTEXT.value = {
        "event_id": str(event_id),
        "occurred_at": str(occurred_at),
        "counters": {},
    }
    try:
        yield
    finally:
        _GENERATION_CONTEXT.value = previous


def now_iso() -> str:
    context = getattr(_GENERATION_CONTEXT, "value", None)
    if context:
        return str(context["occurred_at"])
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    context = getattr(_GENERATION_CONTEXT, "value", None)
    if context:
        counters = context["counters"]
        ordinal = int(counters.get(prefix, 0))
        counters[prefix] = ordinal + 1
        material = f"{context['event_id']}:{prefix}:{ordinal}".encode("utf-8")
        return f"{prefix}-{hashlib.sha256(material).hexdigest()[:10]}"
    return f"{prefix}-{uuid4().hex[:10]}"


VALID_WORKER_KINDS = frozenset({
    "fact",
    "intent",
    "plan_batch",
    "decision",
    "negative_evidence",
    "target_profile_batch",
    "none",
})

# 规范角色及其输入别名。pentester 是旧配置/旧 Job 的兼容输入，任何入口
# 读取后都应立即规范化为 executor；新配置只保存规范角色。
ROLE_ALIASES = {"pentester": "executor"}
SUPPORTED_ROLES = frozenset({
    "reason", "metacog", "executor", "reviewer", "waf_analyst", "profile_mapper",
})


def normalize_role(role: object) -> str:
    """唯一角色规范化函数：别名映射 + 未知角色明确报错。"""
    value = str(role or "").strip()
    value = ROLE_ALIASES.get(value, value)
    if value not in SUPPORTED_ROLES:
        raise ValueError(
            f"未知 Worker 角色: {role}；支持的角色为 "
            + "、".join(sorted(SUPPORTED_ROLES))
            + "（pentester 作为 executor 的兼容别名自动接受）"
        )
    return value


class Phase(str, Enum):
    INTAKE = "intake"
    PROBE = "phase_0_5_probe"
    RECON = "recon"
    HUNT = "hunt"
    VERIFY = "verify"
    REPORT = "report"


class AssessmentLevel(str, Enum):
    GREEN = "GREEN"
    RED = "RED"
    GRAY = "GRAY"


class FactStatus(str, Enum):
    PHENOMENON = "phenomenon"
    LEAD = "lead"
    EVIDENCE = "evidence"
    VULNERABILITY = "vulnerability"
    SUSPICION = "suspicion"
    BLOCKER = "blocker"


class FactClassification(str, Enum):
    ATTACK_SURFACE = "attack_surface"
    RISK_LEAD = "risk_lead"
    VULNERABILITY = "vulnerability"
    NEGATIVE_EVIDENCE = "negative_evidence"
    INCONCLUSIVE = "inconclusive"


class HumanReviewStatus(str, Enum):
    NOT_REQUIRED = "not_required"
    PENDING = "pending_human_review"
    ACCEPTED = "human_accepted"
    ADJUSTED = "human_adjusted"
    REFUTED = "human_refuted"
    RECLASSIFIED = "human_reclassified"
    RETEST_REQUESTED = "retest_requested"


class AttackSurface(str, Enum):
    IPC_ENDPOINT = "ipc_endpoint"
    LISTENING_PORT = "listening_port"
    LPE_PATH = "lpe_path"
    FILE_TRUST = "asset"
    ELECTRON_WEB = "electron_config"
    PARSER_FFI = "parser_target"
    SUPPLY_CHAIN = "supply_chain"
    CREDENTIAL = "credential_leak"
    ENTITLEMENT = "entitlement"
    LIFECYCLE = "deeplink"


CLIENT_ATTACK_SURFACE_COVERAGE = {item.value: "unverified" for item in AttackSurface}

WEB_ATTACK_SURFACE_COVERAGE = {
    "api_endpoint": "unverified",
    "listening_port_service": "unverified",
    "priv_esc_path": "unverified",
    "asset_web_directory": "unverified",
    "framework_config": "unverified",
    "parser_target": "unverified",
    "supply_chain_third_party": "unverified",
    "credential_leak": "unverified",
    "cloud_entitlement": "unverified",
    "business_logic": "unverified",
}


def coverage_template_for_project_type(project_type: str | None) -> dict[str, str]:
    normalized = str(project_type or "").strip().casefold()
    if any(marker in normalized for marker in ("web", "api", "web渗透", "网站", "网页")):
        return dict(WEB_ATTACK_SURFACE_COVERAGE)
    return dict(CLIENT_ATTACK_SURFACE_COVERAGE)


class ControllerAction(str, Enum):
    CONTINUE = "continue"
    STOP_LOSS = "stop_loss"
    SWITCH_TARGET = "switch_target"
    SWITCH_PHASE = "switch_phase"
    REQUEST_CONFIRMATION = "request_confirmation"


class GateStatus(str, Enum):
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"


@dataclass
class ProjectState:
    vendor: str
    phase: str = Phase.INTAKE.value
    elapsed_minutes: int = 0
    last_gate_elapsed_minutes: int = 0
    gate_interval_minutes: int = 15
    gate_status: str = GateStatus.RUNNING.value
    gate_reason: str | None = None
    current_task: str = "项目初始化"
    current_breakthrough: str | None = None
    task_started_elapsed_minutes: int = 0
    high_risk_fingerprint_count: int = 0
    serendipity_budget_minutes: int = 54
    serendipity_used_minutes: int = 0
    asset_count: int = 0
    fact_count: int = 0
    vulnerability_count: int = 0
    pending_human_review_count: int = 0
    human_confirmed_count: int = 0
    human_refuted_count: int = 0
    last_discovery_at: str | None = None
    current_decision: str = ControllerAction.CONTINUE.value
    active_run_id: str | None = None
    run_status: str = "idle"
    control_version: int = 0
    attack_surface_coverage: dict[str, str] = field(
        default_factory=lambda: dict(CLIENT_ATTACK_SURFACE_COVERAGE)
    )
    updated_at: str = field(default_factory=now_iso)


@dataclass
class Fact:
    title: str
    category: str
    evidence: str
    assets: list[str] = field(default_factory=list)
    status: str = FactStatus.PHENOMENON.value
    severity: str = "unknown"
    confidence: float = 0.5
    impact_score: float = 0.0
    classification: str = FactClassification.ATTACK_SURFACE.value
    business_impact: str = ""
    reproduction_steps: list[str] = field(default_factory=list)
    evidence_path: str = ""
    proposed_by: str = "worker"
    hypothesis_id: str | None = None
    intent_id: str | None = None
    id: str = field(default_factory=lambda: new_id("F"))
    created_at: str = field(default_factory=now_iso)
    quality_notes: list[str] = field(default_factory=list)
    evidence_metrics: dict[str, Any] = field(default_factory=dict)
    validator_result: dict[str, Any] = field(default_factory=dict)
    review_status: str = HumanReviewStatus.NOT_REQUIRED.value


@dataclass
class TechnologyObservation:
    """A technology fingerprint bound to one concrete HTTP(S) URL."""

    url: str
    technology: str
    category: str
    confidence: float
    evidence_type: str
    evidence_path: str = ""
    version: str = ""
    verification_status: str = "suspected"
    source_fact_id: str | None = None
    hypothesis_id: str | None = None
    intent_id: str | None = None
    proposed_by: str = "worker"
    id: str = field(default_factory=lambda: new_id("TECH"))
    observed_at: str = field(default_factory=now_iso)
    last_verified_at: str = field(default_factory=now_iso)


@dataclass
class TargetProfileRecord:
    """One model-observed target function, intentionally limited to three outputs."""

    url: str
    function: str
    technology_stack: list[str] = field(default_factory=list)
    proposed_by: str = "profile_mapper"
    id: str = field(default_factory=lambda: new_id("TP"))
    observed_at: str = field(default_factory=now_iso)


@dataclass
class TargetAssessment:
    """A model judgment used to prioritize a profiled target, not a vulnerability fact.

    ``target_score`` is a scheduling/test priority (0-100). It is not a
    severity and must never be mapped into ``risk_level`` semantics.
    """

    url: str
    profile_class: str
    target_score: int | None = None
    risk_tags: list[str] = field(default_factory=list)
    score_reason: str = ""
    recommended_tests: list[str] = field(default_factory=list)
    target_profile_id: str | None = None
    proposed_by: str = "profile_mapper"
    # Version link to the assessment this record replaces (same URL). History
    # stays append-only; readers always resolve the latest record per URL.
    supersedes: str | None = None
    # Provenance of WHO classified and under which policy. Keeps the boundary
    # for a future shadow classifier (e.g. typed-question model) without
    # assuming anything about its accuracy.
    classification_provenance: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: new_id("TA"))
    assessed_at: str = field(default_factory=now_iso)


@dataclass
class RoutineTargetGroup:
    """A collapsed family of routine display URLs. Routine groups are never scored."""

    label: str
    hostname: str
    url_pattern: str
    member_count: int
    representative_urls: list[str] = field(default_factory=list)
    classification_reason: str = ""
    group_key: str = ""
    proposed_by: str = "profile_mapper"
    id: str = field(default_factory=lambda: new_id("RTG"))
    assessed_at: str = field(default_factory=now_iso)


@dataclass
class EvidenceMetrics:
    """Evidence-derived tri-state metrics used by deterministic validators.

    ``None`` means that the available artifacts do not prove either outcome.
    Values supplied by a model remain assertions until the normalizer can bind
    them to concrete proof references.
    """

    boundary_crossed: bool | None = None
    unauthorized_capability_obtained: bool | None = None
    data_leaked: bool | None = None
    control_bypassed: bool | None = None
    reproducible: bool | None = None
    has_raw_request_response: bool | None = None
    evidence_files_exist: bool | None = None
    result_reliable: bool | None = None
    waf_interference: bool = False
    response_codes: list[int] = field(default_factory=list)
    actual_result_summary: str = ""
    proof_refs: dict[str, list[str]] = field(default_factory=dict)
    validator: str = "generic_boundary_v1"


@dataclass
class NegativeEvidence:
    hypothesis: str
    target: str
    reason: str
    method: str
    valid_until: str
    outcome: str = "blocked"
    evidence_type: str = "inconclusive"
    observed_at: str = field(default_factory=now_iso)
    network_context: str = "default_egress"
    identity_context: str = "anonymous"
    attempts: int = 1
    evidence_paths: list[str] = field(default_factory=list)
    invalidation_triggers: list[str] = field(
        default_factory=lambda: ["ip_changed", "network_egress_changed", "user_forced"]
    )
    proposed_by: str = "worker"
    id: str = field(default_factory=lambda: new_id("NE"))


@dataclass
class HumanVerdict:
    finding_id: str
    action: str
    final_classification: str
    final_severity: str
    reason: str
    duplicate_of_finding_id: str | None = None
    reason_codes: list[str] = field(default_factory=list)
    applicable_scope: str = "current_finding"
    reviewed_by: str = "project_owner"
    machine_classification: str = ""
    machine_severity: str = ""
    model_context: dict[str, Any] = field(default_factory=dict)
    versions: dict[str, str] = field(default_factory=dict)
    id: str = field(default_factory=lambda: new_id("HV"))
    created_at: str = field(default_factory=now_iso)


@dataclass
class RefutationMemory:
    finding_id: str
    original_reason: str
    reason_codes: list[str]
    extracted_principle: str
    vulnerability_type: str
    evidence_pattern: str
    applicable_scope: str = "current_finding"
    hit_count: int = 0
    active: bool = True
    id: str = field(default_factory=lambda: new_id("RM"))
    created_at: str = field(default_factory=now_iso)


@dataclass
class WAFAssessment:
    target: str
    original_hypothesis: str
    status: str = "suspected"
    layer: str = "unknown"
    signals: list[str] = field(default_factory=list)
    baseline_evidence: list[str] = field(default_factory=list)
    blocked_evidence: list[str] = field(default_factory=list)
    allowed_mutation_families: list[str] = field(default_factory=lambda: [
        "encoding_normalization",
        "path_normalization",
        "parameter_structure",
        "method_content_type",
        "parser_differential",
        "session_context",
    ])
    tested_mutation_families: list[str] = field(default_factory=list)
    semantic_preserved: bool | None = None
    differential_found: bool = False
    budget_minutes: int = 12
    used_minutes: int = 0
    requires_human_confirmation: bool = False
    source_negative_evidence_id: str | None = None
    id: str = field(default_factory=lambda: new_id("WAF"))
    created_at: str = field(default_factory=now_iso)


@dataclass
class Intent:
    verb: str
    target: str
    evidence_sink: str
    success_criteria: str
    hypothesis: str = ""
    scope_check: str = ""
    scope_refs: list[str] = field(default_factory=list)
    expected_business_impact: str = ""
    hypothesis_id: str | None = None
    source_fact_ids: list[str] = field(default_factory=list)
    potential_impact: float = 0.0
    boundary_reachability: float = 0.0
    information_gain: float = 0.0
    novelty: float = 0.0
    prerequisite_readiness: float = 0.0
    estimated_cost: float = 0.5
    action_safety_risk: str = "low"
    evidence_maturity: str = "hypothesis"
    priority_score: float = 0.0
    risk_level: str = "low"
    requires_human_confirmation: bool = False
    target_profile_id: str | None = None
    target_score: int | None = None
    risk_tags: list[str] = field(default_factory=list)
    recommended_tests: list[str] = field(default_factory=list)
    proposed_by: str = "worker"
    claimed_by: str | None = None
    lease_expires_at: str | None = None
    parent_id: str | None = None
    chain_id: str | None = None
    sequence: int = 0
    status: str = "open"
    id: str = field(default_factory=lambda: new_id("I"))
    created_at: str = field(default_factory=now_iso)


@dataclass
class AttackHypothesis:
    title: str
    statement: str
    target: str
    dimension: str
    validation_plan: dict[str, Any]
    expected_business_impact: str = ""
    potential_impact: float = 0.5
    boundary_reachability: float = 0.5
    information_gain: float = 0.5
    novelty: float = 0.5
    prerequisite_readiness: float = 0.5
    estimated_cost: float = 0.5
    action_safety_risk: str = "low"
    evidence_maturity: str = "hypothesis"
    score: float = 0.0
    status: str = "proposed"
    source: str = "method_pack"
    run_id: str | None = None
    wave: int = 0
    parent_fact_ids: list[str] = field(default_factory=list)
    intent_ids: list[str] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)
    id: str = field(default_factory=lambda: new_id("AH"))
    created_at: str = field(default_factory=now_iso)


@dataclass
class PlanBatch:
    hypotheses: list[dict[str, Any]]
    selected_hypothesis_ids: list[str] = field(default_factory=list)
    strategy_summary: str = ""
    counterfactual: dict[str, Any] = field(default_factory=dict)
    proposed_by: str = "worker"
    run_id: str | None = None
    wave: int = 0
    id: str = field(default_factory=lambda: new_id("PB"))
    created_at: str = field(default_factory=now_iso)


@dataclass
class Decision:
    action: str
    reason: str
    phase: str
    focus_cost: str | None = None
    counterfactual_hypothesis: str | None = None
    ignored_evidence: str | None = None
    override_rule: str | None = None
    serendipity_minutes: int = 0
    id: str = field(default_factory=lambda: new_id("D"))
    created_at: str = field(default_factory=now_iso)


@dataclass
class Lesson:
    pattern: str
    expiry_conditions: list[str]
    target: str = ""
    hypothesis: str = ""
    method: str = ""
    outcome: str = ""
    evidence_paths: list[str] = field(default_factory=list)
    source_id: str | None = None
    valid_until: str | None = None
    confidence: float = 0.7
    id: str = field(default_factory=lambda: new_id("L"))
    created_at: str = field(default_factory=now_iso)


@dataclass
class Hint:
    content: str
    target: str | None = None
    priority: int = 0
    intervention_type: str = "supplement"
    applies_to_run_id: str | None = None
    source: str = "project_owner"
    scope: str = "project"
    authority: str = "project_owner"
    supersedes_agent_planning: bool = True
    status: str = "open"
    id: str = field(default_factory=lambda: new_id("H"))
    created_at: str = field(default_factory=now_iso)


def to_dict(obj: Any) -> dict[str, Any]:
    return dict(obj.__dict__)
