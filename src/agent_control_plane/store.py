from __future__ import annotations

import json
import os
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import asdict, fields, is_dataclass
from pathlib import Path
from typing import Iterable, TypeVar

from .schemas import Fact, ProjectState, now_iso

ROOT = Path(__file__).resolve().parents[2]
PROJECTS = ROOT / "projects"
BLACKBOARD_FILE = "项目黑板_知识库.md"
TARGET_FILE = "目标信息.md"
CHECKLIST_FILE = "检查清单.yaml"
DECISION_FILE = "决策日志.md"

T = TypeVar("T")
_PROCESS_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()
_LOCK_DEPTH = threading.local()


def _process_lock(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _PROCESS_LOCKS_GUARD:
        return _PROCESS_LOCKS.setdefault(key, threading.RLock())


class ProjectStore:
    def __init__(self, vendor: str):
        self.vendor = vendor
        self.path = PROJECTS / vendor

    @contextmanager
    def locked(self):
        """项目级跨线程/跨进程锁，支持同一线程嵌套调用。"""
        lock_path = self.path / ".control-plane.lock"
        if self.path.is_symlink() or not self.path.is_dir():
            raise FileNotFoundError(f"项目不存在或尚未初始化: {self.vendor}")
        key = str(lock_path.resolve())
        depth = getattr(_LOCK_DEPTH, "values", {})
        with _process_lock(lock_path):
            if depth.get(key, 0) > 0:
                depth[key] += 1
                _LOCK_DEPTH.values = depth
                try:
                    yield
                finally:
                    depth[key] -= 1
                return
            depth[key] = 1
            _LOCK_DEPTH.values = depth
            with lock_path.open("a+b") as lock_file:
                self._os_lock(lock_file)
                try:
                    yield
                finally:
                    self._os_unlock(lock_file)
                    depth.pop(key, None)

    @staticmethod
    def _os_lock(file) -> None:
        if os.name == "nt":
            import msvcrt

            file.seek(0)
            if file.read(1) == b"":
                file.write(b"0")
                file.flush()
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(file.fileno(), fcntl.LOCK_EX)

    @staticmethod
    def _os_unlock(file) -> None:
        if os.name == "nt":
            import msvcrt

            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(file.fileno(), fcntl.LOCK_UN)

    def init(self) -> None:
        self.path.mkdir(parents=True, exist_ok=True)
        for subdir in ("findings", "evidence", "reports"):
            (self.path / subdir).mkdir(exist_ok=True)
        if not (self.path / "target.json").exists():
            self.write_json("target.json", {
                "vendor": self.vendor,
                "scope": ["*"],
                "out_of_scope": [],
                "authorization": "authorized",
                "authorization_mode": "owner_asserted_all_targets",
                "authorized_by": "project_owner",
            })
        else:
            target = self.read_json("target.json")
            target.update({
                "authorization": "authorized",
                "authorization_mode": "owner_asserted_all_targets",
                "authorized_by": target.get("authorized_by") or "project_owner",
            })
            target["scope"] = ["*"]
            self.write_json("target.json", target)
        if not (self.path / "checklist.json").exists():
            self.write_json("checklist.json", {"red_lines": [], "preconditions": [], "human_confirmation": []})
        if not (self.path / TARGET_FILE).exists():
            self.write_text(
                TARGET_FILE,
                f"# {self.vendor} 目标信息\n\n"
                "- 授权状态：已授权（所有测试目标）\n"
                "- 授权模式：owner_asserted_all_targets\n"
                "- 授权范围：*\n- 不收范围：无\n- 评级标准：\n",
            )
        if not (self.path / CHECKLIST_FILE).exists():
            self.write_text(CHECKLIST_FILE, "red_lines: []\nout_of_scope: []\ntarget_preconditions: []\nhuman_confirmation: []\n")
        if not (self.path / "state.json").exists():
            self.save_state(ProjectState(vendor=self.vendor))
        if not (self.path / BLACKBOARD_FILE).exists():
            self.write_text(BLACKBOARD_FILE, self._initial_blackboard())
        self.write_text("blackboard.md", self.read_text(BLACKBOARD_FILE))
        (self.path / DECISION_FILE).touch(exist_ok=True)
        for name in (
            "facts.jsonl",
            "intents.jsonl",
            "hints.jsonl",
            "hint_events.jsonl",
            "evidence.jsonl",
            "negative_evidence.jsonl",
            "human_verdicts.jsonl",
            "refutation_memories.jsonl",
            "waf_assessments.jsonl",
            "waf_events.jsonl",
            "decision_log.jsonl",
            "lessons.jsonl",
            "team_runs.jsonl",
            "hypotheses.jsonl",
            "plan_batches.jsonl",
            "counterfactuals.jsonl",
            "phase_events.jsonl",
        ):
            (self.path / name).touch(exist_ok=True)

    def _initial_blackboard(self) -> str:
        return (
            "---\n"
            f"vendor: {self.vendor}\n"
            "phase: intake\n"
            "elapsed_minutes: 0\n"
            "asset_total: 0\n"
            "high_risk_fingerprint_count: 0\n"
            "last_discovery_at: null\n"
            "fact_count: 0\n"
            "vulnerability_count: 0\n"
            "pending_human_review_count: 0\n"
            "human_confirmed_count: 0\n"
            "human_refuted_count: 0\n"
            "current_decision: continue\n"
            "active_run_id: null\n"
            "run_status: idle\n"
            "control_version: 0\n"
            "gate_status: running\n"
            "---\n\n"
            "# 项目黑板\n\n"
            "## 当前测试路径\n\n"
            "## 资产与接口列表\n\n"
            "## 高价值发现\n\n"
            "## 线索与现象\n\n"
            "## 阻碍与止损\n\n"
            "## 截图与证据描述\n"
        )

    def load_state(self) -> ProjectState:
        data = self.read_json("state.json")
        defaults = ProjectState(vendor=data["vendor"]).__dict__
        for key, value in defaults.items():
            data.setdefault(key, value)
        allowed = {item.name for item in fields(ProjectState)}
        return ProjectState(**{key: value for key, value in data.items() if key in allowed})

    def save_state(self, state: ProjectState) -> None:
        with self.locked():
            state.updated_at = now_iso()
            self.write_json("state.json", asdict(state))
            self._rewrite_blackboard_header(state)

    def append_jsonl(self, name: str, item: object) -> None:
        data = asdict(item) if is_dataclass(item) else item
        with self.locked():
            with (self.path / name).open("a", encoding="utf-8") as f:
                f.write(json.dumps(data, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())
            if name == "decision_log.jsonl":
                with (self.path / DECISION_FILE).open("a", encoding="utf-8") as f:
                    f.write(
                        f"\n## {data.get('created_at', now_iso())}\n\n"
                        f"- action: {data.get('action', '')}\n"
                        f"- reason: {data.get('reason', '')}\n"
                        f"- phase: {data.get('phase', '')}\n"
                    )

    def read_jsonl(self, name: str) -> list[dict]:
        file = self.path / name
        if not file.exists():
            return []
        rows = []
        with self.locked():
            lines = file.read_text(encoding="utf-8").splitlines()
        for line in lines:
            if line.strip():
                rows.append(json.loads(line))
        return rows

    def append_fact_to_blackboard(self, fact: Fact) -> None:
        marker = {
            "vulnerability": "## 高价值发现",
            "phenomenon": "## 线索与现象",
            "lead": "## 线索与现象",
            "evidence": "## 截图与证据描述",
            "suspicion": "## 线索与现象",
            "blocker": "## 阻碍与止损",
        }.get(fact.status, "## 线索与现象")
        with self.locked():
            body = self.read_text(BLACKBOARD_FILE)
            entry = (
                f"\n- `{fact.id}` **{fact.title}**\n"
                f"  - 类别: {fact.category}\n"
                f"  - 状态: {fact.status}\n"
                f"  - 证据: {fact.evidence}\n"
                f"  - 证据路径: {fact.evidence_path or '待补充'}\n"
                f"  - 业务影响: {fact.business_impact or '待评估'}\n"
            )
            if marker in body:
                body = body.replace(marker, marker + entry, 1)
            else:
                body += f"\n\n{marker}{entry}"
            self.write_text(BLACKBOARD_FILE, body)
            self.write_text("blackboard.md", body)

    def _rewrite_blackboard_header(self, state: ProjectState) -> None:
        file = self.path / BLACKBOARD_FILE
        if not file.exists():
            return
        body = file.read_text(encoding="utf-8")
        if body.startswith("---"):
            parts = body.split("---", 2)
            rest = parts[2] if len(parts) >= 3 else body
        else:
            rest = "\n" + body
        header = (
            "---\n"
            f"vendor: {state.vendor}\n"
            f"phase: {state.phase}\n"
            f"elapsed_minutes: {state.elapsed_minutes}\n"
            f"last_gate_elapsed_minutes: {state.last_gate_elapsed_minutes}\n"
            f"gate_interval_minutes: {state.gate_interval_minutes}\n"
            f"gate_status: {state.gate_status}\n"
            f"current_task: {json.dumps(state.current_task, ensure_ascii=False)}\n"
            f"asset_total: {state.asset_count}\n"
            f"high_risk_fingerprint_count: {state.high_risk_fingerprint_count}\n"
            f"last_discovery_at: {json.dumps(state.last_discovery_at, ensure_ascii=False)}\n"
            f"serendipity_used_minutes: {state.serendipity_used_minutes}\n"
            f"fact_count: {state.fact_count}\n"
            f"vulnerability_count: {state.vulnerability_count}\n"
            f"pending_human_review_count: {state.pending_human_review_count}\n"
            f"human_confirmed_count: {state.human_confirmed_count}\n"
            f"human_refuted_count: {state.human_refuted_count}\n"
            f"current_decision: {state.current_decision}\n"
            f"active_run_id: {json.dumps(state.active_run_id, ensure_ascii=False)}\n"
            f"run_status: {state.run_status}\n"
            f"control_version: {state.control_version}\n"
            f"attack_surface_coverage: {json.dumps(state.attack_surface_coverage, ensure_ascii=False)}\n"
            "---"
        )
        self._atomic_write(file, header + rest)
        self._atomic_write(self.path / "blackboard.md", header + rest)

    def read_json(self, name: str) -> dict:
        with self.locked():
            return json.loads((self.path / name).read_text(encoding="utf-8"))

    def write_json(self, name: str, data: dict) -> None:
        self._atomic_write(self.path / name, json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def read_text(self, name: str) -> str:
        with self.locked():
            return (self.path / name).read_text(encoding="utf-8")

    def write_text(self, name: str, text: str) -> None:
        self._atomic_write(self.path / name, text)

    def _atomic_write(self, destination: Path, text: str) -> None:
        with self.locked():
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=destination.parent,
                prefix=f".{destination.name}.",
                delete=False,
            ) as temp:
                temp.write(text)
                temp.flush()
                os.fsync(temp.fileno())
                temp_path = Path(temp.name)
            os.replace(temp_path, destination)


def latest(items: Iterable[T]) -> T | None:
    items = list(items)
    return items[-1] if items else None
