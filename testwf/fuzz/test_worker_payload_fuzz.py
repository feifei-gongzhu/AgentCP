"""worker_payload 生成式模糊测试：随机 JSON 片段拼接、字符串包裹、截断、
超大数组、合法 kind 混入垃圾前后缀。

断言：不崩溃、不抛 WorkerPayloadError 之外的未捕获异常、返回类型稳定（dict）。
"""

from __future__ import annotations

import json
import random

import pytest

from src.sorne.schemas import VALID_WORKER_KINDS
from src.sorne.worker_payload import (
    WorkerPayloadError,
    extract_worker_json,
    find_json_objects,
    parse_api_error,
)

SEED = 20261008

KINDS = sorted(VALID_WORKER_KINDS)

SCALAR_PAYLOADS = [
    json.dumps({"kind": kind, "title": "t", "summary": "s"}, ensure_ascii=False)
    for kind in KINDS
]

FRAGMENTS = [
    "{", "}", "[]", '{"kind"', '"vuln_report"', "123", "true", "null",
    "```json", "```", "，", "\n", " ", "\t", "模型输出如下：", "}}}",
    '{"a": [1, 2', '"unclosed', "\\u4f60\\u597d", "‮", "\x00", "﻿",
    '{"kind": null}', '{"kind": 123}', '{"kind": ""}', "{}",
]

SEPARATORS = ["", "\n", "\n\n", " ", "```json\n", "，", " | ", "\r\n"]


def _random_text(rng: random.Random, valid_payload: str | None = None) -> str:
    style = rng.randrange(5)
    if style == 0 and valid_payload is not None:
        # 合法 kind 混入垃圾前后缀
        prefix = "".join(rng.choice(FRAGMENTS) for _ in range(rng.randint(1, 3)))
        suffix = "".join(rng.choice(FRAGMENTS) for _ in range(rng.randint(1, 3)))
        return prefix + rng.choice(SEPARATORS) + valid_payload + rng.choice(SEPARATORS) + suffix
    if style == 1 and valid_payload is not None:
        # 截断 JSON：在随机位置切断
        cut = rng.randint(0, len(valid_payload))
        return valid_payload[:cut]
    if style == 2 and valid_payload is not None:
        # 嵌套字符串包裹：把 JSON 再包成字符串（1~3 层）
        wrapped = valid_payload
        for _ in range(rng.randint(1, 3)):
            wrapped = json.dumps(wrapped, ensure_ascii=False)
        return wrapped
    if style == 3 and valid_payload is not None:
        # 超大数组
        size = rng.choice([100, 1000, 5000])
        blob = json.dumps({"kind": rng.choice(KINDS), "items": list(range(size))})
        return rng.choice(SEPARATORS) + blob + rng.choice(SEPARATORS)
    # 纯随机片段拼接
    parts = [rng.choice(FRAGMENTS) for _ in range(rng.randint(1, 8))]
    return rng.choice(SEPARATORS).join(parts)


def test_find_json_objects_never_raises_and_returns_list() -> None:
    rng = random.Random(SEED)
    for _ in range(500):
        text = _random_text(rng, rng.choice(SCALAR_PAYLOADS))
        result = find_json_objects(text)
        assert isinstance(result, list)
        for item in result:
            assert isinstance(item, (dict, list, str, int, float, bool)) or item is None


def test_extract_worker_json_scalar_kind_corpus_type_stable() -> None:
    """标量 kind 语料：要么 dict 要么 WorkerPayloadError，绝不其他异常。"""
    rng = random.Random(SEED + 1)
    for _ in range(500):
        text = _random_text(rng, rng.choice(SCALAR_PAYLOADS))
        try:
            payload = extract_worker_json(text)
        except WorkerPayloadError:
            continue
        assert isinstance(payload, dict)
        assert payload.get("kind") in VALID_WORKER_KINDS


def test_extract_worker_json_truncated_never_partial_garbage() -> None:
    rng = random.Random(SEED + 2)
    for payload_text in SCALAR_PAYLOADS:
        for cut in range(0, len(payload_text), 7):
            text = payload_text[:cut]
            try:
                extracted = extract_worker_json(text)
            except WorkerPayloadError:
                continue
            assert isinstance(extracted, dict)
            assert extracted.get("kind") in VALID_WORKER_KINDS


def test_extract_worker_json_wrapped_string_payloads() -> None:
    rng = random.Random(SEED + 3)
    for _ in range(200):
        payload_text = rng.choice(SCALAR_PAYLOADS)
        wrapped = payload_text
        for _ in range(rng.randint(1, 3)):
            wrapped = json.dumps(wrapped, ensure_ascii=False)
        try:
            extracted = extract_worker_json(wrapped)
        except WorkerPayloadError:
            continue
        assert isinstance(extracted, dict)
        assert extracted.get("kind") in VALID_WORKER_KINDS


def test_extract_worker_json_huge_array_input() -> None:
    huge = "[" + ",".join(str(i) for i in range(100_000)) + "]"
    with pytest.raises(WorkerPayloadError):
        extract_worker_json(huge)  # 数组绝不作为业务结果
    result = find_json_objects(huge)
    assert isinstance(result, list)  # 顶层合法 JSON 数组按原样返回（行为契约）


def test_parse_api_error_random_text_type_stable() -> None:
    rng = random.Random(SEED + 4)
    for _ in range(300):
        text = _random_text(rng, None)
        message = parse_api_error(text)
        assert message is None or isinstance(message, str)


# ---------------------------------------------------------------------------
# 已确认缺陷（保留测试，套件整体转绿）
# ---------------------------------------------------------------------------


def test_extract_worker_json_rejects_unhashable_kind_list() -> None:
    with pytest.raises(WorkerPayloadError):
        extract_worker_json('{"kind": ["vuln_report"]}')


def test_extract_worker_json_rejects_unhashable_kind_dict() -> None:
    with pytest.raises(WorkerPayloadError):
        extract_worker_json('{"kind": {"vuln": 1}}')


def test_extract_worker_json_generative_kind_collection_fuzz() -> None:
    rng = random.Random(SEED + 5)
    for _ in range(200):
        kind_value = rng.choice([["vuln_report"], {"a": 1}, [["x"]], [{"kind": 1}]])
        text = (
            rng.choice(["模型输出：", "```json\n", "", "结果 "])
            + json.dumps({"kind": kind_value}, ensure_ascii=False)
            + rng.choice(["\n完", "```", "", " 。"])
        )
        try:
            payload = extract_worker_json(text)
        except WorkerPayloadError:
            continue
        assert isinstance(payload, dict)


def test_require_worker_kind_via_drivers_contract() -> None:
    from src.sorne.worker_payload import require_worker_kind

    with pytest.raises(WorkerPayloadError):
        require_worker_kind({"kind": {"nested": True}})
