from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .schemas import HumanVerdict, RefutationMemory, now_iso
from .store import ProjectStore


REVIEW_ACTIONS = {
    "accepted",
    "adjusted",
    "refuted",
    "reclassified",
    "retest_requested",
}
FALSE_POSITIVE_ACTIONS = {"refuted", "reclassified"}
CONFIRMED_ACTIONS = {"accepted", "adjusted"}
SEVERITY_ORDER = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


class QualityLedger:
    """Append-only human adjudication and anonymized quality metrics."""

    def review(
        self,
        store: ProjectStore,
        *,
        finding_id: str,
        action: str,
        final_classification: str,
        final_severity: str,
        reason: str,
        reason_codes: list[str] | None = None,
        applicable_scope: str = "current_finding",
        reviewed_by: str = "project_owner",
    ) -> HumanVerdict:
        action = action.strip()
        if action not in REVIEW_ACTIONS:
            raise ValueError(f"不支持的人工裁决动作: {action}")
        if not reason.strip():
            raise ValueError("人工裁决必须填写理由。")
        if final_classification not in {"vulnerability", "risk_lead", "attack_surface", "inconclusive"}:
            raise ValueError(f"不支持的最终分类: {final_classification}")
        if final_severity not in SEVERITY_ORDER:
            raise ValueError(f"不支持的最终等级: {final_severity}")
        if action in CONFIRMED_ACTIONS and final_classification != "vulnerability":
            raise ValueError("认可或调级后，最终分类必须仍为 vulnerability。")
        if action in FALSE_POSITIVE_ACTIONS and final_classification == "vulnerability":
            raise ValueError("驳斥或重新分类时，最终分类不能仍为 vulnerability。")
        facts = store.read_jsonl("facts.jsonl")
        fact = next((item for item in facts if item.get("id") == finding_id), None)
        if fact is None:
            raise ValueError(f"漏洞不存在: {finding_id}")
        if fact.get("classification") != "vulnerability":
            raise ValueError("只有系统漏洞池中的记录可以进行漏洞驳斥。")

        previous = self.latest_verdicts(store).get(finding_id)
        verdict = HumanVerdict(
            finding_id=finding_id,
            action=action,
            final_classification=final_classification,
            final_severity=final_severity,
            reason=reason.strip(),
            reason_codes=list(dict.fromkeys(reason_codes or [])),
            applicable_scope=applicable_scope,
            reviewed_by=reviewed_by,
            machine_classification=str(fact.get("classification", "")),
            machine_severity=str(fact.get("severity", "unknown")),
            model_context={"proposed_by": fact.get("proposed_by", "worker")},
            versions={
                "guardian": "2.1.0",
                "normalizer": "1.0.0",
                "evidence_policy": str((fact.get("validator_result") or {}).get("validator", "unknown")),
            },
        )
        store.append_jsonl("human_verdicts.jsonl", verdict)
        self._append_global(store, verdict, fact)
        if action in FALSE_POSITIVE_ACTIONS:
            memory = RefutationMemory(
                finding_id=finding_id,
                original_reason=verdict.reason,
                reason_codes=verdict.reason_codes,
                extracted_principle=self._principle(verdict),
                vulnerability_type=str(fact.get("category", "other")),
                evidence_pattern=self._evidence_pattern(fact, verdict),
                applicable_scope=applicable_scope,
            )
            store.append_jsonl("refutation_memories.jsonl", memory)
        self._update_state(store, previous, verdict)
        return verdict

    @staticmethod
    def latest_verdicts(store: ProjectStore) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        for item in store.read_jsonl("human_verdicts.jsonl"):
            finding_id = str(item.get("finding_id", ""))
            if finding_id:
                result[finding_id] = item
        return result

    def project_metrics(self, store: ProjectStore) -> dict[str, Any]:
        verdicts = list(self.latest_verdicts(store).values())
        reviewed = [item for item in verdicts if item.get("action") != "retest_requested"]
        false_positives = [item for item in reviewed if item.get("action") in FALSE_POSITIVE_ACTIONS]
        confirmed = [item for item in reviewed if item.get("action") in CONFIRMED_ACTIONS]
        adjusted = [item for item in confirmed if item.get("action") == "adjusted"]
        overestimated = 0
        underestimated = 0
        exact = 0
        for item in confirmed:
            machine = SEVERITY_ORDER.get(str(item.get("machine_severity", "")).casefold())
            human = SEVERITY_ORDER.get(str(item.get("final_severity", "")).casefold())
            if machine is None or human is None:
                continue
            if machine > human:
                overestimated += 1
            elif machine < human:
                underestimated += 1
            else:
                exact += 1
        denominator = len(reviewed)
        confirmed_denominator = len(confirmed)
        return {
            "system_vulnerabilities": sum(
                1 for item in store.read_jsonl("facts.jsonl")
                if item.get("classification") == "vulnerability"
            ),
            "reviewed": denominator,
            "pending": max(0, sum(
                1 for item in store.read_jsonl("facts.jsonl")
                if item.get("classification") == "vulnerability"
            ) - sum(1 for item in verdicts if item.get("action") != "retest_requested")),
            "confirmed": len(confirmed),
            "false_positives": len(false_positives),
            "false_positive_rate": len(false_positives) / denominator if denominator else None,
            "confirmation_rate": len(confirmed) / denominator if denominator else None,
            "severity_adjusted": len(adjusted),
            "severity_overestimate_rate": overestimated / confirmed_denominator if confirmed_denominator else None,
            "severity_underestimate_rate": underestimated / confirmed_denominator if confirmed_denominator else None,
            "severity_exact_rate": exact / confirmed_denominator if confirmed_denominator else None,
            "sample_size": denominator,
            "sample_quality": self._sample_quality(denominator),
        }

    def global_metrics(self, store: ProjectStore) -> dict[str, Any]:
        destination = store.path.parent / ".quality" / "quality_ledger.jsonl"
        if not destination.exists():
            return self._aggregate_global([])
        latest: dict[str, dict[str, Any]] = {}
        for line in destination.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            key = f"{item.get('project_hash')}:{item.get('finding_id_hash')}"
            latest[key] = item
        return self._aggregate_global(list(latest.values()))

    def _aggregate_global(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        reviewed = [item for item in items if item.get("human_action") != "retest_requested"]
        false_positives = [item for item in reviewed if item.get("human_action") in FALSE_POSITIVE_ACTIONS]
        confirmed = [item for item in reviewed if item.get("human_action") in CONFIRMED_ACTIONS]
        by_guardian: dict[str, dict[str, int]] = {}
        for item in reviewed:
            version = str((item.get("versions") or {}).get("guardian", "unknown"))
            bucket = by_guardian.setdefault(version, {"reviewed": 0, "false_positives": 0})
            bucket["reviewed"] += 1
            if item.get("human_action") in FALSE_POSITIVE_ACTIONS:
                bucket["false_positives"] += 1
        versions = {
            version: {
                **values,
                "false_positive_rate": values["false_positives"] / values["reviewed"] if values["reviewed"] else None,
            }
            for version, values in by_guardian.items()
        }
        denominator = len(reviewed)
        patterns: dict[str, dict[str, Any]] = {}
        for item in false_positives:
            codes = sorted(str(code) for code in item.get("reason_codes", []))
            key = f"{item.get('vulnerability_type','other')}|{','.join(codes)}"
            bucket = patterns.setdefault(key, {
                "vulnerability_type": item.get("vulnerability_type", "other"),
                "reason_codes": codes,
                "count": 0,
                "projects": set(),
            })
            bucket["count"] += 1
            bucket["projects"].add(item.get("project_hash"))
        rule_suggestions = [
            {
                "vulnerability_type": value["vulnerability_type"],
                "reason_codes": value["reason_codes"],
                "count": value["count"],
                "distinct_projects": len(value["projects"]),
                "recommendation": "生成 Guardian 规则候选并在历史证据上回放，人工批准后再启用。",
            }
            for value in patterns.values()
            if value["count"] >= 3
        ]
        return {
            "reviewed": denominator,
            "confirmed": len(confirmed),
            "false_positives": len(false_positives),
            "false_positive_rate": len(false_positives) / denominator if denominator else None,
            "sample_size": denominator,
            "sample_quality": self._sample_quality(denominator),
            "by_guardian_version": versions,
            "rule_suggestions": sorted(rule_suggestions, key=lambda item: item["count"], reverse=True),
        }

    def _append_global(self, store: ProjectStore, verdict: HumanVerdict, fact: dict[str, Any]) -> None:
        root = store.path.parent / ".quality"
        root.mkdir(parents=True, exist_ok=True)
        record = {
            "id": verdict.id,
            "project_hash": hashlib.sha256(store.vendor.encode("utf-8")).hexdigest(),
            "project_type": store.read_json("target.json").get("project_type", "unknown"),
            "finding_id_hash": hashlib.sha256(verdict.finding_id.encode("utf-8")).hexdigest(),
            "vulnerability_type": fact.get("category", "other"),
            "machine_classification": verdict.machine_classification,
            "machine_severity": verdict.machine_severity,
            "human_action": verdict.action,
            "human_classification": verdict.final_classification,
            "human_severity": verdict.final_severity,
            "reason_codes": verdict.reason_codes,
            "applicable_scope": verdict.applicable_scope,
            "model_context": verdict.model_context,
            "versions": verdict.versions,
            "created_at": verdict.created_at,
        }
        destination = root / "quality_ledger.jsonl"
        with destination.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    @staticmethod
    def _update_state(
        store: ProjectStore,
        previous: dict[str, Any] | None,
        verdict: HumanVerdict,
    ) -> None:
        state = store.load_state()
        was_pending = previous is None or previous.get("action") == "retest_requested"
        is_pending = verdict.action == "retest_requested"
        if previous:
            if previous.get("action") in CONFIRMED_ACTIONS:
                state.human_confirmed_count = max(0, state.human_confirmed_count - 1)
            elif previous.get("action") in FALSE_POSITIVE_ACTIONS:
                state.human_refuted_count = max(0, state.human_refuted_count - 1)
        if was_pending and not is_pending:
            state.pending_human_review_count = max(0, state.pending_human_review_count - 1)
        elif not was_pending and is_pending:
            state.pending_human_review_count += 1
        if verdict.action in CONFIRMED_ACTIONS:
            state.human_confirmed_count += 1
        elif verdict.action in FALSE_POSITIVE_ACTIONS:
            state.human_refuted_count += 1
        store.save_state(state)

    @staticmethod
    def _principle(verdict: HumanVerdict) -> str:
        codes = "、".join(verdict.reason_codes)
        prefix = f"人工反例标签：{codes}。" if codes else ""
        return (prefix + verdict.reason).strip()[:1000]

    @staticmethod
    def _evidence_pattern(fact: dict[str, Any], verdict: HumanVerdict) -> str:
        metrics = fact.get("evidence_metrics") or {}
        codes = ",".join(str(item) for item in metrics.get("response_codes", []))
        return f"{fact.get('category','other')}|http={codes}|reasons={','.join(verdict.reason_codes)}"

    @staticmethod
    def _sample_quality(size: int) -> str:
        if size < 5:
            return "样本严重不足"
        if size < 20:
            return "仅供参考"
        if size < 50:
            return "中等可信"
        return "趋势较稳定"
