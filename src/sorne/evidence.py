from __future__ import annotations

import copy
import hashlib
import os
import re
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

_FROZEN_HASH_PREFIX_LENGTH = 16
_SAFE_PATH_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")


class EvidenceReferenceError(ValueError):
    pass


def freeze_worker_result_evidence(
    project_root: Path,
    result: dict[str, Any],
    *,
    run_id: str,
    job_id: str,
    attempt: int,
) -> dict[str, Any]:
    """Replace mutable worker evidence references with immutable attempt copies."""

    frozen_result = copy.deepcopy(result)
    payload = frozen_result.get("payload")
    if not isinstance(payload, dict):
        return frozen_result
    freezer = _EvidenceFreezer(
        project_root,
        run_id=run_id,
        job_id=job_id,
        attempt=attempt,
    )

    def freeze_if_valid(reference: str) -> str:
        try:
            return freezer.freeze_reference(reference)
        except EvidenceReferenceError:
            return reference

    primary = payload.get("evidence_path")
    if isinstance(primary, str) and primary.strip():
        payload["evidence_path"] = freeze_if_valid(primary)

    evidence_paths = payload.get("evidence_paths")
    if isinstance(evidence_paths, list):
        payload["evidence_paths"] = [
            freeze_if_valid(item)
            if isinstance(item, str) and item.strip()
            else item
            for item in evidence_paths
        ]

    metrics = payload.get("evidence_metrics")
    if isinstance(metrics, dict):
        proof_refs = metrics.get("proof_refs")
        if isinstance(proof_refs, dict):
            metrics["proof_refs"] = {
                claim: [
                    freeze_if_valid(item)
                    if isinstance(item, str) and item.strip()
                    else item
                    for item in refs
                ]
                if isinstance(refs, list)
                else refs
                for claim, refs in proof_refs.items()
            }

    observations = payload.get("technology_observations")
    if isinstance(observations, list):
        for observation in observations:
            if not isinstance(observation, dict):
                continue
            path = observation.get("evidence_path")
            if isinstance(path, str) and path.strip():
                observation["evidence_path"] = freeze_if_valid(path)
    return frozen_result


def freeze_external_evidence_file(
    project_root: Path,
    source: Path,
    *,
    run_id: str,
    job_id: str,
    attempt: int,
    basename: str | None = None,
) -> str:
    """Freeze one explicitly supplied operator evidence file.

    Normal worker payloads must use :func:`freeze_worker_result_evidence`, which
    restricts sources to the current project's evidence directory.
    """

    return _EvidenceFreezer(
        project_root,
        run_id=run_id,
        job_id=job_id,
        attempt=attempt,
        allow_external=True,
    ).freeze_file(source, basename=basename)


class _EvidenceFreezer:
    def __init__(
        self,
        project_root: Path,
        *,
        run_id: str,
        job_id: str,
        attempt: int,
        allow_external: bool = False,
    ) -> None:
        for label, value in (("run_id", run_id), ("job_id", job_id)):
            if not _SAFE_PATH_SEGMENT.fullmatch(str(value)):
                raise ValueError(f"非法 {label}: {value}")
        if int(attempt) < 1:
            raise ValueError("attempt 必须大于 0")
        self.project_root = project_root.resolve()
        self.evidence_root = (self.project_root / "evidence").resolve()
        self.attempt_root = (
            self.evidence_root
            / "runs"
            / str(run_id)
            / str(job_id)
            / f"attempt-{int(attempt)}"
        )
        self.allow_external = allow_external
        self._frozen: dict[Path, str] = {}

    def freeze_reference(self, reference: str) -> str:
        source = Path(reference)
        resolved = source.resolve() if source.is_absolute() else (self.project_root / source).resolve()
        if not self.allow_external:
            try:
                resolved.relative_to(self.evidence_root)
            except ValueError as exc:
                raise EvidenceReferenceError(f"证据路径不在当前项目 evidence/ 内: {reference}") from exc
        if resolved.name.endswith(".sha256"):
            raise EvidenceReferenceError(f"摘要 sidecar 不能作为证据: {reference}")
        if resolved.is_file():
            return self.freeze_file(resolved)
        if resolved.is_dir():
            files = sorted(
                item
                for item in resolved.rglob("*")
                if item.is_file() and not item.name.endswith(".sha256")
            )
            if not files:
                raise EvidenceReferenceError(f"证据目录为空: {reference}")
            for item in files:
                self.freeze_file(item)
            return self.attempt_root.relative_to(self.project_root).as_posix()
        raise EvidenceReferenceError(f"证据文件不存在: {reference}")

    def freeze_file(self, source: Path, *, basename: str | None = None) -> str:
        resolved = source.resolve()
        if not self.allow_external:
            try:
                resolved.relative_to(self.evidence_root)
            except ValueError as exc:
                raise EvidenceReferenceError(f"证据路径不在当前项目 evidence/ 内: {source}") from exc
        if not resolved.is_file() or resolved.name.endswith(".sha256"):
            raise EvidenceReferenceError(f"证据文件无效: {source}")
        if resolved in self._frozen:
            return self._frozen[resolved]
        data = resolved.read_bytes()
        if not data:
            raise EvidenceReferenceError(f"证据文件为空: {source}")
        digest = hashlib.sha256(data).hexdigest()
        safe_basename = Path(basename or resolved.name).name
        if not safe_basename or safe_basename.endswith(".sha256"):
            raise ValueError(f"证据文件名无效: {safe_basename}")
        destination = self.attempt_root / (
            f"{digest[:_FROZEN_HASH_PREFIX_LENGTH]}-{safe_basename}"
        )
        _write_once(destination, data)
        _write_once(destination.with_name(destination.name + ".sha256"), f"{digest}\n".encode())
        relative = destination.relative_to(self.project_root).as_posix()
        self._frozen[resolved] = relative
        return relative


def _write_once(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if not path.is_file() or path.read_bytes() != data:
            raise ValueError(f"冻结证据冲突，拒绝覆盖: {path}")
        return
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise


def validated_evidence_file(path: Path, evidence_root: Path) -> bool:
    """Return whether an evidence file is non-empty and digest-consistent."""

    if path.name.endswith(".sha256") or not path.is_file() or path.stat().st_size <= 0:
        return False
    resolved = path.resolve()
    allowed = evidence_root.resolve()
    try:
        relative = resolved.relative_to(allowed)
    except ValueError:
        return False
    sidecar = resolved.with_name(resolved.name + ".sha256")
    frozen_layout = (
        len(relative.parts) >= 5
        and relative.parts[0] == "runs"
        and relative.parts[3].startswith("attempt-")
    )
    if not sidecar.exists():
        return not frozen_layout
    if not sidecar.is_file():
        return False
    try:
        declared = sidecar.read_text(encoding="utf-8").strip().split()[0].casefold()
    except (OSError, UnicodeError, IndexError):
        return False
    if not _SHA256.fullmatch(declared):
        return False
    actual = hashlib.sha256(resolved.read_bytes()).hexdigest()
    if actual != declared:
        return False
    if frozen_layout:
        prefix = resolved.name.split("-", 1)[0].casefold()
        if prefix != actual[:_FROZEN_HASH_PREFIX_LENGTH]:
            return False
    return True


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
        if resolved.is_file() and validated_evidence_file(resolved, allowed):
            return [resolved]
        if resolved.is_dir():
            return [
                item
                for item in resolved.rglob("*")
                if validated_evidence_file(item, allowed)
            ]
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
                if resolved.is_file() and validated_evidence_file(resolved, allowed_root):
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
