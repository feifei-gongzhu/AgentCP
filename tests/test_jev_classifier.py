from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from src.agent_control_plane.jev_classifier import (
    ENTRY_TYPE_CRITERIA,
    JEV_MAX_TARGETS_PER_CALL,
    JEV_QUESTION_SET_VERSION,
    build_questions,
    build_state_entry,
    build_state_text,
    classify_targets,
    confidence_band,
    merge_collection_context,
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


def _official_answers(state_text: str) -> dict:
    targets = json.loads(state_text)["targets"]
    answers = {}
    for index, entry in enumerate(targets):
        answers[f"t{index}_entry_type"] = {
            "type": "choice", "choice": "file_upload",
            "confidence": 0.9, "probabilities": {"file_upload": 0.9, "unknown": 0.1},
        }
        answers[f"t{index}_has_privilege_boundary"] = {"noul": 0.95}
        answers[f"t{index}_information_sufficient"] = {"noul": 0.8}
        answers[f"t{index}_needs_more_evidence"] = {"noul": 0.1}
    return answers


def test_disabled_without_endpoint_or_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENTCP_JEV_ENDPOINT", raising=False)
    assert classify_targets([_row()]) is None, "未配置端点时必须零行为"


def test_official_rest_contract_with_local_http_mock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """官方契约验证：POST /v1/systemone、type/criteria 字段、state 为字符串。

    本地 HTTP mock 全量断言请求，不调用付费 API。
    """
    captured: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            captured.update({
                "path": self.path,
                "auth": self.headers.get("Authorization"),
                "content_type": self.headers.get("Content-Type"),
                "body": body,
            })
            payload = {
                "model": "jev-1.13.0",
                "answers": _official_answers(body["state"]),
                "usage": {"input_tokens": 100, "output_tokens": 10},
            }
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):  # 静默
            return

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("AGENTCP_JEV_ENDPOINT", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("AGENTCP_JEV_API_KEY", "test-key")
    try:
        result = classify_targets([_row()])
    finally:
        server.shutdown()
        server.server_close()

    assert captured["path"] == "/v1/systemone", "官方契约端点路径"
    assert captured["auth"] == "Bearer test-key"
    assert captured["content_type"] == "application/json"
    body = captured["body"]
    # state 是字符串（官方定义），内容为过滤后的目标列表。
    assert isinstance(body["state"], str)
    assert json.loads(body["state"])["targets"][0]["url"] == "https://example.com/admin/upload"
    assert body["model"] == "jev-1.13"
    question = body["questions"]["t0_entry_type"]
    assert question["type"] == "choice", "官方契约使用 type 字段"
    assert question["criteria"] == dict(ENTRY_TYPE_CRITERIA), "choice 使用 criteria 映射"
    assert "instructions" in question
    noul_question = body["questions"]["t0_has_privilege_boundary"]
    assert noul_question["type"] == "noul"
    # 官方应答形态解析：choice 带 confidence，noul 只带数值。
    assert result is not None
    answers = result.answers_by_url["https://example.com/admin/upload"]
    assert answers["entry_type"] == {
        "type": "choice", "choice": "file_upload",
        "confidence": 0.9, "probabilities": {"file_upload": 0.9, "unknown": 0.1},
    }
    assert answers["has_privilege_boundary"] == {"noul": 0.95}
    assert result.model == "jev-1.13.0"  # 应答中的已解析版本优先
    assert result.question_set_version == JEV_QUESTION_SET_VERSION
    provenance = result.provenance_for("https://example.com/admin/upload")
    assert provenance is not None
    assert provenance["influences_scheduling"] is False


def test_questions_bind_target_index_and_url_explicitly() -> None:
    questions_zero = build_questions(0, "https://a.example.com/x")
    questions_one = build_questions(1, "https://b.example.com/y")
    for name, question in questions_zero.items():
        assert "下标为 0" in question["instructions"], name
        assert "https://a.example.com/x" in question["instructions"], name
    for name, question in questions_one.items():
        assert "下标为 1" in question["instructions"], name
        assert "https://b.example.com/y" in question["instructions"], name
    # 不同目标的问题正文必须不同（仅键名不同不满足绑定要求）。
    assert questions_zero["t0_entry_type"]["instructions"] != questions_one["t1_entry_type"]["instructions"]


def test_state_excludes_agent_conclusions_and_merges_function() -> None:
    """影子输入只含采集证据：结论字段不得泄漏；function 从采集行回退。"""
    assessment = {
        "url": "https://example.com/admin/upload",
        "profile_class": "priority_target",
        "score_reason": "后台高影响入口",
        "target_score": 85,
    }
    record = {
        "url": "https://example.com/admin/upload",
        "function": "后台文件上传接口",
        "observation_kind": "requested",
        "status": 200,
        "parameter_names": ["file"],
        "technology_stack": ["Spring Boot"],
    }
    merged = merge_collection_context([assessment], [record])[0]
    assert merged["function"] == "后台文件上传接口", "采集行的 function 必须回退"
    entry = build_state_entry(merged)
    state_text = build_state_text([entry])
    assert "priority_target" not in state_text, "结论字段不得进入影子输入"
    assert "后台高影响入口" not in state_text, "评分理由不得进入影子输入"
    assert "后台文件上传接口" in state_text


def test_state_fingerprint_is_deterministic_and_sensitive_to_state() -> None:
    state_one = build_state_text([build_state_entry(_row())])
    state_two = build_state_text([build_state_entry(_row())])
    assert state_fingerprint(state_one) == state_fingerprint(state_two)
    changed = build_state_text([build_state_entry(_row(function="登录页面"))])
    assert state_fingerprint(changed) != state_fingerprint(state_one)


def test_batch_is_bounded_and_overflow_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENTCP_JEV_ENDPOINT", raising=False)
    seen: list[int] = []

    def transport(state_text, questions):
        seen.append(len(json.loads(state_text)["targets"]))
        return {"answers": _official_answers(state_text), "model": "jev-1.13"}

    rows = [_row(f"https://example.com/t{i}") for i in range(JEV_MAX_TARGETS_PER_CALL + 7)]
    result = classify_targets(rows, transport=transport)

    assert seen == [JEV_MAX_TARGETS_PER_CALL]
    assert result is not None
    assert result.skipped == 7
    assert len(result.answers_by_url) == JEV_MAX_TARGETS_PER_CALL


def test_confidence_band_three_range_defaults() -> None:
    assert confidence_band(0.95) == "high"
    assert confidence_band(0.8) == "high"
    assert confidence_band(0.65) == "medium"
    assert confidence_band(0.5) == "medium"
    assert confidence_band(0.2) == "low"
    assert confidence_band(None) == "unknown"


def test_malformed_transport_answer_is_tolerated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENTCP_JEV_ENDPOINT", raising=False)

    def transport(state_text, questions):
        return {
            "answers": {
                "t0_entry_type": {"type": "choice", "choice": "authentication", "confidence": 0.4},
                "t0_has_privilege_boundary": "not-a-dict",
            },
            "model": "jev-1.13",
        }

    result = classify_targets([_row()], transport=transport)
    assert result is not None
    answers = result.answers_by_url["https://example.com/admin/upload"]
    assert answers["entry_type"]["choice"] == "authentication"
    assert "has_privilege_boundary" not in answers
    assert "information_sufficient" not in answers
