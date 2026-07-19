from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .database import ControlDatabase
from .schemas import AttackHypothesis, Fact, Intent
from .store import CHECKLIST_FILE, ProjectStore


@dataclass(frozen=True)
class MethodDimension:
    id: str
    name: str
    objective: str
    seed_verb: str
    success_criteria: str
    potential_impact: float


@dataclass(frozen=True)
class MethodPack:
    id: str
    name: str
    project_family: str
    version: str
    dimensions: tuple[MethodDimension, ...]


WEB_DIMENSIONS = (
    MethodDimension("api_endpoint", "API 路由挖掘", "识别未直接暴露的 API 与对象边界", "inspect", "确认至少一个可达 API，并记录请求方法、鉴权要求和响应结构", 0.75),
    MethodDimension("listening_port_service", "外网端口与服务", "识别外网服务及可能被 SSRF 触达的边界", "inspect", "确认端口、协议、服务指纹与访问控制状态", 0.65),
    MethodDimension("priv_esc_path", "越权与鉴权边界", "找到对象级、功能级或租户级权限边界", "verify", "得到两组身份或对象对照所需的可复核请求模板", 0.95),
    MethodDimension("asset_web_directory", "目录与资产发现", "补齐主机、路径、静态文件和环境资产", "inspect", "发现新的存活资产或可解析路径，并给出去重证据", 0.55),
    MethodDimension("framework_config", "框架指纹与配置缺陷", "确认框架及高价值运维、调试、文档端点", "inspect", "获取可复核的框架证据或配置端点响应", 0.7),
    MethodDimension("parser_target", "输入解析与反序列化", "定位复杂解析器、上传、转换和反序列化入口", "inspect", "确认解析器入口、内容类型与可控字段", 0.9),
    MethodDimension("supply_chain_third_party", "供应链与三方组件", "识别可达组件、版本与信任边界", "inspect", "确认组件和版本的双重证据，并记录可达前置", 0.65),
    MethodDimension("credential_leak", "外泄凭据检索", "在公开资产与静态资源中定位可验证的凭据线索", "inspect", "确认凭据格式、归属和最小无害有效性验证条件", 0.95),
    MethodDimension("cloud_entitlement", "云原生权限边界", "识别对象存储、元数据、身份与云服务授权边界", "inspect", "确认云服务入口与当前身份可见权限，不执行数据修改", 0.9),
    MethodDimension("business_logic", "业务逻辑黑盒对抗", "从资金、账户、隐私、配额和流程完整性反推滥用路径", "inspect", "建立至少一条业务损失假设及其最小可验证前置", 1.0),
)


CLIENT_DIMENSIONS = (
    MethodDimension("ipc_endpoint", "IPC 与本地通信", "识别本地 IPC、RPC、WebSocket 及信任边界", "inspect", "确认通信入口、调用方与鉴权前置", 0.9),
    MethodDimension("listening_port", "本地监听服务", "识别本地端口、协议与访问边界", "inspect", "确认端口、协议、进程归属和访问控制", 0.7),
    MethodDimension("lpe_path", "本地提权路径", "识别高权进程、服务、助手程序与低权输入", "inspect", "确认高权组件及其可控输入面", 1.0),
    MethodDimension("asset", "文件与资产信任", "检查安装目录、更新、配置与文件信任", "inspect", "确认可写资产与高权消费方之间的边界", 0.85),
    MethodDimension("electron_config", "WebView 与 Electron 配置", "识别渲染进程和原生能力之间的隔离", "inspect", "确认 contextIsolation、nodeIntegration、preload 和导航策略", 0.9),
    MethodDimension("parser_target", "解析器与 FFI", "定位文件、协议、原生库与复杂解析入口", "inspect", "确认可控样本到解析器的完整路径", 0.95),
    MethodDimension("supply_chain", "供应链与更新", "识别更新、签名、依赖与下载信任边界", "inspect", "确认更新链的校验节点和依赖版本", 0.9),
    MethodDimension("credential_leak", "客户端凭据与隐私", "检查日志、配置、缓存、崩溃与本地存储", "inspect", "确认敏感数据类型、保护措施和可达身份", 0.9),
    MethodDimension("entitlement", "权限与沙箱边界", "识别权限声明、沙箱例外与跨进程能力", "inspect", "确认高价值权限及其真实调用点", 0.85),
    MethodDimension("deeplink", "深链、文件关联与生命周期", "识别外部输入到客户端特权功能的路由", "inspect", "确认可从外部触发的路由、参数与安全检查", 0.8),
)


