"""公共 Runtime 抽取（6a：脱敏/诊断截断/Worker JSON/Claude 事件）跨模式一致性。"""

from __future__ import annotations

import json

import pytest

from src.sorne import claude_events, worker_payload
from src.sorne.agent_compose import AgentComposeError, _extract_json as ac_extract
from src.sorne.agent_compose import _model_api_error
from src.sorne.diagnostics import compact_diagnostic
from src.sorne.drivers import DriverError, _extract_json as drivers_extract
from src.sorne.drivers import _claude_stream_events as drivers_claude_events
from src.sorne.local_docker import LocalDockerError, _extract_final_text as ld_extract
from src.sorne.local_docker import _safe_value
from src.sorne.secret_redact import redact_secret, safe_stream_value


SAMPLES = [
    '{"kind":"none","reason":"done"}',
    '前言 {"kind":"fact","title":"发现"} 后记',
    '```json\n{"kind":"none","reason":"fenced"}\n```',
    '无关 {"a":1} 文本 {"kind":"none","reason":"second"}',
    '{"kind":"none","reason":"工具输出里的无关 JSON 之后"}',
    '{"nested":{"key":"value"},"kind":"none"}',
]


@pytest.mark.parametrize("sample", SAMPLES)
def test_same_output_same_worker_json_across_runtimes(sample: str) -> None:
    expected = worker_payload.extract_worker_json(sample)
    assert drivers_extract(sample) == expected
    assert ac_extract(sample) == expected
    assert ld_extract(sample) == expected


BAD_SAMPLES = [
    "",
    "plain text no json",
    '["array","not","object"]',
    "42",
    '{"no_kind":true}',
    '{"kind":"not a kind"}',
    '{"kind":"none"',  # 截断输出
]


@pytest.mark.parametrize("sample", BAD_SAMPLES)
def test_bad_output_rejected_by_every_runtime(sample: str) -> None:
    with pytest.raises(worker_payload.WorkerPayloadError):
        worker_payload.extract_worker_json(sample)
    with pytest.raises(DriverError):
        drivers_extract(sample)
    with pytest.raises(AgentComposeError):
        ac_extract(sample)
    with pytest.raises(LocalDockerError):
        ld_extract(sample)


def test_multiple_json_objects_prefers_kind_valid_one() -> None:
    text = '{"tool":"output"} 以及 {"kind":"none","reason":"winner"}'
    assert worker_payload.extract_worker_json(text)["reason"] == "winner"


def test_api_error_detection_shared() -> None:
    assert _model_api_error("API Error: 401 invalid key") == (
        "模型 API 调用失败: HTTP 401 invalid key"
    )
    assert _model_api_error("noise") is None
    assert _model_api_error("") is None


CLAUDE_MESSAGE = {
    "type": "assistant",
    "message": {
        "content": [
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
            {"type": "text", "text": "分析中"},
        ]
    },
}


def test_same_claude_message_same_core_events() -> None:
    events, final = drivers_claude_events(CLAUDE_MESSAGE, None)
    core_events, core_final = claude_events.claude_message_events(CLAUDE_MESSAGE, None)
    assert (events, final) == (core_events, core_final)
    assert [event["event"] for event in events] == ["tool_started", "assistant_update"]
    assert final is None


def test_redaction_covers_known_secret_and_marker_keys() -> None:
    fake = "sk-abcdef1234567890"
    assert redact_secret(f"failed with {fake}", fake) == "failed with [REDACTED]"
    nested = {"Authorization": "Bearer xyz", "safe": "ok", "list": [{"api_token": "t"}]}
    text = safe_stream_value(nested, fake)
    parsed = json.loads(text)
    assert parsed["Authorization"] == "[REDACTED]"
    assert parsed["safe"] == "ok"
    assert parsed["list"][0]["api_token"] == "[REDACTED]"
    # local-docker 的 _safe_value 与共享实现一致。
    assert _safe_value(nested, fake) == text


def test_redaction_truncates_oversized_tool_output() -> None:
    value = {"output": "x" * 5000}
    assert len(safe_stream_value(value, None)) <= 1200


def test_prompt_snapshot_style_redaction_via_secret_replace() -> None:
    fake = "ghp_abcdefghijklmnopqrstuvwxyz"
    prompt = f"运行环境变量 {fake} 已注入"
    assert fake not in redact_secret(prompt, fake)


def test_compact_diagnostic_keeps_head_and_tail() -> None:
    text = "command context\n" + "filler\n" * 900 + "FINAL provider error"
    compacted = compact_diagnostic(text)
    assert len(compacted) == 4000
    assert compacted.startswith("command context")
    assert "FINAL provider error" in compacted
    assert "omitted" in compacted and "省略" in compacted
