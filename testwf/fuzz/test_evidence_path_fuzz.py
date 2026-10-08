"""evidence 层路径越界模糊测试：freeze_worker_result_evidence /
_EvidenceFreezer.freeze_reference 对 "../"、绝对路径、NUL、超长、unicode 输入。

断言：worker 结果冻结只吞 EvidenceReferenceError、返回类型稳定、
冻结产物永远落在项目 evidence/ 内；run_id/job_id 非法段只允许 ValueError。
"""

from __future__ import annotations

import random
from pathlib import Path

import pytest

from src.sorne.evidence import (
    EvidenceReferenceError,
    freeze_external_evidence_file,
    freeze_worker_result_evidence,
    validated_evidence_file,
)

SEED = 20261008


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    evidence = root / "evidence"
    evidence.mkdir(parents=True)
    (evidence / "result.txt").write_text("verified", encoding="utf-8")
    (evidence / "deep").mkdir()
    (evidence / "deep" / "shot.png").write_text("png", encoding="utf-8")
    return root


def _frozen_paths(root: Path) -> set[Path]:
    return {
        item.resolve()
        for item in (root / "evidence" / "runs").rglob("*")
        if item.is_file()
    }


def test_freeze_worker_result_traversal_references_type_stable(project: Path) -> None:
    rng = random.Random(SEED)
    references = [
        "../../etc/passwd", "/etc/passwd", "evidence/../../escape", "..\\..\\win",
        "evidence/result.txt", "evidence/./result.txt", "evidence//result.txt",
        "evidence/result.txt.sha256", "evidence/deep", "evidence/deep/shot.png",
        "evidence/nope.txt", "", "  ", "//etc/passwd", "evidence/" + "a/" * 60 + "x",
        "evidence/result.txt/../../result.txt", "evidence/deep/../result.txt",
        "proofs/../../../etc/hosts", ".", "..", "evidence", "evidence/",
    ]
    # 注意：NUL 字符单独由 xfail 缺陷用例覆盖，这里不混入。
    for _ in range(300):
        references.append("".join(
            rng.choice(["../", "evidence/", "runs/", "..\\", "./", "x/", "\u4e2d/", "", "\x1b"])
            for _ in range(rng.randint(1, 8))
        ) + rng.choice(["result.txt", "", "x", ".sha256"]))
    for reference in references:
        result = freeze_worker_result_evidence(
            project,
            {"payload": {"evidence_path": reference, "evidence_paths": [reference, None, 123]}},
            run_id="RUN-1", job_id="JOB-1", attempt=1,
        )
        assert isinstance(result, dict)
        for frozen in _frozen_paths(project):
            assert frozen.relative_to(project.resolve()).parts[0] == "evidence"


def test_freeze_worker_result_non_dict_payload_passthrough(project: Path) -> None:
    for payload in [None, [], "text", 123, {"payload": "not-a-dict"}]:
        result = freeze_worker_result_evidence(
            project, {"payload": payload}, run_id="RUN-1", job_id="JOB-1", attempt=1,
        )
        assert isinstance(result, dict)


def test_freezer_rejects_escape_with_evidence_reference_error(project: Path) -> None:
    from src.sorne.evidence import _EvidenceFreezer

    freezer = _EvidenceFreezer(project, run_id="RUN-1", job_id="JOB-1", attempt=1)
    for reference in ["../../etc/passwd", "/etc/passwd", "evidence/../../escape"]:
        with pytest.raises(EvidenceReferenceError):
            freezer.freeze_reference(reference)


def test_run_id_job_id_invalid_segments_raise_value_error_only(project: Path) -> None:
    rng = random.Random(SEED + 1)
    # 语料中的每个字符都在 _SAFE_PATH_SEGMENT 字符集之外，保证 fullmatch 失败。
    # （"." / ".." 能通过该正则——属于宽松但目标仍在 evidence/ 内，不算崩溃缺陷。）
    bad_segments = ["../x", "RUN 1", " RUN", "RUN/x", "RUN\\x", "RUé", "", "\x00run"]
    for _ in range(200):
        bad_segments.append("".join(rng.choice(" /\\é\x00:*?") for _ in range(rng.randint(1, 10))))
    for segment in set(bad_segments):
        with pytest.raises(ValueError):
            freeze_worker_result_evidence(
                project, {"payload": {}}, run_id=segment, job_id="JOB-1", attempt=1,
            )


def test_attempt_must_be_positive(project: Path) -> None:
    for attempt in [0, -1, -100]:
        with pytest.raises(ValueError):
            freeze_worker_result_evidence(
                project, {"payload": {}}, run_id="RUN-1", job_id="JOB-1", attempt=attempt,
            )


def test_freeze_external_file_lands_inside_project_evidence(project: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("external", encoding="utf-8")
    relative = freeze_external_evidence_file(
        project, outside, run_id="RUN-2", job_id="JOB-2", attempt=1,
    )
    destination = project / relative
    assert destination.resolve().relative_to((project / "evidence").resolve())
    assert destination.is_file()


def test_validated_evidence_file_weird_inputs_return_bool(project: Path) -> None:
    rng = random.Random(SEED + 2)
    candidates = [
        project / "evidence" / "runs" / ".." / "result.txt",
        project / "evidence" / "result.txt",
        project / "evidence" / "result.txt.sha256",
        project / "nope.txt",
        project / "evidence" / "runs",
        project / "evidence" / ("x" * 200),  # 低于 NAME_MAX 的怪名
    ]
    for _ in range(200):
        candidates.append(project / "evidence" / "".join(
            rng.choice("ab/.\\ é") for _ in range(rng.randint(0, 20))
        ))
    for candidate in candidates:
        result = validated_evidence_file(candidate, project / "evidence")
        assert isinstance(result, bool)


# ---------------------------------------------------------------------------
# 已确认缺陷（保留测试，套件整体转绿）
# ---------------------------------------------------------------------------


def test_freeze_worker_result_nul_reference_kept_as_is(project: Path) -> None:
    for reference in ["evidence/\x00x", "\x00"]:
        result = freeze_worker_result_evidence(
            project,
            {"payload": {"evidence_path": reference}},
            run_id="RUN-1", job_id="JOB-1", attempt=1,
        )
        # 契约：非法引用应原样保留（freeze_if_valid 吞 EvidenceReferenceError），
        # 而不是抛出 ValueError: embedded null byte。
        assert result["payload"]["evidence_path"] == reference


def test_freeze_worker_result_oversized_run_id(project: Path) -> None:
    result = freeze_worker_result_evidence(
        project,
        {"payload": {"evidence_path": "evidence/result.txt"}},
        run_id="R" * 300, job_id="JOB-1", attempt=1,
    )
    # 契约：run_id 应在 _EvidenceFreezer 构造时被拒绝（ValueError），
    # 或冻结失败时原样保留引用；而不是 OSError: File name too long。
    assert isinstance(result, dict)


def test_validated_evidence_file_oversized_name_returns_bool(project: Path) -> None:
    for candidate in [
        project / "evidence" / ("x" * 300),
        project / "evidence" / "res\x00ult.txt",
    ]:
        assert isinstance(validated_evidence_file(candidate, project / "evidence"), bool)