WEB_PACK = MethodPack("agentcp-web-v3", "Web 渗透 Method Pack", "web", "3.2", WEB_DIMENSIONS)
CLIENT_PACK = MethodPack("agentcp-client-v3", "客户端漏洞挖掘 Method Pack", "client", "3.2", CLIENT_DIMENSIONS)


FOLLOW_UPS = {
    "web": {
        "api_endpoint": ("priv_esc_path", "验证已观察 API 的对象级与功能级授权边界", "得到匿名/已登录或两组对象的可复核对照请求；无测试身份时只建立请求模板"),
        "listening_port_service": ("framework_config", "检查已确认服务的运维、调试与文档边界", "确认一个具体管理或配置入口的可达性与鉴权状态"),
        "asset_web_directory": ("api_endpoint", "从已确认资产中提取业务 API 和对象标识边界", "确认至少一个静态路由之外的业务 API 请求模板"),
        "framework_config": ("parser_target", "根据已确认框架定位高价值输入解析入口", "确认解析器、内容类型、可控字段和最小无害样本"),
        "parser_target": ("business_logic", "确认已观察解析入口会否改变业务对象或安全边界", "得到正常样本与单变量差分样本的可复核结果"),
        "credential_leak": ("cloud_entitlement", "确认凭据线索的归属、有效性和最小权限边界", "在不读取业务数据的前提下得到凭据格式、归属与无害有效性结果"),
    },
    "client": {
        "ipc_endpoint": ("lpe_path", "检查已观察 IPC 调用方与高权能力之间的授权边界", "确认调用者身份检查与一个最小无害高权动作路由"),
        "listening_port": ("ipc_endpoint", "验证已观察本地服务的调用方、鉴权与信任边界", "得到本机/非本机访问与协议鉴权的可复核对照"),
        "asset": ("lpe_path", "检查可写资产是否会被更高权限组件消费", "确认写入方、消费方、权限差与无害触发点"),
        "electron_config": ("ipc_endpoint", "从渲染进程配置追踪到原生能力的真实可达路径", "确认 preload/IPC 暴露函数、参数和调用方约束"),
        "parser_target": ("lpe_path", "确认已观察解析器是否处于高权或跨沙箱边界", "得到可控样本到解析进程权限的完整路径"),
        "credential_leak": ("entitlement", "验证本地敏感线索的归属与最小能力边界", "在不扩大数据读取的前提下确认线索是否绑定真实权限"),
    },
}


def method_pack_for_target(target: dict[str, Any]) -> MethodPack:
    project_type = str(target.get("project_type") or "").casefold()
    if any(marker in project_type for marker in ("web", "api", "web渗透", "网站", "网页")):
        return WEB_PACK
    return CLIENT_PACK


def dynamic_checklist(target: dict[str, Any], pack: MethodPack, previous: dict[str, Any] | None = None) -> dict[str, Any]:
    previous = previous or {}
    out_of_scope = list(dict.fromkeys(str(item) for item in target.get("out_of_scope", []) if str(item).strip()))
    owner_red_lines = [
        str(item) for item in previous.get("red_lines", [])
        if str(item).strip() and str(item) not in out_of_scope
    ]
    return {
        "version": "3.2",
        "method_pack_id": pack.id,
        "project_family": pack.project_family,
        "generated_from": {
            "targets": target.get("targets", []),
            "has_local_source": bool(str(target.get("target_path") or "").strip()),
            "project_type": target.get("project_type", ""),
        },
        "red_lines": list(dict.fromkeys(out_of_scope + owner_red_lines)),
        "preconditions": [
            "所有动作必须绑定当前项目目标和证据路径",
            "执行前查询尚在有效期的负向证据和人工驳斥记忆",
            "漏洞成立必须完成安全边界突破与可复核证据双因子闭环",
        ],
        "human_confirmation": [
            "可能造成生产数据修改、删除或业务中断的动作",
            "高强度并发、口令爆破、持久化、社工或第三方边界扩展",
            "明确超出当前 Method Pack 最小无害验证的动作",
        ],
        "phase_gates": {
            "intake": "目标、项目类型、授权和不收范围已写入",
            "phase_0_5_probe": "对主要目标得到 GREEN/RED/GRAY 可达性判定",
            "recon": "十维攻击面至少产生一组可执行假设",
            "hunt": "高分假设正在执行或已形成可复用负向证据",
            "verify": "候选漏洞进入 Guardian 与人工复核",
            "report": "证据、哈希、人工结论与修复建议完整",
        },
        "dimensions": [asdict(item) for item in pack.dimensions],
    }


