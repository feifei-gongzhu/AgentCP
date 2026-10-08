"""asset_inventory.normalize_asset_candidate / _safe_url 与
target_profile.canonical_target_url 生成式模糊测试：
畸形 URL、大小写协议、IPv6、非法定端口、超长 query、敏感参数名。

断言：不崩溃、返回类型稳定、敏感参数被脱敏、端口界内。
"""

from __future__ import annotations

import random

import pytest

from src.sorne.asset_inventory import (
    AssetImportError,
    NormalizedCandidate,
    _safe_url,
    extract_asset_candidates,
    normalize_asset_candidate,
)
from src.sorne.target_profile import canonical_target_url

SEED = 20261008

HOSTS = [
    "example.com", "sub.example.co.uk", "127.0.0.1", "8.8.8.8",
    "[::1]", "[2001:db8::1]", "xn--e1afmkfd.xn--p1ai", "jo𝐱n.com",
    "localhost", "a" * 63 + ".com", "under_score.example.com",
]
SCHEMES = ["http://", "https://", "HTTP://", "Https://", "HtTpS://", "ftp://", "file://", ""]
PORTS = ["", ":80", ":443", ":8080", ":0", ":65535", ":65536", ":99999",
         ":-1", ":abc", ":1e3", ":+80"]
PATHS = ["", "/", "/a/b", "//double//slash", "/%zz", "/../..", "/" + "x" * 500]


def _random_url(rng: random.Random) -> str:
    scheme = rng.choice(SCHEMES)
    host = rng.choice(HOSTS)
    port = rng.choice(PORTS)
    path = rng.choice(PATHS)
    query_parts = []
    for _ in range(rng.randint(0, 4)):
        key = rng.choice(["id", "AccessToken", "PASSWORD", "sig", "sessionid", "q", "Authorization", "api_key", "coDE"])
        value = rng.choice(["1", "", "secret-token-value", "x" * 200, "汉语词语"])
        query_parts.append(f"{key}={value}")
    query = ("?" + "&".join(query_parts)) if query_parts else ""
    fragment = rng.choice(["", "#top", "#/../../x"])
    return scheme + host + port + path + query + fragment


def _candidate_invariants(candidate: NormalizedCandidate) -> None:
    assert isinstance(candidate, NormalizedCandidate)
    assert isinstance(candidate.endpoint_key, str) and candidate.endpoint_key
    assert candidate.port is None or 1 <= int(candidate.port) <= 65535
    assert candidate.canonical_url is None or candidate.canonical_url.startswith(("http://", "https://"))


def test_normalize_asset_candidate_bracket_balanced_corpus_type_stable() -> None:
    rng = random.Random(SEED)
    for _ in range(800):
        url = _random_url(rng)
        candidate = normalize_asset_candidate(url)
        if candidate is not None:
            _candidate_invariants(candidate)


def test_normalize_asset_candidate_non_url_garbage_returns_none() -> None:
    rng = random.Random(SEED + 1)
    garbage_pool = ["", "   ", "not a host", "!!!", "-", ".", ":", "a:b:c",
                    "1.2.3.4.5", "999.999.999.999", "中文说明文字", "null", "undefined",
                    "\x00\x01\x02", "-" * 100, "host:99999:x"]
    for _ in range(500):
        sample = rng.choice(garbage_pool)
        assert normalize_asset_candidate(sample) is None


def test_canonical_target_url_type_stable_or_value_error() -> None:
    rng = random.Random(SEED + 2)
    for _ in range(800):
        url = _random_url(rng)
        try:
            canonical = canonical_target_url(url)
        except ValueError:
            continue
        assert isinstance(canonical, str)
        assert canonical.startswith(("http://", "https://"))


def test_safe_url_random_query_params() -> None:
    rng = random.Random(SEED + 3)
    for _ in range(500):
        url = "http://example.com/?" + "".join(
            rng.choice(["a=1&", "Token=sekrit&", "password=pw&", "q=word&", "session=abc&"])
            for _ in range(rng.randint(1, 5))
        ).rstrip("&")
        try:
            canonical, host, port, scheme = _safe_url(url)
        except AssetImportError:
            continue
        assert isinstance(canonical, str) and canonical.startswith("http")
        assert isinstance(port, int) and 1 <= port <= 65535
        assert scheme in {"http", "https"}


def test_sensitive_query_values_are_redacted() -> None:
    for key in ["token", "AccessToken", "PASSWORD", "api_key", "sessionid", "auth", "signature", "code", "secret", "credential"]:
        for url in [
            f"https://example.com/?{key}=super-secret",
            f"https://example.com/p?x=1&{key}=super-secret&y=2",
        ]:
            canonical, *_ = _safe_url(url)
            assert "super-secret" not in canonical, f"敏感参数 {key} 未脱敏: {canonical}"
            # urlencode 会把 [REDACTED] 编码为 %5BREDACTED%5D
            assert "%5BREDACTED%5D" in canonical
            normalized = canonical_target_url(url)
            assert "super-secret" not in normalized
            assert "%5BREDACTED%5D" in normalized


def test_ipv6_valid_urls_normalize() -> None:
    for url in ["http://[::1]/", "https://[2001:db8::1]:8443/p", "http://[::ffff:127.0.0.1]:80/"]:
        candidate = normalize_asset_candidate(url)
        assert candidate is not None, url
        _candidate_invariants(candidate)
        canonical = canonical_target_url(url)
        assert isinstance(canonical, str) and canonical.startswith(("http://", "https://"))


def test_extract_asset_candidates_random_rows_type_stable() -> None:
    """括号平衡的随机行：提取永不崩溃且输出受限。"""
    rng = random.Random(SEED + 4)
    for _ in range(300):
        row = {
            "note": rng.choice(["见附件", "scan result", ""]),
            "url": _random_url(rng),
            "extra": [_random_url(rng), rng.randint(0, 99), None],
        }
        candidates = extract_asset_candidates(row)
        assert isinstance(candidates, list) and len(candidates) <= 64
        for candidate in candidates:
            _candidate_invariants(candidate)


# ---------------------------------------------------------------------------
# 已确认缺陷（保留测试，套件整体转绿）
# ---------------------------------------------------------------------------


def test_normalize_asset_candidate_unclosed_ipv6_bracket_returns_none() -> None:
    for url in ["http://[::1", "https://[", "http://[::1/:80", "https://[2001:db8::1"]:
        assert normalize_asset_candidate(url) is None, url


def test_safe_url_unclosed_ipv6_raises_asset_import_error() -> None:
    with pytest.raises(AssetImportError):
        _safe_url("http://[::1")


def test_extract_asset_candidates_survives_unclosed_bracket_row() -> None:
    rows = [
        {"url": "http://[::1"},
        ["https://[::ffff:1.2.3.4"],
        {"a": {"b": ["x", "https://["]}},
    ]
    for row in rows:
        result = extract_asset_candidates(row)
        assert isinstance(result, list)


def test_normalize_asset_candidate_unicode_digit_port_returns_none() -> None:
    for sample in ["example.com:①①", "h:①", "h:²", "host:①80"]:
        assert normalize_asset_candidate(sample) is None, sample
