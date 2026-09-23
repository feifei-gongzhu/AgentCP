from __future__ import annotations


WINDOWS_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}


def valid_project_name(value: object) -> bool:
    name = str(value or "")
    if (
        not name
        or len(name) > 80
        or name in {".", ".."}
        or name.startswith(".")
        or name.endswith((".", " "))
        or any(char in name for char in ("/", "\\", "\0"))
        or not all(char.isalnum() or char in {"-", "_", "."} for char in name)
    ):
        return False
    return name.split(".", 1)[0].casefold() not in WINDOWS_RESERVED_NAMES
