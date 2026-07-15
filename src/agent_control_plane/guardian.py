from __future__ import annotations

from pathlib import Path

from .evidence import BoundaryValidator, EvidenceNormalizer
from .schemas import Fact, FactClassification, FactStatus, Intent


class ScopeViolation(RuntimeError):
    pass


GARBAGE_KEYWORDS = (
    "加固评分",
    "依赖版本",
    "安全建议",
    "最佳实践",
    "可能存在",
    "疑似存在",
    "渗透测试建议",
    "缺少安全头",
    "banner 泄露",
    "version disclosure",
)

VERIFICATION_PREDICATES = (
    "运行",
    "触发",
    "观察到",
    "返回",
    "写入",
    "执行",
    "复现",
    "截图",
    "日志",
)

SPECULATIVE_WORDS = ("可能", "疑似", "might", "maybe", "理论上")
UNVERIFIED_MARKERS = ("requires host", "static only", "仅静态", "需要宿主验证", "尚未运行")
CONDITIONAL_MARKERS = ("如果攻击者", "若可以", "一旦能够", "assuming", "if an attacker")
ATTACK_SURFACE_CATEGORIES = {
    "asset",
    "listening_port",
    "electron_config",
    "supply_chain",
    "entitlement",
    "deeplink",
    "other",
}
HARM_MARKERS = (
    "未授权",
    "越权",
    "绕过",
    "接管",
    "批量读取",
    "导出",
    "篡改",
    "删除",
    "任意写入",
    "命令执行",
    "rce",
    "任意代码执行",
    "数据库",
    "订单",
    "账号",
    "session",
    "cookie",
    "jwt",
    "token",
    "密码",
    "密钥",
    "ak/sk",
    "secret",
    "credential",
    "password",
    "private key",
)


class Guardian:
    """Deterministic quality gate for findings.

    Guardian does not decide exploitability. It only prevents unverified claims
    from being promoted to vulnerability.
    """

    def review(self, fact: Fact, project_root: Path | None = None) -> Fact:
        text = f"{fact.title} {fact.evidence}"
        impact_text = f"{fact.title} {fact.business_impact}".casefold()
        notes: list[str] = []
        requested_vulnerability = (
            fact.classification == FactClassification.VULNERABILITY.value
            or fact.status == FactStatus.VULNERABILITY.value
        )

        if any(word in text for word in GARBAGE_KEYWORDS):
            notes.append("命中低价值或垃圾洞关键词，降级为现象。")

        if any(word in text for word in SPECULATIVE_WORDS):
            notes.append("包含投机措辞，不能直接声明漏洞。")

        if any(word in text.casefold() for word in UNVERIFIED_MARKERS):
            notes.append("明确声明未经外部运行验证，降级为现象。")

        if any(word in text.casefold() for word in CONDITIONAL_MARKERS):
            notes.append("存在未实际发生的条件句推测，降级为现象。")

        if len(fact.evidence.strip()) < 30:
            notes.append("证据描述过短，缺少可审计动作。")

        if not any(word in fact.evidence for word in VERIFICATION_PREDICATES):
            notes.append("缺少“我做了 X，观察到 Y”的验证谓词。")

        if len(fact.business_impact.strip()) < 12:
            notes.append("未说明攻击者可造成的具体业务损失，不能升级为漏洞。")

        metrics = EvidenceNormalizer().normalize(fact, project_root)
        if not fact.evidence_path.strip():
            notes.append("漏洞声明缺少可审计的证据落盘路径。")
        elif metrics.evidence_files_exist is not True:
            notes.append("证据文件不存在、为空或不在当前项目 evidence/ 目录内。")
        validator_result = BoundaryValidator().validate(fact, metrics)
        fact.validator_result = validator_result
        notes.extend(validator_result["reasons"])

        has_direct_harm = any(marker.casefold() in impact_text for marker in HARM_MARKERS)
        is_attack_surface_only = fact.category in ATTACK_SURFACE_CATEGORIES and not has_direct_harm

        if is_attack_surface_only:
            notes.append("仅证明信息暴露或攻击面存在，未形成可利用的业务损害闭环。")

        certified = requested_vulnerability and validator_result["certified"] and not notes
        if certified:
            fact.status = FactStatus.VULNERABILITY.value
            fact.classification = FactClassification.VULNERABILITY.value
            fact.impact_score = max(min(float(fact.impact_score or 0.8), 1.0), 0.7)
            fact.confidence = max(fact.confidence, 0.8)
        else:
            if validator_result["certified"] and not requested_vulnerability:
                notes.append("候选结果未声明为漏洞；Guardian 只降不升，保留为风险线索。")
            fact.status = FactStatus.PHENOMENON.value
            if metrics.waf_interference and not validator_result["factor_a"]:
                fact.status = FactStatus.BLOCKER.value
                fact.classification = FactClassification.INCONCLUSIVE.value
            elif fact.classification == FactClassification.NEGATIVE_EVIDENCE.value:
                fact.status = FactStatus.BLOCKER.value
            elif is_attack_surface_only:
                fact.classification = FactClassification.ATTACK_SURFACE.value
            else:
                fact.classification = FactClassification.RISK_LEAD.value
            fact.impact_score = min(max(float(fact.impact_score or 0.0), 0.0), 0.35 if is_attack_surface_only else 0.65)
            fact.confidence = min(fact.confidence, 0.65 if is_attack_surface_only else 0.55)
        fact.quality_notes = list(dict.fromkeys(notes))
        return fact

    def review_intent(self, intent: Intent, target_config: dict) -> Intent:
        if target_config.get("authorization") != "authorized":
            raise ScopeViolation("项目未完成授权确认，Intent 已拒绝。")
        declared_scope = {str(item).strip() for item in target_config.get("scope", []) if str(item).strip()}
        refs = {item.strip() for item in intent.scope_refs if item.strip()}
        if not declared_scope:
            raise ScopeViolation("授权范围为空，Intent 已拒绝。")
        if "*" in declared_scope and not refs:
            intent.scope_refs = ["*"]
            refs = {"*"}
        if "*" not in declared_scope and (not refs or not refs.issubset(declared_scope)):
            raise ScopeViolation("每个 Intent 必须通过 scope_refs 引用已声明的授权范围。")
        target_text = intent.target.casefold()
        for denied in target_config.get("out_of_scope", []):
            denied_text = str(denied).strip().casefold()
            if denied_text and denied_text in target_text:
                raise ScopeViolation(f"Intent 命中不收范围: {denied}")
        if len(intent.scope_check.strip()) < 8:
            raise ScopeViolation("scope_check 过短，无法审计为何没有越界。")
        return intent
