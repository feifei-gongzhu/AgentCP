from __future__ import annotations

import pytest

from src.sorne.maintenance import MaintenanceError, ProjectLocator
from src.sorne.platform_paths import valid_project_name
from src.sorne.webapp import WebAppError, _validate_vendor


INVALID_NAMES = [
    "",
    ".",
    "..",
    ".hidden",
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com9",
    "lpt1",
    "lpt9",
    "CON",
    "trailing.",
    "trailing ",
    " leading",
    "slash/name",
    "back\\slash",
    "nul\x00byte",
    "x" * 81,
]

VALID_NAMES = [
    "production-security",
    "生产安全审计",
    "web.2026",
    "klook",
    "a" * 80,
]


@pytest.mark.parametrize("name", VALID_NAMES)
def test_valid_names_accepted_everywhere(name: str) -> None:
    assert valid_project_name(name)
    assert _validate_vendor(name) == name
    assert ProjectLocator.validate_vendor(name) == name


@pytest.mark.parametrize("name", INVALID_NAMES)
def test_invalid_names_rejected_everywhere(name: str) -> None:
    assert not valid_project_name(name)
    with pytest.raises(WebAppError):
        _validate_vendor(name)
    with pytest.raises(MaintenanceError):
        ProjectLocator.validate_vendor(name)


def test_maintenance_error_keeps_original_name() -> None:
    with pytest.raises(MaintenanceError, match="trailing\\."):
        ProjectLocator.validate_vendor("trailing.")


def test_webapp_does_not_silently_strip_trailing_space() -> None:
    with pytest.raises(WebAppError):
        _validate_vendor("vendor ")


def test_maintenance_does_not_strip_before_validation() -> None:
    with pytest.raises(MaintenanceError):
        ProjectLocator.validate_vendor(" vendor")
