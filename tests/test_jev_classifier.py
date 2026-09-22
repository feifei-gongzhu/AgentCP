from __future__ import annotations

import pytest

from src.agent_control_plane.jev_classifier import (
    ENTRY_TYPE_OPTIONS,
    JEV_MAX_TARGETS_PER_CALL,
    JEV_QUESTION_SET_VERSION,
    build_questions,
    build_state_entry,
    classify_targets,
    confidence_band,
    state_fingerprint,
)


def _row(url: str = "https://example.com/admin/upload", **overrides) -> dict:
    row = {
        "url": url,
        "function": "后台文件上传接口",
        "observation_kind": "requested",
        "status": 200,
        "parameter_names": ["file", "csrf"],
        "technology_stack": ["Spring Boot"],
        "profile_class": "priority_target",
        "score_reason": "后台高影响入口",
    }
    row.update(overrides)
    return row


def _echo_answers(state: dict) -> dict:
    answers = {}
    for index in range(len(state["targets"])):
        answers[f"t{index}_entry_type"] = {"choice": "file_upload", "confidence": 0.9}
        answers[f"t{index}_has_privilege_boundary"] = {"noul": 0.95}
        answers[f"t{index}_information_sufficient"] = {"noul": 0.8}
        answers[f"t{index}_needs_more_evidence"] = {"noul": 0.1}
    return {"answers": answers, "model": "jev-1.13"}


def test_disabled_without_endpoint_or_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENTCP_JEV_ENDPOINT", raising=False)
    assert classify_targets([_row()]) is None, "未配置端点时必须零行为"


def test_transport_receives_filtered_bounded_state_and_questions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AGENTCP_JEV_ENDPOINT", raising=False)
    captured: list[tuple[dict, dict]] = []

    def transport(state, questions):
        captured.append((state, questions))
        return _echo_answers(state)

    rows = [_row(f"https://example.com/t{i}") for i in range(3)]
    result = classify_targets(rows, transport=transport)

    assert result is not None
    state, questions = captured[0]
    # 状态白名单过滤：只含声明的原子字段（context rot 防护）。
    assert set(state["targets"][0]) == {
        "url", "function", "observation_kind", "http_status",
        "parameter_names", "technologies", "profile_class", "score_reason",
    }
    # 问题集原子、原语合法、带字面化指令。
    assert len(questions) == 3 * 4
    assert all(q["primitive"] in {"choice", "noul"} for q in questions.values())
    entry_question = questions["t0_entry_type"]
    assert entry_question["options"] == list(ENTRY_TYPE_OPTIONS)
    assert "不要推测" in entry_question["instructions"]
    # 逐目标答案按 URL 归位，审计元数据齐全且显式声明不影响调度。
    assert result.answers_by_url["https://example.com/t0"]["entry_type"] == {
        "choice": "file_upload", "confidence": 0.9,
    }
    assert result.model == "jev-1.13"
    assert result.question_set_version == JEV_QUESTION_SET_VERSION
    assert result.state_fingerprint.startswith("sha256:")
    provenance = result.provenance_for("https://example.com/t1")
    assert provenance is not None
    assert provenance["influences_scheduling"] is False
    assert provenance["answers"]["has_privilege_boundary"] == {"noul": 0.95}
    assert result.provenance_for("https://example.com/not-in-batch") is None


def test_batch_is_bounded_and_overflow_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENTCP_JEV_ENDPOINT", raising=False)
    seen: list[int] = []

    def transport(state, questions):
        seen.append(len(state["targets"]))
        return _echo_answers(state)

    rows = [_row(f"https://example.com/t{i}") for i in range(JEV_MAX_TARGETS_PER_CALL + 7)]
    result = classify_targets(rows, transport=transport)

    assert seen == [JEV_MAX_TARGETS_PER_CALL]
    assert result is not None
    assert result.skipped == 7
    assert len(result.answers_by_url) == JEV_MAX_TARGETS_PER_CALL


def test_state_fingerprint_is_deterministic_and_sensitive_to_state() -> None:
    state_one = {"targets": [build_state_entry(_row())]}
    state_two = {"targets": [build_state_entry(_row())]}
    assert state_fingerprint(state_one) == state_fingerprint(state_two)
    changed = {"targets": [build_state_entry(_row(function="登录页面"))]}
    assert state_fingerprint(changed) != state_fingerprint(state_one)


def test_confidence_band_three_range_defaults() -> None:
    assert confidence_band(0.95) == "high"
    assert confidence_band(0.8) == "high"
    assert confidence_band(0.65) == "medium"
    assert confidence_band(0.5) == "medium"
    assert confidence_band(0.2) == "low"
    assert confidence_band(None) == "unknown"


def test_malformed_transport_answer_is_tolerated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENTCP_JEV_ENDPOINT", raising=False)

    def transport(state, questions):
        return {
            "answers": {
                "t0_entry_type": {"choice": "authentication", "confidence": 0.4},
                "t0_has_privilege_boundary": "not-a-dict",
                # 其余问题缺失
            },
            "model": "jev-1.13",
        }

    result = classify_targets([_row()], transport=transport)
    assert result is not None
    answers = result.answers_by_url["https://example.com/admin/upload"]
    assert answers["entry_type"] == {"choice": "authentication", "confidence": 0.4}
    assert "has_privilege_boundary" not in answers
    assert "information_sufficient" not in answers


def test_questions_are_atomic_single_judgments() -> None:
    # 每个问题只包含一个判断：无双重否定、无多跳、指令中不含日期/算术。
    for index in range(2):
        for name, question in build_questions(index).items():
            text = question["instructions"]
            assert "不是不" not in text, name
            assert question["primitive"] in {"choice", "noul"}
            if question["primitive"] == "choice":
                assert question["options"], name
