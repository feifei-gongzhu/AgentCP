"""platform_paths.valid_project_name 生成式模糊测试：
超长、unicode、Windows 保留名变体、尾点尾空格、路径分隔符、控制字符。

断言：返回类型稳定（bool）、永不抛异常、True 时必须满足全部结构不变量。
"""

from __future__ import annotations

import random

import pytest

from src.sorne.platform_paths import valid_project_name

SEED = 20261008

RESERVED = ["con", "prn", "aux", "nul"] + [f"com{i}" for i in range(1, 10)] + [f"lpt{i}" for i in range(1, 10)]

SAFE_ALPHABET = "abcXYZ019-_."
UNICODE_ALPHABET = "中文한국어 Abort émoji 𝐗 ﬁ"
DANGEROUS_CHARS = "/ \\ \0 \n \r \t . 空格 : * ? \" < > |".split(" ") + [" ", "\x1b", "‮", "﻿"]


def _assert_bool_invariants(name: str) -> None:
    result = valid_project_name(name)
    assert isinstance(result, bool), f"返回类型不稳定: {type(result)}"
    if result is True:
        assert len(name) <= 80
        assert not name.startswith(".")
        assert not name.endswith((".", " "))
        for char in name:
            assert char not in {"/", "\\", "\0"}
            assert char.isalnum() or char in {"-", "_", "."}
        assert name.split(".", 1)[0].casefold() not in set(RESERVED)


def test_random_alphabet_fuzz_type_stable() -> None:
    rng = random.Random(SEED)
    alphabets = [SAFE_ALPHABET, UNICODE_ALPHABET, SAFE_ALPHABET + "".join(DANGEROUS_CHARS)]
    for _ in range(1000):
        alphabet = rng.choice(alphabets)
        length = rng.choice([0, 1, 5, 20, 79, 80, 81, 200, 5000])
        name = "".join(rng.choice(alphabet) for _ in range(length))
        _assert_bool_invariants(name)


def test_reserved_name_variants_all_rejected() -> None:
    rng = random.Random(SEED + 1)
    # 只有保持“首个点之前仍是保留名主体”的后缀才必须被拒绝；
    # "-x"/"_y" 会派生出不同名字（如 lpt9-x），本就合法。
    reserved_suffixes = ["", ".txt", ".tar.gz", ".log.2024", " ", ".", ".."]
    for _ in range(500):
        base = rng.choice(RESERVED)
        casing = rng.choice([str.upper, str.lower, str.title, lambda s: s.swapcase()])
        suffix = rng.choice(reserved_suffixes + ["-x", "_y"])
        prefix = rng.choice(["", "x", "xx."])
        candidate = prefix + casing(base) + suffix
        _assert_bool_invariants(candidate)
        if prefix == "" and suffix in reserved_suffixes:
            assert valid_project_name(candidate) is False, f"Windows 保留名变体被接受: {candidate!r}"


def test_trailing_dot_and_space_rejected() -> None:
    rng = random.Random(SEED + 2)
    for _ in range(300):
        body = "".join(rng.choice(SAFE_ALPHABET) for _ in range(rng.randint(1, 8)))
        for tail in [".", " ", "..", ". ", " ."]:
            _assert_bool_invariants(body + tail)
            assert valid_project_name(body + tail) is False


def test_path_separators_and_control_chars_rejected() -> None:
    rng = random.Random(SEED + 3)
    for _ in range(400):
        body = "proj" + str(rng.randint(0, 999))
        for evil in ["/", "\\", "\0", "\n", "\r", "../", "..\\", "/etc/passwd", "..", "."]:
            candidate = rng.choice([
                evil + body, body + evil, body + evil + body,
                body.replace("j", evil) if "j" in body else body + evil,
            ])
            _assert_bool_invariants(candidate)
            if any(char in candidate for char in ("/", "\\", "\0")):
                assert valid_project_name(candidate) is False


def test_oversize_names_rejected() -> None:
    rng = random.Random(SEED + 4)
    for _ in range(200):
        name = "a" * rng.choice([81, 100, 1000, 10000])
        _assert_bool_invariants(name)
        assert valid_project_name(name) is False
    assert valid_project_name("a" * 80) is True


def test_non_string_inputs_type_stable() -> None:
    for value in [None, 0, 123, 4.5, True, False, b"bytes", ["list"], {"dict": 1}, ("t",)]:
        result = valid_project_name(value)
        assert isinstance(result, bool)


def test_unicode_names_follow_policy() -> None:
    rng = random.Random(SEED + 5)
    for _ in range(300):
        name = "".join(rng.choice(UNICODE_ALPHABET) for _ in range(rng.randint(1, 10))).strip()
        _assert_bool_invariants(name)