def ensure_methodology(store: ProjectStore, database: ControlDatabase | None = None) -> dict[str, Any]:
    target = store.read_json("target.json")
    pack = method_pack_for_target(target)
    previous = store.read_json("checklist.json") if (store.path / "checklist.json").exists() else {}
    checklist = dynamic_checklist(target, pack, previous)
    store.write_json("method_pack.json", {
        "id": pack.id,
        "name": pack.name,
        "project_family": pack.project_family,
        "version": pack.version,
        "dimensions": [asdict(item) for item in pack.dimensions],
    })
    store.write_json("checklist.json", checklist)
    store.write_text(CHECKLIST_FILE, json.dumps(checklist, ensure_ascii=False, indent=2) + "\n")
    seeded = seed_portfolio(store, pack, database)
    from .phase import reconcile_phase
    reconcile_phase(store, "method_pack_ready")
    return {"method_pack": pack.id, "seeded": seeded, "checklist": checklist}


def seed_portfolio(store: ProjectStore, pack: MethodPack, database: ControlDatabase | None = None) -> int:
    target = store.read_json("target.json")
    targets = [str(item).strip() for item in target.get("targets", []) if str(item).strip()]
    target_path = str(target.get("target_path") or "").strip()
    primary = targets[0] if targets else target_path
    if not primary:
        return 0
    existing = {
        _hypothesis_fingerprint(item)
        for item in store.read_jsonl("hypotheses.jsonl")
    }
    created = 0
    for dimension in pack.dimensions:
        hypothesis = AttackHypothesis(
            title=f"{dimension.name}：{primary}",
            statement=f"{primary} 在「{dimension.name}」维度可能存在尚未验证的安全边界",
            target=primary,
            dimension=dimension.id,
            validation_plan={
                "verb": dimension.seed_verb,
                "evidence_sink": f"evidence/v3/{dimension.id}-baseline.txt",
                "success_criteria": dimension.success_criteria,
                "method": dimension.objective,
            },
            expected_business_impact=f"若安全边界成立，评估「{dimension.name}」对业务资产、账户或数据的实际影响",
            potential_impact=dimension.potential_impact,
            boundary_reachability=0.45,
            information_gain=0.8,
            novelty=0.7,
            prerequisite_readiness=0.8,
            estimated_cost=0.25,
            action_safety_risk="low",
            source="method_pack_seed",
        )
        fingerprint = _hypothesis_fingerprint(asdict(hypothesis))
        if fingerprint in existing:
            continue
        intent = intent_from_hypothesis(hypothesis)
        hypothesis.intent_ids.append(intent.id)
        hypothesis.status = "selected"
        store.append_jsonl("hypotheses.jsonl", hypothesis)
        store.append_jsonl("intents.jsonl", intent)
        if database is not None:
            database.register_direction(asdict(intent))
        existing.add(fingerprint)
        created += 1
    return created


