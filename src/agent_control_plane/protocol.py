from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class ProtocolError(RuntimeError):
    pass


class AutomationHttpClient:
    """调度器的 HTTP 协议客户端。

    远程调度器只调用服务端协议，不读取项目文件或 SQLite。
    """

    def __init__(self, base_url: str, timeout: int = 30, token: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.token = token if token is not None else os.environ.get("AGENTCP_SERVER_TOKEN")

    def start(self, vendor: str, team: str, timeout: int, max_workers: int) -> str:
        response = self._post(
            "/api/automation/start",
            {"vendor": vendor, "team": team, "timeout": timeout, "max_workers": max_workers},
        )
        return str(response["run_id"])

    def run(self, vendor: str, run_id: str | None = None) -> str:
        return str(self._post("/api/automation/run", {"vendor": vendor, "run_id": run_id})["output"])

    def resume(self, vendor: str, run_id: str | None = None) -> str:
        return str(self._post("/api/automation/resume", {"vendor": vendor, "run_id": run_id})["run_id"])

    def status(self, vendor: str, run_id: str | None = None) -> dict[str, Any]:
        query = urllib.parse.urlencode({key: value for key, value in {"vendor": vendor, "run_id": run_id}.items() if value})
        return self._get(f"/api/automation/status?{query}")

    def cancel(self, vendor: str, run_id: str, reason: str = "cancelled_by_user") -> None:
        self._post("/api/automation/cancel", {"vendor": vendor, "run_id": run_id, "reason": reason})

    def approve_gate(self, vendor: str, action: str, reason: str) -> str:
        return str(self._post("/api/gate/approve", {"vendor": vendor, "action": action, "reason": reason})["output"])

    def add_hint(self, vendor: str, content: str, target: str | None, priority: int) -> dict[str, Any]:
        return self._post(
            "/api/hints",
            {"vendor": vendor, "content": content, "target": target, "priority": priority},
        )["hint"]

    def metrics(self, vendor: str) -> dict[str, Any]:
        return self._get(f"/api/metrics?{urllib.parse.urlencode({'vendor': vendor})}")["metrics"]

    def project_state(self, vendor: str) -> dict[str, Any]:
        return self._get(f"/api/project/state?{urllib.parse.urlencode({'vendor': vendor})}")

    def _get(self, path: str) -> dict[str, Any]:
        request = urllib.request.Request(self.base_url + path, headers=self._headers(), method="GET")
        return self._send(request)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=self._headers(json_body=True),
            method="POST",
        )
        return self._send(request)

    def _send(self, request: urllib.request.Request) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise ProtocolError(f"HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise ProtocolError(f"协议请求失败: {exc}") from exc
        if not payload.get("ok"):
            raise ProtocolError(str(payload.get("error", "unknown protocol error")))
        return payload

    def _headers(self, json_body: bool = False) -> dict[str, str]:
        headers: dict[str, str] = {}
        if json_body:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers
