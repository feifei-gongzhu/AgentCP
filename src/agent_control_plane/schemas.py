from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:10]}"


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
    id: str = field(default_factory=lambda: new_id("F"))
    created_at: str = field(default_factory=now_iso)
    quality_notes: list[str] = field(default_factory=list)
    evidence_metrics: dict[str, Any] = field(default_factory=dict)
    validator_result: dict[str, Any] = field(default_factory=dict)
    review_status: str = HumanReviewStatus.NOT_REQUIRED.value


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
    risk_level: str = "low"
    requires_human_confirmation: bool = False
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
