from __future__ import annotations

import pytest

from src.agent_control_plane import runtime_secrets as secrets_module
from src.agent_control_plane.runtime_secrets import RuntimeSecretStore, SecretStoreError


@pytest.fixture(autouse=True)
def reset_secret_cache() -> None:
    RuntimeSecretStore.clear()
    yield
    RuntimeSecretStore.clear()


def test_project_keys_survive_memory_reset_via_keychain(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets_module.sys, "platform", "darwin")
    keychain: dict[str, dict[str, str]] = {}
    monkeypatch.setattr(secrets_module, "_keychain_read", lambda vendor: dict(keychain.get(vendor, {})))
    monkeypatch.setattr(secrets_module, "_keychain_write", lambda vendor, values: keychain.__setitem__(vendor, dict(values)))
    monkeypatch.setattr(secrets_module, "_keychain_delete", lambda vendor: keychain.pop(vendor, None))

    RuntimeSecretStore.set_many(
        "宝马",
        {"reason-main": "sk-reason", "executor-primary": "sk-executor"},
        {"reason-main", "executor-primary"},
        persist=True,
    )
    RuntimeSecretStore.clear()

    assert RuntimeSecretStore.get("宝马", "reason-main") == "sk-reason"
    assert RuntimeSecretStore.status("宝马", ["reason-main", "executor-primary"]) == {
        "reason-main": True,
        "executor-primary": True,
    }


def test_removed_role_is_removed_from_persistent_project_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets_module.sys, "platform", "darwin")
    keychain = {"project": {"keep": "sk-keep", "remove": "sk-remove"}}
    monkeypatch.setattr(secrets_module, "_keychain_read", lambda vendor: dict(keychain.get(vendor, {})))
    monkeypatch.setattr(secrets_module, "_keychain_write", lambda vendor, values: keychain.__setitem__(vendor, dict(values)))
    monkeypatch.setattr(secrets_module, "_keychain_delete", lambda vendor: keychain.pop(vendor, None))

    RuntimeSecretStore.set_many("project", {}, {"keep"}, persist=True)

    assert keychain["project"] == {"keep": "sk-keep"}


def test_failed_keychain_write_rolls_back_runtime_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets_module.sys, "platform", "darwin")
    monkeypatch.setattr(secrets_module, "_keychain_read", lambda vendor: {"reason": "old-key"})

    def fail_write(vendor: str, values: dict[str, str]) -> None:
        raise SecretStoreError("keychain locked")

    monkeypatch.setattr(secrets_module, "_keychain_write", fail_write)

    with pytest.raises(SecretStoreError, match="locked"):
        RuntimeSecretStore.set_many("project", {"reason": "new-key"}, {"reason"}, persist=True)

    assert RuntimeSecretStore.get("project", "reason") == "old-key"


def test_project_delete_removes_persistent_keychain_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets_module.sys, "platform", "darwin")
    deleted: list[str] = []
    monkeypatch.setattr(secrets_module, "_keychain_delete", deleted.append)

    RuntimeSecretStore.clear("project", persistent=True)

    assert deleted == ["project"]


def test_non_macos_uses_memory_without_invoking_keychain(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets_module.sys, "platform", "linux")

    def unexpected(*args: object, **kwargs: object) -> None:
        raise AssertionError("non-macOS hosts must not invoke Keychain")

    monkeypatch.setattr(secrets_module, "_keychain_read", unexpected)
    monkeypatch.setattr(secrets_module, "_keychain_write", unexpected)
    monkeypatch.setattr(secrets_module, "_keychain_delete", unexpected)

    RuntimeSecretStore.set_many(
        "project",
        {"reason": "sk-session"},
        {"reason"},
        persist=True,
    )

    assert RuntimeSecretStore.get("project", "reason") == "sk-session"
    RuntimeSecretStore.clear("project", persistent=True)
    assert RuntimeSecretStore.status("project", ["reason"]) == {"reason": False}
