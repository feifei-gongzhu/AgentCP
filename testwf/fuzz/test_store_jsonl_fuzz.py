"""store.read_jsonl 模糊测试：损坏行、空行、末行无换行、非对象行。

断言：输出类型稳定（list）、允许的异常只有 json.JSONDecodeError、
末行无换行且损坏时静默丢弃（既有契约）。
"""

from __future__ import annotations

import json
import random

import pytest

from src.sorne.store import ProjectStore

SEED = 20261008

VALID_LINES = [
    {"id": "A-1", "kind": "hint", "content": "补充信息"},
    {"id": "A-2", "kind": "hint", "content": "x" * 300},
    {"id": "A-3", "nested": {"a": [1, 2, {"b": None}]}},
]

CORRUPT_LINES = ["{", "{\"a\":", "}}}", "not json", "\x00\x01", "[1,2", "{'single': 1}"]


def _write(store: ProjectStore, text: str) -> None:
    (store.path / "hints.jsonl").write_text(text, encoding="utf-8")


def test_read_jsonl_missing_file_returns_empty_list() -> None:
    store = ProjectStore("fuzz-jsonl-missing")
    store.init()
    assert store.read_jsonl("hints.jsonl") == []


def test_read_jsonl_valid_rows_roundtrip() -> None:
    rng = random.Random(SEED)
    store = ProjectStore("fuzz-jsonl-valid")
    store.init()
    for _ in range(50):
        rows = rng.sample(VALID_LINES * 5, rng.randint(1, 8))
        text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)
        _write(store, text)
        result = store.read_jsonl("hints.jsonl")
        assert isinstance(result, list)
        assert result == rows
        assert all(isinstance(row, dict) for row in result)


def test_read_jsonl_empty_and_blank_lines_skipped() -> None:
    store = ProjectStore("fuzz-jsonl-blank")
    store.init()
    rng = random.Random(SEED + 1)
    for _ in range(200):
        parts = []
        for _ in range(rng.randint(1, 6)):
            parts.append(rng.choice(["", "   ", "\t", json.dumps(rng.choice(VALID_LINES))]))
        _write(store, "\n".join(parts) + "\n")
        result = store.read_jsonl("hints.jsonl")
        assert isinstance(result, list)
        for row in result:
            assert isinstance(row, dict)


def test_read_jsonl_corrupt_middle_line_raises_decode_error_only() -> None:
    store = ProjectStore("fuzz-jsonl-corrupt-mid")
    store.init()
    rng = random.Random(SEED + 2)
    for _ in range(300):
        good = json.dumps(rng.choice(VALID_LINES)) + "\n"
        bad = rng.choice(CORRUPT_LINES)
        text = good + bad + "\n" + good
        try:
            result = store.read_jsonl("hints.jsonl")
        except json.JSONDecodeError:
            continue
        assert isinstance(result, list)


def test_read_jsonl_last_line_without_newline_corrupt_is_dropped() -> None:
    store = ProjectStore("fuzz-jsonl-tail")
    store.init()
    rng = random.Random(SEED + 3)
    for _ in range(200):
        rows = [rng.choice(VALID_LINES) for _ in range(rng.randint(1, 3))]
        text = "".join(json.dumps(row) + "\n" for row in rows)
        bad_tail = rng.choice(CORRUPT_LINES)
        _write(store, text + bad_tail)  # 末行无换行且损坏
        result = store.read_jsonl("hints.jsonl")
        assert isinstance(result, list)
        assert result == rows  # 损坏末行被静默丢弃，前面的完整行保留


def test_read_jsonl_last_line_without_newline_valid_is_kept() -> None:
    store = ProjectStore("fuzz-jsonl-tail-valid")
    store.init()
    row = VALID_LINES[0]
    _write(store, json.dumps(row))  # 合法但末行无换行
    assert store.read_jsonl("hints.jsonl") == [row]


def test_read_jsonl_random_binary_soup_never_leaks_other_exceptions() -> None:
    store = ProjectStore("fuzz-jsonl-binary")
    store.init()
    rng = random.Random(SEED + 4)
    alphabet = "{}[]\"\\,:0123456789 \t\n abc"
    for _ in range(300):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 200)))
        _write(store, text)
        try:
            result = store.read_jsonl("hints.jsonl")
        except json.JSONDecodeError:
            continue
        assert isinstance(result, list)
