from __future__ import annotations

from dataclasses import asdict, fields
from pathlib import Path
from typing import Any

from .schemas import EvidenceMetrics, Fact


HTTP_EVIDENCE_CATEGORIES = {
    "api_endpoint",
    "business_logic",
    "priv_esc_path",
    "authentication",
    "authorization",
    "ssrf",
    "injection",
    "web",
}


class EvidenceNormalizer:
    """Turn worker assertions into evidence-bound, tri-state metrics.

    A model-provided boolean is not treated as proof by itself. Positive
    boundary assertions require at least one valid proof reference inside the
    project's evidence directory.
    """

    def normalize(self, fact: Fact, project_root: Path | None = None) -> EvidenceMetrics:
        raw = fact.evidence_metrics if isinstance(fact.evidence_metrics, dict) else {}
        allowed = {item.name for item in fields(EvidenceMetrics)}
        values = {key: value for key, value in raw.items() if key in allowed}
        metrics = EvidenceMetrics(**values)
        metrics.response_codes = self._response_codes(metrics.response_codes)
        metrics.actual_result_summary = str(
            metrics.actual_result_summary or fact.evidence
        ).strip()[:1200]

        valid_files = self._evidence_files(fact, project_root)
        metrics.evidence_files_exist = bool(valid_files)
        metrics.proof_refs = self._validated_proof_refs(
            metrics.proof_refs, project_root
        )

        for name in (
            "boundary_crossed",
            "unauthorized_capability_obtained",
            "data_leaked",
            "control_bypassed",
        ):
            if getattr(metrics, name) is True and not metrics.proof_refs.get(name):
                setattr(metrics, name, None)

        request_refs = metrics.proof_refs.get("raw_request", []) or metrics.proof_refs.get("request", [])
        response_refs = metrics.proof_refs.get("raw_response", []) or metrics.proof_refs.get("response", [])
        if metrics.has_raw_request_response is True and not (request_refs and response_refs):
            metrics.has_raw_request_response = None

        if metrics.reproducible is True and not fact.reproduction_steps:
            metrics.reproducible = None

        fact.evidence_metrics = asdict(metrics)
        return metrics

    @staticmethod
    def _response_codes(values: Any) -> list[int]:
        result: list[int] = []
        for value in values or []:
            try:
                code = int(value)
            except (TypeError, ValueError):
                continue
            if 100 <= code <= 599 and code not in result:
                result.append(code)
        return result

    @staticmethod
    def _evidence_files(fact: Fact, project_root: Path | None) -> list[Path]:
        if project_root is None or not fact.evidence_path:
            return []
        allowed = (project_root / "evidence").resolve()
        candidate = Path(fact.evidence_path)
        resolved = candidate.resolve() if candidate.is_absolute() else (project_root / candidate).resolve()
        try:
            resolved.relative_to(allowed)
        except ValueError:
            return []
        if resolved.is_file() and resolved.stat().st_size > 0:
            return [resolved]
        if resolved.is_dir():
            return [item for item in resolved.rglob("*") if item.is_file() and item.stat().st_size > 0]
        return []

    @staticmethod
    def _validated_proof_refs(
        raw: Any,
        project_root: Path | None,
    ) -> dict[str, list[str]]:
        if not isinstance(raw, dict) or project_root is None:
            return {}
        allowed_root = (project_root / "evidence").resolve()
        result: dict[str, list[str]] = {}
        for claim, refs in raw.items():
            accepted: list[str] = []
            for ref in refs if isinstance(refs, list) else []:
                path = Path(str(ref))
                resolved = path.resolve() if path.is_absolute() else (project_root / path).resolve()
                try:
                    resolved.relative_to(allowed_root)
                except ValueError:
                    continue
                if resolved.is_file() and resolved.stat().st_size > 0:
                    accepted.append(resolved.relative_to(project_root).as_posix())
            if accepted:
                result[str(claim)] = accepted
        return result


class BoundaryValidator:
    """Deterministic A+B certification for a proposed vulnerability."""

    VERSION = "generic_boundary_v1"

    def validate(self, fact: Fact, metrics: EvidenceMetrics) -> dict[str, Any]:
        factor_a_claims = [
            name
            for name in (
                "boundary_crossed",
                "unauthorized_capability_obtained",
                "data_leaked",
                "control_bypassed",
            )
            if getattr(metrics, name) is True
        ]
        requires_http_pair = fact.category in HTTP_EVIDENCE_CATEGORIES
        factor_b_checks = {
            "reproducible": metrics.reproducible is True,
            "evidence_files_exist": metrics.evidence_files_exist is True,
            "result_reliable": metrics.result_reliable is True,
            "raw_request_response": (
                metrics.has_raw_request_response is True if requires_http_pair else True
            ),
        }
        factor_a = bool(factor_a_claims)
        factor_b = all(factor_b_checks.values())
        certified = factor_a and factor_b
        reasons: list[str] = []
        if not factor_a:
            reasons.append("没有证据绑定的安全边界突破指标。")
        for name, passed in factor_b_checks.items():
            if not passed:
                reasons.append(f"可复核条件未满足: {name}")
        if metrics.waf_interference and not metrics.control_bypassed:
            certified = False
            reasons.append("结果受到 WAF 干扰，且没有证明安全控制被稳定绕过。")
        return {
            "validator": self.VERSION,
            "factor_a": factor_a,
            "factor_a_claims": factor_a_claims,
            "factor_b": factor_b,
            "factor_b_checks": factor_b_checks,
            "certified": certified,
            "reasons": reasons,
        }
