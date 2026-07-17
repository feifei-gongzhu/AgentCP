from __future__ import annotations

import json
import hashlib
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4


SCHEMA_VERSION = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lease_deadline(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


class ControlDatabase:
    """每项目 SQLite 控制库。

    JSONL/Markdown 继续作为人可读导出，SQLite 负责自动化任务的可恢复状态。
    """

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS automation_runs (
                    id TEXT PRIMARY KEY,
                    project TEXT NOT NULL,
                    team TEXT NOT NULL,
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    timeout_seconds INTEGER NOT NULL,
                    max_workers INTEGER NOT NULL,
                    completed_task_count INTEGER NOT NULL DEFAULT 0,
                    low_value_streak INTEGER NOT NULL DEFAULT 0,
                    no_direction_streak INTEGER NOT NULL DEFAULT 0,
                    control_version INTEGER NOT NULL DEFAULT 1,
                    wave INTEGER NOT NULL DEFAULT 1,
                    max_waves INTEGER NOT NULL DEFAULT 4,
                    execution_deadline TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    error TEXT
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
                    stage TEXT NOT NULL,
                    member_name TEXT NOT NULL,
                    role TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    result_json TEXT,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 3,
                    worker_id TEXT,
                    lease_expires_at TEXT,
                    last_heartbeat_at TEXT,
                    error TEXT,
                    committed_at TEXT,
                    commit_error TEXT,
                    control_version INTEGER NOT NULL DEFAULT 1,
                    wave INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_claim
                    ON jobs(run_id, stage, status, lease_expires_at, created_at);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT,
                    job_id TEXT,
                    event_type TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS directions (
                    id TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL UNIQUE,
                    intent_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    claimed_by TEXT,
                    lease_expires_at TEXT,
                    terminal_reason TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_directions_claim
                    ON directions(status, lease_expires_at, created_at);
                """
            )
            row = db.execute("SELECT version FROM schema_meta LIMIT 1").fetchone()
            if row is None:
                db.execute("INSERT INTO schema_meta(version) VALUES (?)", (SCHEMA_VERSION,))
            elif int(row["version"]) > SCHEMA_VERSION:
                raise RuntimeError(f"不支持的数据库版本: {row['version']}")
            self._ensure_column(db, "automation_runs", "control_version", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(db, "automation_runs", "wave", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(db, "automation_runs", "max_waves", "INTEGER NOT NULL DEFAULT 4")
            self._ensure_column(db, "automation_runs", "execution_deadline", "TEXT")
            self._ensure_column(db, "jobs", "control_version", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(db, "jobs", "wave", "INTEGER NOT NULL DEFAULT 1")
            self._ensure_column(db, "directions", "terminal_reason", "TEXT")
            db.execute("UPDATE schema_meta SET version=?", (SCHEMA_VERSION,))

    @staticmethod
    def _ensure_column(
        db: sqlite3.Connection,
        table: str,
        column: str,
        declaration: str,
    ) -> None:
        names = {str(row["name"]) for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in names:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")

    def create_run(
        self,
        project: str,
        team: str,
        timeout_seconds: int,
        max_workers: int,
        *,
        execution_lease_seconds: int = 900,
        max_waves: int = 4,
    ) -> str:
        run_id = f"R-{uuid4().hex[:12]}"
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            active = db.execute(
                """
                SELECT id,status FROM automation_runs
                WHERE project=? AND status IN ('running','paused','stopping')
                ORDER BY created_at DESC LIMIT 1
                """,
                (project,),
            ).fetchone()
            if active is not None:
                db.execute("ROLLBACK")
                raise RuntimeError(
                    f"项目已有未结束运行 {active['id']} ({active['status']})，"
                    "请先恢复、批准或取消该运行。"
                )
            previous = db.execute(
                """
                SELECT completed_task_count,low_value_streak,no_direction_streak,control_version
                FROM automation_runs WHERE project=? ORDER BY created_at DESC LIMIT 1
                """,
                (project,),
            ).fetchone()
            counters = (
                int(previous["completed_task_count"]),
                int(previous["low_value_streak"]),
                int(previous["no_direction_streak"]),
            ) if previous else (0, 0, 0)
            control_version = int(previous["control_version"]) + 1 if previous else 1
            db.execute(
                """
                INSERT INTO automation_runs(
                    id,project,team,status,stage,timeout_seconds,max_workers,
                    completed_task_count,low_value_streak,no_direction_streak,control_version,
                    wave,max_waves,execution_deadline,
                    created_at,updated_at,error
                ) VALUES (?, ?, ?, 'running', 'swarm', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)
                """,
                (
                    run_id, project, team, timeout_seconds, max_workers,
                    *counters, control_version, max(1, max_waves),
                    _lease_deadline(max(60, execution_lease_seconds)), now, now,
                ),
            )
            self._event(db, run_id, None, "run_created", {"team": team})
            db.execute("COMMIT")
        return run_id

    def enqueue_job(
        self,
        run_id: str,
        stage: str,
        member_name: str,
        role: str,
        payload: dict[str, Any],
        max_attempts: int = 3,
        wave: int | None = None,
    ) -> str:
        job_id = f"J-{uuid4().hex[:12]}"
        now = _now()
        with self.connect() as db:
            run = db.execute(
                "SELECT status,control_version,wave FROM automation_runs WHERE id=?",
                (run_id,),
            ).fetchone()
            if run is None or run["status"] != "running":
                raise RuntimeError(f"运行 {run_id} 不接受新任务。")
            db.execute(
                """
                INSERT INTO jobs(
                    id,run_id,stage,member_name,role,payload_json,status,attempts,max_attempts,
                    control_version,wave,created_at,updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
                """,
                (
                    job_id, run_id, stage, member_name, role,
                    json.dumps(payload, ensure_ascii=False), max_attempts,
                    int(run["control_version"]), int(wave or run["wave"]), now, now,
                ),
            )
            self._event(db, run_id, job_id, "job_queued", {"stage": stage, "member": member_name})
        return job_id

    def register_direction(self, intent: dict[str, Any]) -> tuple[str, bool]:
        identity = "\x1f".join(
            str(intent.get(key, "")).strip().casefold()
            for key in ("verb", "target", "hypothesis", "success_criteria", "chain_id", "sequence")
        )
        fingerprint = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        direction_id = str(intent.get("id") or f"I-{uuid4().hex[:12]}")
        now = _now()
        with self.connect() as db:
            existing = db.execute("SELECT id FROM directions WHERE fingerprint=?", (fingerprint,)).fetchone()
            if existing:
                self._event(db, None, None, "direction_duplicate", {"direction_id": existing["id"]})
                return str(existing["id"]), False
            db.execute(
                """
                INSERT INTO directions(id,fingerprint,intent_json,status,created_at,updated_at)
                VALUES (?,?,?,'open',?,?)
                """,
                (direction_id, fingerprint, json.dumps(intent, ensure_ascii=False), now, now),
            )
            self._event(db, None, None, "direction_registered", {"direction_id": direction_id})
        return direction_id, True

    def claim_direction(self, worker_id: str, lease_seconds: int = 60) -> dict[str, Any] | None:
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """
                SELECT * FROM directions
                WHERE status IN ('open','released') OR (status='claimed' AND lease_expires_at < ?)
                ORDER BY
                    CASE
                        WHEN json_extract(intent_json, '$.requires_human_confirmation') THEN 0
                        ELSE 1
                    END,
                    CASE lower(coalesce(json_extract(intent_json, '$.risk_level'), 'low'))
                        WHEN 'critical' THEN 0
                        WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2
                        WHEN 'low' THEN 3
                        ELSE 4
                    END,
                    CAST(coalesce(json_extract(intent_json, '$.priority_score'), 0) AS REAL) DESC,
                    created_at,
                    id
                LIMIT 1
                """,
                (now,),
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            db.execute(
                """
                UPDATE directions SET status='claimed',claimed_by=?,lease_expires_at=?,updated_at=? WHERE id=?
                """,
                (worker_id, _lease_deadline(lease_seconds), now, row["id"]),
            )
            self._event(db, None, None, "direction_claimed", {"direction_id": row["id"], "worker_id": worker_id})
            db.execute("COMMIT")
            result = dict(row)
            result["intent"] = json.loads(result.pop("intent_json"))
            result.update({"status": "claimed", "claimed_by": worker_id})
            return result

    def heartbeat_direction(self, direction_id: str, worker_id: str, lease_seconds: int = 60) -> bool:
        with self.connect() as db:
            result = db.execute(
                """
                UPDATE directions SET lease_expires_at=?,updated_at=?
                WHERE id=? AND claimed_by=? AND status='claimed'
                """,
                (_lease_deadline(lease_seconds), _now(), direction_id, worker_id),
            )
            return result.rowcount == 1

    def finish_direction(
        self,
        direction_id: str,
        worker_id: str,
        success: bool | None = None,
        *,
        outcome: str | None = None,
        reason: str | None = None,
    ) -> None:
        with self.connect() as db:
            status = outcome or ("completed" if success else "released")
            if status not in {
                "completed", "rejected", "exhausted", "blocked", "cancelled", "released",
            }:
                raise ValueError(f"非法 Intent 终态: {status}")
            db.execute(
                """
                UPDATE directions SET status=?,claimed_by=NULL,lease_expires_at=NULL,
                    terminal_reason=?,updated_at=?
                WHERE id=? AND claimed_by=?
                """,
                (status, reason, _now(), direction_id, worker_id),
            )
            self._event(db, None, None, "direction_finished", {
                "direction_id": direction_id, "status": status, "reason": reason,
            })

    def list_directions(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM directions ORDER BY created_at,id").fetchall()]
        for row in rows:
            row["intent"] = json.loads(row.pop("intent_json"))
        return rows

    def get_direction(self, direction_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM directions WHERE id=?", (direction_id,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["intent"] = json.loads(result.pop("intent_json"))
        return result

    def dismiss_direction(self, direction_id: str, reason: str) -> dict[str, Any]:
        """Human-reject a direction and fence every not-yet-committed job bound to it."""
        reason = reason.strip()
        if not reason:
            raise ValueError("人工否决方向必须填写理由。")
        now = _now()
        terminal_reason = f"human_dismissed:{reason[:1000]}"
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            direction = db.execute(
                "SELECT * FROM directions WHERE id=?", (direction_id,)
            ).fetchone()
            if direction is None:
                db.execute("ROLLBACK")
                raise RuntimeError(f"方向不存在: {direction_id}")
            if direction["status"] == "cancelled" and str(direction["terminal_reason"] or "").startswith("human_dismissed:"):
                db.execute("COMMIT")
                return self.get_direction(direction_id) or {}

            matched_jobs = db.execute(
                """
                SELECT id,run_id,status FROM jobs
                WHERE json_extract(payload_json, '$.direction.id')=?
                  AND committed_at IS NULL
                  AND status IN ('queued','running','completed','cancelling')
                """,
                (direction_id,),
            ).fetchall()
            db.execute(
                """
                UPDATE directions SET status='cancelled',claimed_by=NULL,lease_expires_at=NULL,
                    terminal_reason=?,updated_at=? WHERE id=?
                """,
                (terminal_reason, now, direction_id),
            )
            db.execute(
                """
                UPDATE jobs SET status='cancelled',error=?,worker_id=NULL,
                    lease_expires_at=NULL,updated_at=?
                WHERE json_extract(payload_json, '$.direction.id')=?
                  AND committed_at IS NULL AND status IN ('queued','completed')
                """,
                (terminal_reason, now, direction_id),
            )
            db.execute(
                """
                UPDATE jobs SET status='cancelling',error=?,updated_at=?
                WHERE json_extract(payload_json, '$.direction.id')=?
                  AND committed_at IS NULL AND status='running'
                """,
                (terminal_reason, now, direction_id),
            )
            for job in matched_jobs:
                next_status = "cancelling" if job["status"] == "running" else "cancelled"
                self._event(db, job["run_id"], job["id"], "job_human_cancelled", {
                    "direction_id": direction_id,
                    "status": next_status,
                    "reason": reason[:1000],
                })
            self._event(db, None, None, "direction_human_dismissed", {
                "direction_id": direction_id,
                "reason": reason[:1000],
                "affected_jobs": len(matched_jobs),
            })
            db.execute("COMMIT")
        return self.get_direction(direction_id) or {}

    def job_status(self, job_id: str) -> str | None:
        with self.connect() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            return str(row["status"]) if row else None

    def set_direction_status(
        self,
        direction_id: str,
        status: str,
        reason: str | None = None,
    ) -> None:
        if status not in {
            "open", "released", "completed", "rejected", "exhausted", "blocked", "cancelled",
        }:
            raise ValueError(f"非法 Intent 状态: {status}")
        with self.connect() as db:
            db.execute(
                """
                UPDATE directions SET status=?,claimed_by=NULL,lease_expires_at=NULL,
                    terminal_reason=?,updated_at=? WHERE id=? AND status!='claimed'
                """,
                (status, reason, _now(), direction_id),
            )
            self._event(db, None, None, "direction_status_changed", {
                "direction_id": direction_id, "status": status, "reason": reason,
            })

    def claim_job(
        self,
        run_id: str,
        stage: str,
        worker_id: str,
        lease_seconds: int = 60,
        wave: int | None = None,
    ) -> dict[str, Any] | None:
        now = _now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """
                SELECT jobs.* FROM jobs
                JOIN automation_runs ON automation_runs.id=jobs.run_id
                WHERE jobs.run_id=? AND jobs.stage=? AND jobs.attempts < jobs.max_attempts
                  AND automation_runs.status='running'
                  AND jobs.control_version=automation_runs.control_version
                  AND (? IS NULL OR jobs.wave=?)
                  AND (jobs.status='queued' OR (jobs.status='running' AND jobs.lease_expires_at < ?))
                ORDER BY jobs.created_at, jobs.id LIMIT 1
                """,
                (run_id, stage, wave, wave, now),
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            db.execute(
                """
                UPDATE jobs SET status='running', attempts=attempts+1, worker_id=?,
                    lease_expires_at=?, last_heartbeat_at=?, updated_at=?, error=NULL
                WHERE id=?
                """,
                (worker_id, _lease_deadline(lease_seconds), now, now, row["id"]),
            )
            self._event(db, run_id, row["id"], "job_claimed", {"worker_id": worker_id})
            db.execute("COMMIT")
            claimed = dict(row)
            claimed.update({"status": "running", "worker_id": worker_id, "attempts": int(row["attempts"]) + 1})
            claimed["payload"] = json.loads(claimed.pop("payload_json"))
            return claimed

    def heartbeat(
        self,
        job_id: str,
        worker_id: str,
        lease_seconds: int = 60,
        control_version: int | None = None,
    ) -> bool:
        now = _now()
        with self.connect() as db:
            if control_version is None:
                row = db.execute("SELECT control_version FROM jobs WHERE id=?", (job_id,)).fetchone()
                control_version = int(row["control_version"]) if row else -1
            result = db.execute(
                """
                UPDATE jobs SET lease_expires_at=?, last_heartbeat_at=?, updated_at=?
                WHERE id=? AND worker_id=? AND status='running' AND control_version=?
                  AND EXISTS (
                    SELECT 1 FROM automation_runs
                    WHERE automation_runs.id=jobs.run_id
                      AND automation_runs.status='running'
                      AND automation_runs.control_version=jobs.control_version
                  )
                """,
                (_lease_deadline(lease_seconds), now, now, job_id, worker_id, control_version),
            )
            return result.rowcount == 1

    def complete_job(
        self,
        job_id: str,
        worker_id: str,
        result: dict[str, Any],
        control_version: int | None = None,
    ) -> None:
        now = _now()
        with self.connect() as db:
            row = db.execute(
                "SELECT run_id,control_version FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            if row is None:
                raise RuntimeError(f"任务不存在: {job_id}")
            expected_version = int(row["control_version"]) if control_version is None else control_version
            updated = db.execute(
                """
                UPDATE jobs SET status='completed', result_json=?, lease_expires_at=NULL,
                    updated_at=? WHERE id=? AND worker_id=? AND status='running'
                    AND control_version=?
                    AND EXISTS (
                      SELECT 1 FROM automation_runs
                      WHERE automation_runs.id=jobs.run_id
                        AND automation_runs.status='running'
                        AND automation_runs.control_version=jobs.control_version
                    )
                """,
                (json.dumps(result, ensure_ascii=False), now, job_id, worker_id, expected_version),
            )
            if updated.rowcount != 1:
                self._event(db, row["run_id"], job_id, "stale_write_rejected", {
                    "worker_id": worker_id, "control_version": expected_version,
                })
                raise RuntimeError(f"任务控制版本或租约已失效: {job_id}")
            self._event(db, row["run_id"], job_id, "job_completed", {})

    def fail_job(
        self,
        job_id: str,
        worker_id: str,
        error: str,
        *,
        retryable: bool = True,
        control_version: int | None = None,
    ) -> str:
        now = _now()
        with self.connect() as db:
            row = db.execute(
                """
                SELECT jobs.run_id,jobs.status AS job_status,jobs.attempts,jobs.max_attempts,jobs.control_version,
                    automation_runs.status AS run_status,
                    automation_runs.control_version AS run_control_version
                FROM jobs JOIN automation_runs ON automation_runs.id=jobs.run_id WHERE jobs.id=?
                """,
                (job_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"任务不存在: {job_id}")
            expected_version = int(row["control_version"]) if control_version is None else control_version
            stale = (
                row["job_status"] != "running"
                or
                row["run_status"] != "running"
                or int(row["run_control_version"]) != expected_version
                or int(row["control_version"]) != expected_version
            )
            next_status = (
                "cancelled"
                if stale
                else "failed"
                if not retryable or int(row["attempts"]) >= int(row["max_attempts"])
                else "queued"
            )
            db.execute(
                """
                UPDATE jobs SET status=?, error=?, worker_id=NULL, lease_expires_at=NULL,
                    updated_at=? WHERE id=? AND worker_id=? AND status IN ('running','cancelling')
                """,
                (next_status, error, now, job_id, worker_id),
            )
            self._event(db, row["run_id"], job_id, "job_failed", {"status": next_status, "error": error})
            if stale:
                self._event(db, row["run_id"], job_id, "stale_write_rejected", {
                    "worker_id": worker_id, "control_version": expected_version,
                })
            return next_status

    def add_event(
        self,
        run_id: str | None,
        job_id: str | None,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        with self.connect() as db:
            self._event(db, run_id, job_id, event_type, data)

    def list_jobs(
        self,
        run_id: str,
        stage: str | None = None,
        wave: int | None = None,
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM jobs WHERE run_id=?"
        params: list[Any] = [run_id]
        if stage:
            query += " AND stage=?"
            params.append(stage)
        if wave is not None:
            query += " AND wave=?"
            params.append(wave)
        query += " ORDER BY created_at,id"
        with self.connect() as db:
            rows = [dict(row) for row in db.execute(query, params).fetchall()]
        for row in rows:
            row["payload"] = json.loads(row.pop("payload_json"))
            row["result"] = json.loads(row["result_json"]) if row.get("result_json") else None
        return rows

    def set_run_stage(self, run_id: str, stage: str) -> None:
        with self.connect() as db:
            updated = db.execute(
                "UPDATE automation_runs SET stage=?,updated_at=? WHERE id=? AND status IN ('running','paused')",
                (stage, _now(), run_id),
            )
            if updated.rowcount != 1:
                return
            self._event(db, run_id, None, "run_stage_changed", {"stage": stage})

    def advance_run_wave(self, run_id: str) -> int:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status,wave,max_waves FROM automation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None or row["status"] != "running":
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行 {run_id} 不能进入下一波")
            next_wave = int(row["wave"]) + 1
            if next_wave > int(row["max_waves"]):
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行 {run_id} 已达最大波次")
            db.execute(
                "UPDATE automation_runs SET wave=?,stage='swarm',updated_at=? WHERE id=?",
                (next_wave, _now(), run_id),
            )
            self._event(db, run_id, None, "run_wave_advanced", {"wave": next_wave})
            db.execute("COMMIT")
            return next_wave

    def open_direction_count(self) -> int:
        with self.connect() as db:
            row = db.execute(
                "SELECT COUNT(*) AS count FROM directions WHERE status IN ('open','released')"
            ).fetchone()
            return int(row["count"])

    def set_run_status(self, run_id: str, status: str, error: str | None = None) -> None:
        with self.connect() as db:
            current = db.execute(
                "SELECT status FROM automation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if current is None:
                raise RuntimeError(f"运行不存在: {run_id}")
            if current["status"] in {"stopped", "cancelled", "completed", "failed"}:
                if status != current["status"]:
                    raise RuntimeError(f"终结运行 {run_id} 不能从 {current['status']} 变为 {status}")
                return
            db.execute(
                "UPDATE automation_runs SET status=?,error=?,updated_at=? WHERE id=?",
                (status, error, _now(), run_id),
            )
            self._event(db, run_id, None, "run_status_changed", {"status": status, "error": error})

    def update_run_counters(
        self,
        run_id: str,
        *,
        completed_delta: int = 0,
        low_value: bool | None = None,
        no_direction: bool | None = None,
    ) -> None:
        with self.connect() as db:
            row = db.execute(
                "SELECT completed_task_count,low_value_streak,no_direction_streak FROM automation_runs WHERE id=?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"运行不存在: {run_id}")
            low_streak = int(row["low_value_streak"])
            no_streak = int(row["no_direction_streak"])
            if low_value is not None:
                low_streak = low_streak + 1 if low_value else 0
            if no_direction is not None:
                no_streak = no_streak + 1 if no_direction else 0
            db.execute(
                """
                UPDATE automation_runs SET completed_task_count=completed_task_count+?,
                    low_value_streak=?,no_direction_streak=?,updated_at=? WHERE id=?
                """,
                (completed_delta, low_streak, no_streak, _now(), run_id),
            )

    def mark_job_committed(self, job_id: str, error: str | None = None) -> None:
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET committed_at=?,commit_error=?,updated_at=? WHERE id=?",
                (_now() if error is None else None, error, _now(), job_id),
            )
            row = db.execute("SELECT run_id FROM jobs WHERE id=?", (job_id,)).fetchone()
            self._event(
                db,
                row["run_id"] if row else None,
                job_id,
                "job_committed" if error is None else "job_commit_deferred",
                {"error": error},
            )

    def reject_job_candidate(self, job_id: str, error: str) -> None:
        """Permanently consume a malformed candidate instead of pausing forever."""
        now = _now()
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET committed_at=?,commit_error=?,updated_at=? WHERE id=?",
                (now, error, now, job_id),
            )
            row = db.execute("SELECT run_id FROM jobs WHERE id=?", (job_id,)).fetchone()
            self._event(
                db,
                row["run_id"] if row else None,
                job_id,
                "job_commit_rejected",
                {"error": error},
            )

    def finish_run(self, run_id: str, status: str, error: str | None = None) -> None:
        with self.connect() as db:
            updated = db.execute(
                """
                UPDATE automation_runs SET status=?,stage='finished',error=?,updated_at=?
                WHERE id=? AND status IN ('running','paused')
                """,
                (status, error, _now(), run_id),
            )
            if updated.rowcount != 1:
                return
            self._event(db, run_id, None, "run_finished", {"status": status, "error": error})

    def cancel_run(self, run_id: str, reason: str) -> None:
        self.stop_run(run_id, reason)

    def stop_run(self, run_id: str, reason: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = db.execute(
                "SELECT status,control_version FROM automation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                db.execute("ROLLBACK")
                raise RuntimeError(f"运行不存在: {run_id}")
            if run["status"] in {"stopped", "cancelled", "completed", "failed"}:
                db.execute("COMMIT")
                return
            next_version = int(run["control_version"]) + 1
            now = _now()
            db.execute(
                """
                UPDATE automation_runs SET status='stopping',control_version=?,error=?,updated_at=?
                WHERE id=?
                """,
                (next_version, reason, now, run_id),
            )
            db.execute(
                """
                UPDATE jobs SET status='cancelled',error=?,worker_id=NULL,
                    lease_expires_at=NULL,updated_at=?
                WHERE run_id=? AND status='queued'
                """,
                (reason, now, run_id),
            )
            db.execute(
                """
                UPDATE jobs SET status='cancelling',error=?,updated_at=?
                WHERE run_id=? AND status='running'
                """,
                (reason, now, run_id),
            )
            db.execute(
                """
                UPDATE directions SET status='cancelled',claimed_by=NULL,lease_expires_at=NULL,
                    terminal_reason=?,updated_at=?
                WHERE status='claimed' AND claimed_by LIKE ?
                """,
                (reason, now, f"{run_id}:%"),
            )
            self._event(db, run_id, None, "run_stopping", {
                "reason": reason, "control_version": next_version,
            })
            db.execute(
                "UPDATE automation_runs SET status='stopped',stage='finished',updated_at=? WHERE id=?",
                (_now(), run_id),
            )
            self._event(db, run_id, None, "run_stopped", {
                "reason": reason, "control_version": next_version,
            })
            db.execute("COMMIT")

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM automation_runs WHERE id=?", (run_id,)).fetchone()
            return dict(row) if row else None

    def latest_resumable_run(self) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM automation_runs WHERE status IN ('running','paused') ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            return dict(row) if row else None

    def latest_run(self) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT 1").fetchone()
            return dict(row) if row else None

    def list_runs(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM automation_runs ORDER BY created_at").fetchall()]

    def list_all_jobs(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM jobs ORDER BY created_at,id").fetchall()]
        for row in rows:
            row["payload"] = json.loads(row.pop("payload_json"))
            row["result"] = json.loads(row["result_json"]) if row.get("result_json") else None
        return rows

    def event_count(self, event_type: str) -> int:
        with self.connect() as db:
            row = db.execute("SELECT COUNT(*) AS count FROM events WHERE event_type=?", (event_type,)).fetchone()
            return int(row["count"])

    def events(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM events WHERE run_id=? ORDER BY id", (run_id,)).fetchall()
        events = [dict(row) for row in rows]
        for event in events:
            event["data"] = json.loads(event.pop("data_json"))
        return events

    @staticmethod
    def _event(
        db: sqlite3.Connection,
        run_id: str | None,
        job_id: str | None,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        db.execute(
            "INSERT INTO events(run_id,job_id,event_type,data_json,created_at) VALUES (?,?,?,?,?)",
            (run_id, job_id, event_type, json.dumps(data, ensure_ascii=False), _now()),
        )
