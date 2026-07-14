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
    last_discovery_at: str | None = None
    current_decision: str = ControllerAction.CONTINUE.value
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


@dataclass
class Intent:
    verb: str
    target: str
    evidence_sink: str
    success_criteria: str
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
    status: str = "open"
    id: str = field(default_factory=lambda: new_id("H"))
    created_at: str = field(default_factory=now_iso)


def to_dict(obj: Any) -> dict[str, Any]:
    return dict(obj.__dict__)
