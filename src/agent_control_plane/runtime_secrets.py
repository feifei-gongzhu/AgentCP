from __future__ import annotations

import json
import subprocess
import sys
import threading
from typing import Any


KEYCHAIN_SERVICE = "com.agentcp.project-secrets.v1"


class SecretStoreError(RuntimeError):
    pass


def _run_security(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    if sys.platform != "darwin":
        raise SecretStoreError("当前系统不支持 macOS Keychain，无法安全持久保存 API Key")
    try:
        return subprocess.run(
            ["/usr/bin/security", *arguments],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SecretStoreError("访问 macOS Keychain 失败") from exc


def _is_missing(result: subprocess.CompletedProcess[str]) -> bool:
    return result.returncode == 44 or "could not be found" in (result.stderr or "").casefold()


def _keychain_read(vendor: str) -> dict[str, str]:
    result = _run_security([
        "find-generic-password", "-a", vendor, "-s", KEYCHAIN_SERVICE, "-w",
    ])
    if result.returncode != 0:
        if _is_missing(result):
            return {}
        raise SecretStoreError(f"读取项目 API Key 失败: {(result.stderr or '').strip()[:300]}")
    try:
        payload: Any = json.loads(result.stdout.rstrip("\r\n"))
    except json.JSONDecodeError as exc:
        raise SecretStoreError("macOS Keychain 中的 AgentCP 项目密钥数据已损坏") from exc
    if not isinstance(payload, dict):
        raise SecretStoreError("macOS Keychain 中的 AgentCP 项目密钥格式无效")
    return {
        str(member): str(secret)
        for member, secret in payload.items()
        if isinstance(member, str) and isinstance(secret, str) and secret
    }


def _keychain_write(vendor: str, values: dict[str, str]) -> None:
    # -X accepts raw password bytes as hexadecimal, avoiding shell quoting,
    # interactive prompts, newline corruption and plaintext project files.
    serialized = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    result = _run_security([
        "add-generic-password", "-U",
        "-a", vendor,
        "-s", KEYCHAIN_SERVICE,
        "-l", f"AgentCP project API keys: {vendor}",
        "-X", serialized.hex(),
    ])
    if result.returncode != 0:
        raise SecretStoreError(f"保存项目 API Key 失败: {(result.stderr or '').strip()[:300]}")


def _keychain_delete(vendor: str) -> None:
    result = _run_security([
        "delete-generic-password", "-a", vendor, "-s", KEYCHAIN_SERVICE,
    ])
    if result.returncode != 0 and not _is_missing(result):
        raise SecretStoreError(f"删除项目 API Key 失败: {(result.stderr or '').strip()[:300]}")


class RuntimeSecretStore:
    """项目级密钥仓库。

    运行期间使用进程内缓存；由 Web 配置保存的密钥同时进入 macOS
    Keychain，服务重启后自动恢复。项目文件、数据库、审计事件和 API
    响应中都不会出现密钥明文。
    """

    _lock = threading.RLock()
    _values: dict[tuple[str, str], str] = {}
    _loaded_projects: set[str] = set()

    @classmethod
    def _ensure_loaded(cls, vendor: str) -> None:
        if vendor in cls._loaded_projects:
            return
        # macOS persists Web-entered secrets in Keychain. Other supported
        # hosts keep the same API but intentionally fall back to process
        # memory, so saving an otherwise valid team configuration never
        # depends on a platform-specific credential helper.
        values = _keychain_read(vendor) if sys.platform == "darwin" else {}
        for member, secret in values.items():
            cls._values[(vendor, member)] = secret
        cls._loaded_projects.add(vendor)

    @classmethod
    def get(cls, vendor: str, member: str) -> str | None:
        with cls._lock:
            cls._ensure_loaded(vendor)
            return cls._values.get((vendor, member))

    @classmethod
    def set_many(
        cls,
        vendor: str,
        values: dict[str, str],
        valid_members: set[str],
        *,
        persist: bool = False,
    ) -> None:
        with cls._lock:
            if persist:
                cls._ensure_loaded(vendor)
            previous = {
                member: secret
                for (project, member), secret in cls._values.items()
                if project == vendor
            }
            for key in [key for key in cls._values if key[0] == vendor and key[1] not in valid_members]:
                cls._values.pop(key, None)
            for member, value in values.items():
                if member not in valid_members:
                    continue
                secret = str(value or "")
                if secret:
                    cls._values[(vendor, member)] = secret
            cls._loaded_projects.add(vendor)
            if persist and sys.platform == "darwin":
                project_values = {
                    member: secret
                    for (project, member), secret in cls._values.items()
                    if project == vendor and member in valid_members
                }
                try:
                    if project_values:
                        _keychain_write(vendor, project_values)
                    else:
                        _keychain_delete(vendor)
                except Exception:
                    for key in [key for key in cls._values if key[0] == vendor]:
                        cls._values.pop(key, None)
                    for member, secret in previous.items():
                        cls._values[(vendor, member)] = secret
                    raise

    @classmethod
    def status(cls, vendor: str, members: list[str]) -> dict[str, bool]:
        with cls._lock:
            cls._ensure_loaded(vendor)
            return {member: (vendor, member) in cls._values for member in members}

    @classmethod
    def clear(cls, vendor: str | None = None, *, persistent: bool = False) -> None:
        with cls._lock:
            if vendor is None:
                cls._values.clear()
                cls._loaded_projects.clear()
                return
            for key in [key for key in cls._values if key[0] == vendor]:
                cls._values.pop(key, None)
            cls._loaded_projects.discard(vendor)
            if persistent and sys.platform == "darwin":
                _keychain_delete(vendor)
