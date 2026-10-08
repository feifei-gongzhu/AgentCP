"""webapp JSON 校验层模糊测试（in-process 服务器模式）：
对 /api/target、/api/config、/api/hints、/api/findings/review 发送
错误类型、超长字段、深嵌套炸弹、畸形 JSON 载荷，断言绝不 5xx。

服务器只绑定 127.0.0.1（本机 localhost 例外允许），不触网。
"""

from __future__ import annotations

import http.client
import json
import random
import threading
from http.server import ThreadingHTTPServer

import pytest

from src.sorne import webapp as webapp_module
from src.sorne.store import ProjectStore

SEED = 20261008

ENDPOINTS = ["/api/target", "/api/config", "/api/hints", "/api/findings/review"]

VENDOR = "fuzz-proj"


class _QuietHandler(webapp_module.AgentControlHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


@pytest.fixture()
def server(isolated_projects_dir):
    store = ProjectStore(VENDOR)
    store.init()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _QuietHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield port
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


def _post(port: int, path: str, body: bytes) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        conn.request(
            "POST", path, body=body,
            headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
        )
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def _assert_rejected_4xx(port: int, path: str, body: bytes) -> None:
    status, data = _post(port, path, body)
    assert 400 <= status <= 499, f"{path} 对畸形载荷返回 {status}: {data[:200]!r}"
    payload = json.loads(data.decode("utf-8"))
    assert isinstance(payload, dict)
    assert payload.get("ok") is False


def _assert_no_5xx(port: int, path: str, body: bytes) -> None:
    """允许 200（被清洗后接受）或 4xx（被拒绝），但绝不 5xx、连接不重置。"""
    status, data = _post(port, path, body)
    assert 200 <= status <= 499, f"{path} 载荷 {body[:120]!r} -> {status}: {data[:200]!r}"
    payload = json.loads(data.decode("utf-8"))
    assert isinstance(payload, dict)
    assert "ok" in payload


def test_healthz_alive(server) -> None:
    conn = http.client.HTTPConnection("127.0.0.1", server, timeout=10)
    conn.request("GET", "/healthz")
    response = conn.getresponse()
    assert response.status == 200
    conn.close()


def test_non_dict_json_bodies_rejected_4xx(server) -> None:
    bodies = [
        b"[1,2,3]", b"null", b"123", b'"string"', b"true", b"[]", b"{}",
        b"-0.5", b"NaN", b"Infinity", b"0x10",
    ]
    for path in ENDPOINTS:
        for body in bodies:
            _assert_rejected_4xx(server, path, body)


def test_garbage_and_binary_bodies_rejected_4xx(server) -> None:
    rng = random.Random(SEED)
    bodies = [b"", b"{", b"}", b'{"a":', b"\x80\xff\xfe", b"\x00\x01\x02", b"\xef\xbb\xbf{}"]
    for _ in range(80):
        bodies.append(bytes(rng.randint(0, 255) for _ in range(rng.randint(1, 200))))
    for path in ENDPOINTS:
        for body in bodies:
            _assert_rejected_4xx(server, path, body)


def test_wrong_typed_fields_never_5xx(server) -> None:
    payloads = [
        {"vendor": ["list"]}, {"vendor": {"k": 1}}, {"vendor": 123}, {"vendor": None},
        {"vendor": "../escape"}, {"vendor": "a/b"}, {"vendor": "a\\b"}, {"vendor": "con"},
        {"vendor": "尾部空格 "}, {"vendor": "尾点."}, {"vendor": "no-such-project"},
        {"target": "not-a-dict"}, {"target": [1, 2]}, {"target": None},
        {"target": {"targets": "single-string"}},
        {"target": {"targets": [{"nested": True}]}},
        {"config": "not-a-dict"}, {"config": []},
        {"config": {"members": "not-a-list"}},
        {"config": {"members": [{"name": 1, "type": 2}]}},
        {"config": {"members": [1, 2, 3]}},
        {"secrets": "not-a-dict"}, {"secrets": [{"a": 1}]},
        {"content": None}, {"content": ["list"]}, {"content": {"dict": 1}},
        {"intervention_type": ["x"]}, {"priority": "abc"}, {"priority": None},
        {"finding_id": ["x"]}, {"action": ["approve"]}, {"reason_codes": "abc"},
        {"reason_codes": {"a": 1}}, {"reason_codes": [None, {"x": 1}]},
        {"duplicate_of_finding_id": ["x"]}, {"reason": {"dict": True}},
    ]
    for path in ENDPOINTS:
        for extra in payloads:
            body = json.dumps({"vendor": VENDOR, **extra}, ensure_ascii=False).encode("utf-8")
            _assert_no_5xx(server, path, body)


def test_overlong_fields_never_5xx(server) -> None:
    long_text = "x" * 4000
    many = [str(i) for i in range(300)]
    payloads = [
        {"content": long_text},
        {"target": {"targets": [long_text]}},
        {"target": {"targets": many}},
        {"target": {"out_of_scope": [long_text]}},
        {"target": {"success_criteria": many}},
        {"config": {"members": [{"name": long_text}]}},
        {"secrets": {"m": "k" * 9000}},
        {"reason": long_text},
        {"finding_id": long_text},
        {"reviewed_by": long_text},
        {"run_id": long_text},
    ]
    for path in ENDPOINTS:
        for extra in payloads:
            body = json.dumps({"vendor": VENDOR, **extra}, ensure_ascii=False).encode("utf-8")
            _assert_no_5xx(server, path, body)


def test_deeply_nested_structures_never_5xx(server) -> None:
    deep_array = b"[" * 20000 + b"]" * 20000  # 顶层数组：必被拒为 4xx
    deep_dict = (
        b'{"vendor":"fuzz-proj","target":{"targets":'
        + b"[" * 5000 + b"]" * 5000 + b"}}"
    )
    deep_key = b'{"a":' * 2000 + b"1" + b"}" * 2000
    for path in ENDPOINTS:
        _assert_rejected_4xx(server, path, deep_array)
        for body in [deep_dict, deep_key]:
            _assert_no_5xx(server, path, body)


def test_random_json_dict_fuzz_never_5xx(server) -> None:
    rng = random.Random(SEED + 1)
    keys = ["vendor", "target", "targets", "config", "members", "secrets", "content",
            "intervention_type", "priority", "finding_id", "action", "reason",
            "reason_codes", "final_severity", "final_classification", "scope", "run_id"]
    value_pool = [
        None, True, False, 0, -1, 2**64, -2**64, 3.14, "", "x" * 3000, "中文内容",
        [], {}, [[[]]], {"a": {"b": {"c": 1}}}, "con", "a/b", 1e308, "0x10",
    ]
    for _ in range(400):
        payload = {"vendor": rng.choice([VENDOR, VENDOR, "no-such", 12, None, "../x"])}
        for key in rng.sample(keys, rng.randint(0, 4)):
            payload[key] = rng.choice(value_pool)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        path = rng.choice(ENDPOINTS)
        _assert_no_5xx(server, path, body)


def test_unicode_and_control_chars_never_5xx(server) -> None:
    payloads = [
        {"content": "含\u202e反转\u0000空字符"},
        {"content": "\U0001F680" * 50},
        {"target": {"targets": ["目标是 internal.example.com"]}},
        {"reason": "\u0000\u0001\u0002"},
    ]
    for path in ENDPOINTS:
        for extra in payloads:
            body = json.dumps({"vendor": VENDOR, **extra}, ensure_ascii=False).encode("utf-8")
            _assert_no_5xx(server, path, body)
