"""P3 定向测试共享的本地 HTTP 夹具（授权范围内的本地服务，§13.2）。

一个线程化 http.server 实例，覆盖四类场景：

- 静态页 + JS 资产（dir_scan / js_scan 输入）；
- Spring 风格指纹（``X-Application-Context`` 头 + ``/actuator/health``
  JSON 标记）与 catch-all 变体（软 404 全 200）；
- HTTP Basic 保护路径与表单登录（pwd_crack 输入）；
- JWT/端点字面量 JS（js_scan 线索 + 脱敏验证）。
"""

from __future__ import annotations

import base64
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

INDEX_HTML = (
    b"<html><head><title>fixture app</title>"
    b'<script src="/js/app.js"></script></head><body>'
    b'<form action="/login" method="POST">'
    b'<input type="text" name="username" value="">'
    b'<input type="hidden" name="csrf" value="t123">'
    b'<input type="password" name="password"></form></body></html>'
)

APP_JS = (
    b'var apiBase="/api/v2/user"; '
    b'var token="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N5nPIfIYDBdKqzAwrHZylI"; '
    b'fetch(apiBase+"/profile");'
)

CREDENTIALS = {"admin": "s3cret-pass"}


class _Handler(BaseHTTPRequestHandler):
    catchall = False  # 类属性由 make_server 按场景设置

    def _send(self, status: int, body: bytes = b"", headers: dict | None = None) -> None:
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            return self._send(200, INDEX_HTML)
        if path == "/js/app.js":
            return self._send(200, APP_JS, {"Content-Type": "application/javascript"})
        if path == "/actuator/health" and not self.catchall:
            return self._send(
                200, b'{"status":"UP"}',
                {"X-Application-Context": "application:8080"},
            )
        if path == "/protected":
            header = self.headers.get("Authorization") or ""
            if header.startswith("Basic "):
                try:
                    user, _, password = base64.b64decode(header[6:]).decode().partition(":")
                except Exception:  # noqa: BLE001
                    user, password = "", ""
                if CREDENTIALS.get(user) == password:
                    return self._send(200, b"protected content")
                return self._send(403, b"denied")
            return self._send(401, b"auth required", {"WWW-Authenticate": 'Basic realm="fixture"'})
        if path == "/login":
            return self._send(200, INDEX_HTML)
        if self.catchall:
            return self._send(200, b"<html>fallback page</html>")
        return self._send(404, b"not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/login":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8", errors="replace")
            fields = dict(re.findall(r"([^=&]+)=([^&]*)", raw))
            user = fields.get("username", "")
            password = fields.get("password", "")
            if CREDENTIALS.get(user) == password:
                return self._send(302, b"", {
                    "Set-Cookie": "SESSIONID=abc123; Path=/",
                    "Location": "/dashboard",
                })
            return self._send(
                200,
                b'<html><form action="/login" method="POST">'
                b'<input type="password" name="password"></form>bad credentials</html>',
            )
        return self._send(404, b"not found")

    def log_message(self, *args) -> None:  # 静默：测试输出不被请求日志淹没
        return


class LocalFixtureServer:
    def __init__(self, *, catchall: bool = False) -> None:
        handler = type("Handler", (_Handler,), {"catchall": catchall})
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self) -> "LocalFixtureServer":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def fixture_json_for_scope(server: LocalFixtureServer) -> dict:
    return {
        "authorization": "authorized",
        "scope": [f"127.0.0.1:{server.port}"],
        "out_of_scope": [],
        "targets": [server.base_url],
        "goal": "P3 定向测试（本地夹具）",
    }
