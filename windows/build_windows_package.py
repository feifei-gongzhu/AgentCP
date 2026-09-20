from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "AgentCP-Windows-v3.3.zip"
INCLUDE_ROOTS = ("src", "frontend", "teams", "windows", "docs", "third_party/agent-compose")
ROOT_FILES = (
    "agentcp", "agentcp.cmd", "Install-AgentCP.cmd", "Start-AgentCP.cmd",
    "Stop-AgentCP.cmd", "README.md", "pyproject.toml",
)
EXCLUDED_PARTS = {
    ".git", ".github", ".cache", ".claude", ".venv", ".venv-windows", ".agentcp-windows",
    "__pycache__", "node_modules", "build", "coverage", "test-results",
    "playwright-report", "projects", "user_presets",
}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".sock", ".log"}


def allowed(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return (
        not any(part in EXCLUDED_PARTS for part in relative.parts)
        and path.suffix.casefold() not in EXCLUDED_SUFFIXES
        and path.name != ".DS_Store"
    )


def package_files() -> list[Path]:
    files = [ROOT / name for name in ROOT_FILES]
    for name in INCLUDE_ROOTS:
        root = ROOT / name
        if root.exists():
            files.extend(path for path in root.rglob("*") if path.is_file() and allowed(path))
    return sorted({path.resolve() for path in files if path.is_file() and allowed(path)})


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    files = package_files()
    manifest = {
        "product": "AgentCP", "version": "3.3.0",
        "platform": "Windows 10/11 x64",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "file_count": len(files), "projects_included": False,
        "note": "API keys and project data are intentionally excluded.",
    }
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            archive.write(path, Path("AgentCP-Windows") / path.relative_to(ROOT))
        archive.writestr(
            "AgentCP-Windows/WINDOWS-PACKAGE.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    OUTPUT.with_suffix(OUTPUT.suffix + ".sha256").write_text(
        f"{digest}  {OUTPUT.name}\n", encoding="ascii",
    )
    print(OUTPUT)
    print(f"sha256={digest}")
    print(f"files={len(files)} size={OUTPUT.stat().st_size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
