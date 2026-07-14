from __future__ import annotations

import os
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    prompt = sys.stdin.read()
    if not prompt.strip():
        print(json.dumps({"kind": "none", "reason": "容器没有收到任务上下文"}, ensure_ascii=False))
        return 0
    if not os.environ.get("OPENAI_API_KEY"):
        print(json.dumps({"kind": "none", "reason": "容器缺少 OPENAI_API_KEY，未执行 Intent"}, ensure_ascii=False))
        return 0

    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as output:
        output_path = Path(output.name)
    command = [
        "codex", "exec", "--skip-git-repo-check", "--cd", "/workspace",
        "--sandbox", "workspace-write",
        "--output-schema", "/opt/agentcp/output-schema.json",
        "--output-last-message", str(output_path), "-",
    ]
    try:
        result = subprocess.run(command, input=prompt, text=True, capture_output=True, timeout=900)
    except subprocess.TimeoutExpired:
        print(json.dumps({"kind": "none", "reason": "容器 Executor 超过 900 秒，已终止"}, ensure_ascii=False))
        return 0
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip()[-1200:]
        print(json.dumps({"kind": "none", "reason": f"容器 Executor 失败: {message}"}, ensure_ascii=False))
        return 0
    sys.stdout.write(output_path.read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