def intent_from_hypothesis(hypothesis: AttackHypothesis) -> Intent:
    plan = hypothesis.validation_plan
    score = score_hypothesis(asdict(hypothesis))
    return Intent(
        verb=str(plan.get("verb") or "inspect"),
        target=hypothesis.target,
        evidence_sink=str(plan.get("evidence_sink") or f"evidence/v3/{hypothesis.id}.txt"),
        success_criteria=str(plan.get("success_criteria") or "得到可复核的实际结果"),
        hypothesis=hypothesis.statement,
        hypothesis_id=hypothesis.id,
        scope_check="项目所有测试目标已统一授权",
        scope_refs=["*"],
        expected_business_impact=hypothesis.expected_business_impact,
        potential_impact=hypothesis.potential_impact,
        boundary_reachability=hypothesis.boundary_reachability,
        information_gain=hypothesis.information_gain,
        novelty=hypothesis.novelty,
        prerequisite_readiness=hypothesis.prerequisite_readiness,
        estimated_cost=hypothesis.estimated_cost,
        action_safety_risk=hypothesis.action_safety_risk,
        evidence_maturity=hypothesis.evidence_maturity,
        priority_score=score,
        risk_level=_legacy_risk(hypothesis.potential_impact),
        requires_human_confirmation=hypothesis.action_safety_risk in {"high", "critical"},
        chain_id=hypothesis.id,
    )


def score_hypothesis(item: dict[str, Any]) -> float:
    def number(name: str, default: float = 0.5) -> float:
        try:
            return max(0.0, min(1.0, float(item.get(name, default))))
        except (TypeError, ValueError):
            return default

    score = (
        0.25 * number("potential_impact")
        + 0.20 * number("boundary_reachability")
        + 0.20 * number("information_gain")
        + 0.15 * number("novelty")
        + 0.15 * number("prerequisite_readiness")
        - 0.15 * number("estimated_cost")
    )
    return round(max(0.0, min(1.0, score)), 4)


def derive_bounded_follow_up(
    store: ProjectStore,
    fact: Fact,
    database: ControlDatabase | None = None,
) -> AttackHypothesis | None:
    """Promote one observed surface into one adjacent boundary hypothesis."""
    if fact.classification not in {"attack_surface", "risk_lead"} or not fact.assets:
        return None
    if not (store.path / "method_pack.json").exists():
        return None
    pack_data = store.read_json("method_pack.json")
    family = str(pack_data.get("project_family") or "client")
    rule = FOLLOW_UPS.get(family, {}).get(fact.category)
    if not rule:
        return None
    dimension, statement, success_criteria = rule
    target = str(fact.assets[0]).strip()
    if not target:
        return None
    hypothesis = AttackHypothesis(
        title=f"{dimension}：{target} 的边界升级验证",
        statement=f"{target}：{statement}",
        target=target,
        dimension=dimension,
        validation_plan={
            "verb": "inspect",
            "evidence_sink": f"evidence/v3/follow-up-{fact.id}.txt",
            "success_criteria": success_criteria,
            "method": "仅执行一个相邻安全边界的最小无害差分验证",
        },
        expected_business_impact=fact.business_impact,
        potential_impact=max(0.55, min(1.0, float(fact.impact_score or 0.55) + 0.2)),
        boundary_reachability=max(0.5, min(0.9, float(fact.confidence))),
        information_gain=0.85,
        novelty=0.7,
        prerequisite_readiness=0.8,
        estimated_cost=0.25,
        action_safety_risk="low",
        evidence_maturity="observed",
        source="fact_follow_up",
        parent_fact_ids=[fact.id],
        run_id=store.load_state().active_run_id,
    )
    fingerprint = _hypothesis_fingerprint(asdict(hypothesis))
    if any(
        _hypothesis_fingerprint(item) == fingerprint
        for item in store.read_jsonl("hypotheses.jsonl")
    ):
        return None
    intent = intent_from_hypothesis(hypothesis)
    hypothesis.intent_ids.append(intent.id)
    hypothesis.status = "selected"
    store.append_jsonl("hypotheses.jsonl", hypothesis)
    store.append_jsonl("intents.jsonl", intent)
    if database is not None:
        database.register_direction(asdict(intent))
    return hypothesis


def _legacy_risk(impact: float) -> str:
    if impact >= 0.9:
        return "critical"
    if impact >= 0.7:
        return "high"
    if impact >= 0.4:
        return "medium"
    return "low"


def _hypothesis_fingerprint(item: dict[str, Any]) -> str:
    identity = "\x1f".join(
        str(item.get(key, "")).strip().casefold()
        for key in ("statement", "target", "dimension")
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()
